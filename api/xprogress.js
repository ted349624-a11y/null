// X quests on the homepage, no wallet needed; progress is kept per X username.
// GET  ?u=<username>      -> { username, done, linked }
// POST { username, id }   -> marks the next X quest done (in order); if the username is already
//                            linked to a wallet, the points go straight to that wallet.
const P = require("../lib/points");
async function state(h) {
  const lc = h.toLowerCase();
  const [p, owner] = [await P.xProgress(lc), await P.redis(["GET", `x:${lc}`])];
  return { username: p.name || h, done: p.done, points: p.points, redo: p.redo, linked: Boolean(owner), owner };
}
module.exports = P.handler(async (req, res) => {
  if (req.method === "GET") {
    const h = P.normHandle(new URL(req.url, "http://x").searchParams.get("u"));
    if (!h) throw P.fail(400, "Enter a valid X username (letters, numbers and _ only, up to 15).");
    const { owner, ...s } = await state(h);
    return P.send(res, 200, s);
  }
  if (req.method !== "POST") throw P.fail(405, "GET or POST");
  if (!P.publicConfig().ready) throw P.fail(503, "Quests open soon.");
  const b = await P.body(req);
  const h = P.normHandle(b.username);
  if (!h) throw P.fail(400, "Enter a valid X username (letters, numbers and _ only, up to 15).");
  const task = P.X_TASKS.find((t) => t.id === b.id);
  if (!task) throw P.fail(400, "Unknown quest");
  const lc = h.toLowerCase();
  let s = await state(h);
  if (!s.done.includes(task.id)) {
    const next = P.X_TASKS.find((t) => !s.done.includes(t.id));
    if (!next || next.id !== task.id) throw P.fail(400, "Finish the quests in order.");
    await P.redisMulti([["HSETNX", `xq:${lc}`, `t:${task.id}`, String(Date.now())], ["HSETNX", `xq:${lc}`, "name", h]]);
    if (s.owner) await P.syncX(s.owner, lc);
    s = await state(h);
  }
  const { owner, ...out } = s;
  P.send(res, 200, out);
});
