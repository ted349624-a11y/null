// POST { username } — links an X username to the signed-in wallet (one wallet per username) and
// brings over the X quests already done under that username on the homepage.
// Also serves the /apply form (/api/apply, /api/apply/responses; see lib/apply.js).
const P = require("../lib/points");
const A = require("../lib/apply");
module.exports = P.handler(async (req, res) => {
  if (A.isApply(req)) return A.handle(req, res);
  if (req.method !== "POST") throw P.fail(405, "POST only");
  const a = P.readToken(req);
  if (!a) throw P.fail(401, "Sign in again");
  const raw = P.normHandle((await P.body(req)).username);
  if (!raw) throw P.fail(400, "Enter a valid X username (letters, numbers and _ only, up to 15).");
  const handle = raw.toLowerCase();
  const prev = (await P.getProfile(a)).x;
  if (prev && prev.toLowerCase() !== handle) throw P.fail(409, `This wallet is already linked to @${prev}.`);
  if (!prev) {
    const ok = await P.redis(["SET", `x:${handle}`, a, "NX"]);
    if (ok !== "OK" && (await P.redis(["GET", `x:${handle}`])) !== a) throw P.fail(409, `@${raw} is already linked to another wallet.`);
    await P.redis(["HSET", `u:${a}`, "x", raw]);
  }
  await P.syncX(a, handle);
  P.send(res, 200, await P.getProfile(a));
});
