// GET /api/history?token=0x…[&pair=0x…] — trade history of one testnet token.
// Fetched from Blockscout on the server (phones and wallet browsers can't always reach it, and the public
// RPC only allows tiny log ranges), then cached at the edge for a few seconds so all viewers share one lookup.
const P = require("../lib/points");
const { ethers } = P;

const TOPIC = {
  trade: ethers.id("Trade(address,address,bool,uint256,uint256,uint256,uint256,uint256)"),
  swap: ethers.id("Swap(address,uint256,uint256,uint256,uint256,address)"),
  sync: ethers.id("Sync(uint112,uint112)"),
};
const DEPLOY_BLOCK = Number(process.env.TESTNET_DEPLOY_BLOCK || 63429131);
const lastGood = new Map(); // per warm instance: answer with the last good result if Blockscout has a hiccup

async function getJson(url, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function logs(address, topic0, topic1) {
  const out = [], seen = new Set();
  let from = DEPLOY_BLOCK;
  for (let page = 0; page < 30; page++) {
    let url = `${P.TESTNET.blockscout}?module=logs&action=getLogs&fromBlock=${from}&toBlock=latest&address=${address}&topic0=${topic0}`;
    if (topic1) url += `&topic1=${topic1}&topic0_1_opr=and`;
    let r;
    for (let attempt = 0; ; attempt++) {
      try { r = await getJson(url, 9000); break; } catch (e) { if (attempt >= 1) throw e; }
    }
    const items = Array.isArray(r.result) ? r.result : [];
    if (r.status !== "1" && !(items.length === 0 && /no (logs|records)/i.test(r.message || ""))) throw new Error(r.message || "log api error");
    for (const x of items) {
      const key = x.transactionHash + ":" + x.logIndex;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ blockNumber: parseInt(x.blockNumber, 16), index: parseInt(x.logIndex || "0x0", 16), transactionHash: x.transactionHash, topics: x.topics.filter(Boolean), data: x.data, ts: parseInt(x.timeStamp, 16) });
    }
    if (items.length < 1000) break;
    from = out[out.length - 1].blockNumber; // the last block may continue on the next page; duplicates are skipped
  }
  return out;
}

function reply(res, status, body, cache) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", cache || "no-store");
  res.end(JSON.stringify(body));
}

module.exports = P.handler(async (req, res) => {
  const q = new URL(req.url, "http://x").searchParams;
  const token = q.get("token") || "", pair = q.get("pair") || "";
  if (!ethers.isAddress(token) || (pair && !ethers.isAddress(pair))) throw P.fail(400, "Bad address");
  const key = (token + ":" + pair).toLowerCase();
  try {
    const tok = ethers.zeroPadValue(token, 32).toLowerCase();
    const [trade, swap, sync] = await Promise.all([
      logs(P.TESTNET.launchpad, TOPIC.trade, tok),
      pair ? logs(pair, TOPIC.swap) : [],
      pair ? logs(pair, TOPIC.sync) : [],
    ]);
    const body = { trade, swap, sync, at: Date.now() };
    lastGood.set(key, body);
    if (lastGood.size > 500) lastGood.delete(lastGood.keys().next().value);
    reply(res, 200, body, "public, s-maxage=5, stale-while-revalidate=10");
  } catch (e) {
    const prev = lastGood.get(key);
    if (prev) return reply(res, 200, { ...prev, stale: true });
    throw P.fail(502, "Trade history is temporarily unavailable.");
  }
});
