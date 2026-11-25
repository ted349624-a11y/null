// POST { username } — links one X username to the signed-in wallet (one wallet per username).
const P = require("../lib/points");
module.exports = P.handler(async (req, res) => {
  if (req.method !== "POST") throw P.fail(405, "POST only");
  const a = P.readToken(req);
  if (!a) throw P.fail(401, "Sign in again");
  const raw = String((await P.body(req)).username || "").trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, "").split(/[/?#]/)[0];
  if (!/^[A-Za-z0-9_]{1,15}$/.test(raw)) throw P.fail(400, "Enter a valid X username (letters, numbers, _ ; max 15).");
  const handle = raw.toLowerCase();
  const prev = (await P.getProfile(a)).x;
  if (prev && prev.toLowerCase() === handle) return P.send(res, 200, await P.getProfile(a));
  if (prev) throw P.fail(409, `This wallet is already linked to @${prev}.`);
  const ok = await P.redis(["SET", `x:${handle}`, a, "NX"]);
  if (ok !== "OK" && (await P.redis(["GET", `x:${handle}`])) !== a) throw P.fail(409, "That X username is already linked to another wallet.");
  await P.redis(["HSET", `u:${a}`, "x", raw]);
  P.send(res, 200, await P.getProfile(a));
});
