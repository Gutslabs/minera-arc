// minara.js — Minara.fun launch on Arc mainnet: constants and pure builders.
// Runs unchanged in the browser (app.js) and in Node (tests). No keys, no network here.
//
// The call format was reverse-engineered on 2026-09-15 from Minara's mainnet contracts (no source published):
//   launcher.multicall([
//     createToken(UniswapUERC20Factory, name, symbol, 18, 1e27, launcher, metadata)   -> the 1 USDC launch fee is taken here
//     distributeToken(token, { strategy, 1e27, abi.encode(creator, quote=0x0, expectedTick, creatorFee) }, 0)
//     distributeWithNative(urStrategy, UniversalRouter V4_SWAP route, 0, buyAmount)   -> optional opening buy, snipe-tax exempt
//   ])  with msg.value == launchFee + buyAmount exactly.
import { AbiCoder, Interface, keccak256, id, getAddress } from "./vendor/ethers.min.js";

export const CHAIN_ID = 5042, CHAIN_ID_HEX = "0x13b2";
export const RPC_DEFAULTS = ["https://rpc.arc-scan.org"];   // only public Arc mainnet RPC that serves eth_call without a key (2026-09-15)
export const EXPLORER = "https://arc-scan.org";
export const ZERO = "0x0000000000000000000000000000000000000000";

export const MINARA = {
  launcher: "0xb6c6f77ee74af874a183bfd77dd0176d1ac91de6",     // fork of Uniswap LiquidityLauncher with launchFee()
  strategy: "0x29495fbfaee13f7d9779e1b10b25e338c10084d3",     // hooked launch strategy (single locked v4 position)
  feeHook: "0xc0fda29b6683ef1aa5376d5d7054ff773f5a20cc",      // v4 hook: platform + creator fee, 3-second snipe tax
  urStrategy: "0x3369f3bacd8e0625617368e292a21808dd4fb344",   // UniversalRouterStrategy bound to this launcher (opening buy)
  feeRecipient: "0x1df53ab8bd37ca3d58ab1e18412abfa2e72f48a1", // same wallet as platformRecipient() of Minara's official testnet hook
  deployBlock: 20925233,
};
export const UNI_FACTORY = "0xff99d8f6c994607576eb652edcf12e04a7ebfbf6";      // Uniswap UERC20Factory on Arc
export const UNIVERSAL_ROUTER = "0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1";
export const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
export const STATE_VIEW = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";
export const SUPPLY = 10n ** 27n, DECIMALS = 18, TICK_SPACING = 25, POOL_FEE = 0;
export const TOPICS = {
  TokenLaunched: "0x3b3d2bafdcae274a232217e1f80ee4305d3af6aa25c8b14b1681bd68d18042a4",
  Initialize: "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438",
  Swap: "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f",
  Transfer: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
};
const abi = AbiCoder.defaultAbiCoder();

export const IFACE = {
  launcher: new Interface([
    "function multicall(bytes[] data) payable returns (bytes[] results)",
    "function createToken(address factory,string name,string symbol,uint8 decimals,uint128 supply,address recipient,bytes tokenData) returns (address)",
    "function distributeToken(address token,(address strategy,uint128 amount,bytes configData) distribution,bytes32 salt)",
    "function distributeWithNative(address strategy,bytes configData,bytes32 salt,uint256 amount) payable",
    "function launchFee() view returns (uint256)",
    "function launchFeeRecipient() view returns (address)",
  ]),
  factory: new Interface(["function getUERC20Address(string name,string symbol,uint8 decimals,address recipient,bytes32 graffiti) view returns (address)"]),
  strategy: new Interface([
    "function quotes(address quote) view returns (bool enabled,int24 initialTick,int24 minTick)",
    "function curveFor(address quote) view returns (bool enabled,int24 initialTick,int24 minTick,uint160 sqrtPriceX96,uint128 liquidity)",
  ]),
  hook: new Interface(["function platformFeeBps() view returns (uint256)", "function creatorFeeBps() view returns (uint256)", "function creatorAccrued(bytes32 poolId) view returns (uint256)"]),
  stateView: new Interface(["function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)"]),
  erc20: new Interface(["function symbol() view returns (string)", "function name() view returns (string)", "function balanceOf(address) view returns (uint256)"]),
};

// Custom errors seen in the contracts (revert data -> readable message).
const ERROR_SIGS = ["TickChanged(int24,int24)", "QuoteNotEnabled(address)", "InvalidFeeBeneficiary(address)", "InvalidConfigData()", "OnlyLauncher()", "InvalidSupply()", "InvalidTokenDecimals()", "TokenAmountMismatch(uint256,uint256)", "PoolNotInitialized()", "PoolAlreadyInitialized()", "V4TooLittleReceived(uint256,uint256)", "ExecutionFailed(uint256,bytes)", "TransactionDeadlinePassed()", "ETHTransferFailed()", "AllowanceNotFullyConsumed()", "Error(string)", "Panic(uint256)"];
const ERRORS = new Map(ERROR_SIGS.map(s => [id(s).slice(0, 10), s]));
export function decodeError(data) {
  if (!data || data === "0x") return "reverted without data (usually a malformed config)";
  const sel = data.slice(0, 10).toLowerCase(), sig = ERRORS.get(sel);
  if (!sig) return `unknown error ${sel}`;
  const types = sig.slice(sig.indexOf("(") + 1, -1);
  try {
    const args = types ? abi.decode(types.split(","), "0x" + data.slice(10)) : [];
    if (sig.startsWith("ExecutionFailed")) return `ExecutionFailed(command ${args[0]}) -> ${decodeError(String(args[1]))}`;
    return `${sig.replace(/\(.*/, "")}(${args.map(String).join(", ")})`;
  } catch { return sig; }
}
/** Pull revert data out of an ethers/JSON-RPC error object. */
export function errorData(e) {
  return e?.data?.data || e?.data || e?.error?.data || e?.info?.error?.data || (typeof e?.message === "string" && (e.message.match(/0x[0-9a-f]{8,}/i) || [])[0]) || null;
}

export const graffitiOf = from => keccak256(abi.encode(["address"], [from]));
export const short = a => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "-");
export const basedbotLink = token => `https://basedbot.app/token/arc/${token.toLowerCase()}`;

/** 128-byte static strategy config: (creator, quote, expectedTick, creatorFee). Fewer bytes revert empty; extra bytes are ignored. */
export function encodeConfig({ creator, expectedTick, creatorFee, quote = ZERO }) {
  if (!creator || creator === ZERO) throw new Error("creator must not be the zero address (strategy reverts InvalidFeeBeneficiary)");
  return abi.encode(["address", "address", "int24", "bool"], [creator, quote, expectedTick, Boolean(creatorFee)]);
}
export const poolKeyOf = token => ({ currency0: ZERO, currency1: token, fee: POOL_FEE, tickSpacing: TICK_SPACING, hooks: MINARA.feeHook });
export const poolIdOf = token => { const k = poolKeyOf(token); return keccak256(abi.encode(["tuple(address,address,uint24,int24,address)"], [[k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]])); };

/** Opening buy: UniversalRouterStrategy config {router, recipient, route}; route = UR V4_SWAP [SWAP_EXACT_IN_SINGLE, SETTLE, TAKE]. */
export function buyRoute({ token, amountIn, amountOutMinimum = 0n, recipient, deadline }) {
  const swap = abi.encode(["tuple(tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)"], [{ poolKey: poolKeyOf(token), zeroForOne: true, amountIn, amountOutMinimum, hookData: "0x" }]);
  const settle = abi.encode(["address", "uint256", "bool"], [ZERO, 0n, false]);        // OPEN_DELTA, router pays from msg.value
  const take = abi.encode(["address", "address", "uint256"], [token, recipient, 0n]);    // OPEN_DELTA -> recipient
  const v4 = abi.encode(["bytes", "bytes[]"], ["0x060b0e", [swap, settle, take]]);
  const route = abi.encode(["bytes", "bytes[]", "uint256"], ["0x10", [v4], BigInt(deadline)]);
  return abi.encode(["tuple(address router,address recipient,bytes route)"], [{ router: UNIVERSAL_ROUTER, recipient, route }]);
}

/** Full launch calldata. buy is native USDC in wei (18 decimals); 0 = no opening buy. */
export function buildLaunch({ name, symbol, description = "", website = "", image = "", creator, predicted, expectedTick, creatorFee, launchFee, buy = 0n, minOut = 0n, deadline }) {
  const metadata = abi.encode(["tuple(string description,string website,string image,bytes extraData)"], [{ description, website, image, extraData: "0x" }]);
  const inner = [
    IFACE.launcher.encodeFunctionData("createToken", [UNI_FACTORY, name, symbol, DECIMALS, SUPPLY, MINARA.launcher, metadata]),
    IFACE.launcher.encodeFunctionData("distributeToken", [predicted, { strategy: MINARA.strategy, amount: SUPPLY, configData: encodeConfig({ creator, expectedTick, creatorFee }) }, "0x" + "0".repeat(64)]),
  ];
  if (buy > 0n) inner.push(IFACE.launcher.encodeFunctionData("distributeWithNative", [MINARA.urStrategy, buyRoute({ token: predicted, amountIn: buy, amountOutMinimum: minOut, recipient: creator, deadline }), "0x" + "0".repeat(64), buy]));
  return { inner, data: IFACE.launcher.encodeFunctionData("multicall", [inner]), value: BigInt(launchFee) + buy };
}

/** Expected result of the opening buy on the single-position curve. The hook fee is taken from the USDC leg before the swap; pool fee is 0. */
export function buyOutcome({ sqrtPriceX96, liquidity, usdcIn, hookFeeBps }) {
  const L = BigInt(liquidity), sqrtP = BigInt(sqrtPriceX96);
  const amountIn = BigInt(Math.round(Number(usdcIn) * 1e6)) * 10n ** 12n * (10_000n - BigInt(hookFeeBps)) / 10_000n;
  const num1 = L << 96n, product = amountIn * sqrtP;
  const sqrtAfter = amountIn === 0n ? sqrtP : (num1 * sqrtP + (num1 + product) - 1n) / (num1 + product);
  const tokensOut = L * (sqrtP - sqrtAfter) / (1n << 96n);
  const fdv = s => 1e9 / (Number(s) / 2 ** 96) ** 2;
  return { tokensOut, tokens: Number(tokensOut) / 1e18, pctSupply: Number(tokensOut * 1_000_000n / SUPPLY) / 1e4, fdvBefore: fdv(sqrtP), fdvAfter: fdv(sqrtAfter), pricePerUsdc: (Number(sqrtP) / 2 ** 96) ** 2, hookFeeUsdc: Number(usdcIn) * Number(hookFeeBps) / 10_000 };
}

/** Receipt (raw JSON-RPC or ethers) -> { ok, token, poolId, bought }. */
export function parseLaunchReceipt(rc, creator) {
  const logs = rc.logs || [], find = t => logs.find(l => l.topics[0] === t);
  const launched = find(TOPICS.TokenLaunched), init = find(TOPICS.Initialize);
  const token = launched ? "0x" + launched.topics[2].slice(26) : init ? "0x" + init.topics[3].slice(26) : null;
  const c = (creator || "").toLowerCase();
  const bought = logs.filter(l => token && l.address.toLowerCase() === token && l.topics[0] === TOPICS.Transfer && l.topics[2] && "0x" + l.topics[2].slice(26) === c).reduce((s, l) => s + BigInt(l.data), 0n);
  return { ok: Number(rc.status) === 1, token, poolId: launched ? launched.topics[1] : init ? init.topics[1] : null, bought };
}

/** Live parameters. call(to, data) -> hex; works with any provider. */
export async function readLive(call) {
  const [fee, quotes, curve, platformBps, creatorBps] = await Promise.all([
    call(MINARA.launcher, IFACE.launcher.encodeFunctionData("launchFee")).then(r => BigInt(r)),
    call(MINARA.strategy, IFACE.strategy.encodeFunctionData("quotes", [ZERO])).then(r => IFACE.strategy.decodeFunctionResult("quotes", r)),
    call(MINARA.strategy, IFACE.strategy.encodeFunctionData("curveFor", [ZERO])).then(r => IFACE.strategy.decodeFunctionResult("curveFor", r)),
    call(MINARA.feeHook, IFACE.hook.encodeFunctionData("platformFeeBps")).then(r => Number(BigInt(r))),
    call(MINARA.feeHook, IFACE.hook.encodeFunctionData("creatorFeeBps")).then(r => Number(BigInt(r))),
  ]);
  return { launchFee: fee, quoteEnabled: quotes.enabled, expectedTick: Number(quotes.initialTick), sqrtPriceX96: BigInt(curve.sqrtPriceX96), liquidity: BigInt(curve.liquidity), platformBps, creatorBps };
}
export async function predictToken(call, { name, symbol, creator }) {
  const r = await call(UNI_FACTORY, IFACE.factory.encodeFunctionData("getUERC20Address", [name, symbol, DECIMALS, MINARA.launcher, graffitiOf(creator)]));
  return getAddress("0x" + r.slice(-40));
}
