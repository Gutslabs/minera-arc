# minera-arc

Launch a token on **Minara.fun** on **Arc mainnet (chain 5042)** straight from your wallet — name, ticker, image, description, opening buy, creator fee — in one transaction, without waiting for the minara.fun site to open mainnet.

Unofficial. Not affiliated with Minara, Circle, Arc or Uniswap. It talks to Minara's public, permissionless contracts on Arc mainnet exactly the way their own app does on testnet.

## Quick start

```bash
git clone https://github.com/Gutslabs/minera-arc && cd minera-arc
node server.mjs          # http://127.0.0.1:8788  (Node 22+, zero dependencies)
```

1. Connect a wallet (MetaMask / Rabby). The app adds Arc mainnet if it is missing.
2. Fill in name, ticker, description, image URL. Set the opening buy (USDC) and whether the creator fee is on.
3. **Simulate** — the app builds the real calldata, predicts the token address, and runs `eth_call` against the chain. It shows the exact USDC you pay, the tokens you get, and any revert reason.
4. **Launch** — your wallet signs one transaction. The receipt shows the token, pool and what you received.

The page is static (`index.html` + `app.js` + `minara.js`); `server.mjs` adds the RPC proxy and the optional image upload.

### Image upload (optional)

Copy `.env.example` to `.env` and put a Pinata JWT (or key + secret) in it. The server then exposes `POST /api/pin` for the upload button. The server binds to `127.0.0.1` because that endpoint spends your Pinata quota. Without keys, paste any `https://` or `ipfs://` image URL.

### RPC

Public Arc RPCs refuse browser (CORS) requests, so the page reads the chain through the local server's `/rpc` proxy. By default it forwards to `https://rpc.arc-scan.org` (the only keyless public RPC that serves `eth_call`; slow and rate-limited). Put your own RPC(s) in `.env` as `ARC_RPC_URLS=` — the key stays on the server, the page only sees the hostname. If you host the page without the server, add a CORS-enabled RPC (e.g. Infura) under **Settings**; that list lives in your browser's localStorage only.

## What the launch transaction does

One `multicall` on Minara's launcher (`0xb6c6f77ee74af874a183bfd77dd0176d1ac91de6`):

| step | call | effect |
|---|---|---|
| 1 | `createToken(UniswapUERC20Factory, name, ticker, 18, 1e27, launcher, metadata)` | mints 1,000,000,000 tokens to the launcher; the **1 USDC launch fee** is forwarded to Minara here |
| 2 | `distributeToken(token, {strategy, 1e27, config}, 0)` | the strategy (`0x29495fbf…84d3`) opens a Uniswap v4 pool (native USDC / token, fee 0, Minara fee hook `0xc0fda29b…20cc`), puts the whole supply in one locked position, registers you as creator |
| 3 | `distributeWithNative(urStrategy, V4_SWAP route, 0, amount)` | optional opening buy through the UniversalRouter; **exempt from the snipe tax** |

`msg.value` must equal `launchFee + openingBuy` exactly. Config is `abi.encode(creator, quote = 0x0, expectedTick, creatorFee)`; `expectedTick` is read live from `strategy.quotes(0x0)` so a changed curve reverts with `TickChanged` instead of launching at a surprise price.

Economics as of 2026-09-15 (all read live by the app):
- opening price ≈ 237,800 tokens per USDC → FDV ≈ $4,200; single-sided curve, liquidity **locked forever**
- swap fee inside the pool: 0.70% to Minara + 0.30% to the creator when the creator fee is on (claimable from the hook)
- buys in the first 3 seconds pay a snipe tax of up to 99% — your own opening buy in the launch tx does not
- description and image are written into the token metadata and **cannot be edited later**

## Verify it yourself

Everything the app assumes can be checked with plain JSON-RPC (any Arc mainnet node):

```
eth_call  to 0xb6c6f77ee74af874a183bfd77dd0176d1ac91de6 data 0xcf3cf573   # launchFee() = 1e18
eth_call  to 0xb6c6f77ee74af874a183bfd77dd0176d1ac91de6 data 0xbdac5f5f   # launchFeeRecipient() = 0x1df53ab8…48a1
eth_call  to 0x29495fbfaee13f7d9779e1b10b25e338c10084d3 data 0x16eebd1e   # strategy.launcher()
eth_call  to 0x29495fbfaee13f7d9779e1b10b25e338c10084d3 data 0xf11f4461   # strategy.feeHook()
eth_getLogs address 0x29495fbfaee13f7d9779e1b10b25e338c10084d3 topics [0x3b3d2baf…8042a4]   # every launch (TokenLaunched)
```

`0x1df53ab8…48a1` is also `platformRecipient()` of the fee hook listed in Minara's own registry (`https://api.minara.fun/minara-fun/contracts?chainId=5042002`) — the same platform wallet on testnet and mainnet.

## Safety

- Your private key never leaves your wallet; this code only builds calldata and asks the wallet to sign.
- Simulate first. The app refuses to enable **Launch** until `eth_call` passes and the wallet has the funds.
- Use a fresh wallet for launches. Tokens you buy at launch are visible on-chain as the creator's.
- `.env` (Pinata keys) is git-ignored. Never commit it.

## Development

```bash
npm test          # pure builders: config layout, calldata, curve math, receipt parsing
```

`vendor/ethers.min.js` is ethers v6 (MIT, see `vendor/LICENSE-ethers.md`), vendored so the same `minara.js` runs in the browser and in Node without a bundler.

## License

MIT © Gutslabs
