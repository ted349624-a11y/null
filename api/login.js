// GET  ?address=0x…                    -> { message, issuedAt }   (text for the wallet to sign)
// POST { address, issuedAt, signature } -> { token, profile }
const P = require("../lib/points");
module.exports = P.handler(async (req, res) => {
  if (req.method === "GET") {
    const address = new URL(req.url, "http://x").searchParams.get("address") || "";
    if (!P.ethers.isAddress(address)) throw P.fail(400, "Bad address");
    const issuedAt = new Date().toISOString();
    return P.send(res, 200, { issuedAt, message: P.loginMessage(P.ethers.getAddress(address), issuedAt) });
  }
  if (req.method !== "POST") throw P.fail(405, "GET or POST");
  const { address, issuedAt, signature } = await P.body(req);
  if (!P.ethers.isAddress(address || "") || typeof signature !== "string" || typeof issuedAt !== "string") throw P.fail(400, "Bad request");
  const t = Date.parse(issuedAt);
  if (!isFinite(t) || Math.abs(Date.now() - t) > 10 * 60 * 1000) throw P.fail(400, "Signature expired. Try again.");
  const addr = P.ethers.getAddress(address);
  let signer;
  try { signer = P.ethers.verifyMessage(P.loginMessage(addr, issuedAt), signature); } catch { throw P.fail(401, "Invalid signature"); }
  if (signer !== addr) throw P.fail(401, "Signature does not match the wallet");
  const a = addr.toLowerCase();
  P.send(res, 200, { token: P.issueToken(a), profile: await P.getProfile(a) });
});
