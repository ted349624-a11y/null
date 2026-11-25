// POST { id, tx? } — completes the next task. X tasks are self-reported; testnet tasks are verified on-chain.
const P = require("../lib/points");
module.exports = P.handler(async (req, res) => {
  if (req.method !== "POST") throw P.fail(405, "POST only");
  const a = P.readToken(req);
  if (!a) throw P.fail(401, "Sign in again");
  const { id, tx } = await P.body(req);
  const idx = P.TASKS.findIndex((t) => t.id === id);
  if (idx < 0) throw P.fail(400, "Unknown task");
  const profile = await P.getProfile(a);
  if (!profile.x) throw P.fail(400, "Add your X username first.");
  if (profile.done.includes(id)) return P.send(res, 200, profile);
  const next = P.TASKS.find((t) => !profile.done.includes(t.id));
  if (!next || next.id !== id) throw P.fail(400, "Finish the tasks in order.");
  const task = P.TASKS[idx];
  if (!P.publicConfig().ready) throw P.fail(503, "Quests open soon.");
  if (task.kind === "chain") {
    let ok = false;
    if (tx) { try { const t = await P.txByHash(a, tx); ok = Boolean(t && task.check(t)); } catch {} }
    if (!ok) { try { ok = (await P.walletTxs(a)).some(task.check); } catch {} }
    if (!ok) throw P.fail(400, `No matching ${P.TESTNET.chainName} transaction from this wallet yet. It can take a minute to show up — try again shortly.`);
  }
  const first = await P.redis(["HSETNX", `u:${a}`, `t:${id}`, String(Date.now())]);
  if (Number(first) === 1) {
    await P.redis(["HINCRBY", `u:${a}`, "points", P.POINTS_PER_TASK]);
    await P.redis(["ZINCRBY", "lb", P.POINTS_PER_TASK, a]);
  }
  P.send(res, 200, await P.getProfile(a));
});
