// Our own index of trading activity, kept in Redis, so charts, trade lists and the homepage numbers
// never depend on a third-party indexer being up, and never re-read the whole history.
//
// It follows: launchpad TokenLaunched / Trade / Graduated events, and Swap / Sync of every nullswap pool.
// - Backfill once from Blockscout (fast), then follow the chain over the public RPC in 200-block chunks
//   (the most it allows), at most once a minute, whenever someone asks for data.
// - A user's own trade is added straight from its transaction receipt (no waiting on anyone).
// - While storing, it keeps running summaries up to date, so reading them is a handful of commands:
//     K+"t:"<token>  raw logs for that token's chart (list)        K+"a:"<token>  per-token summary (JSON)
//     K+"hours"      hourly trades / volume / launches (hash)      K+"wallets"    traders + creators (HyperLogLog)
//     K+"recent"     latest trades for the ticker (list)           K+"last" / K+"mcap"  rankings (sorted sets)
//     K+"pairs"      pool -> "token|wethIsToken0" (hash)            K+"state"      cursor (hash), K+"lock" throttle
// Redis bills per command (free plan: 500K a month), so every batch writes a fixed handful of commands.
const P = require("./points");
const X = require("./indexer");
const { ethers } = P;

const K = "ix2:"; // bump to rebuild the index from scratch
const TOPIC = {
  launched: ethers.id("TokenLaunched(address,address,string,string,uint16)"),
  trade: ethers.id("Trade(address,address,bool,uint256,uint256,uint256,uint256,uint256)"),
  graduated: ethers.id("Graduated(address,address,uint256,uint256,uint256,uint256)"),
  swap: ethers.id("Swap(address,uint256,uint256,uint256,uint256,address)"),
  sync: ethers.id("Sync(uint112,uint112)"),
};
const CHUNK = 200, PARALLEL = 8, LAG = 600, THROTTLE_S = Number(process.env.INDEX_THROTTLE_S || 60);
const MAX_TRADERS = 300, SPARK = 30, RECENT = 50;
const coder = ethers.AbiCoder.defaultAbiCoder();
const eth = (wei) => Number(ethers.formatEther(wei));
const rpc = () => new ethers.JsonRpcProvider(P.TESTNET.rpc, undefined, { staticNetwork: true, batchMaxCount: 10 });
const loadPairs = async () => { const h = P.pairs(await P.redis(["HGETALL", K + "pairs"])); const o = {}; for (const [pair, v] of Object.entries(h)) { const [token, w0] = v.split("|"); o[pair] = { token, w0: w0 === "1" }; } return o; };
const blankAgg = () => ({ sym: "", creator: "", born: 0, trades: 0, vol: 0, last: 0, price: 0, tr: [], capped: 0, spark: [], grad: 0 });

// Store a batch of logs ({ address, topics, data, block, index, tx, ts }, oldest first) and update summaries.
async function ingest(logs, pairs, provider) {
  if (!logs.length) return 0;
  const lp = P.TESTNET.launchpad;
  // Learn new pools first, so their logs in the same batch are recognised.
  const newPairs = [];
  for (const l of logs) if (l.address === lp && l.topics[0] === TOPIC.graduated) {
    const pair = X.topicAddr(l.topics[2]), token = X.topicAddr(l.topics[1]);
    if (pairs[pair]) continue;
    let w0 = true;
    try { w0 = (await new ethers.Contract(pair, ["function token0() view returns (address)"], provider).token0()).toLowerCase() === P.TESTNET.weth; } catch {}
    pairs[pair] = { token, w0 }; newPairs.push(pair, `${token}|${w0 ? 1 : 0}`);
  }
  const cmds = [];
  if (newPairs.length) cmds.push(["HSET", K + "pairs", ...newPairs]);

  // 1) Raw logs per token, for charts and trade lists: one RPUSH per token.
  const byToken = new Map();
  const isPool = (l) => pairs[l.address] && (l.topics[0] === TOPIC.swap || l.topics[0] === TOPIC.sync);
  for (const l of logs) {
    const trade = l.address === lp && l.topics[0] === TOPIC.trade;
    if (!trade && !isPool(l)) continue;
    const token = trade ? X.topicAddr(l.topics[1]) : pairs[l.address].token;
    if (!byToken.has(token)) byToken.set(token, []);
    byToken.get(token).push(JSON.stringify({ k: trade ? "t" : l.topics[0] === TOPIC.swap ? "w" : "y", b: l.block, i: l.index, h: l.tx, tp: l.topics, d: l.data, ts: l.ts }));
  }
  for (const [token, vals] of byToken) cmds.push(["RPUSH", `${K}t:${token}`, ...vals]);

  // 2) Activity, decoded.
  const launches = [], trades = [], grads = [], poolPrice = new Map();
  for (const l of logs) if (isPool(l) && l.topics[0] === TOPIC.sync) {
    const [r0, r1] = coder.decode(["uint112", "uint112"], l.data), w0 = pairs[l.address].w0;
    const rw = eth(w0 ? r0 : r1), rt = eth(w0 ? r1 : r0);
    if (rt > 0) poolPrice.set(l.tx, rw / rt);
  }
  for (const l of logs) {
    if (l.address === lp && l.topics[0] === TOPIC.launched) {
      const [, symbol] = coder.decode(["string", "string", "uint16"], l.data);
      launches.push({ t: X.topicAddr(l.topics[1]), sym: String(symbol), creator: X.topicAddr(l.topics[2]), ts: l.ts });
    } else if (l.address === lp && l.topics[0] === TOPIC.trade) {
      const [isBuy, nativeAmount, , , vN, vT] = coder.decode(["bool", "uint256", "uint256", "uint256", "uint256", "uint256"], l.data);
      trades.push({ t: X.topicAddr(l.topics[1]), buy: isBuy, eth: eth(nativeAmount), trader: X.topicAddr(l.topics[2]), price: vT > 0n ? eth(vN) / eth(vT) : 0, ts: l.ts });
    } else if (l.address === lp && l.topics[0] === TOPIC.graduated) {
      grads.push(X.topicAddr(l.topics[1]));
    } else if (isPool(l) && l.topics[0] === TOPIC.swap) {
      const [a0in, a1in, a0out, a1out] = coder.decode(["uint256", "uint256", "uint256", "uint256"], l.data), w0 = pairs[l.address].w0;
      const wIn = w0 ? a0in : a1in, wOut = w0 ? a0out : a1out, buy = wIn > 0n;
      trades.push({ t: pairs[l.address].token, buy, eth: eth(buy ? wIn : wOut), trader: buy ? X.topicAddr(l.topics[2]) : "", price: poolPrice.get(l.tx) || 0, ts: l.ts });
    }
  }

  if (launches.length || trades.length || grads.length) {
    // Per-token summaries: read the touched ones, update, write back (MGET + MSET: two commands).
    const touched = [...new Set([...launches.map((x) => x.t), ...trades.map((x) => x.t), ...grads])];
    const prev = await P.redis(["MGET", ...touched.map((t) => K + "a:" + t)]);
    const agg = new Map(touched.map((t, i) => [t, prev && prev[i] ? JSON.parse(prev[i]) : blankAgg()]));
    for (const x of launches) Object.assign(agg.get(x.t), { sym: x.sym, creator: x.creator, born: x.ts });
    for (const t of grads) agg.get(t).grad = 1;
    for (const x of trades) {
      const a = agg.get(x.t);
      a.trades++; a.vol = +(a.vol + x.eth).toFixed(8); a.last = Math.max(a.last, x.ts);
      if (x.price) { a.price = x.price; a.spark.push(+x.price.toPrecision(5)); if (a.spark.length > SPARK) a.spark.splice(0, a.spark.length - SPARK); }
      if (x.trader && !a.tr.includes(x.trader)) { if (a.tr.length < MAX_TRADERS) a.tr.push(x.trader); else a.capped = 1; }
    }
    cmds.push(["MSET", ...[...agg].flatMap(([t, a]) => [K + "a:" + t, JSON.stringify(a)])]);

    // Hourly totals (for the 24h tiles); keep two days.
    const hours = P.pairs(await P.redis(["HGETALL", K + "hours"]));
    const bump = (ts, f) => { const h = String(Math.floor(ts / 3600)); const [tr, vo, la] = (hours[h] || "0,0,0").split(",").map(Number); hours[h] = f(tr, vo, la).join(","); return h; };
    const changed = new Set();
    for (const x of trades) changed.add(bump(x.ts, (tr, vo, la) => [tr + 1, +(vo + x.eth).toFixed(8), la]));
    for (const x of launches) changed.add(bump(x.ts, (tr, vo, la) => [tr, vo, la + 1]));
    const nowH = Math.floor(Date.now() / 1000 / 3600), old = Object.keys(hours).filter((h) => Number(h) < nowH - 48);
    if (changed.size) cmds.push(["HSET", K + "hours", ...[...changed].flatMap((h) => [h, hours[h]])]);
    if (old.length) cmds.push(["HDEL", K + "hours", ...old]);

    // Per-person token sets, for "my coins": launched by them, traded by them (one SADD per person).
    const by = (arr, key) => { const m = new Map(); for (const x of arr) if (x[key]) { if (!m.has(x[key])) m.set(x[key], new Set()); m.get(x[key]).add(x.t); } return m; };
    for (const [c, ts] of by(launches, "creator")) cmds.push(["SADD", K + "c:" + c, ...ts]);
    for (const [u, ts] of by(trades, "trader")) cmds.push(["SADD", K + "u:" + u, ...ts]);
    const people = [...new Set([...trades.map((x) => x.trader), ...launches.map((x) => x.creator)].filter(Boolean))];
    if (people.length) cmds.push(["PFADD", K + "wallets", ...people]);
    if (trades.length) { // LPUSH puts each value at the head in turn, so push oldest first: newest ends up on top
      const rec = trades.slice(-RECENT).map((x) => JSON.stringify({ t: x.t, sym: agg.get(x.t).sym, buy: x.buy, eth: +x.eth.toPrecision(4), ts: x.ts }));
      cmds.push(["LPUSH", K + "recent", ...rec], ["LTRIM", K + "recent", "0", String(RECENT - 1)]);
    }
    const lastT = touched.filter((t) => agg.get(t).last), mc = touched.filter((t) => agg.get(t).price);
    if (lastT.length) cmds.push(["ZADD", K + "last", ...lastT.flatMap((t) => [String(agg.get(t).last), t])]);
    if (mc.length) cmds.push(["ZADD", K + "mcap", ...mc.flatMap((t) => [String(agg.get(t).price * 1e9), t])]);
  }
  for (let i = 0; i < cmds.length; i += 40) await P.redisMulti(cmds.slice(i, i + 40));
  return logs.length;
}

const fromRpcLog = (l, ts) => ({ address: l.address.toLowerCase(), topics: l.topics, data: l.data, block: l.blockNumber, index: l.index, tx: l.transactionHash, ts });

async function backfill(provider, pairs) {
  const to = Math.max(X.DEPLOY_BLOCK, (await provider.getBlockNumber()) - LAG);
  const lp = P.TESTNET.launchpad;
  const [launched, trades, grads] = await Promise.all([X.logs(lp, TOPIC.launched, null, to), X.logs(lp, TOPIC.trade, null, to), X.logs(lp, TOPIC.graduated, null, to)]);
  const all = [...launched, ...trades, ...grads].map((l) => ({ ...l, address: lp }));
  for (const g of grads) {
    const pair = X.topicAddr(g.topics[2]);
    const [sw, sy] = await Promise.all([X.logs(pair, TOPIC.swap, null, to), X.logs(pair, TOPIC.sync, null, to)]);
    all.push(...sw.map((l) => ({ ...l, address: pair })), ...sy.map((l) => ({ ...l, address: pair })));
  }
  all.sort((a, b) => a.block - b.block || a.index - b.index);
  for (let i = 0; i < all.length; i += 500) await ingest(all.slice(i, i + 500), pairs, provider);
  await saveState({ cur: to, head: to + LAG, ms: Date.now() }, true);
  return to;
}

const note = (m) => P.redis(["SET", K + "err", new Date().toISOString() + " " + String(m).slice(0, 300), "EX", "86400"]).catch(() => {});

// ---- cursor state: one small hash, cached in each instance's memory ----
const STATE_MS = Math.min(20000, THROTTLE_S * 1000), PERSIST_IDLE_MS = 5 * 60000;
const memo = { state: null, stateAt: 0, tokens: new Map(), persistedAt: 0, summary: null, summaryAt: 0 };
async function getState(force) {
  if (!force && memo.state && Date.now() - memo.stateAt < STATE_MS) return memo.state;
  const h = P.pairs(await P.redis(["HGETALL", K + "state"]));
  memo.state = { cur: Number(h.cur) || 0, head: Number(h.head) || 0, ms: Number(h.ms) || 0, ver: Number(h.ver) || 0 };
  memo.stateAt = Date.now();
  return memo.state;
}
async function saveState(fields, bump) {
  const cmds = [["HSET", K + "state", ...Object.entries(fields).flat().map(String)]];
  if (bump) cmds.push(["HINCRBY", K + "state", "ver", "1"]);
  await P.redisMulti(cmds);
  memo.stateAt = 0; memo.persistedAt = Date.now(); memo.summaryAt = 0;
}

// Brings the index up to date, spending at most `budgetMs`. Cheap to call on every request: at most one
// instance syncs per THROTTLE window (the lock's lifetime is the throttle), everyone else returns at once.
async function sync(budgetMs = 3500) {
  if (memo.skipUntil && Date.now() < memo.skipUntil) return;
  memo.skipUntil = Date.now() + Math.min(25000, THROTTLE_S * 1000);
  if ((await P.redis(["SET", K + "lock", "1", "NX", "EX", String(THROTTLE_S)])) !== "OK") return;
  const start = Date.now();
  try {
    const provider = rpc();
    const pairs = await loadPairs();
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
      if (await ingest(logs, pairs, provider)) wrote = true;
      if (Object.keys(pairs).length > before) { // a pool born in this round: fetch its own logs for the rest of the round
        const newOnes = Object.keys(pairs).slice(before);
        const gradBlock = Math.min(...logs.filter((l) => l.topics[0] === TOPIC.graduated).map((l) => l.block));
        for (let f = gradBlock; f <= doneTo; f += CHUNK) {
          const extra = await provider.getLogs({ address: newOnes, fromBlock: f, toBlock: Math.min(doneTo, f + CHUNK - 1) });
          if (await ingest(await Promise.all(extra.map(async (l) => fromRpcLog(l, await tsOf(l.blockNumber)))), pairs, provider)) wrote = true;
        }
      }
      cur = doneTo;
      if (cur >= latest) latest = await provider.getBlockNumber();
    }
    const behind = latest - cur > 3000;
    if (wrote || behind || Date.now() - memo.persistedAt > PERSIST_IDLE_MS || !(await getState()).cur) await saveState({ cur, head: latest, ms: Date.now() }, wrote);
  } catch (e) {
    await note("sync: " + (e.message || e));
  }
}

// Adds one transaction's logs straight from its receipt (right after a user's own trade), for the chart.
// The follower meets the same logs later: the chart drops repeats when read, and the summaries are only
// built by the follower, so they never count a trade twice.
async function ingestTx(hash) {
  const provider = rpc();
  const rc = await provider.getTransactionReceipt(hash);
  if (!rc || rc.status !== 1) return 0;
  const ts = (await provider.getBlock(rc.blockNumber)).timestamp;
  const pairs = await loadPairs();
  const lp = P.TESTNET.launchpad;
  const vals = new Map();
  for (const l of rc.logs.map((x) => fromRpcLog(x, ts))) {
    const trade = l.address === lp && l.topics[0] === TOPIC.trade;
    if (!trade && !(pairs[l.address] && (l.topics[0] === TOPIC.swap || l.topics[0] === TOPIC.sync))) continue;
    const token = trade ? X.topicAddr(l.topics[1]) : pairs[l.address].token;
    if (!vals.has(token)) vals.set(token, []);
    vals.get(token).push(JSON.stringify({ k: trade ? "t" : l.topics[0] === TOPIC.swap ? "w" : "y", b: l.block, i: l.index, h: l.tx, tp: l.topics, d: l.data, ts: l.ts }));
  }
  if (!vals.size) return 0;
  await P.redisMulti([...[...vals].map(([t, v]) => ["RPUSH", `${K}t:${t}`, ...v]), ["HINCRBY", K + "state", "ver", "1"]]);
  memo.stateAt = 0;
  return [...vals.values()].reduce((n, v) => n + v.length, 0);
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
  const raw = (await P.redis(["LRANGE", `${K}t:${t}`, "0", "-1"])) || [];
  const seen = new Set(), out = { trade: [], swap: [], sync: [] };
  const recs = raw.map((r) => JSON.parse(r)).filter((r) => { const k = r.h + ":" + r.i; if (seen.has(k)) return false; seen.add(k); return true; });
  recs.sort((a, b) => a.b - b.b || a.i - b.i);
  for (const r of recs) (r.k === "t" ? out.trade : r.k === "w" ? out.swap : out.sync).push({ blockNumber: r.b, index: r.i, transactionHash: r.h, topics: r.tp, data: r.d, ts: r.ts });
  memo.tokens.set(t, { ver: s.ver, data: out });
  if (memo.tokens.size > 300) memo.tokens.delete(memo.tokens.keys().next().value);
  return out;
}

// Homepage summary: totals for the tiles, the ticker, rankings and graduated tokens. One pipeline of six
// commands, cached in memory for 15 seconds.
async function summary() {
  if (memo.summary && Date.now() - memo.summaryAt < 15000) return memo.summary;
  const [hoursRaw, wallets, recent, last, mcap, pairsRaw] = await P.redisMulti([
    ["HGETALL", K + "hours"], ["PFCOUNT", K + "wallets"], ["LRANGE", K + "recent", "0", "23"],
    ["ZREVRANGE", K + "last", "0", "99"], ["ZREVRANGE", K + "mcap", "0", "99"], ["HGETALL", K + "pairs"],
  ]);
  const hours = P.pairs(hoursRaw), from = Math.floor(Date.now() / 1000 / 3600) - 23;
  let trades24 = 0, volume24 = 0, launched24 = 0;
  for (const [h, v] of Object.entries(hours)) if (Number(h) >= from) { const [tr, vo, la] = v.split(",").map(Number); trades24 += tr; volume24 += vo; launched24 += la; }
  const graduated = Object.values(P.pairs(pairsRaw)).map((v) => v.split("|")[0]);
  memo.summary = {
    totals: { launched24, graduated: graduated.length, trades24, volume24: +volume24.toFixed(4), wallets: Number(wallets) || 0 },
    recent: (recent || []).map((r) => JSON.parse(r)), topLast: last || [], topMcap: mcap || [], graduated, at: Date.now(),
  };
  memo.summaryAt = Date.now();
  return memo.summary;
}

// Per-token summaries for the tokens on screen (one MGET).
async function tokenStats(tokens) {
  const list = [...new Set(tokens.map((t) => String(t).toLowerCase()).filter((t) => /^0x[0-9a-f]{40}$/.test(t)))].slice(0, 200);
  if (!list.length) return {};
  const vals = await P.redis(["MGET", ...list.map((t) => K + "a:" + t)]);
  const out = {};
  list.forEach((t, i) => { if (!vals || !vals[i]) return; const a = JSON.parse(vals[i]); out[t] = { sym: a.sym, creator: a.creator, born: a.born, trades: a.trades, vol: a.vol, last: a.last, traders: a.tr.length, tradersMore: Boolean(a.capped), spark: a.spark }; });
  return out;
}

// Tokens a wallet launched and tokens it traded (two commands).
async function mine(addr) {
  const a = String(addr).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) return { launched: [], traded: [] };
  const [c, u] = await P.redisMulti([["SMEMBERS", K + "c:" + a], ["SMEMBERS", K + "u:" + a]]);
  return { launched: c || [], traded: u || [] };
}

// Where the index stands (for monitoring).
async function status() {
  const [st, lock, err] = await P.redisMulti([["HGETALL", K + "state"], ["TTL", K + "lock"], ["GET", K + "err"]]);
  const h = P.pairs(st);
  return { cur: Number(h.cur) || null, head: Number(h.head) || null, lag: h.cur && h.head ? Number(h.head) - Number(h.cur) : null, saved: h.ms ? new Date(Number(h.ms)).toISOString() : null, version: Number(h.ver) || 0, nextSyncIn: Number(lock) > 0 ? Number(lock) : 0, lastError: err || null };
}

module.exports = { sync, ingestTx, read, current, summary, tokenStats, mine, status, TOPIC };
