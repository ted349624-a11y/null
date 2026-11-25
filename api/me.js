const P = require("../lib/points");
module.exports = P.handler(async (req, res) => {
  const a = P.readToken(req);
  if (!a) throw P.fail(401, "Sign in again");
  P.send(res, 200, await P.getProfile(a));
});
