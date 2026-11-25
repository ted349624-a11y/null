const P = require("../lib/points");
module.exports = P.handler(async (req, res) => P.send(res, 200, P.publicConfig()));
