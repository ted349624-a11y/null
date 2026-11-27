// Quest settings. Env vars X_HANDLE / X_POST_ID (Vercel → Settings → Environment Variables) override these.
module.exports = {
  xHandle: "nullfamily",   // X account to follow, without @
  postId: "2125916389743739331", // numeric id of the post to like / repost / reply to (from x.com/<handle>/status/<id>)
  pointsOpen: false, // points are closed for now: no new quests or wallet links (stored points stay). Env POINTS_OPEN=1 reopens.
};
