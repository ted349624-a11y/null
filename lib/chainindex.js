// Our own index of trading activity, kept in Redis, so charts and trade lists never depend on a
// third-party indexer being up. It stores the raw logs of:
//   launchpad Trade + Graduated events, and Swap + Sync events of every nullswap pool.
// - Backfill once from Blockscout (fast), then follow the chain over the public RPC in 200-block
//   chunks (the most it allows), a few seconds at a time whenever someone asks for data.
// - A user's own trade is added straight from its transaction receipt (no waiting on anyone).
// Keys: ix:state (cur/head/ms/ver), ix:lock (also the 30s throttle), ix:pairs (pair -> token),
//       ix:t:<token> (list of stored logs for that token).
const P = require("./points");
const X = require("./indexer");
const { ethers } = P;

const TOPIC = {
  trade: ethers.id("Trade(address,address,bool,uint256,uint256,uint256,uint256,uint256)"),
  graduated: ethers.id("Graduated(address,address,uint256,uint256,uint256,uint256)"),
  swap: ethers.id("Swap(address,uint256,uint256,uint256,uint256,address)"),
  sync: ethers.id("Sync(uint112,uint112)"),
};
const CHUNK = 200, PARALLEL = 8, LAG = 600, THROTTLE_S = Number(process.env.INDEX_THROTTLE_S || 60);
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
  // One RPUSH per token for the whole batch (Redis counts commands, not values). A log seen twice
  // (a reported trade the follower meets again) is dropped when read.
  const byToken = new Map();
  for (const l of keep) {
    const token = l.address === P.TESTNET.launchpad ? X.topicAddr(l.topics[1]) : pairs[l.address];
    const k = l.address === P.TESTNET.launchpad ? "t" : l.topics[0] === TOPIC.swap ? "w" : "y";
    if (!byToken.has(token)) byToken.set(token, []);
    byToken.get(token).push(JSON.stringify({ k, b: l.block, i: l.index, h: l.tx, tp: l.topics, d: l.data, ts: l.ts }));
  }
  const cmds = [...byToken].map(([token, vals]) => ["RPUSH", `ix:t:${token}`, ...vals]);
  for (let i = 0; i < cmds.length; i += 50) await P.redisMulti(cmds.slice(i, i + 50));
  return keep.length;
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
  await saveState({ cur: to, head: to + LAG, ms: Date.now() }, true);
  return to;
}

const note = (m) => P.redis(["SET", "ix:err", new Date().toISOString() + " " + String(m).slice(0, 300), "EX", "86400"]).catch(() => {});

// ---- shared state, kept small on purpose (the free Redis plan allows 500K commands a month) ----
// ix:state hash: cur (last indexed block), head (chain head then), ms (when), ver (bumped on every write).
// Each server instance keeps a copy in memory for STATE_MS and caches token histories until ver changes.
const STATE_MS = Math.min(20000, THROTTLE_S * 1000), PERSIST_IDLE_MS = 5 * 60000;
const memo = { state: null, stateAt: 0, tokens: new Map(), persistedAt: 0 };
async function getState(force) {
  if (!force && memo.state && Date.now() - memo.stateAt < STATE_MS) return memo.state;
  const h = P.pairs(await P.redis(["HGETALL", "ix:state"]));
  memo.state = { cur: Number(h.cur) || 0, head: Number(h.head) || 0, ms: Number(h.ms) || 0, ver: Number(h.ver) || 0 };
  memo.stateAt = Date.now();
  return memo.state;
}
async function saveState(fields, bump) {
  const cmds = [["HSET", "ix:state", ...Object.entries(fields).flat().map(String)]];
  if (bump) cmds.push(["HINCRBY", "ix:state", "ver", "1"]);
  await P.redisMulti(cmds);
  memo.stateAt = 0; memo.persistedAt = Date.now();
}

// Brings the index up to date, spending at most `budgetMs`. Cheap to call on every request: at most one
// instance syncs per THROTTLE window (the lock's lifetime is the throttle), everyone else returns at once.
async function sync(budgetMs = 3500) {
  if (memo.skipUntil && Date.now() < memo.skipUntil) return; // this instance checked very recently
  memo.skipUntil = Date.now() + Math.min(25000, THROTTLE_S * 1000);
  if ((await P.redis(["SET", "ix:lock", "1", "NX", "EX", String(THROTTLE_S)])) !== "OK") return;
  const start = Date.now();
  try {
    const provider = rpc();
    const pairs = P.pairs(await P.redis(["HGETALL", "ix:pairs"]));
    let { cur } = await getState(true);
    if (!cur) {
      try { cur = await backfill(provider, pairs); }
      catch (e) { await note("backfill: " + (e.message || e)); cur = X.DEPLOY_BLOCK - 1; } // Blockscout down: walk from the start over RPC
    }
    let latest = await provider.getBlockNumber(), wrote = false;
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
      if (doneTo === cur) { await note("rpc: " + String(res[0].reason && (res[0].reason.shortMessage || res[0].reason.message)).slice(0, 160)); break; }
      const logs = await Promise.all(got.map(async (l) => fromRpcLog(l, await tsOf(l.blockNumber))));
      logs.sort((a, b) => a.block - b.block || a.index - b.index);
      const before = Object.keys(pairs).length;
      if (await ingest(logs, pairs)) wrote = true;
      if (Object.keys(pairs).length > before) { // a pool born in this round: fetch its own logs for the rest of the round
        const newOnes = Object.keys(pairs).slice(before);
        const gradBlock = Math.min(...logs.filter((l) => l.topics[0] === TOPIC.graduated).map((l) => l.block));
        for (let f = gradBlock; f <= doneTo; f += CHUNK) {
          const extra = await provider.getLogs({ address: newOnes, fromBlock: f, toBlock: Math.min(doneTo, f + CHUNK - 1) });
          if (await ingest(await Promise.all(extra.map(async (l) => fromRpcLog(l, await tsOf(l.blockNumber)))), pairs)) wrote = true;
        }
      }
      cur = doneTo;
      if (cur >= latest) latest = await provider.getBlockNumber();
    }
    // Save progress: right away if anything was stored or we're still catching up, otherwise once a minute.
    const behind = latest - cur > 3000;
    if (wrote || behind || Date.now() - memo.persistedAt > PERSIST_IDLE_MS || !(await getState()).cur) await saveState({ cur, head: latest, ms: Date.now() }, wrote);
  } catch (e) {
    await note("sync: " + (e.message || e));
  }
}

// Adds one transaction's logs straight from its receipt (right after a user's own trade).
async function ingestTx(hash) {
  const provider = rpc();
  const rc = await provider.getTransactionReceipt(hash);
  if (!rc || rc.status !== 1) return 0;
  const ts = (await provider.getBlock(rc.blockNumber)).timestamp;
  const pairs = P.pairs(await P.redis(["HGETALL", "ix:pairs"]));
  const n = await ingest(rc.logs.map((l) => fromRpcLog(l, ts)), pairs);
  if (n) { await P.redis(["HINCRBY", "ix:state", "ver", "1"]); memo.stateAt = 0; }
  return n;
}

// True when the index is close enough to the chain head to be served (not still catching up or stalled).
async function current() {
  const s = await getState();
  return Boolean(s.cur && s.head && s.head - s.cur < 3000 && Date.now() - s.ms < 15 * 60000);
}

// Stored history of one token, in the shape the app's chart code reads. Cached until the index changes.
async function read(token) {
  const t = token.toLowerCase(), s = await getState();
  const hit = memo.tokens.get(t);
  if (hit && hit.ver === s.ver) return hit.data;
  const raw = (await P.redis(["LRANGE", `ix:t:${t}`, "0", "-1"])) || [];
  const seen = new Set(), out = { trade: [], swap: [], sync: [] };
  const recs = raw.map((r) => JSON.parse(r)).filter((r) => { const k = r.h + ":" + r.i; if (seen.has(k)) return false; seen.add(k); return true; });
  recs.sort((a, b) => a.b - b.b || a.i - b.i);
  for (const r of recs) (r.k === "t" ? out.trade : r.k === "w" ? out.swap : out.sync).push({ blockNumber: r.b, index: r.i, transactionHash: r.h, topics: r.tp, data: r.d, ts: r.ts });
  memo.tokens.set(t, { ver: s.ver, data: out });
  if (memo.tokens.size > 300) memo.tokens.delete(memo.tokens.keys().next().value);
  return out;
}

// Where the index stands (for monitoring).
async function status() {
  const [st, lock, err] = await P.redisMulti([["HGETALL", "ix:state"], ["TTL", "ix:lock"], ["GET", "ix:err"]]);
  const h = P.pairs(st);
  return { cur: Number(h.cur) || null, head: Number(h.head) || null, lag: h.cur && h.head ? Number(h.head) - Number(h.cur) : null, saved: h.ms ? new Date(Number(h.ms)).toISOString() : null, version: Number(h.ver) || 0, nextSyncIn: Number(lock) > 0 ? Number(lock) : 0, lastError: err || null };
}

module.exports = { sync, ingestTx, read, current, status, TOPIC };
