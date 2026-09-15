#!/usr/bin/env node
// server.mjs — serves the UI and (optionally) pins images to Pinata with keys from a local .env.
// Zero dependencies. Binds to 127.0.0.1 only: the pin endpoint spends YOUR Pinata quota, so it is not exposed to the network.
//   node server.mjs                 -> http://127.0.0.1:8788
//   PORT=3000 node server.mjs
//   HOST=0.0.0.0 node server.mjs    -> reachable from other devices (only do this on a network you trust)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const env = { ...process.env };
try { for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split("\n")) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {}
const PORT = Number(env.PORT || 8788), HOST = env.HOST || "127.0.0.1", MAX_UPLOAD = 5 * 1024 * 1024;
const pinning = Boolean(env.PINATA_JWT || (env.PINATA_API_KEY && env.PINATA_API_SECRET));
// /rpc proxy: the public Arc RPC refuses browser (CORS) requests, so the page calls this same-origin endpoint instead.
// Put your own RPC(s) in .env ARC_RPC_URLS (comma-separated); URLs with keys never reach the browser, only their hostnames do.
const UPSTREAMS = (env.ARC_RPC_URLS || "https://rpc.arc-scan.org").split(",").map(s => s.trim()).filter(Boolean);
const hostOf = u => { try { return new URL(u).host; } catch { return "?"; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function proxyRpc(body) {
  let last = "no upstream";
  for (const u of UPSTREAMS) {
    // rpc.arc-scan.org answers 503 ("retry_after_seconds": 2) on roughly half of the requests under load: retry with backoff before moving on
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await sleep(350 * attempt + Math.random() * 200);
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 60_000);
      try {
        const r = await fetch(u, { method: "POST", headers: { "content-type": "application/json", "user-agent": "curl/8.4.0" }, body, signal: ctl.signal });
        const text = await r.text();
        if (r.status >= 500) { last = `HTTP ${r.status} from ${hostOf(u)}`; continue; }
        return { status: r.status, text };
      } catch (e) { last = `${hostOf(u)}: ${e.name === "AbortError" ? "timeout" : e.message}`; }
      finally { clearTimeout(t); }
    }
  }
  return { status: 502, text: JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: `all upstream RPCs failed: ${last}` } }) };
}
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8" };

async function pinToPinata(buf, filename, type) {
  const headers = env.PINATA_JWT ? { Authorization: `Bearer ${env.PINATA_JWT}` } : { pinata_api_key: env.PINATA_API_KEY, pinata_secret_api_key: env.PINATA_API_SECRET };
  const fd = new FormData();
  fd.append("file", new Blob([buf], { type }), filename);
  fd.append("pinataMetadata", JSON.stringify({ name: filename }));
  const r = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", { method: "POST", headers, body: fd });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.IpfsHash) throw new Error(`Pinata: HTTP ${r.status} ${JSON.stringify(j).slice(0, 160)}`);
  return { cid: j.IpfsHash, url: `https://gateway.pinata.cloud/ipfs/${j.IpfsHash}` };
}
const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/api/config") return json(res, 200, { pinning, rpc: true, upstreams: UPSTREAMS.map(hostOf), maxUploadBytes: MAX_UPLOAD });
    if (url.pathname === "/rpc") {
      if (req.method !== "POST") return json(res, 405, { error: "POST only" });
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > 1 << 20) return json(res, 413, { error: "request larger than 1 MB" }); chunks.push(c); }
      const out = await proxyRpc(Buffer.concat(chunks));
      res.writeHead(out.status, { "content-type": "application/json" }); return res.end(out.text);
    }
    if (url.pathname === "/api/pin") {
      if (req.method !== "POST") return json(res, 405, { error: "POST only" });
      if (!pinning) return json(res, 503, { error: "pinning disabled: put PINATA_JWT or PINATA_API_KEY + PINATA_API_SECRET in .env" });
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > MAX_UPLOAD) return json(res, 413, { error: "file larger than 5 MB" }); chunks.push(c); }
      const type = req.headers["content-type"] || "application/octet-stream";
      if (!type.startsWith("image/")) return json(res, 415, { error: "only images" });
      const name = decodeURIComponent(req.headers["x-filename"] || "image").replace(/[^\w.\-]+/g, "_").slice(0, 80) || "image";
      return json(res, 200, await pinToPinata(Buffer.concat(chunks), name, type));
    }
    // static files: no dotfiles, no traversal, no server/env
    let p = decodeURIComponent(url.pathname); if (p === "/") p = "/index.html";
    if (p.split("/").some(seg => seg.startsWith(".")) || p.includes("..") || /^\/(server\.mjs|node_modules|test)(\/|$)/.test(p)) { res.writeHead(404); return res.end("not found"); }
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
    fs.createReadStream(file).pipe(res);
  } catch (e) { json(res, 500, { error: String(e.message || e).slice(0, 200) }); }
}).listen(PORT, HOST, () => console.log(`minera-arc → http://${HOST}:${PORT}  · rpc via ${UPSTREAMS.map(hostOf).join(", ")} · pinning ${pinning ? "on" : "off (add Pinata keys to .env to upload images)"}`));
