// Applications from the /apply page: one X username + one EVM address per entry, like a short form.
// Served through api/x.js (rewrites /api/apply and /api/apply/responses) to stay under the function limit.
//
// POST /api/apply            { username, address } -> { ok, n, username, address, updated }
// GET  /api/apply/responses  (Bearer token of an admin wallet) -> { count, items: [{ n, u, a, t }] }
//
// Redis: hash ap:a  address(lowercase) -> JSON { n, u, a, t }
//        hash ap:u  username(lowercase) -> address(lowercase)
//        ap:n      running number (the "#123" shown after submitting)
//        ap:ip:<ip> submissions from one IP in the last hour (spam brake)
const P = require("./points");

const owners = [];
for (const f of ["../deployments/base.json", "../deployments/baseSepolia-v2.json"]) {
  try { owners.push(require(f).owner); } catch {}
}
const ADMINS = new Set(
  [...owners, ...String(process.env.APPLY_ADMINS || "").split(",")]
    .map((a) => String(a || "").trim().toLowerCase())
    .filter((a) => /^0x[0-9a-f]{40}$/.test(a)),
);
const PER_IP_HOUR = 60;

const isApply = (req) => {
  const u = new URL(req.url, "http://x");
  return u.pathname.startsWith("/api/apply") || u.searchParams.has("apply") || Boolean(req.query && req.query.apply);
};
const isList = (req) => {
  const u = new URL(req.url, "http://x");
  return u.pathname.endsWith("/responses") || u.searchParams.has("list") || Boolean(req.query && req.query.list);
};

function fieldError(res, field, error) {
  P.send(res, 400, { error, field });
}

async function submit(req, res) {
  const b = await P.body(req);
  const user = P.normHandle(b.username);
  if (!String(b.username || "").trim()) return fieldError(res, "username", "This is a required question.");
  if (!user) return fieldError(res, "username", "Enter a valid X username: letters, numbers and _ only, up to 15.");
  const raw = String(b.address || "").trim();
  if (!raw) return fieldError(res, "address", "This is a required question.");
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) return fieldError(res, "address", "Enter a valid EVM address: 0x followed by 40 characters.");
  if (!P.ethers.isAddress(raw)) return fieldError(res, "address", "This address has a typo (its checksum does not match). Copy it again from your wallet.");
  const addr = P.ethers.getAddress(raw.toLowerCase());
  if (/^0x0{40}$/i.test(addr)) return fieldError(res, "address", "That is the zero address. Enter your own wallet address.");

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || (req.socket && req.socket.remoteAddress) || "?";
  const ipKey = "ap:ip:" + ip;
  const [, seen] = await P.redisMulti([["SET", ipKey, "0", "NX", "EX", "3600"], ["INCR", ipKey]]);
  if (Number(seen) > PER_IP_HOUR) throw P.fail(429, "Too many submissions from your network. Try again in an hour.");

  const al = addr.toLowerCase(), ul = user.toLowerCase();
  const prevRaw = await P.redis(["HGET", "ap:a", al]);
  const prev = prevRaw ? JSON.parse(prevRaw) : null;
  if (prev && prev.u.toLowerCase() === ul) return P.send(res, 200, { ok: true, n: prev.n, username: prev.u, address: prev.a, updated: false });

  // Claim the username for this address (one address per username).
  if ((await P.redis(["HSETNX", "ap:u", ul, al])) !== 1) {
    const owner = await P.redis(["HGET", "ap:u", ul]);
    if (owner !== al) return P.send(res, 409, { error: `@${user} has already applied with a different address.`, field: "username" });
  }
  if (prev) {
    // Same address, new username: the applicant fixed a typo. Keep their number, free the old username.
    const entry = { ...prev, u: user, t: Date.now() };
    await P.redisMulti([["HSET", "ap:a", al, JSON.stringify(entry)], ["HDEL", "ap:u", prev.u.toLowerCase()]]);
    return P.send(res, 200, { ok: true, n: entry.n, username: user, address: addr, updated: true });
  }
  const n = Number(await P.redis(["INCR", "ap:n"]));
  await P.redis(["HSET", "ap:a", al, JSON.stringify({ n, u: user, a: addr, t: Date.now() })]);
  P.send(res, 200, { ok: true, n, username: user, address: addr, updated: false });
}

async function list(req, res) {
  const a = P.readToken(req);
  if (!a) throw P.fail(401, "Sign in again");
  if (!ADMINS.has(a)) throw P.fail(403, `Only the null team can see responses. You are signed in as ${a.slice(0, 6)}…${a.slice(-4)}.`);
  const items = Object.values(P.pairs(await P.redis(["HGETALL", "ap:a"])))
    .map((v) => { try { return JSON.parse(v); } catch { return null; } })
    .filter(Boolean)
    .sort((x, y) => x.n - y.n);
  P.send(res, 200, { count: items.length, items });
}

async function handle(req, res) {
  if (isList(req)) {
    if (req.method !== "GET") throw P.fail(405, "GET only");
    return list(req, res);
  }
  if (req.method !== "POST") throw P.fail(405, "POST only");
  return submit(req, res);
}

module.exports = { isApply, handle, ADMINS };
