// app.js — browser UI: connect wallet, fill the form, simulate, launch. Private keys never touch this page: the wallet signs.
import { ethers, JsonRpcProvider, BrowserProvider, getAddress, isAddress, formatUnits, parseUnits } from "./vendor/ethers.min.js";
import { CHAIN_ID, CHAIN_ID_HEX, RPC_DEFAULTS, EXPLORER, MINARA, POOL_MANAGER, STATE_VIEW, IFACE, TOPICS, SUPPLY, short, basedbotLink, poolIdOf, buildLaunch, buyOutcome, parseLaunchReceipt, readLive, predictToken, decodeError, errorData } from "./minara.js";

const $ = id => document.getElementById(id);
const fmt = (n, d = 2) => n == null || Number.isNaN(n) ? "?" : Math.abs(n) >= 1e9 ? (n / 1e9).toFixed(2) + "B" : Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(2) + "M" : Math.abs(n) >= 1e3 ? n.toLocaleString("en-US", { maximumFractionDigits: 0 }) : n.toFixed(d);
const usd = n => "$" + fmt(n, 0);
const hx = n => "0x" + BigInt(n).toString(16);
const state = { rpcs: [], proxy: null, live: null, wallet: null, account: null, sim: null, pinning: false, busy: false };

// ---------- read RPCs: the local server's /rpc proxy first (public RPCs block browser CORS), then any URLs from settings ----------
function loadRpcs() { try { const s = localStorage.getItem("minera.rpcs"); if (s) return JSON.parse(s); } catch {} return []; }
function saveRpcs(list) { try { localStorage.setItem("minera.rpcs", JSON.stringify(list)); } catch {} }
let providers = [];
function setRpcs(list) {
  state.rpcs = list.filter(Boolean);
  const urls = [...(state.proxy ? [state.proxy] : []), ...state.rpcs, ...(state.proxy ? [] : RPC_DEFAULTS)];
  providers = urls.map(u => new JsonRpcProvider(u, CHAIN_ID, { staticNetwork: true }));
  $("rpcs").value = state.rpcs.join(", ");
}
/** Try every read RPC in order, then the wallet provider. Reverts are returned immediately (they are answers, not outages). */
async function rpcSend(method, params) {
  let last;
  for (const p of [...providers, ...(state.wallet ? [state.wallet] : [])]) {
    try { return await p.send(method, params); }
    catch (e) { if (errorData(e) || /revert/i.test(e?.message || "")) throw e; last = e; }
  }
  throw last || new Error("no RPC reachable");
}
const call = (to, data, from) => rpcSend("eth_call", [{ to, data, ...(from ? { from } : {}) }, "latest"]);

// ---------- wallet ----------
async function connect() {
  if (!window.ethereum) { toast("No wallet found. Install MetaMask or Rabby.", true); return; }
  state.wallet = new BrowserProvider(window.ethereum, "any");
  const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
  state.account = getAddress(accounts[0]);
  await ensureChain();
  $("creator").value = state.account;
  $("connect").textContent = short(state.account);
  window.ethereum.on?.("accountsChanged", a => { state.account = a[0] ? getAddress(a[0]) : null; $("creator").value = state.account || ""; $("connect").textContent = state.account ? short(state.account) : "Connect wallet"; simulate(); });
  window.ethereum.on?.("chainChanged", () => refreshChainBadge());
  await refreshChainBadge();
  simulate();
}
async function ensureChain() {
  const cur = await window.ethereum.request({ method: "eth_chainId" });
  if (parseInt(cur, 16) === CHAIN_ID) return;
  try { await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_ID_HEX }] }); }
  catch (e) {
    if (e.code !== 4902 && !/unrecognized|not added|4902/i.test(e.message || "")) throw e;
    await window.ethereum.request({ method: "wallet_addEthereumChain", params: [{ chainId: CHAIN_ID_HEX, chainName: "Arc", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: [state.rpcs[0] || RPC_DEFAULTS[0]], blockExplorerUrls: [EXPLORER] }] });   // the wallet needs a real RPC, not the local proxy
  }
}
async function refreshChainBadge() {
  if (!window.ethereum) return;
  const cur = parseInt(await window.ethereum.request({ method: "eth_chainId" }), 16);
  $("chain").textContent = cur === CHAIN_ID ? "Arc mainnet 5042 ✓" : `wrong chain (${cur}) — switch to Arc 5042`;
  $("chain").className = cur === CHAIN_ID ? "ok" : "bad";
}

// ---------- live Minara parameters ----------
async function loadLive() {
  try {
    state.live = await readLive(call);
    const L = state.live, o = buyOutcome({ sqrtPriceX96: L.sqrtPriceX96, liquidity: L.liquidity, usdcIn: 0, hookFeeBps: 0 });
    $("live").innerHTML = `launch fee <b>${formatUnits(L.launchFee, 18)} USDC</b> · opening <b>1 USDC = ${fmt(o.pricePerUsdc, 0)} tokens</b> (FDV ${usd(o.fdvBefore)}) · swap fee <b>${(L.platformBps / 100).toFixed(2)}% platform${L.creatorBps ? ` + ${(L.creatorBps / 100).toFixed(2)}% creator` : ""}</b> · tick ${L.expectedTick}${L.quoteEnabled ? "" : " · <span class=bad>native USDC quote DISABLED</span>"}`;
  } catch (e) { $("live").innerHTML = `<span class=bad>cannot read Minara contracts: ${e.message.slice(0, 120)}</span>`; }
}

// ---------- form -> simulation ----------
function readForm() {
  const f = { name: $("name").value.trim(), symbol: $("symbol").value.trim().replace(/^\$/, ""), description: $("description").value.trim(), image: $("image").value.trim(), website: $("website").value.trim(), buy: Number($("buy").value || 0), creatorFee: $("creatorFee").checked, slippage: Number($("slippage").value || 0), creator: $("creator").value.trim() };
  const errors = [];
  if (!f.name) errors.push("name is empty"); else if (new TextEncoder().encode(f.name).length > 64) errors.push("name > 64 bytes");
  if (!f.symbol) errors.push("ticker is empty"); else if (new TextEncoder().encode(f.symbol).length > 12) errors.push("ticker > 12 bytes");
  if (!isAddress(f.creator)) errors.push("creator address is not valid (connect a wallet or paste an address)");
  if (!(f.buy >= 0)) errors.push("opening buy must be 0 or more");
  if (f.image && !/^https?:\/\/|^ipfs:\/\//i.test(f.image)) errors.push("image must be an http(s) or ipfs URL");
  return { f, errors };
}
let simTimer = null;
function scheduleSim() { clearTimeout(simTimer); simTimer = setTimeout(simulate, 400); }
async function simulate() {
  const { f, errors } = readForm();
  $("launch").disabled = true; state.sim = null;
  if (errors.length) { $("sim").innerHTML = errors.map(e => `<div class=bad>• ${e}</div>`).join(""); return; }
  if (!state.live) { $("sim").innerHTML = "<div class=dim>waiting for Minara parameters…</div>"; return; }
  const L = state.live, creator = getAddress(f.creator);
  $("sim").innerHTML = "<div class=dim>simulating…</div>";
  try {
    const predicted = await predictToken(call, { name: f.name, symbol: f.symbol, creator });
    const code = await rpcSend("eth_getCode", [predicted, "latest"]);
    if (code && code !== "0x") throw new Error(`this name + ticker was already launched from this wallet: ${predicted}`);
    const hookFeeBps = L.platformBps + (f.creatorFee ? L.creatorBps : 0);
    const out = buyOutcome({ sqrtPriceX96: L.sqrtPriceX96, liquidity: L.liquidity, usdcIn: f.buy, hookFeeBps });
    const buy = parseUnits(String(f.buy || 0), 18), minOut = out.tokensOut * BigInt(Math.round((100 - f.slippage) * 100)) / 10_000n;
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const { data, value } = buildLaunch({ name: f.name, symbol: f.symbol, description: f.description, website: f.website, image: f.image, creator, predicted, expectedTick: L.expectedTick, creatorFee: f.creatorFee, launchFee: L.launchFee, buy, minOut, deadline });
    const balance = BigInt(await rpcSend("eth_getBalance", [creator, "latest"]));
    const need = value + parseUnits("0.3", 18), enough = balance >= need;
    const tx = { from: creator, to: MINARA.launcher, data, value: hx(value) };
    let gas = null, simErr = null;
    try { await rpcSend("eth_call", enough ? [tx, "latest"] : [tx, "latest", { [creator]: { balance: hx(value + parseUnits("1", 18)) } }]); }
    catch (e) { simErr = decodeError(errorData(e)) + (errorData(e) ? "" : ` (${(e.shortMessage || e.message || "").slice(0, 100)})`); }
    if (!simErr) { try { gas = Number(BigInt(await rpcSend("eth_estimateGas", enough ? [tx] : [tx, "latest", { [creator]: { balance: hx(value + parseUnits("1", 18)) } }]))); } catch { gas = 3_300_000; } }
    const rows = [
      ["token", `<a href="${basedbotLink(predicted)}" target=_blank>${predicted}</a> <span class=dim>(predicted)</span>`],
      ["pool", `<span class=mono>${poolIdOf(predicted)}</span>`],
      ["opening", `1 USDC = ${fmt(out.pricePerUsdc, 0)} ${f.symbol} · FDV ${usd(out.fdvBefore)}`],
      ["your buy", f.buy > 0 ? `${f.buy} USDC → <b>${fmt(out.tokens, 0)} ${f.symbol}</b> (${out.pctSupply.toFixed(2)}% of supply) · FDV after ${usd(out.fdvAfter)} · min out ${fmt(Number(minOut) / 1e18, 0)} (${f.slippage}% slippage)` : "none"],
      ["fees", `launch ${formatUnits(L.launchFee, 18)} USDC → Minara · swap ${(hookFeeBps / 100).toFixed(2)}%${f.creatorFee ? ` (${(L.creatorBps / 100).toFixed(2)}% accrues to you)` : ""}${f.buy > 0 ? ` · on your buy ${out.hookFeeUsdc.toFixed(3)} USDC` : ""}`],
      ["total", `<b>${formatUnits(value, 18)} USDC</b> + gas${gas ? ` (~${gas.toLocaleString()} gas)` : ""} · wallet ${formatUnits(balance, 18).slice(0, 8)} USDC ${enough ? "<span class=ok>✓</span>" : `<span class=bad>— need ≥ ${formatUnits(need, 18).slice(0, 7)}</span>`}`],
      ["simulation", simErr ? `<span class=bad>REVERT: ${simErr}</span>` : `<span class=ok>eth_call OK${enough ? "" : " (balance overridden for the check)"}</span>`],
    ];
    $("sim").innerHTML = rows.map(([k, v]) => `<div class=row><span class=k>${k}</span><span class=v>${v}</span></div>`).join("");
    if (!simErr) { state.sim = { data, value, gas, predicted, creator, symbol: f.symbol, enough }; $("launch").disabled = !(state.account && enough && state.account.toLowerCase() === creator.toLowerCase()); }
    $("launchHint").textContent = !state.account ? "connect the wallet that owns the creator address to launch" : state.account.toLowerCase() !== creator.toLowerCase() ? "creator must be the connected wallet" : !enough ? "fund the wallet first" : simErr ? "" : "ready";
  } catch (e) { $("sim").innerHTML = `<div class=bad>${(e.shortMessage || e.message || String(e)).slice(0, 200)}</div>`; }
}

// ---------- launch ----------
async function launch() {
  if (!state.sim || !state.wallet || state.busy) return;
  const s = state.sim; state.busy = true; $("launch").disabled = true;
  try {
    await ensureChain();
    const signer = await state.wallet.getSigner();
    if ((await signer.getAddress()).toLowerCase() !== s.creator.toLowerCase()) throw new Error("connected account is not the creator address");
    const gasLimit = BigInt(Math.max(Math.ceil((s.gas || 3_300_000) * 1.25), 3_300_000));
    $("result").innerHTML = "<div class=dim>confirm in your wallet…</div>";
    const tx = await signer.sendTransaction({ to: MINARA.launcher, data: s.data, value: s.value, gasLimit });
    $("result").innerHTML = `<div>sent: <a href="${EXPLORER}/tx/${tx.hash}" target=_blank class=mono>${tx.hash}</a> — waiting for the receipt…</div>`;
    const rc = await tx.wait();
    const r = parseLaunchReceipt(rc, s.creator);
    if (!r.ok) { $("result").innerHTML = `<div class=bad>transaction reverted on-chain: <a href="${EXPLORER}/tx/${tx.hash}" target=_blank>${tx.hash}</a></div>`; return; }
    $("result").innerHTML = `<div class=ok><b>LAUNCHED ✓</b> block ${rc.blockNumber}</div>
      <div class=row><span class=k>token</span><span class=v><a href="${basedbotLink(r.token)}" target=_blank>${r.token}</a></span></div>
      <div class=row><span class=k>pool</span><span class=v class=mono>${r.poolId}</span></div>
      <div class=row><span class=k>you got</span><span class=v>${fmt(Number(r.bought) / 1e18, 0)} ${s.symbol} (${(Number(r.bought * 1_000_000n / SUPPLY) / 1e4).toFixed(2)}% of supply)</span></div>
      <div class=row><span class=k>tx</span><span class=v><a href="${EXPLORER}/tx/${tx.hash}" target=_blank class=mono>${tx.hash}</a></span></div>`;
    loadLaunches();
  } catch (e) { $("result").innerHTML = `<div class=bad>${decodeError(errorData(e)) !== "reverted without data (usually a malformed config)" && errorData(e) ? decodeError(errorData(e)) : (e.shortMessage || e.message || String(e)).slice(0, 240)}</div>`; }
  finally { state.busy = false; simulate(); }
}

// ---------- image ----------
async function pinFile(file) {
  if (!state.pinning) { toast("Pinning is off: run server.mjs with Pinata keys in .env, or paste an image URL.", true); return; }
  if (file.size > 5 * 1024 * 1024) { toast("image is larger than 5 MB", true); return; }
  $("pinStatus").textContent = "pinning…";
  try {
    const r = await fetch("/api/pin", { method: "POST", headers: { "content-type": file.type || "application/octet-stream", "x-filename": encodeURIComponent(file.name) }, body: file });
    const j = await r.json(); if (!r.ok) throw new Error(j.error || r.statusText);
    $("image").value = j.url; $("pinStatus").textContent = `pinned: ${j.cid}`; previewImage(); scheduleSim();
  } catch (e) { $("pinStatus").textContent = "failed: " + e.message; }
}
function previewImage() { const u = $("image").value.trim(); const img = $("preview"); img.hidden = !u; if (u) img.src = u.startsWith("ipfs://") ? "https://gateway.pinata.cloud/ipfs/" + u.slice(7) : u; }

// ---------- recent launches on Minara ----------
async function loadLaunches() {
  try {
    const head = Number(BigInt(await rpcSend("eth_blockNumber", [])));
    const from = Math.max(MINARA.deployBlock, head - 170_000), logs = [];   // ~24 hours
    const chunks = []; for (let a = from; a <= head; a += 10_000) chunks.push([a, Math.min(head, a + 9_999)]);
    // 3 chunks at a time: the public RPC starts answering 503 when hammered
    let i = 0; await Promise.all([0, 1, 2].map(async () => { while (i < chunks.length) { const [a, b] = chunks[i++]; try { logs.push(...await rpcSend("eth_getLogs", [{ address: MINARA.strategy, topics: [TOPICS.TokenLaunched], fromBlock: hx(a), toBlock: hx(b) }])); } catch {} } }));
    logs.sort((x, y) => Number(BigInt(y.blockNumber)) - Number(BigInt(x.blockNumber)));
    const rows = await Promise.all(logs.slice(0, 25).map(async l => {
      const token = "0x" + l.topics[2].slice(26); let sym = "?";
      try { sym = IFACE.erc20.decodeFunctionResult("symbol", await call(token, IFACE.erc20.encodeFunctionData("symbol")))[0]; } catch {}
      let fdv = null; try { const [sqrt] = IFACE.stateView.decodeFunctionResult("getSlot0", await call(STATE_VIEW, IFACE.stateView.encodeFunctionData("getSlot0", [l.topics[1]]))); fdv = 1e9 / (Number(sqrt) / 2 ** 96) ** 2; } catch {}
      return `<div class=row><span class=k>#${Number(BigInt(l.blockNumber))}</span><span class=v><a href="${basedbotLink(token)}" target=_blank>${sym}</a> <span class=mono>${short(token)}</span>${fdv ? ` · FDV ${usd(fdv)}` : ""} · <a href="${EXPLORER}/tx/${l.transactionHash}" target=_blank>tx</a></span></div>`;
    }));
    $("launches").innerHTML = rows.join("") || "<div class=dim>no launches in the last 24 hours</div>";
    $("launchCount").textContent = logs.length ? `${logs.length} in 24h` : "";
  } catch (e) { $("launches").innerHTML = `<div class=dim>could not load: ${e.message.slice(0, 80)}</div>`; }
}

// ---------- misc ----------
function toast(msg, bad) { const t = $("toast"); t.textContent = msg; t.className = bad ? "bad" : "ok"; t.hidden = false; setTimeout(() => (t.hidden = true), 5000); }

// ---------- boot ----------
$("rpcs").addEventListener("change", () => { setRpcs($("rpcs").value.split(",").map(s => s.trim()).filter(Boolean)); saveRpcs(state.rpcs); loadLive().then(simulate); loadLaunches(); });
$("connect").addEventListener("click", () => connect().catch(e => toast(e.shortMessage || e.message, true)));
$("launch").addEventListener("click", launch);
$("simulate").addEventListener("click", simulate);
for (const id of ["name", "symbol", "description", "image", "website", "buy", "creatorFee", "slippage", "creator"]) $(id).addEventListener("input", scheduleSim);
$("image").addEventListener("input", previewImage);
$("file").addEventListener("change", e => e.target.files[0] && pinFile(e.target.files[0]));
(async () => {
  try {
    const j = await (await fetch("/api/config")).json();
    state.pinning = Boolean(j.pinning); state.proxy = j.rpc ? new URL("/rpc", location.href).href : null;
    $("proxyInfo").textContent = j.rpc ? `reads go through the local server → ${(j.upstreams || []).join(", ")} (set ARC_RPC_URLS in .env to change)` : "";
  } catch { state.pinning = false; state.proxy = null; $("proxyInfo").textContent = "no local server: reads go straight to the RPCs below (they must allow browser CORS, e.g. Infura)"; }
  $("pinRow").hidden = !state.pinning;
  setRpcs(loadRpcs());
  await loadLive(); simulate(); loadLaunches();
})();
