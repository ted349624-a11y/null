// Small helpers for reading testnet event logs from Blockscout (Etherscan-compatible API), server-side.
const P = require("./points");

const DEPLOY_BLOCK = Number(process.env.TESTNET_DEPLOY_BLOCK || 63429131);

async function getJson(url, ms = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

// Blockscout rate-limits bursts (HTTP 429), so each instance keeps at most 3 log requests in flight
// and backs off when it is told to slow down.
const MAX_IN_FLIGHT = 3;
let inFlight = 0;
const waiting = [];
async function limited(fn) {
  if (inFlight >= MAX_IN_FLIGHT) await new Promise((res) => waiting.push(res));
  inFlight++;
  try { return await fn(); }
  finally { inFlight--; const next = waiting.shift(); if (next) next(); }
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// All logs of `address` with topic0 (and optional topic1), oldest first, deduplicated across pages.
async function logs(address, topic0, topic1, toBlock) {
  const out = [], seen = new Set();
  let from = DEPLOY_BLOCK;
  for (let page = 0; page < 30; page++) {
    let url = `${P.TESTNET.blockscout}?module=logs&action=getLogs&fromBlock=${from}&toBlock=${toBlock || "latest"}&address=${address}&topic0=${topic0}`;
    if (topic1) url += `&topic1=${topic1}&topic0_1_opr=and`;
    let r;
    for (let attempt = 0; ; attempt++) {
      try { r = await limited(() => getJson(url)); break; }
      catch (e) {
        const busy = /HTTP (429|5\d\d)/.test(e.message || "");
        if (attempt >= (busy ? 4 : 1)) throw e;
        if (busy) await sleep(1200 * (attempt + 1));
      }
    }
    const items = Array.isArray(r.result) ? r.result : [];
    if (r.status !== "1" && !(items.length === 0 && /no (logs|records)/i.test(r.message || ""))) throw new Error(r.message || "log api error");
    for (const x of items) {
      const key = x.transactionHash + ":" + x.logIndex;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ block: parseInt(x.blockNumber, 16), index: parseInt(x.logIndex || "0x0", 16), tx: x.transactionHash, topics: x.topics.filter(Boolean), data: x.data, ts: parseInt(x.timeStamp, 16) });
    }
    if (items.length < 1000) break;
    from = out[out.length - 1].block;
  }
  return out;
}

const topicAddr = (t) => ("0x" + t.slice(26)).toLowerCase();

module.exports = { DEPLOY_BLOCK, getJson, logs, topicAddr };
