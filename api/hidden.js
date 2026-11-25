// GET /api/hidden — testnet tokens to keep off the token list: ones launched by bot wallet chains.
// Rule: a launch creator that was funded by another launch creator, or that funded one, is part of a
// wallet chain (one script passing its ETH from wallet to wallet). Wallets funded by faucets or
// bridges never match; the launchpad owner, and wallets it funded, are never hidden. Points are not touched.
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

module.exports = P.handler(async (req, res) => {
  const deadline = Date.now() + 4000; // answer fast; unfinished lookups continue on the next call
  let all;
  try { all = await launches(); } catch { throw P.fail(502, "Indexer unavailable, try again shortly."); }
  const creators = [...new Set(all.map((l) => l.creator))];
  // Funders never change, so each creator is looked up once and remembered.
  const known = P.pairs(await P.redis(["HGETALL", "cfund"]));
  const todo = creators.filter((c) => !known[c]).slice(0, 120);
  for (let i = 0; i < todo.length && Date.now() < deadline; i += 6) {
    const got = await Promise.all(todo.slice(i, i + 6).map(async (c) => { try { return [c, await firstFunder(c)]; } catch { return null; } }));
    const ok = got.filter(Boolean);
    if (ok.length) { await P.redis(["HSET", "cfund", ...ok.flat()]); for (const [c, f] of ok) known[c] = f; }
  }
  const isCreator = new Set(creators), adminAddr = await owner();
  const bot = new Set();
  for (const c of creators) {
    const f = known[c];
    if (f && f !== NONE && f !== c && f !== adminAddr && isCreator.has(f)) { bot.add(c); bot.add(f); } // the owner funding a wallet is fine
  }
  bot.delete(adminAddr);
  const hidden = all.filter((l) => bot.has(l.creator)).map((l) => l.token);
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  const pending = creators.filter((c) => !known[c]).length;
  res.setHeader("cache-control", pending ? "no-store" : "public, s-maxage=60, stale-while-revalidate=300");
  res.end(JSON.stringify({ hidden, botWallets: bot.size, checked: creators.length - pending, pending }));
});
