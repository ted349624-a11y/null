// Shared logic for the points API (Vercel Node functions in /api).
// Storage: Upstash Redis over REST (env from Vercel's Upstash/KV integration). Without it, an
// in-memory store is used only when NULL_DEV=1 (local development).
const crypto = require("crypto");
const { ethers } = require("ethers");

// ---------------------------------------------------------------- config
const QC = require("./quest-config");
const X_HANDLE = String(process.env.X_HANDLE || QC.xHandle || "").trim().replace(/^@/, "");
const X_POST_ID = (() => { const v = String(process.env.X_POST_ID || QC.postId || "").trim(); return (/status(?:es)?\/(\d+)/.exec(v) || /^(\d+)$/.exec(v) || [])[1] || ""; })();
const TESTNET = {
  rpc: process.env.TESTNET_RPC || "https://sepolia.base.org",
  chainName: "Base Sepolia",
  blockscout: process.env.BLOCKSCOUT_API || "https://base-sepolia.blockscout.com/api",
  launchpad: (process.env.TESTNET_LAUNCHPAD || "0x5e5cF3b8a1d0B99fEaf33B985552270B28674393").toLowerCase(),
  router: (process.env.TESTNET_ROUTER || "0xf5551CD1bc1c69C8fC43D11f602032A8F5972A68").toLowerCase(),
  weth: (process.env.TESTNET_WETH || "0x4200000000000000000000000000000000000006").toLowerCase(),
  url: process.env.TESTNET_URL || "https://testnet.nullfamily.fun",
};
const POINTS_PER_TASK = 500;

const sel = (sig) => ethers.id(sig).slice(0, 10);
const SEL = {
  createToken: sel("createToken(string,string,(string,string,string,string,string),uint16,address,uint256)"),
  buy: sel("buy(address,uint256,uint256)"),
  sell: sel("sell(address,uint256,uint256,uint256)"),
  poolBuy: sel("swapExactETHForTokens(address,uint256,address,uint256)"),
  poolSell: sel("swapExactTokensForETH(address,uint256,uint256,address,uint256)"),
};

// The first announcement post's quests were stored without a post suffix; later posts get "<quest>:<postId>".
const LEGACY_POST = "2125683170708217882";
const postKey = (base) => (X_POST_ID && X_POST_ID !== LEGACY_POST ? `${base}:${X_POST_ID}` : base);
// Quests needed before the testnet quests unlock (post quests come and go, so they don't block the testnet).
const BASE_X = ["follow", "notify"];

// X quests run in this order, testnet quests in theirs.
const TASKS = [
  { id: "follow", kind: "x", title: `Follow @${X_HANDLE} on X`, cta: "Follow on X", url: () => `https://x.com/intent/follow?screen_name=${X_HANDLE}` },
  { id: "notify", kind: "x", title: `Turn on post notifications for @${X_HANDLE}`, hint: "Open the profile and tap the bell icon.", cta: "Open profile", url: () => `https://x.com/${X_HANDLE}` },
  // Like / repost / reply point at the announcement post once X_POST_ID is set; until then, at the profile.
  // Like / repost / reply belong to the current post: a new post gives them new ids, so everyone can earn them again.
  { id: postKey("like"), post: true, kind: "x", title: X_POST_ID ? "Like the announcement post" : `Like the latest @${X_HANDLE} post`, cta: "Like on X", url: () => (X_POST_ID ? `https://x.com/intent/like?tweet_id=${X_POST_ID}` : `https://x.com/${X_HANDLE}`) },
  { id: postKey("repost"), post: true, kind: "x", title: X_POST_ID ? "Repost the announcement" : `Repost the latest @${X_HANDLE} post`, cta: "Repost on X", url: () => (X_POST_ID ? `https://x.com/intent/retweet?tweet_id=${X_POST_ID}` : `https://x.com/${X_HANDLE}`) },
  { id: postKey("reply"), post: true, kind: "x", title: X_POST_ID ? "Reply to the announcement" : `Reply to the latest @${X_HANDLE} post`, hint: "Say anything you like, in your own words.", cta: "Reply on X", url: () => (X_POST_ID ? `https://x.com/intent/tweet?in_reply_to=${X_POST_ID}` : `https://x.com/${X_HANDLE}`) },
  { id: "launch", kind: "chain", title: "Launch a token on the testnet", hint: "No test ETH yet? Tap “Get free test ETH” on the testnet, then hit + Launch.", cta: "Open testnet", check: (tx) => tx.to === TESTNET.launchpad && tx.input.startsWith(SEL.createToken) },
  { id: "buy", kind: "chain", title: "Buy a token on the bonding curve", cta: "Open testnet", check: (tx) => tx.to === TESTNET.launchpad && tx.input.startsWith(SEL.buy) },
  { id: "sell", kind: "chain", title: "Sell a token on the bonding curve", cta: "Open testnet", check: (tx) => tx.to === TESTNET.launchpad && tx.input.startsWith(SEL.sell) },
  { id: "pool", kind: "chain", title: "Trade a graduated token on nullswap", hint: "Open a token marked “graduated · on nullswap” and buy or sell.", cta: "Open testnet", check: (tx) => tx.to === TESTNET.router && (tx.input.startsWith(SEL.poolBuy) || tx.input.startsWith(SEL.poolSell)) },
];

function publicConfig() {
  return {
    ready: Boolean(X_HANDLE),
    xHandle: X_HANDLE,
    postUrl: X_POST_ID ? `https://x.com/${X_HANDLE}/status/${X_POST_ID}` : "",
    pointsPerTask: POINTS_PER_TASK,
    testnet: { chainName: TESTNET.chainName, url: TESTNET.url },
    questsUrl: process.env.QUESTS_URL || "https://nullfamily.fun",
    tasks: TASKS.map((t) => ({ id: t.id, kind: t.kind, post: Boolean(t.post), title: t.title, hint: t.hint || "", cta: t.cta, url: t.url ? t.url() : TESTNET.url })),
  };
}

// ---------------------------------------------------------------- storage
// Vercel's Upstash integration names these KV_REST_API_URL/TOKEN by default, or <PREFIX>_REST_API_URL/TOKEN
// when a custom prefix is chosen; Upstash's own console uses UPSTASH_REDIS_REST_URL/TOKEN.
function envPair() {
  const e = process.env;
  if (e.KV_REST_API_URL && e.KV_REST_API_TOKEN) return [e.KV_REST_API_URL, e.KV_REST_API_TOKEN];
  if (e.UPSTASH_REDIS_REST_URL && e.UPSTASH_REDIS_REST_TOKEN) return [e.UPSTASH_REDIS_REST_URL, e.UPSTASH_REDIS_REST_TOKEN];
  for (const k of Object.keys(e)) {
    const m = /^(.*)_REST_API_URL$/.exec(k) || /^(.*)_REDIS_REST_URL$/.exec(k);
    if (!m) continue;
    const tok = e[k.replace(/URL$/, "TOKEN")];
    if (tok && /^https:\/\//.test(e[k])) return [e[k], tok];
  }
  return [null, null];
}
const [REST_URL, REST_TOKEN] = envPair();
const mem = { kv: new Map(), hashes: new Map(), zset: new Map() };

async function redis(cmd) {
  if (REST_URL && REST_TOKEN) {
    const r = await fetch(REST_URL, { method: "POST", headers: { Authorization: `Bearer ${REST_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(cmd) });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    return j.result;
  }
  if (process.env.NULL_DEV !== "1") throw Object.assign(new Error("Points storage is not configured yet."), { status: 503 });
  return memRedis(cmd);
}

// Several commands in one round trip (Upstash REST /pipeline).
async function redisMulti(cmds) {
  if (REST_URL && REST_TOKEN) {
    const r = await fetch(REST_URL.replace(/\/$/, "") + "/pipeline", { method: "POST", headers: { Authorization: `Bearer ${REST_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(cmds) });
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error(j.error || "pipeline failed");
    return j.map((x) => { if (x.error) throw new Error(x.error); return x.result; });
  }
  const out = [];
  for (const c of cmds) out.push(await redis(c));
  return out;
}

function memRedis([op, key, ...a]) {
  const h = () => { if (!mem.hashes.has(key)) mem.hashes.set(key, new Map()); return mem.hashes.get(key); };
  switch (op) {
    case "GET": return mem.kv.has(key) ? mem.kv.get(key) : null;
    case "SET": { if (a.includes("NX") && mem.kv.has(key)) return null; mem.kv.set(key, a[0]); return "OK"; }
    case "HGETALL": return [...(mem.hashes.get(key) || new Map())].flat();
    case "DEL": { const had = mem.kv.delete(key) | mem.hashes.delete(key) | (mem.lists && mem.lists.delete(key)) | (mem.sets && mem.sets.delete(key)); return had ? 1 : 0; }
    case "SADD": { mem.sets ||= new Map(); if (!mem.sets.has(key)) mem.sets.set(key, new Set()); const st = mem.sets.get(key); let n = 0; for (const v of a) if (!st.has(v)) { st.add(v); n++; } return n; }
    case "RPUSH": { mem.lists ||= new Map(); if (!mem.lists.has(key)) mem.lists.set(key, []); mem.lists.get(key).push(...a); return mem.lists.get(key).length; }
    case "LRANGE": { const l = (mem.lists && mem.lists.get(key)) || []; const st = Number(a[0]), en = Number(a[1]); return l.slice(st, en < 0 ? l.length + en + 1 : en + 1); }
    case "SCARD": return (mem.sets && mem.sets.get(key) ? mem.sets.get(key).size : 0);
    case "HLEN": return (mem.hashes.get(key) || new Map()).size;
    case "HGET": return h().has(a[0]) ? h().get(a[0]) : null;
    case "HSET": { for (let i = 0; i < a.length; i += 2) h().set(a[i], String(a[i + 1])); return 1; }
    case "HSETNX": { if (h().has(a[0])) return 0; h().set(a[0], String(a[1])); return 1; }
    case "HINCRBY": { const v = Number(h().get(a[0]) || 0) + Number(a[1]); h().set(a[0], String(v)); return v; }
    case "ZINCRBY": { const v = (mem.zset.get(a[1]) || 0) + Number(a[0]); mem.zset.set(a[1], v); return String(v); }
    case "ZREVRANGE": { const arr = [...mem.zset].sort((x, y) => y[1] - x[1]).slice(Number(a[0]), Number(a[1]) + 1); return arr.flatMap(([m, s]) => [m, String(s)]); }
    case "ZREVRANK": { const arr = [...mem.zset].sort((x, y) => y[1] - x[1]).map(([m]) => m); const i = arr.indexOf(a[0]); return i < 0 ? null : i; }
    case "ZCARD": return mem.zset.size;
    default: throw new Error("unsupported " + op);
  }
}

const pairs = (arr) => { const o = {}; for (let i = 0; i < (arr || []).length; i += 2) o[arr[i]] = arr[i + 1]; return o; };

async function getProfile(addr) {
  const [hraw, rank, total] = await redisMulti([["HGETALL", `u:${addr}`], ["ZREVRANK", "lb", addr], ["ZCARD", "lb"]]);
  const h = pairs(hraw);
  const done = TASKS.filter((t) => h[`t:${t.id}`]).map((t) => t.id);
  return { address: addr, x: h.x || "", points: Number(h.points || 0), done, rank: rank === null ? null : Number(rank) + 1, players: Number(total || 0) };
}

// ---------------------------------------------------------------- quest progress
const X_TASKS = TASKS.filter((t) => t.kind === "x");
function normHandle(raw) {
  const v = String(raw || "").trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, "").split(/[/?#]/)[0];
  return /^[A-Za-z0-9_]{1,15}$/.test(v) ? v : null;
}
// Awards a task to a wallet once. Returns true if it was new.
async function completeTask(addr, id) {
  const first = Number(await redis(["HSETNX", `u:${addr}`, `t:${id}`, String(Date.now())]));
  if (first === 1) await redisMulti([["HINCRBY", `u:${addr}`, "points", POINTS_PER_TASK], ["ZINCRBY", "lb", POINTS_PER_TASK, addr]]);
  return first === 1;
}
// X quests are done on the homepage without a wallet and kept per X username (xq:<handle>).
async function xProgress(h) {
  const o = pairs(await redis(["HGETALL", `xq:${h}`]));
  const fields = Object.keys(o).filter((k) => k.startsWith("t:"));
  const done = X_TASKS.filter((t) => o[`t:${t.id}`]).map((t) => t.id);
  const current = new Set(X_TASKS.map((t) => "t:" + t.id));
  // Did this username do an earlier post's quests but not the current post's yet?
  const redo = X_TASKS.some((t) => t.post && !o[`t:${t.id}`]) && fields.some((k) => /^t:(like|repost|reply)/.test(k) && !current.has(k));
  return { name: o.name || "", done, points: fields.length * POINTS_PER_TASK, redo };
}
// Copies an X username's quest progress onto the wallet it is linked to, in quest order.
async function syncX(addr, h) {
  const o = pairs(await redis(["HGETALL", `xq:${h}`]));
  for (const k of Object.keys(o)) if (k.startsWith("t:")) await completeTask(addr, k.slice(2)); // every X quest, old posts included
}

// ---------------------------------------------------------------- auth
// Sessions are stateless HMAC tokens; the key is derived from the storage token (or SESSION_SECRET).
const SECRET = crypto.createHash("sha256").update("null-points-session:" + (process.env.SESSION_SECRET || REST_TOKEN || "dev-only-secret")).digest();
const b64u = (b) => Buffer.from(b).toString("base64url");

function loginMessage(address, issuedAt) {
  return `nullfamily.fun quests\n\nSign in with ${address}\nIssued at: ${issuedAt}\n\nThis only proves you own this wallet. No transaction, no gas.`;
}
function issueToken(addr) {
  const payload = b64u(JSON.stringify({ a: addr, e: Date.now() + 30 * 24 * 3600 * 1000 }));
  return payload + "." + b64u(crypto.createHmac("sha256", SECRET).update(payload).digest());
}
function readToken(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
  if (!m) return null;
  const [payload, sig] = m[1].split(".");
  if (!payload || !sig) return null;
  const want = b64u(crypto.createHmac("sha256", SECRET).update(payload).digest());
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try { const { a, e } = JSON.parse(Buffer.from(payload, "base64url").toString()); return e > Date.now() && /^0x[0-9a-f]{40}$/.test(a) ? a : null; } catch { return null; }
}

// ---------------------------------------------------------------- http helpers
async function body(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  return raw ? JSON.parse(raw) : {};
}
function send(res, status, data) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(data));
}
function handler(fn) {
  return async (req, res) => {
    try { await fn(req, res); }
    catch (e) { send(res, e.status || 500, { error: e.expose || e.status ? e.message : "Something went wrong. Try again." }); if (!e.status) console.error(e); }
  };
}
const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });

// ---------------------------------------------------------------- on-chain checks
async function walletTxs(addr) {
  const url = `${TESTNET.blockscout}?module=account&action=txlist&address=${addr}&sort=desc&page=1&offset=200`;
  const r = await fetch(url);
  const j = await r.json();
  const list = Array.isArray(j.result) ? j.result : [];
  return list
    .filter((t) => String(t.from).toLowerCase() === addr && t.isError === "0" && (t.txreceipt_status === undefined || t.txreceipt_status === "1" || t.txreceipt_status === ""))
    .map((t) => ({ to: String(t.to || "").toLowerCase(), input: String(t.input || "").toLowerCase(), hash: t.hash }));
}

// Direct check of one transaction by hash (no indexer lag); used right after a trade in the testnet app.
async function rpc(method, params) {
  const r = await fetch(TESTNET.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
async function txByHash(addr, hash) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash || "")) return null;
  const [tx, rc] = await Promise.all([rpc("eth_getTransactionByHash", [hash]), rpc("eth_getTransactionReceipt", [hash])]);
  if (!tx || !rc || rc.status !== "0x1" || String(tx.from).toLowerCase() !== addr) return null;
  return { to: String(tx.to || "").toLowerCase(), input: String(tx.input || "").toLowerCase(), hash };
}

module.exports = {
  _mem: mem, // in-memory store (NULL_DEV only), exposed for tests
  TASKS, X_TASKS, BASE_X, normHandle, completeTask, xProgress, syncX, POINTS_PER_TASK, TESTNET, publicConfig, redis, redisMulti, pairs, getProfile, loginMessage, issueToken, readToken,
  body, send, handler, fail, walletTxs, txByHash, ethers,
};
