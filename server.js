// Roblox profile card server. Needs Node 18+, no npm packages, no API keys, no cookies, no passwords.
// Run:  ROBLOX_USER=yourUsername node server.js      (Windows PowerShell: $env:ROBLOX_USER="yourUsername"; node server.js)
// Open: http://localhost:8888
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const PORT = process.env.PORT || 8888;
const DEFAULT_USER = process.env.ROBLOX_USER || process.argv[2] || "";
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36", Accept: "application/json, text/plain, */*", "Accept-Language": "en-US,en;q=0.9", Origin: "https://www.roblox.com", Referer: "https://www.roblox.com/" };
const cache = new Map();       // userId -> { ver, mh, meta, at }
const assets = new Map();      // content-addressed rbxcdn files (hash -> {buf,type})

class Err extends Error { constructor(m, d, code) { super(m); this.detail = d; this.code = code || 502; } }
const sha = s => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
const sleep = ms => new Promise(r => setTimeout(r, ms));
function send(res, code, obj) { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(obj)); }

async function rj(url, opt) {
  let r; const host = new URL(url).host;
  for (let a = 0; a < 3; a++) { // retry politely when Roblox says "too many requests"
    try { r = await fetch(url, opt); } catch (e) { throw new Err("This computer cannot reach Roblox (" + host + ")", String(e.cause && e.cause.code || e.message)); }
    if (r.status !== 429 || a === 2) break;
    await sleep(Math.min(5, +r.headers.get("retry-after") || a + 1) * 1000);
  }
  if (!r.ok) throw new Err("Roblox answered HTTP " + r.status + " from " + host, (await r.text()).slice(0, 200));
  try { return JSON.parse(await r.text()); } catch (e) { throw new Err("Roblox sent a response that is not JSON (" + host + ")"); }
}

async function resolveUser(q) {
  q = (q || "").trim();
  if (!q) throw new Err("No Roblox username set", "Type it in the dashboard (Avatar section) or start the server with ROBLOX_USER=yourname", 400);
  const m = q.match(/^id:(\d+)$/i) || (/^\d+$/.test(q) && [0, q]);
  if (m) return { id: +m[1], name: "id " + m[1] };
  const d = await rj("https://users.roblox.com/v1/usernames/users", { method: "POST", headers: { ...UA, "Content-Type": "application/json" }, body: JSON.stringify({ usernames: [q], excludeBannedUsers: false }) });
  if (!d.data || !d.data.length) throw new Err("Roblox user not found", 'No account is named "' + q + '"', 404);
  return { id: d.data[0].id, name: d.data[0].name };
}

// Fingerprint of what you're wearing right now (not cached by Roblox's thumbnail system) – used to detect changes.
async function avatarVersion(id) {
  const a = await rj("https://avatar.roblox.com/v1/users/" + id + "/avatar", { headers: UA });
  return sha(JSON.stringify([(a.assets || []).map(x => [x.id, x.currentVersionId || 0]).sort((p, q) => p[0] - q[0]), a.bodyColors, a.bodyColor3s, a.scales, a.playerAvatarType, a.emotes]));
}

// Flat avatar picture (2D thumbnails still work without a Roblox login)
async function thumb(id) {
  for (let i = 0; i < 15; i++) {
    const t = await rj("https://thumbnails.roblox.com/v1/users/avatar?userIds=" + id + "&size=720x720&format=Png&isCircular=false", { headers: UA });
    const d = t.data && t.data[0], st = d && d.state;
    if (st === "Completed" && d.imageUrl) return { imageUrl: d.imageUrl };
    if (!d || st === "Pending" || st === "TemporarilyUnavailable") { await sleep(1200); continue; }
    throw new Err("Roblox will not give a picture for this user", "Thumbnail state: " + st + (st === "Blocked" ? " (the avatar or an item is moderated)" : st === "InReview" ? " (in moderation review)" : ""));
  }
  throw new Err("Roblox is still generating the picture", "Timed out after ~18s; it will retry on the next check", 504);
}

// Fewer Roblox calls: user id remembered, picture re-checked at most once a minute for ALL visitors,
// and if Roblox refuses (e.g. rate limit) the last good picture keeps showing.
const users = new Map(); let cooldown = 0;
async function avatar(q, force) {
  const name = (q || DEFAULT_USER || "").trim(), key = name.toLowerCase(), now = Date.now(), c = cache.get(key);
  const out = (c, extra) => ({ userId: c.userId, username: c.username, modelHash: c.mh, image: "/api/img?u=" + encodeURIComponent(c.imageUrl), ...extra });
  if (c && now - c.at < (force ? 15e3 : 6e4)) return out(c);
  if (c && now < cooldown) return out(c, { stale: true, note: "Roblox is limiting this server, showing last picture" });
  try {
    let u = users.get(key); if (!u) { u = await resolveUser(name); users.set(key, u); }
    const meta = await thumb(u.id);
    const n = { userId: u.id, username: u.name, imageUrl: meta.imageUrl, mh: sha(meta.imageUrl), at: Date.now() };
    cache.set(key, n); return out(n);
  } catch (e) {
    if (/429/.test(e.message)) cooldown = Date.now() + 60e3;
    if (c) return out(c, { stale: true, note: e.message });
    throw e;
  }
}

function cdnHost(h) { let i = 31; for (const ch of h) i ^= ch.charCodeAt(0); return "t" + (i % 8) + ".rbxcdn.com"; }
async function asset(hash, res) {
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(hash)) return send(res, 400, { error: "bad asset hash" });
  let a = assets.get(hash);
  if (!a) {
    const first = cdnHost(hash), hosts = [first, ...[0, 1, 2, 3, 4, 5, 6, 7].map(n => "t" + n + ".rbxcdn.com").filter(h => h !== first)];
    for (const h of hosts) {
      try {
        const r = await fetch("https://" + h + "/" + hash, { headers: UA });
        if (r.ok) { const buf = Buffer.from(await r.arrayBuffer()); a = { buf, type: buf[0] === 0x89 && buf[1] === 0x50 ? "image/png" : buf[0] === 0xff ? "image/jpeg" : "text/plain" }; break; }
      } catch (e) { /* try next host */ }
    }
    if (!a) return send(res, 502, { error: "Roblox CDN has no file " + hash });
    if (assets.size > 300) assets.delete(assets.keys().next().value);
    assets.set(hash, a);
  }
  res.writeHead(200, { "Content-Type": a.type, "Cache-Control": "public, max-age=31536000, immutable" }); res.end(a.buf); // content-addressed: safe to cache forever
}

async function img(u, res) {
  let url; try { url = new URL(u); } catch (e) { return send(res, 400, { error: "bad url" }); }
  if (url.protocol !== "https:" || !/(^|\.)rbxcdn\.com$/.test(url.hostname)) return send(res, 400, { error: "only rbxcdn.com pictures are allowed" });
  let r; try { r = await fetch(url, { headers: UA }); } catch (e) { return send(res, 502, { error: "could not download the picture from Roblox" }); }
  if (!r.ok) return send(res, 502, { error: "Roblox CDN answered HTTP " + r.status });
  const buf = Buffer.from(await r.arrayBuffer());
  res.writeHead(200, { "Content-Type": r.headers.get("content-type") || "image/png", "Cache-Control": "public, max-age=86400" }); res.end(buf);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/api/avatar") return send(res, 200, await avatar(url.searchParams.get("user"), url.searchParams.get("force") === "1"));
    if (url.pathname === "/api/img") return img(url.searchParams.get("u") || "", res);
    if (url.pathname.startsWith("/api/asset/")) return asset(url.pathname.slice(11), res);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const f = path.join(__dirname, "index.html");
      if (!fs.existsSync(f)) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("index.html was not found in this folder:\n" + __dirname + "\n\nPut index.html in the same folder as server.js (check it isn't named 'index (1).html'), then refresh."); }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); return res.end(fs.readFileSync(f));
    }
    send(res, 404, { error: "not found" });
  } catch (e) { if (res.headersSent) return res.end(); send(res, e.code || 500, { error: e.message, detail: e.detail || "" }); }
}).listen(PORT, () => console.log("Profile card running at http://localhost:" + PORT + (DEFAULT_USER ? "  (default Roblox user: " + DEFAULT_USER + ")" : "  (no ROBLOX_USER set – enter it in the dashboard)")));
