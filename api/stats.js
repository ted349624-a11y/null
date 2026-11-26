// GET /api/stats — testnet activity for the home page: totals, per-token activity and the latest trades.
// Built from the launchpad's events (plus nullswap pool events for graduated tokens), kept in Redis and
// recomputed at most every 30 seconds.
const P = require("../lib/points");
const X = require("../lib/indexer");
const { ethers } = P;

const T = {
  launched: ethers.id("TokenLaunched(address,address,string,string,uint16)"),
  trade: ethers.id("Trade(address,address,bool,uint256,uint256,uint256,uint256,uint256)"),
  graduated: ethers.id("Graduated(address,address,uint256,uint256,uint256,uint256)"),
  swap: ethers.id("Swap(address,uint256,uint256,uint256,uint256,address)"),
  sync: ethers.id("Sync(uint112,uint112)"),
};
const coder = ethers.AbiCoder.defaultAbiCoder();
const FRESH_MS = 30000;
const eth = (wei) => Number(ethers.formatEther(wei));

async function token0Of(pair) {
  const rp = new ethers.JsonRpcProvider(P.TESTNET.rpc, undefined, { staticNetwork: true });
  return (await new ethers.Contract(pair, ["function token0() view returns (address)"], rp).token0()).toLowerCase();
}

async function compute() {
  const [launchLogs, tradeLogs, gradLogs] = await Promise.all([
    X.logs(P.TESTNET.launchpad, T.launched), X.logs(P.TESTNET.launchpad, T.trade), X.logs(P.TESTNET.launchpad, T.graduated),
  ]);
  const now = Math.floor(Date.now() / 1000), day = now - 86400;
  const tokens = {}; // per token
  const get = (t) => (tokens[t] ||= { sym: "", trades: 0, vol: 0, vol24: 0, last: 0, traders: new Set(), spark: [] });
  for (const l of launchLogs) {
    const t = X.topicAddr(l.topics[1]);
    const [, symbol] = coder.decode(["string", "string", "uint16"], l.data);
    Object.assign(get(t), { sym: String(symbol), creator: X.topicAddr(l.topics[2]), born: l.ts });
  }
  const trades = []; // { t, buy, eth, ts, trader, block, index }
  for (const l of tradeLogs) {
    const t = X.topicAddr(l.topics[1]);
    const [isBuy, nativeAmount, , , vN, vT] = coder.decode(["bool", "uint256", "uint256", "uint256", "uint256", "uint256"], l.data);
    trades.push({ t, buy: isBuy, eth: eth(nativeAmount), ts: l.ts, trader: X.topicAddr(l.topics[2]), price: vT > 0n ? eth(vN) / eth(vT) : 0, block: l.block, index: l.index });
  }
  // Graduated tokens keep trading in their nullswap pool.
  const pairs = gradLogs.map((l) => ({ t: X.topicAddr(l.topics[1]), pair: X.topicAddr(l.topics[2]) }));
  await Promise.all(pairs.map(async ({ t, pair }) => {
    try {
      const [w0, swaps, syncs] = await Promise.all([token0Of(pair).then((a) => a === P.TESTNET.weth), X.logs(pair, T.swap), X.logs(pair, T.sync)]);
      const priceAt = new Map(); // tx -> price after the swap (from the Sync in the same tx)
      for (const s of syncs) { const [r0, r1] = coder.decode(["uint112", "uint112"], s.data); const rw = eth(w0 ? r0 : r1), rt = eth(w0 ? r1 : r0); if (rt > 0) priceAt.set(s.tx, rw / rt); }
      for (const s of swaps) {
        const [a0in, a1in, a0out, a1out] = coder.decode(["uint256", "uint256", "uint256", "uint256"], s.data);
        const wIn = w0 ? a0in : a1in, wOut = w0 ? a0out : a1out, buy = wIn > 0n;
        trades.push({ t, buy, eth: eth(buy ? wIn : wOut), ts: s.ts, trader: buy ? X.topicAddr(s.topics[2]) : "", price: priceAt.get(s.tx) || 0, block: s.block, index: s.index, pool: true });
      }
    } catch { /* a pool we can't read just doesn't add activity */ }
  }));
  trades.sort((a, b) => a.block - b.block || a.index - b.index);
  const wallets = new Set(launchLogs.map((l) => X.topicAddr(l.topics[2])));
  let trades24 = 0, volume24 = 0;
  for (const x of trades) {
    const k = get(x.t);
    k.trades++; k.vol += x.eth; k.last = Math.max(k.last, x.ts);
    if (x.trader) { k.traders.add(x.trader); wallets.add(x.trader); }
    if (x.price) k.spark.push(x.price);
    if (x.ts >= day) { k.vol24 += x.eth; trades24++; volume24 += x.eth; }
  }
  const out = {};
  for (const [t, k] of Object.entries(tokens)) {
    out[t] = { sym: k.sym, creator: k.creator, born: k.born, trades: k.trades, vol: +k.vol.toFixed(6), vol24: +k.vol24.toFixed(6), last: k.last, traders: k.traders.size, spark: k.spark.slice(-30).map((p) => +p.toPrecision(5)) };
  }
  const recent = trades.slice(-24).reverse().map((x) => ({ t: x.t, sym: tokens[x.t]?.sym || "", buy: x.buy, eth: +x.eth.toPrecision(4), ts: x.ts }));
  return {
    totals: { tokens: launchLogs.length, launched24: launchLogs.filter((l) => l.ts >= day).length, graduated: gradLogs.length, trades24, volume24: +volume24.toFixed(4), wallets: wallets.size },
    tokens: out, recent, at: Date.now(),
  };
}

// Kept in this instance's memory; Redis only holds a backup (written every 5 minutes) for when the
// indexer is down on a cold start. Keeps database commands low.
let memResult = null, savedAt = 0;
module.exports = P.handler(async (req, res) => {
  let result = memResult;
  if (!result || Date.now() - result.at > FRESH_MS) {
    try {
      result = await compute();
      if (Date.now() - savedAt > 5 * 60000) { savedAt = Date.now(); P.redis(["SET", "statsResult", JSON.stringify(result), "EX", "86400"]).catch(() => {}); }
    } catch (e) {
      if (!result) { try { result = JSON.parse((await P.redis(["GET", "statsResult"])) || "null"); } catch {} }
      if (!result) throw P.fail(502, "Activity is unavailable right now.");
    }
  }
  memResult = result;
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "public, s-maxage=20, stale-while-revalidate=60");
  res.end(JSON.stringify(result));
});
