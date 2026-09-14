require('dotenv').config();
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');

const { db, initDb } = require('./lib/db');
const { uploadFile, deleteFile, downloadFile } = require('./lib/drive');
const { getAuthUrl, getTokens } = require('./lib/google-oauth');
const U = require('./lib/util');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const CONFIG = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {};
const PORT = parseInt(process.env.PORT || CONFIG.server?.port || 3000, 10);
const IS_PROD = process.env.NODE_ENV === 'production';
const SESSION_SECRET = process.env.SESSION_SECRET || 'HamadaPortal_2026_DefaultSecret_9x2K8p';

const MAX_FILE_MB = 25;
const MAX_FILES_PER_REQ = 12;
const ALLOW_EXT = new Set(['pdf', 'png', 'jpg', 'jpeg', 'xlsx', 'xls', 'docx', 'doc', 'csv', 'txt', 'zip']);

/* ----------------------------- admin bootstrap ---------------------------- */
async function bootstrapAdmin() {
  try {
    const row = await db.get("SELECT id FROM users WHERE role='admin' LIMIT 1");
    if (row) return;

    const a = CONFIG.admin || {};
    const email = String(a.email || 'doma20091212@gmail.com').trim().toLowerCase();
    const phone = U.normalizePhone(a.phone || '01010799378');
    const pw = String(a.password || phone);

    await db.run(
      `INSERT INTO users (role, name, name_ar, email, phone, password_hash, must_change, active)
       VALUES ($1, $2, $3, $4, $5, $6, 1, 1)`,
      ['admin', a.name || 'Hamada Ahmed Ali', a.name_ar || 'حمادة أحمد علي', email, phone, bcrypt.hashSync(pw, 10)]
    );
    console.log(`[boot] Admin account created → login: ${email} | password: ${pw}`);
  } catch (err) {
    console.error('[boot] Error bootstrapping admin account:', err.message);
  }
}

/* --------------------------------- upload middleware -------------------------------- */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: MAX_FILES_PER_REQ },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(U.latinFix(file.originalname)).toLowerCase().slice(1);
    if (ALLOW_EXT.has(ext)) return cb(null, true);
    const err = new Error('bad_type');
    err.uploadFail = true;
    cb(err);
  },
});

function withUpload(req, res, next) {
  upload.array('files', MAX_FILES_PER_REQ)(req, res, (err) => {
    if (err) {
      if (err.message === 'bad_type') return res.status(400).json({ error: 'file_type_not_allowed' });
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'file_too_large', limit_mb: MAX_FILE_MB });
      if (err.code === 'LIMIT_UNEXPECTED_FILE') return res.status(400).json({ error: 'too_many_files', max: MAX_FILES_PER_REQ });
      return res.status(400).json({ error: 'upload_failed' });
    }
    next();
  });
}

async function saveFiles({ client_id, sender_id, inbox, folder, note, files }) {
  const rows = [];
  for (const f of files) {
    const name = U.sanitizeFilename(U.latinFix(f.originalname));
    const uploaded = await uploadFile(f);
    const result = await db.run(
      `INSERT INTO files (client_id, sender_id, inbox, name, stored, size, mime, folder, note, is_read)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0) RETURNING id`,
      [client_id, sender_id, inbox ? 1 : 0, name, uploaded.stored, f.size || 0, f.mimetype || '', folder || '', note || '']
    );
    const newId = result.rows && result.rows[0] ? result.rows[0].id : result.lastID;
    rows.push({ id: newId, name, size: f.size, folder: folder || '', mime: f.mimetype || '' });
  }
  return rows;
}

async function deleteFileRow(id) {
  const f = await db.get(`SELECT * FROM files WHERE id=$1`, [id]);
  if (!f) return false;
  await db.run(`DELETE FROM files WHERE id=$1`, [id]);
  await deleteFile(f.stored);
  return true;
}

/* --------------------------------- app setup -------------------------------- */
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(
  cookieSession({
    name: 'session',
    keys: [SESSION_SECRET],
    maxAge: 7 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
    secure: IS_PROD,
    httpOnly: true,
  })
);

app.use(async (req, res, next) => {
  req.user = null;
  if (req.session && req.session.uid) {
    const u = await db.get(`SELECT id, role, name, name_ar, email, phone, must_change, active FROM users WHERE id=$1`, [req.session.uid]);
    if (u && u.active) req.user = u;
    else req.session = null;
  }
  next();
});

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'unauthorized' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  next();
}
function requireClient(req, res, next) {
  if (!req.user || req.user.role !== 'client') return res.status(403).json({ error: 'forbidden' });
  next();
}

function pubUser(u) {
  if (!u) return null;
  return { id: u.id, role: u.role, name: u.name, name_ar: u.name_ar, email: u.email, phone: u.phone, must_change: !!u.must_change };
}

/* ---------------------------------- auth ------------------------------------ */
const attempts = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of attempts) if (v.lockUntil && v.lockUntil < now && v.n === 0) attempts.delete(k);
}, 10 * 60 * 1000).unref();

app.post('/api/login', async (req, res) => {
  const ip = req.ip || 'anon';
  const rec = attempts.get(ip);
  if (rec && rec.lockUntil > Date.now()) return res.status(429).json({ error: 'too_many_attempts' });

  const { identifier = '', password = '' } = req.body || {};
  const ident = String(identifier).trim();
  const phone = U.normalizePhone(ident);
  if (!ident || !password) return res.status(400).json({ error: 'fill_fields' });

  const u = await db.get(`SELECT * FROM users WHERE lower(email)=$1 OR phone=$2`, [ident.toLowerCase(), phone]);
  if (!u || !bcrypt.compareSync(String(password), u.password_hash)) {
    const n = (rec ? rec.n : 0) + 1;
    attempts.set(ip, { n, lockUntil: n >= 8 ? Date.now() + 10 * 60 * 1000 : 0 });
    return res.status(401).json({ error: 'bad_credentials' });
  }
  if (!u.active) return res.status(403).json({ error: 'account_disabled' });

  attempts.delete(ip);
  req.session.uid = u.id;
  req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.json({ user: pubUser(u), csrf: req.session.csrf });
});

app.get('/api/session', (req, res) => {
  if (!req.user) return res.json({ user: null });
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.json({ user: pubUser(req.user), csrf: req.session.csrf });
});

app.post('/api/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.post('/api/password', requireAuth, async (req, res) => {
  const { current = '', next: np = '' } = req.body || {};
  const me = await db.get(`SELECT password_hash FROM users WHERE id=$1`, [req.user.id]);
  if (!bcrypt.compareSync(String(current), me.password_hash)) return res.status(400).json({ error: 'bad_current' });
  if (String(np).length < 8) return res.status(400).json({ error: 'weak_password' });
  if (String(np) === String(current)) return res.status(400).json({ error: 'same_password' });

  await db.run(`UPDATE users SET password_hash=$1, must_change=0 WHERE id=$2`, [bcrypt.hashSync(String(np), 10), req.user.id]);
  res.json({ ok: true });
});

app.get('/api/brand', (req, res) => res.json(CONFIG.brand || {}));

/* --------------------------------- client ----------------------------------- */
app.get('/api/me', requireClient, async (req, res) => {
  const me = req.user;
  const files = await db.all(
    `SELECT id, name, size, mime, folder, created_at FROM files WHERE client_id=$1 AND inbox=0 ORDER BY folder ASC, name ASC`,
    [me.id]
  );
  const sent = await db.all(
    `SELECT id, name, size, is_read, created_at FROM files WHERE sender_id=$1 AND inbox=1 ORDER BY created_at DESC`,
    [me.id]
  );
  res.json({ user: pubUser(me), files, sent });
});

app.get('/api/me/files', requireClient, async (req, res) => {
  const me = req.user;
  const files = await db.all(
    `SELECT id, name, size, mime, folder, created_at FROM files WHERE client_id=$1 AND inbox=0 ORDER BY folder ASC, name ASC`,
    [me.id]
  );
  const sent = await db.all(
    `SELECT id, name, size, is_read, created_at FROM files WHERE sender_id=$1 AND inbox=1 ORDER BY created_at DESC`,
    [me.id]
  );
  res.json({ user: pubUser(me), files, sent });
});

app.post('/api/me/send', requireClient, withUpload, async (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'no_files' });
  const note = U.sanitizeName((req.body && req.body.note) || '', 500);
  try {
    const rows = await saveFiles({ client_id: req.user.id, sender_id: req.user.id, inbox: 1, files: req.files, note });
    res.json({ ok: true, count: rows.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.delete('/api/me/sent/:id', requireClient, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const f = await db.get(`SELECT id, sender_id, inbox FROM files WHERE id=$1`, [id]);
  if (!f || f.sender_id !== req.user.id || f.inbox !== 1) return res.status(404).json({ error: 'not_found' });
  await deleteFileRow(id);
  res.json({ ok: true });
});

/* --------------------------------- admin ------------------------------------ */
app.get('/api/admin/overview', requireAdmin, async (req, res) => {
  const clientsRow = await db.get(`SELECT COUNT(*)::int AS count FROM users WHERE role='client'`);
  const filesRow = await db.get(`SELECT COUNT(*)::int AS count, COALESCE(SUM(size), 0)::bigint AS bytes FROM files WHERE inbox=0`);
  const unreadRow = await db.get(`SELECT COUNT(*)::int AS count FROM files WHERE inbox=1 AND is_read=0`);

  res.json({
    stats: {
      clients: clientsRow ? clientsRow.count : 0,
      files: filesRow ? filesRow.count : 0,
      unread: unreadRow ? unreadRow.count : 0,
      bytes: filesRow ? parseInt(filesRow.bytes, 10) || 0 : 0,
    }
  });
});

app.get('/api/admin/clients', requireAdmin, async (req, res) => {
  const list = await db.all(`
    SELECT u.id, u.name, u.name_ar, u.email, u.phone, u.active, u.created_at,
           COUNT(f.id)::int AS nfiles,
           COALESCE(SUM(f.size), 0)::bigint AS bytes,
           MAX(f.created_at) AS last_upload
    FROM users u
    LEFT JOIN files f ON f.client_id = u.id AND f.inbox = 0
    WHERE u.role = 'client'
    GROUP BY u.id
    ORDER BY u.id DESC
  `);
  res.json({ clients: list });
});

app.post('/api/admin/clients', requireAdmin, async (req, res) => {
  const { name, name_ar = '', email, phone, password } = req.body || {};
  const sName = U.sanitizeName(name, 120);
  const sAr = U.sanitizeName(name_ar, 120);
  const sEmail = String(email || '').trim().toLowerCase();
  const sPhone = U.normalizePhone(phone);

  if (!sName || !U.validEmail(sEmail) || sPhone.length < 8) {
    return res.status(400).json({ error: 'invalid_client_data' });
  }

  const dup = await db.get(`SELECT id FROM users WHERE lower(email)=$1 OR phone=$2`, [sEmail, sPhone]);
  if (dup) return res.status(409).json({ error: 'email_or_phone_exists' });

  const tempPw = password ? String(password) : sPhone;
  const hash = bcrypt.hashSync(tempPw, 10);

  const r = await db.run(
    `INSERT INTO users (role, name, name_ar, email, phone, password_hash, must_change, active)
     VALUES ('client', $1, $2, $3, $4, $5, 1, 1) RETURNING id`,
    [sName, sAr, sEmail, sPhone, hash]
  );
  const newId = r.rows && r.rows[0] ? r.rows[0].id : r.lastID;

  res.json({
    client: { id: newId, role: 'client', name: sName, name_ar: sAr, email: sEmail, phone: sPhone, must_change: true, active: 1 },
    initial_password: tempPw,
    used_phone_as_password: !password
  });
});

app.put('/api/admin/clients/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const c = await db.get(`SELECT * FROM users WHERE id=$1 AND role='client'`, [id]);
  if (!c) return res.status(404).json({ error: 'not_found' });

  const { name, name_ar, email, phone, active } = req.body || {};
  const sName = name !== undefined ? U.sanitizeName(name, 120) : c.name;
  const sAr = name_ar !== undefined ? U.sanitizeName(name_ar, 120) : c.name_ar;
  const sEmail = email !== undefined ? String(email).trim().toLowerCase() : c.email;
  const sPhone = phone !== undefined ? U.normalizePhone(phone) : c.phone;
  const sActive = active !== undefined ? (active ? 1 : 0) : c.active;

  if (!sName || !U.validEmail(sEmail) || sPhone.length < 8) return res.status(400).json({ error: 'invalid_data' });

  const dup = await db.get(`SELECT id FROM users WHERE (lower(email)=$1 OR phone=$2) AND id<>$3`, [sEmail, sPhone, id]);
  if (dup) return res.status(409).json({ error: 'conflict' });

  await db.run(
    `UPDATE users SET name=$1, name_ar=$2, email=$3, phone=$4, active=$5 WHERE id=$6`,
    [sName, sAr, sEmail, sPhone, sActive, id]
  );

  res.json({ ok: true });
});

app.delete('/api/admin/clients/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const c = await db.get(`SELECT id FROM users WHERE id=$1 AND role='client'`, [id]);
  if (!c) return res.status(404).json({ error: 'not_found' });

  const files = await db.all(`SELECT stored FROM files WHERE client_id=$1`, [id]);
  for (const f of files) {
    await deleteFile(f.stored);
  }
  await db.run(`DELETE FROM users WHERE id=$1`, [id]);
  res.json({ ok: true });
});

app.post('/api/admin/clients/:id/reset', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const c = await db.get(`SELECT id, phone FROM users WHERE id=$1 AND role='client'`, [id]);
  if (!c) return res.status(404).json({ error: 'not_found' });

  const temp = c.phone;
  await db.run(`UPDATE users SET password_hash=$1, must_change=1 WHERE id=$2`, [bcrypt.hashSync(temp, 10), id]);
  res.json({ ok: true, initial_password: temp });
});

app.post('/api/admin/clients/:id/reset-password', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const c = await db.get(`SELECT id, phone FROM users WHERE id=$1 AND role='client'`, [id]);
  if (!c) return res.status(404).json({ error: 'not_found' });

  const temp = c.phone;
  await db.run(`UPDATE users SET password_hash=$1, must_change=1 WHERE id=$2`, [bcrypt.hashSync(temp, 10), id]);
  res.json({ ok: true, initial_password: temp, temp_password: temp });
});

app.get('/api/admin/client-folders/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const c = await db.get(`SELECT id, name, name_ar, email, phone FROM users WHERE id=$1 AND role='client'`, [id]);
  if (!c) return res.status(404).json({ error: 'not_found' });

  const files = await db.all(
    `SELECT f.id, f.name, f.size, f.mime, f.folder, f.note, f.created_at, f.client_id, s.name AS sender_name
     FROM files f
     LEFT JOIN users s ON s.id = f.sender_id
     WHERE f.client_id=$1 AND f.inbox=0
     ORDER BY f.folder ASC, f.name ASC`,
    [id]
  );

  const folders = [...new Set(files.map(f => f.folder).filter(Boolean))].sort();

  res.json({ client: c, files, folders });
});

app.get('/api/admin/clients/:id/files', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const c = await db.get(`SELECT id, name, name_ar, email, phone FROM users WHERE id=$1 AND role='client'`, [id]);
  if (!c) return res.status(404).json({ error: 'not_found' });

  const files = await db.all(
    `SELECT f.id, f.name, f.size, f.mime, f.folder, f.note, f.created_at, f.client_id, s.name AS sender_name
     FROM files f
     LEFT JOIN users s ON s.id = f.sender_id
     WHERE f.client_id=$1 AND f.inbox=0
     ORDER BY f.folder ASC, f.name ASC`,
    [id]
  );

  const folders = [...new Set(files.map(f => f.folder).filter(Boolean))].sort();

  res.json({ client: c, files, folders });
});

app.post('/api/admin/clients/:id/files', requireAdmin, withUpload, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const c = await db.get(`SELECT id FROM users WHERE id=$1 AND role='client'`, [id]);
  if (!c) return res.status(404).json({ error: 'not_found' });
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'no_files' });

  const folder = U.sanitizeFolder((req.body && req.body.folder) || '');
  const note = U.sanitizeName((req.body && req.body.note) || '', 300);

  try {
    const rows = await saveFiles({ client_id: c.id, sender_id: req.user.id, inbox: 0, folder, note, files: req.files });
    res.json({ ok: true, saved: rows.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.put('/api/admin/files/:id', requireAdmin, async (req, res) => {
  const f = await db.get(`SELECT * FROM files WHERE id=$1`, [req.params.id]);
  if (!f) return res.status(404).json({ error: 'not_found' });

  const b = req.body || {};
  const newName = b.name !== undefined ? U.sanitizeFilename(String(b.name)) : f.name;
  const newFolder = b.folder !== undefined ? U.sanitizeFolder(String(b.folder)) : f.folder;
  const newClientId = b.client_id !== undefined ? parseInt(b.client_id, 10) : f.client_id;
  const newInbox = b.inbox !== undefined ? parseInt(b.inbox, 10) : f.inbox;

  await db.run(
    `UPDATE files SET name=$1, folder=$2, client_id=$3, inbox=$4 WHERE id=$5`,
    [newName, newFolder, newClientId, newInbox, f.id]
  );
  res.json({ ok: true });
});

app.delete('/api/admin/files/:id', requireAdmin, async (req, res) => {
  const ok = await deleteFileRow(req.params.id);
  if (!ok) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

app.get('/api/admin/inbox', requireAdmin, async (req, res) => {
  const items = await db.all(`
    SELECT f.id, f.name, f.size, f.mime, f.note, f.created_at, f.is_read,
           c.id AS client_id, c.name AS sender_name, c.email AS sender_email, c.phone AS sender_phone
    FROM files f
    JOIN users c ON c.id = f.client_id
    WHERE f.inbox = 1
    ORDER BY f.created_at DESC
  `);
  await db.run(`UPDATE files SET is_read=1 WHERE inbox=1 AND is_read=0`);
  res.json({ inbox: items });
});

app.post('/api/admin/inbox/:id/file', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const f = await db.get(`SELECT id FROM files WHERE id=$1 AND inbox=1`, [id]);
  if (!f) return res.status(404).json({ error: 'not_found' });

  const folder = U.sanitizeFolder((req.body && req.body.folder) || '');
  await db.run(`UPDATE files SET inbox=0, folder=$1, is_read=1 WHERE id=$2`, [folder, id]);
  res.json({ ok: true });
});

app.get('/api/admin/files', requireAdmin, async (req, res) => {
  const { q = '', client_id = '' } = req.query || {};
  let sql = `
    SELECT f.id, f.name, f.size, f.mime, f.folder, f.created_at, f.client_id, c.name AS client_name
    FROM files f
    JOIN users c ON c.id = f.client_id
    WHERE f.inbox = 0
  `;
  const params = [];
  if (client_id) {
    params.push(parseInt(client_id, 10));
    sql += ` AND f.client_id = $${params.length}`;
  }
  if (q.trim()) {
    params.push(`%${q.trim().toLowerCase()}%`);
    sql += ` AND (lower(f.name) LIKE $${params.length} OR lower(f.folder) LIKE $${params.length})`;
  }
  sql += ` ORDER BY f.created_at DESC LIMIT 2000`;

  const files = await db.all(sql, params);
  res.json({ files });
});

/* --------------------------------- download ---------------------------------- */
app.get('/api/file/:id/download', async (req, res) => {
  const f = await db.get(`SELECT * FROM files WHERE id=$1`, [req.params.id]);
  if (!f) return res.status(404).json({ error: 'not_found' });

  const u = req.user;
  const allowed =
    u && (u.role === 'admin' || (u.role === 'client' && ((f.inbox === 0 && f.client_id === u.id) || f.sender_id === u.id)));

  if (!allowed) return res.status(403).json({ error: 'not_allowed' });

  await downloadFile(f.stored, res, f.name, f.mime);
});

/* -------------------------------- OAuth2 Callbacks --------------------------- */
app.get('/api/auth/google/url', requireAdmin, (req, res) => {
  res.json({ url: getAuthUrl() });
});

app.get('/auth/google/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('Missing authorization code');
  try {
    const tokens = await getTokens(code);
    const refreshToken = tokens.refresh_token;
    if (refreshToken) {
      process.env.GOOGLE_REFRESH_TOKEN = refreshToken;
      const envPath = path.join(__dirname, '.env');
      let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
      if (envContent.includes('GOOGLE_REFRESH_TOKEN=')) {
        envContent = envContent.replace(/GOOGLE_REFRESH_TOKEN=.*/g, `GOOGLE_REFRESH_TOKEN=${refreshToken}`);
      } else {
        envContent += `\nGOOGLE_REFRESH_TOKEN=${refreshToken}\n`;
      }
      fs.writeFileSync(envPath, envContent);
    }
    res.send(`
      <div style="font-family:sans-serif;max-width:520px;margin:50px auto;padding:24px;border:1px solid #e0e0e0;border-radius:8px;text-align:center;">
        <h2 style="color:#10b981;margin-bottom:10px;">✓ Google Drive Connected!</h2>
        <p style="color:#4b5563;line-height:1.5;">Your personal Google Drive has been connected. All future file uploads will now land directly inside your Google Drive folder.</p>
        <a href="/admin" style="display:inline-block;margin-top:15px;padding:10px 20px;background:#4f46e5;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Return to Admin Panel</a>
      </div>
    `);
  } catch (err) {
    res.status(500).send('OAuth Error: ' + err.message);
  }
});

/* -------------------------------- static & page routes ----------------------- */
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/client', (req, res) => res.sendFile(path.join(__dirname, 'public', 'client.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'server_error' });
});

/* -------------------------------- start -------------------------------------- */
async function startServer() {
  await initDb();
  await bootstrapAdmin();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Hamada Portal running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch(console.error);
