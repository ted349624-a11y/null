// GET /api/hidden — testnet tokens to keep off the token list: ones launched by bot wallet chains.
// Rule: a launch creator that was funded by another launch creator, or that funded one, is part of a
// wallet chain (one script passing its ETH from wallet to wallet). Wallets funded by faucets or
// bridges never match; transfers to or from the launchpad owner never count. Points are not touched.
const P = require("../lib/points");
const { ethers } = P;

const LAUNCHED = ethers.id("TokenLaunched(address,address,string,string,uint16)");
const DEPLOY_BLOCK = Number(process.env.TESTNET_DEPLOY_BLOCK || 63429131);
const NONE = "-";

async function getJson(url, ms = 4000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetch(url, { signal: ctl.signal }); if (!r.ok) throw new Error("HTTP " + r.status); return await r.json(); }
  finally { clearTimeout(t); }
}

// Every launch: token and creator, from the TokenLaunched events.
async function launches() {
  const out = [], seen = new Set();
  let from = DEPLOY_BLOCK;
  for (let page = 0; page < 30; page++) {
    const r = await getJson(`${P.TESTNET.blockscout}?module=logs&action=getLogs&fromBlock=${from}&toBlock=latest&address=${P.TESTNET.launchpad}&topic0=${LAUNCHED}`);
    const items = Array.isArray(r.result) ? r.result : [];
    if (r.status !== "1" && !(items.length === 0 && /no (logs|records)/i.test(r.message || ""))) throw new Error(r.message || "log api error");
    for (const x of items) {
      if (seen.has(x.transactionHash + x.logIndex)) continue;
      seen.add(x.transactionHash + x.logIndex);
      out.push({ token: ("0x" + x.topics[1].slice(26)).toLowerCase(), creator: ("0x" + x.topics[2].slice(26)).toLowerCase(), block: parseInt(x.blockNumber, 16) });
    }
    if (items.length < 1000) break;
    from = out[out.length - 1].block;
  }
  return out;
}

// Who sent a wallet its first ETH (the earliest incoming transfer), or NONE.
async function firstFunder(addr) {
  const r = await getJson(`${P.TESTNET.blockscout}?module=account&action=txlist&address=${addr}&sort=asc&page=1&offset=10`);
  const list = Array.isArray(r.result) ? r.result : [];
  if (r.status !== "1" && list.length === 0 && !/no transactions/i.test(r.message || "")) throw new Error(r.message || "txlist error");
  const tx = list.find((t) => String(t.to).toLowerCase() === addr && BigInt(t.value || "0") > 0n);
  return tx ? String(tx.from).toLowerCase() : NONE;
}

async function owner() {
  try {
    const rp = new ethers.JsonRpcProvider(P.TESTNET.rpc, undefined, { staticNetwork: true });
    return (await new ethers.Contract(P.TESTNET.launchpad, ["function owner() view returns (address)"], rp).owner()).toLowerCase();
  } catch { return ""; }
}

const FRESH_MS = 5 * 60000, RETRY_MS = 30 * 60000;

// Works out the hidden list. Funders never change, so each creator is looked up once and remembered;
// a failed lookup is remembered as "?<time>" and retried after RETRY_MS (it counts as "not a bot" meanwhile).
async function compute() {
  const deadline = Date.now() + 3000;
  const all = await launches();
  const creators = [...new Set(all.map((l) => l.creator))];
  const known = P.pairs(await P.redis(["HGETALL", "cfund"]));
  const due = (c) => !known[c] || (known[c].startsWith("?") && Date.now() - Number(known[c].slice(1)) > RETRY_MS);
  const todo = creators.filter(due).slice(0, 120);
  for (let i = 0; i < todo.length && Date.now() < deadline; i += 6) {
    const got = await Promise.all(todo.slice(i, i + 6).map(async (c) => { try { return [c, await firstFunder(c)]; } catch { return [c, "?" + Date.now()]; } }));
    await P.redis(["HSET", "cfund", ...got.flat()]);
    for (const [c, f] of got) known[c] = f;
  }
  const isCreator = new Set(creators), adminAddr = await owner();
  const bot = new Set();
  for (const c of creators) {
    const f = known[c];
    // Transfers to or from the owner never count (the owner funds testers; the setup wallet refunded the owner).
    if (f && f !== NONE && !f.startsWith("?") && f !== c && f !== adminAddr && c !== adminAddr && isCreator.has(f)) { bot.add(c); bot.add(f); }
  }
  bot.delete(adminAddr);
  return {
    hidden: all.filter((l) => bot.has(l.creator)).map((l) => l.token),
    botWallets: bot.size,
    unchecked: creators.filter((c) => !known[c]).length,
    at: Date.now(),
  };
}

let memResult = null; // this instance's copy, so most requests don't touch Redis at all
module.exports = P.handler(async (req, res) => {
  // Serve the last result right away; recompute at most every 5 minutes.
  let result = memResult && Date.now() - memResult.at < FRESH_MS && !memResult.unchecked ? memResult : null;
  if (!result) { try { result = JSON.parse((await P.redis(["GET", "hiddenResult"])) || "null"); } catch {} }
  if (!result || Date.now() - result.at > FRESH_MS || result.unchecked > 0) {
    try {
      result = await compute();
      await P.redis(["SET", "hiddenResult", JSON.stringify(result), "EX", "86400"]);
    } catch (e) {
      if (!result) throw P.fail(502, "Indexer unavailable, try again shortly.");
    }
  }
  memResult = result;
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "public, s-maxage=60, stale-while-revalidate=300");
  res.end(JSON.stringify(result));
});
