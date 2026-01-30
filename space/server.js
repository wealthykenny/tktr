import express from "express";
import helmet from "helmet";
import session from "express-session";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import db from "./db.js";

const app = express();

// ---- config ----
const PORT = process.env.PORT || 7860;

// Set these in HF Space “Secrets”:
// ADMIN_USERNAME, ADMIN_PASSWORD
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || null;

// Optional: allow your Netlify domain to read the API
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://tektrey.online";

// ---- security basics ----
app.use(helmet({
  contentSecurityPolicy: false // keep simple for now; can harden later
}));
app.use(cookieParser());
app.use(express.json({ limit: "1mb" }));

app.set("trust proxy", 1);

app.use(session({
  name: "tektrey.sid",
  secret: process.env.SESSION_SECRET || "change-me-in-secrets",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: true // HF is https
  }
}));

// Rate limit login + write endpoints
const writeLimiter = rateLimit({
  windowMs: 60_000,
  max: 60
});
app.use("/api/", writeLimiter);

// CORS (minimal)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---- seed admin user if not exists (requires ADMIN_PASSWORD set once) ----
function ensureAdminUser() {
  const existing = db.prepare("SELECT * FROM users WHERE username=?").get(ADMIN_USERNAME);
  if (existing) return;

  if (!ADMIN_PASSWORD) {
    console.warn("[WARN] No ADMIN_PASSWORD set; cannot seed initial admin user.");
    return;
  }

  const password_hash = bcrypt.hashSync(ADMIN_PASSWORD, 12);
  db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')")
    .run(ADMIN_USERNAME, password_hash);

  console.log("[OK] Seeded admin user:", ADMIN_USERNAME);
}
ensureAdminUser();

function requireAuth(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ error: "Unauthorized" });
  next();
}

function audit(actor, action, entity, entity_id = null, meta = {}) {
  db.prepare(`
    INSERT INTO audit_log (actor, action, entity, entity_id, meta_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(actor, action, entity, entity_id, JSON.stringify(meta));
}

// ---- static admin UI ----
app.use("/admin", express.static("public/admin", { fallthrough: true }));
app.get("/admin/*", (req, res) => res.sendFile(process.cwd() + "/public/admin/index.html"));

// ---- auth ----
app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare("SELECT username, password_hash, role FROM users WHERE username=?").get(username);
  if (!user) return res.status(401).json({ error: "Invalid credentials" });

  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });

  req.session.user = { username: user.username, role: user.role };
  audit(user.username, "login", "auth", null, {});
  res.json({ ok: true, user: req.session.user });
});

app.post("/api/logout", requireAuth, (req, res) => {
  const actor = req.session.user.username;
  req.session.destroy(() => {
    audit(actor, "logout", "auth", null, {});
    res.json({ ok: true });
  });
});

app.get("/api/me", (req, res) => {
  res.json({ user: req.session?.user || null });
});

// ---- PUBLIC content endpoint (Netlify site reads this) ----
app.get("/api/public/content", (req, res) => {
  const content = db.prepare("SELECT hero_headline, hero_subtitle, updated_at FROM content WHERE id=1").get();
  const skills = db.prepare("SELECT id, label, percent FROM skills ORDER BY sort ASC, id ASC").all();
  const projects = db.prepare(`
    SELECT id, title, summary, stack, links_json, featured, sort, updated_at
    FROM projects
    ORDER BY featured DESC, sort ASC, id DESC
  `).all().map(p => ({ ...p, links: JSON.parse(p.links_json || "[]") }));

  res.json({ content, skills, projects });
});

// ---- ADMIN CRUD ----
app.get("/api/admin/content", requireAuth, (req, res) => {
  const content = db.prepare("SELECT hero_headline, hero_subtitle, updated_at FROM content WHERE id=1").get();
  res.json({ content });
});

app.put("/api/admin/content", requireAuth, (req, res) => {
  const { hero_headline, hero_subtitle } = req.body || {};
  if (!hero_headline || !hero_subtitle) return res.status(400).json({ error: "Missing fields" });

  db.prepare(`
    UPDATE content
    SET hero_headline=?, hero_subtitle=?, updated_at=datetime('now')
    WHERE id=1
  `).run(hero_headline.trim(), hero_subtitle.trim());

  audit(req.session.user.username, "update", "content", 1, {});
  res.json({ ok: true });
});

// Skills
app.get("/api/admin/skills", requireAuth, (req, res) => {
  const skills = db.prepare("SELECT id, label, percent, sort FROM skills ORDER BY sort ASC, id ASC").all();
  res.json({ skills });
});

app.post("/api/admin/skills", requireAuth, (req, res) => {
  const { label, percent, sort = 0 } = req.body || {};
  if (!label) return res.status(400).json({ error: "Label required" });
  const pct = Number(percent);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return res.status(400).json({ error: "Percent 0-100" });

  const info = db.prepare("INSERT INTO skills (label, percent, sort) VALUES (?, ?, ?)").run(label.trim(), pct, sort);
  audit(req.session.user.username, "create", "skill", info.lastInsertRowid, { label, percent: pct });
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.put("/api/admin/skills/:id", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const { label, percent, sort = 0 } = req.body || {};
  const pct = Number(percent);
  if (!label) return res.status(400).json({ error: "Label required" });
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return res.status(400).json({ error: "Percent 0-100" });

  db.prepare("UPDATE skills SET label=?, percent=?, sort=? WHERE id=?").run(label.trim(), pct, sort, id);
  audit(req.session.user.username, "update", "skill", id, { label, percent: pct });
  res.json({ ok: true });
});

app.delete("/api/admin/skills/:id", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  db.prepare("DELETE FROM skills WHERE id=?").run(id);
  audit(req.session.user.username, "delete", "skill", id, {});
  res.json({ ok: true });
});

// Projects
app.get("/api/admin/projects", requireAuth, (req, res) => {
  const projects = db.prepare(`
    SELECT id, title, summary, stack, links_json, featured, sort, updated_at
    FROM projects
    ORDER BY featured DESC, sort ASC, id DESC
  `).all().map(p => ({ ...p, links: JSON.parse(p.links_json || "[]") }));

  res.json({ projects });
});

app.post("/api/admin/projects", requireAuth, (req, res) => {
  const { title, summary, stack = "", links = [], featured = 0, sort = 0 } = req.body || {};
  if (!title || !summary) return res.status(400).json({ error: "Title and summary required" });

  const info = db.prepare(`
    INSERT INTO projects (title, summary, stack, links_json, featured, sort)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    title.trim(),
    summary.trim(),
    String(stack || "").trim(),
    JSON.stringify(Array.isArray(links) ? links : []),
    featured ? 1 : 0,
    sort
  );

  audit(req.session.user.username, "create", "project", info.lastInsertRowid, { title });
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.put("/api/admin/projects/:id", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const { title, summary, stack = "", links = [], featured = 0, sort = 0 } = req.body || {};
  if (!title || !summary) return res.status(400).json({ error: "Title and summary required" });

  db.prepare(`
    UPDATE projects
    SET title=?, summary=?, stack=?, links_json=?, featured=?, sort=?, updated_at=datetime('now')
    WHERE id=?
  `).run(
    title.trim(),
    summary.trim(),
    String(stack || "").trim(),
    JSON.stringify(Array.isArray(links) ? links : []),
    featured ? 1 : 0,
    sort,
    id
  );

  audit(req.session.user.username, "update", "project", id, { title });
  res.json({ ok: true });
});

app.delete("/api/admin/projects/:id", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  db.prepare("DELETE FROM projects WHERE id=?").run(id);
  audit(req.session.user.username, "delete", "project", id, {});
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Admin/API running on :${PORT}`));
