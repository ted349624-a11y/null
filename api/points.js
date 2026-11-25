// GET ?address=0x… — public points lookup (used by the testnet header).
const P = require("../lib/points");
module.exports = P.handler(async (req, res) => {
  const addr = new URL(req.url, "http://x").searchParams.get("address") || "";
  if (!P.ethers.isAddress(addr)) throw P.fail(400, "Bad address");
  const p = await P.getProfile(addr.toLowerCase());
  P.send(res, 200, { address: p.address, points: p.points, rank: p.rank, done: p.done.length, total: P.TASKS.length });
});
