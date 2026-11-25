// Quest settings. Env vars X_HANDLE / X_POST_ID (Vercel → Settings → Environment Variables) override these.
module.exports = {
  xHandle: "",   // X account to follow, without @
  postId: "",    // numeric id of the post to like / repost / reply to (from x.com/<handle>/status/<id>)
};
