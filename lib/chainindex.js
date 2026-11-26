// Our own index of trading activity, kept in Redis, so charts and trade lists never depend on a
// third-party indexer being up. It stores the raw logs of:
//   launchpad Trade + Graduated events, and Swap + Sync events of every nullswap pool.
// - Backfill once from Blockscout (fast), then follow the chain over the public RPC in 200-block
//   chunks (the most it allows), a few seconds at a time whenever someone asks for data.
// - A user's own trade is added straight from its transaction receipt (no waiting on anyone).
// Keys: ix:cur (last indexed block), ix:at (last sync time), ix:lock, ix:pairs (pair -> token),
//       ix:logs (logs already stored), ix:t:<token> (list of stored logs for that token).
const P = require("./points");
const X = require("./indexer");
const { ethers } = P;

const TOPIC = {
  trade: ethers.id("Trade(address,address,bool,uint256,uint256,uint256,uint256,uint256)"),
  graduated: ethers.id("Graduated(address,address,uint256,uint256,uint256,uint256)"),
  swap: ethers.id("Swap(address,uint256,uint256,uint256,uint256,address)"),
  sync: ethers.id("Sync(uint112,uint112)"),
};
const CHUNK = 200, PARALLEL = 8, THROTTLE_MS = 3000, LAG = 600;
const rpc = () => new ethers.JsonRpcProvider(P.TESTNET.rpc, undefined, { staticNetwork: true, batchMaxCount: 10 });

// Store logs: { address, topics, data, block, index, tx, ts }. Skips transactions already stored.
async function ingest(logs, pairs) {
  if (!logs.length) return 0;
  // Learn new pools first, so their logs in the same batch are recognised.
  const newPairs = [];
  for (const l of logs) if (l.address === P.TESTNET.launchpad && l.topics[0] === TOPIC.graduated) {
    const pair = X.topicAddr(l.topics[2]), token = X.topicAddr(l.topics[1]);
    if (!pairs[pair]) { pairs[pair] = token; newPairs.push(pair, token); }
  }
  if (newPairs.length) await P.redis(["HSET", "ix:pairs", ...newPairs]);
  const keep = logs.filter((l) => (l.address === P.TESTNET.launchpad && l.topics[0] === TOPIC.trade) || (pairs[l.address] && (l.topics[0] === TOPIC.swap || l.topics[0] === TOPIC.sync)));
  if (!keep.length) return 0;
  // One record per log (transaction + log index), however many times it is seen.
  const ids = keep.map((l) => l.tx + ":" + l.index), fresh = [];
  for (let i = 0; i < ids.length; i += 200) fresh.push(...(await P.redisMulti(ids.slice(i, i + 200).map((id) => ["SADD", "ix:logs", id]))));
  const cmds = [];
  for (const [n, l] of keep.entries()) {
    if (Number(fresh[n]) !== 1) continue;
    const token = l.address === P.TESTNET.launchpad ? X.topicAddr(l.topics[1]) : pairs[l.address];
    const k = l.address === P.TESTNET.launchpad ? "t" : l.topics[0] === TOPIC.swap ? "w" : "y";
    cmds.push(["RPUSH", `ix:t:${token}`, JSON.stringify({ k, b: l.block, i: l.index, h: l.tx, tp: l.topics, d: l.data, ts: l.ts })]);
  }
  for (let i = 0; i < cmds.length; i += 200) await P.redisMulti(cmds.slice(i, i + 200));
  return cmds.length;
}

const fromRpcLog = (l, ts) => ({ address: l.address.toLowerCase(), topics: l.topics, data: l.data, block: l.blockNumber, index: l.index, tx: l.transactionHash, ts });

async function backfill(provider, pairs) {
  const to = Math.max(X.DEPLOY_BLOCK, (await provider.getBlockNumber()) - LAG);
  const lp = P.TESTNET.launchpad;
  const [trades, grads] = await Promise.all([X.logs(lp, TOPIC.trade, null, to), X.logs(lp, TOPIC.graduated, null, to)]);
  const all = [...trades, ...grads].map((l) => ({ ...l, address: lp }));
  for (const g of grads) {
    const pair = X.topicAddr(g.topics[2]);
    const [sw, sy] = await Promise.all([X.logs(pair, TOPIC.swap, null, to), X.logs(pair, TOPIC.sync, null, to)]);
    all.push(...sw.map((l) => ({ ...l, address: pair })), ...sy.map((l) => ({ ...l, address: pair })));
  }
  all.sort((a, b) => a.block - b.block || a.index - b.index);
  await ingest(all, pairs);
  await P.redis(["SET", "ix:cur", String(to)]);
  return to;
}

const note = (m) => P.redis(["SET", "ix:err", new Date().toISOString() + " " + String(m).slice(0, 300), "EX", "86400"]).catch(() => {});

// Brings the index up to date, spending at most `budgetMs`. Safe to call on every request.
async function sync(budgetMs = 3500) {
  const start = Date.now();
  const [at, gotLock] = await P.redisMulti([["GET", "ix:at"], ["SET", "ix:lock", "1", "NX", "EX", "20"]]);
  if (gotLock !== "OK") return;
  try {
    if (at && Date.now() - Number(at) < THROTTLE_MS) return;
    await P.redis(["SET", "ix:at", String(Date.now())]);
    const provider = rpc();
    const pairs = P.pairs(await P.redis(["HGETALL", "ix:pairs"]));
    let cur = Math.max(0, Number(await P.redis(["GET", "ix:cur"])) || 0);
    if (!cur) {
      try { cur = await backfill(provider, pairs); }
      catch (e) { await note("backfill: " + (e.message || e)); cur = X.DEPLOY_BLOCK - 1; await P.redis(["SET", "ix:cur", String(cur)]); } // Blockscout down: walk from the start over RPC
    }
    let latest = await provider.getBlockNumber();
    await P.redis(["SET", "ix:head", String(latest)]);
    const tsCache = new Map();
    const tsOf = async (bn) => { if (!tsCache.has(bn)) tsCache.set(bn, provider.getBlock(bn).then((b) => b.timestamp)); return tsCache.get(bn); };
    while (cur < latest && Date.now() - start < budgetMs) {
      const ranges = [];
      for (let f = cur + 1; f <= latest && ranges.length < PARALLEL; f += CHUNK) ranges.push([f, Math.min(latest, f + CHUNK - 1)]);
      const addrs = [P.TESTNET.launchpad, ...Object.keys(pairs)];
      const res = await Promise.allSettled(ranges.map(([f, t]) => provider.getLogs({ address: addrs, fromBlock: f, toBlock: t })));
      let doneTo = cur;
      const got = [];
      for (let i = 0; i < res.length; i++) { if (res[i].status !== "fulfilled") break; got.push(...res[i].value); doneTo = ranges[i][1]; }
      if (doneTo === cur) { await note("rpc: " + String(res[0].reason && (res[0].reason.shortMessage || res[0].reason.message)).slice(0, 160)); break; } // the RPC refused; try again next time
      const logs = await Promise.all(got.map(async (l) => fromRpcLog(l, await tsOf(l.blockNumber))));
      logs.sort((a, b) => a.block - b.block || a.index - b.index);
      const before = Object.keys(pairs).length;
      await ingest(logs, pairs);
      // A pool born in this round: fetch its own logs for the rest of the round.
      if (Object.keys(pairs).length > before) {
        const newOnes = Object.keys(pairs).slice(before);
        const gradBlock = Math.min(...logs.filter((l) => l.topics[0] === TOPIC.graduated).map((l) => l.block));
        for (let f = gradBlock; f <= doneTo; f += CHUNK) {
          const extra = await provider.getLogs({ address: newOnes, fromBlock: f, toBlock: Math.min(doneTo, f + CHUNK - 1) });
          await ingest(await Promise.all(extra.map(async (l) => fromRpcLog(l, await tsOf(l.blockNumber)))), pairs);
        }
      }
      cur = doneTo;
      await P.redis(["SET", "ix:cur", String(cur)]);
      if (cur >= latest) { latest = await provider.getBlockNumber(); await P.redis(["SET", "ix:head", String(latest)]); }
    }
  } catch (e) {
    await note("sync: " + (e.message || e));
  } finally {
    await P.redis(["DEL", "ix:lock"]).catch(() => {});
  }
}

// Adds one transaction's logs straight from its receipt (right after a user's own trade).
async function ingestTx(hash) {
  const provider = rpc();
  const rc = await provider.getTransactionReceipt(hash);
  if (!rc || rc.status !== 1) return 0;
  const ts = (await provider.getBlock(rc.blockNumber)).timestamp;
  const pairs = P.pairs(await P.redis(["HGETALL", "ix:pairs"]));
  return ingest(rc.logs.map((l) => fromRpcLog(l, ts)), pairs);
}

// Stored history of one token, in the shape the app's chart code reads.
async function read(token) {
  const raw = (await P.redis(["LRANGE", `ix:t:${token.toLowerCase()}`, "0", "-1"])) || [];
  const seen = new Set(), out = { trade: [], swap: [], sync: [] };
  const recs = raw.map((r) => JSON.parse(r)).filter((r) => { const k = r.h + ":" + r.i; if (seen.has(k)) return false; seen.add(k); return true; });
  recs.sort((a, b) => a.b - b.b || a.i - b.i);
  for (const r of recs) (r.k === "t" ? out.trade : r.k === "w" ? out.swap : out.sync).push({ blockNumber: r.b, index: r.i, transactionHash: r.h, topics: r.tp, data: r.d, ts: r.ts });
  return out;
}

// True when the index is close enough to the chain head to be served (not still catching up).
async function current() {
  const [cur, head] = await P.redisMulti([["GET", "ix:cur"], ["GET", "ix:head"]]);
  return Boolean(cur && head && Number(head) - Number(cur) < 3000);
}

// Where the index stands (for monitoring): last indexed block, chain head, lag, last error.
async function status() {
  const [cur, head, at, lock, err, logs] = await P.redisMulti([["GET", "ix:cur"], ["GET", "ix:head"], ["GET", "ix:at"], ["GET", "ix:lock"], ["GET", "ix:err"], ["SCARD", "ix:logs"]]);
  return { cur: Number(cur) || null, head: Number(head) || null, lag: cur && head ? Number(head) - Number(cur) : null, lastSync: at ? new Date(Number(at)).toISOString() : null, busy: Boolean(lock), logs: Number(logs) || 0, lastError: err || null };
}

module.exports = { sync, ingestTx, read, current, status, TOPIC };
