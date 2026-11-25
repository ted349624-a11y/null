const P = require("../lib/points");
module.exports = P.handler(async (req, res) => {
  const [flat, players] = await P.redisMulti([["ZREVRANGE", "lb", "0", "19", "WITHSCORES"], ["ZCARD", "lb"]]);
  const addrs = [];
  for (let i = 0; i < (flat || []).length; i += 2) addrs.push([flat[i], Number(flat[i + 1])]);
  const hs = addrs.length ? await P.redisMulti(addrs.map(([a]) => ["HGET", `u:${a}`, "x"])) : [];
  const rows = addrs.map(([a, points], i) => ({ rank: i + 1, address: a.slice(0, 6) + "…" + a.slice(-4), x: hs[i] || "", points }));
  P.send(res, 200, { rows, players: Number(players || 0) });
});
