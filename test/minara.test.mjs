import test from "node:test";
import assert from "node:assert/strict";
import { AbiCoder } from "../vendor/ethers.min.js";
import { MINARA, ZERO, SUPPLY, UNI_FACTORY, IFACE, TOPICS, encodeConfig, poolKeyOf, poolIdOf, buildLaunch, buyOutcome, parseLaunchReceipt, decodeError, graffitiOf } from "../minara.js";

const abi = AbiCoder.defaultAbiCoder();
const CREATOR = "0x00000000000000000000000000000000000000C1", TOKEN = "0xE21154189E630a656f6fC5e90A69570Cf5181614";
// Values read from strategy.curveFor(0x0) on 2026-09-15 and the traced opening buy.
const CURVE = { sqrtPriceX96: 38639190702208873927139873089154n, liquidity: BigInt("0x1b233cd59659708e6c79d") };

test("config is the 128-byte static layout the strategy decodes", () => {
  const cfg = encodeConfig({ creator: CREATOR, expectedTick: 123800, creatorFee: true });
  assert.equal((cfg.length - 2) / 2, 128);
  const [creator, quote, tick, fee] = abi.decode(["address", "address", "int24", "bool"], cfg);
  assert.equal(creator, CREATOR); assert.equal(quote, ZERO); assert.equal(Number(tick), 123800); assert.equal(fee, true);
  assert.throws(() => encodeConfig({ creator: ZERO, expectedTick: 123800, creatorFee: false }), /InvalidFeeBeneficiary/);
});

test("pool key and id match the on-chain pool of the simulated launch", () => {
  assert.deepEqual(poolKeyOf(TOKEN), { currency0: ZERO, currency1: TOKEN, fee: 0, tickSpacing: 25, hooks: MINARA.feeHook });
  assert.equal(poolIdOf(TOKEN), "0xe8fa62aaf5d8cd3287bbe0a80da4a2bdf30119c06a8e711f7e5b497ba5e7d817");
});

test("buildLaunch: createToken + distributeToken (+ opening buy), value is exactly fee + buy", () => {
  const { inner, value } = buildLaunch({ name: "Test Token", symbol: "TEST", image: "https://x/y.png", creator: CREATOR, predicted: TOKEN, expectedTick: 123800, creatorFee: true, launchFee: 10n ** 18n, buy: 200n * 10n ** 18n, minOut: 1n, deadline: 1_800_000_000 });
  assert.equal(inner.length, 3);
  assert.equal(value, 201n * 10n ** 18n);
  const create = IFACE.launcher.decodeFunctionData("createToken", inner[0]);
  assert.equal(create.factory.toLowerCase(), UNI_FACTORY); assert.equal(create.recipient.toLowerCase(), MINARA.launcher); assert.equal(create.supply, SUPPLY);
  const [md] = abi.decode(["tuple(string description,string website,string image,bytes extraData)"], create.tokenData);
  assert.equal(md.image, "https://x/y.png");
  const dist = IFACE.launcher.decodeFunctionData("distributeToken", inner[1]);
  assert.equal(dist.distribution.strategy.toLowerCase(), MINARA.strategy);
  assert.equal(dist.distribution.configData, encodeConfig({ creator: CREATOR, expectedTick: 123800, creatorFee: true }));
  const swap = IFACE.launcher.decodeFunctionData("distributeWithNative", inner[2]);
  assert.equal(swap.strategy.toLowerCase(), MINARA.urStrategy); assert.equal(swap.amount, 200n * 10n ** 18n);
  assert.equal(buildLaunch({ name: "A", symbol: "A", creator: CREATOR, predicted: TOKEN, expectedTick: 123800, creatorFee: false, launchFee: 10n ** 18n }).inner.length, 2);
});

test("buyOutcome reproduces the traced buy: 1 USDC at 0.7% hook fee -> ~236,126 tokens, opening FDV ~$4,204", () => {
  const r = buyOutcome({ ...CURVE, usdcIn: 1, hookFeeBps: 70 });
  assert.ok(Math.abs(r.tokens - 236126) < 300, `tokens ${r.tokens}`);
  assert.equal(Math.round(r.fdvBefore), 4204);
  const big = buyOutcome({ ...CURVE, usdcIn: 200, hookFeeBps: 100 });
  assert.ok(big.pctSupply > 4 && big.pctSupply < 6);
});

test("receipt parsing reads token, pool and the creator's tokens", () => {
  const pad = a => "0x" + a.slice(2).toLowerCase().padStart(64, "0"), POOL = "0x" + "cd".repeat(32);
  const rc = { status: 1, logs: [
    { address: MINARA.strategy, topics: [TOPICS.TokenLaunched, POOL, pad(TOKEN), pad(MINARA.strategy)], data: "0x" },
    { address: TOKEN, topics: [TOPICS.Transfer, pad("0x8366a39cc670b4001a1121b8f6a443a643e40951"), pad(CREATOR)], data: "0x" + (12_345_678n * 10n ** 18n).toString(16).padStart(64, "0") },
  ] };
  const r = parseLaunchReceipt(rc, CREATOR);
  assert.equal(r.ok, true); assert.equal(r.token, TOKEN.toLowerCase()); assert.equal(r.poolId, POOL); assert.equal(r.bought, 12_345_678n * 10n ** 18n);
});

test("custom errors decode to readable messages", () => {
  assert.equal(decodeError("0xe2f0a115" + "000000000000000000000000000000000000000000000000000000000001e398" + "000000000000000000000000000000000000000000000000000000000001dcc2"), "TickChanged(123800, 122050)");
  assert.match(decodeError("0x"), /without data/);
  assert.equal(graffitiOf(CREATOR).length, 66);
});
