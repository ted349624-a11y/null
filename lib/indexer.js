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

// All logs of `address` with topic0 (and optional topic1), oldest first, deduplicated across pages.
async function logs(address, topic0, topic1) {
  const out = [], seen = new Set();
  let from = DEPLOY_BLOCK;
  for (let page = 0; page < 30; page++) {
    let url = `${P.TESTNET.blockscout}?module=logs&action=getLogs&fromBlock=${from}&toBlock=latest&address=${address}&topic0=${topic0}`;
    if (topic1) url += `&topic1=${topic1}&topic0_1_opr=and`;
    let r;
    for (let attempt = 0; ; attempt++) {
      try { r = await getJson(url); break; } catch (e) { if (attempt >= 1) throw e; }
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
