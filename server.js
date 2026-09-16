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
const { uploadFile, createFolder, renameFolder, moveFile, moveFolder, deleteFile, downloadFile, downloadFileBuffer } = require('./lib/drive');
const { PERMISSIONS, isOwner, hasPermission, hasClientAccess, can, getAdminProfile } = require('./lib/access');
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
      `INSERT INTO users (role, name, name_ar, email, phone, password_hash, must_change, active, is_owner)
       VALUES ($1, $2, $3, $4, $5, $6, 1, 1, 1)`,
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

function withUploadSingle(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.message === 'bad_type') return res.status(400).json({ error: 'file_type_not_allowed' });
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'file_too_large', limit_mb: MAX_FILE_MB });
      return res.status(400).json({ error: 'upload_failed' });
    }
    next();
  });
}

async function saveFiles({ client_id, sender_id, inbox, folder, note, files, driveParentId, folderId }) {
  const rows = [];
  for (const f of files) {
    const name = U.sanitizeFilename(U.latinFix(f.originalname));
    const uploaded = await uploadFile(f, driveParentId);
    const result = await db.run(
      `INSERT INTO files (client_id, sender_id, inbox, name, stored, size, mime, folder, folder_id, note, is_read)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0) RETURNING id`,
      [client_id, sender_id, inbox ? 1 : 0, name, uploaded.stored, f.size || 0, f.mimetype || '', folder || '', folderId || null, note || '']
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

async function ensureFolderPath(clientId, parentId, folderPath) {
  let currentParentId = parentId || null;
  let driveParentId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (currentParentId) {
    const p = await db.get(`SELECT drive_id FROM folders WHERE id=$1 AND client_id=$2`, [currentParentId, clientId]);
    if (!p) throw Object.assign(new Error('invalid_parent'), { code: 'invalid_parent' });
    driveParentId = p.drive_id;
  }
  const parts = String(folderPath || '').split(/[\/]+/).map(x => U.sanitizeName(x, 120)).filter(Boolean);
  for (const name of parts) {
    let row = await db.get(`SELECT id,drive_id FROM folders WHERE client_id=$1 AND parent_id IS NOT DISTINCT FROM $2 AND name=$3 LIMIT 1`, [clientId, currentParentId, name]);
    if (!row) {
      const drive = await createFolder(name, driveParentId);
      try {
        const r = await db.run(`INSERT INTO folders(client_id,parent_id,name,sort_order,drive_id) VALUES($1,$2,$3,(SELECT COALESCE(MAX(sort_order),0)+1 FROM folders WHERE client_id=$1 AND parent_id IS NOT DISTINCT FROM $2),$4) RETURNING id,drive_id`, [clientId, currentParentId, name, drive.id]);
        row = r.rows[0];
      } catch (e) {
        try { await deleteFile(drive.id); } catch (_) {}
        if (e.code !== '23505') throw e;
        row = await db.get(`SELECT id,drive_id FROM folders WHERE client_id=$1 AND parent_id IS NOT DISTINCT FROM $2 AND name=$3 LIMIT 1`, [clientId, currentParentId, name]);
      }
    }
    currentParentId = row.id;
    driveParentId = row.drive_id;
  }
  return { folderId: currentParentId, driveId: driveParentId };
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipDosTime(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = (date.getDate() & 31) | ((date.getMonth() + 1) << 5) | (date.getFullYear() - 1980 << 9);
  return { time, day };
}

async function getFolderZipEntries(folderId, clientId) {
  const folders=await db.all(`WITH RECURSIVE tree AS (SELECT id,parent_id,name FROM folders WHERE id=$1 AND client_id=$2 UNION ALL SELECT f.id,f.parent_id,f.name FROM folders f JOIN tree t ON f.parent_id=t.id WHERE f.client_id=$2) SELECT id,parent_id,name FROM tree`,[folderId,clientId]);
  if(!folders.length)return null;
  const names=new Map(folders.map(f=>[f.id,f.name])); const parents=new Map(folders.map(f=>[f.id,f.parent_id]));
  const root=folders.find(f=>f.id===folderId); const rel=(fid)=>{const a=[];let cur=fid;while(cur&&cur!==folderId){a.unshift(names.get(cur));cur=parents.get(cur);}return a.length?a.join('/')+'/':'';};
  const rows=await db.all(`WITH RECURSIVE tree AS (SELECT id FROM folders WHERE id=$1 AND client_id=$2 UNION ALL SELECT f.id FROM folders f JOIN tree t ON f.parent_id=t.id WHERE f.client_id=$2) SELECT fi.id,fi.name,fi.stored,fi.created_at,fi.folder_id FROM files fi JOIN tree t ON t.id=fi.folder_id WHERE fi.client_id=$2 ORDER BY fi.created_at,fi.id`,[folderId,clientId]);
  const folderEntries=folders.filter(f=>f.id!==folderId).map(f=>({directory:true,name:f.name,path:rel(f.id)})).filter(x=>x.path);
  return { root, entries: [...folderEntries, ...rows.map(f=>({...f,path:rel(f.folder_id)+f.name}))] };
}

async function sendZip(res, entries, archiveName) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(archiveName || 'folder')}.zip"`);
  const central = [];
  let offset = 0;
  const write = (b) => { res.write(b); offset += b.length; };
  for (const entry of entries) {
    const data = entry.directory ? Buffer.alloc(0) : await downloadFileBuffer(entry.stored);
    const compressed = entry.directory ? Buffer.alloc(0) : require('zlib').deflateRawSync(data, { level: 6 });
    const crc = crc32(data);
    const name = Buffer.from(String(entry.path || entry.name || 'file'), 'utf8');
    const { time, day } = zipDosTime(entry.created_at ? new Date(entry.created_at) : new Date());
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(entry.directory ? 0 : 8, 8); local.writeUInt16LE(time, 10); local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28); name.copy(local, 30);
    write(local); write(compressed);
    const c = Buffer.alloc(46 + name.length);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(entry.directory ? 0 : 8, 10); c.writeUInt16LE(time, 12); c.writeUInt16LE(day, 14); c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(compressed.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt16LE(0, 30);
    c.writeUInt16LE(0, 32); c.writeUInt16LE(0, 34); c.writeUInt32LE(0, 36); c.writeUInt32LE(offset - compressed.length - local.length, 42); name.copy(c, 46);
    central.push(c);
  }
  const centralOffset = offset;
  for (const c of central) write(c);
  const centralSize = offset - centralOffset;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(centralOffset, 16); end.writeUInt16LE(0, 20);
  write(end); res.end();
}

/* --------------------------------- app setup -------------------------------- */
const app = express();

// Reject malformed numeric route IDs before they reach PostgreSQL.
// This prevents values such as /api/admin/folders/undefined from becoming NaN
// and crashing the Express 4 process with a PostgreSQL integer error.
app.param('id', (req, res, next, value) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'invalid_id' });
  }
  next();
});

app.param('clientId', (req, res, next, value) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'invalid_client_id' });
  }
  next();
});
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
    const u = await db.get(`SELECT id, role, name, name_ar, email, phone, must_change, active, is_owner FROM users WHERE id=$1`, [req.session.uid]);
    if (u && u.active) req.user = u;
    else req.session = null;
  }
  next();
});

app.use('/api', (req, res, next) => {
  if (['GET','HEAD','OPTIONS'].includes(req.method) || req.path === '/login' || req.path === '/session') return next();
  if (!req.user) return next();
  if (!req.session.csrf || req.get('x-csrf-token') !== req.session.csrf) return res.status(403).json({ error: 'csrf' });
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
  return { id: u.id, role: u.role, name: u.name, name_ar: u.name_ar, email: u.email, phone: u.phone, must_change: !!u.must_change, is_owner: !!u.is_owner };
}

async function requirePermission(req, res, permission, clientId) {
  if (!req.user || req.user.role !== 'admin') return false;
  return can(db, req.user, permission, clientId);
}

async function audit(req, action, entityType = '', entityId = null, details = {}) {
  try {
    await db.run(`INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, details) VALUES ($1,$2,$3,$4,$5::jsonb)`, [req.user?.id || null, action, entityType, entityId == null ? null : String(entityId), JSON.stringify(details)]);
  } catch (e) { console.error('[audit]', e.message); }
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

app.get('/api/brand', async (req, res) => { const rows=await db.all(`SELECT key,value FROM portal_settings WHERE key LIKE 'brand.%'`); const out={...(CONFIG.brand||{})}; for(const r of rows){const k=r.key.split('.')[1]; if(k) out[k]=r.value;} res.json(out); });

/* --------------------------------- client ----------------------------------- */
app.get('/api/me', requireClient, async (req, res) => {
  const me = req.user;
  const files = await db.all(
    `WITH RECURSIVE folder_tree AS (
       SELECT id, parent_id, sort_order, ARRAY[sort_order, id]::int[] AS order_path
       FROM folders WHERE client_id=$1 AND parent_id IS NULL
       UNION ALL
       SELECT f.id, f.parent_id, f.sort_order, ft.order_path || ARRAY[f.sort_order, f.id]::int[]
       FROM folders f JOIN folder_tree ft ON f.parent_id=ft.id
       WHERE f.client_id=$1
     )
     SELECT f.id, f.name, f.size, f.mime, f.folder, f.folder_id, f.created_at
      FROM files f
      WHERE f.client_id=$1 AND f.inbox=0
        AND (
          f.folder_id IS NULL
          OR NOT EXISTS (SELECT 1 FROM client_folder_access cfa WHERE cfa.client_id=$1)
          OR EXISTS (
            SELECT 1 FROM (
              WITH RECURSIVE visible(id) AS (
                SELECT cfa.folder_id FROM client_folder_access cfa WHERE cfa.client_id=$1
                UNION
                SELECT fo.id FROM folders fo JOIN visible v ON fo.parent_id=v.id
              ) SELECT id FROM visible
            ) v WHERE v.id=f.folder_id
          )
        )
      ORDER BY COALESCE((SELECT order_path FROM folder_tree ft WHERE ft.id=f.folder_id), ARRAY[2147483647]::int[]), f.name ASC`,
     [me.id]
   );
  const sent = await db.all(
    `SELECT id, name, size, is_read, created_at FROM files WHERE sender_id=$1 AND inbox=1 ORDER BY created_at DESC`,
    [me.id]
  );
  const folders = await db.all(`
    WITH RECURSIVE visible(id) AS (
      SELECT f.id FROM folders f
      WHERE f.client_id=$1 AND (NOT EXISTS (SELECT 1 FROM client_folder_access cfa WHERE cfa.client_id=$1) OR f.id IN (SELECT cfa.folder_id FROM client_folder_access cfa WHERE cfa.client_id=$1))
      UNION
      SELECT f.id FROM folders f JOIN visible v ON f.parent_id=v.id WHERE f.client_id=$1
    ), folder_tree AS (
      SELECT f.id,f.parent_id,f.name,f.sort_order,ARRAY[f.sort_order,f.id]::int[] AS order_path
      FROM folders f WHERE f.client_id=$1 AND f.parent_id IS NULL AND f.id IN (SELECT id FROM visible)
      UNION ALL
      SELECT f.id,f.parent_id,f.name,f.sort_order,ft.order_path || ARRAY[f.sort_order,f.id]::int[]
      FROM folders f JOIN folder_tree ft ON f.parent_id=ft.id WHERE f.client_id=$1 AND f.id IN (SELECT id FROM visible)
    )
    SELECT ft.id,ft.parent_id,ft.name,ft.sort_order,COUNT(fi.id)::int AS file_count
    FROM folder_tree ft LEFT JOIN files fi ON fi.folder_id=ft.id
    GROUP BY ft.id,ft.parent_id,ft.name,ft.sort_order,ft.order_path
    ORDER BY ft.order_path
  `,[me.id]);
  res.json({ user: pubUser(me), files, sent, folders });
});

app.get('/api/me/files', requireClient, async (req, res) => {
  const me = req.user;
  const files = await db.all(
    `SELECT f.id, f.name, f.size, f.mime, f.folder, f.folder_id, f.created_at
     FROM files f
     WHERE f.client_id=$1 AND f.inbox=0
       AND (
         f.folder_id IS NULL
         OR NOT EXISTS (SELECT 1 FROM client_folder_access cfa WHERE cfa.client_id=$1)
         OR EXISTS (
           WITH RECURSIVE visible(id) AS (
             SELECT cfa.folder_id FROM client_folder_access cfa WHERE cfa.client_id=$1
             UNION
             SELECT fo.id FROM folders fo JOIN visible v ON fo.parent_id=v.id
           )
           SELECT 1 FROM visible v WHERE v.id=f.folder_id
         )
       )
     ORDER BY f.folder ASC, f.name ASC`,
    [me.id]
  );
  const sent = await db.all(
    `SELECT id, name, size, is_read, created_at FROM files WHERE sender_id=$1 AND inbox=1 ORDER BY created_at DESC`,
    [me.id]
  );
  const folders = await db.all(`
    SELECT f.id,f.parent_id,f.name,f.sort_order,COUNT(fi.id)::int AS file_count
    FROM folders f
    LEFT JOIN files fi ON fi.folder_id=f.id
    WHERE f.client_id=$1
      AND (
        NOT EXISTS (SELECT 1 FROM client_folder_access cfa WHERE cfa.client_id=$1)
        OR EXISTS (
          WITH RECURSIVE visible(id) AS (
            SELECT cfa.folder_id FROM client_folder_access cfa WHERE cfa.client_id=$1
            UNION
            SELECT fo.id FROM folders fo JOIN visible v ON fo.parent_id=v.id
          )
          SELECT 1 FROM visible v WHERE v.id=f.id
        )
      )
    GROUP BY f.id ORDER BY f.parent_id NULLS FIRST,f.sort_order,f.name
  `,[me.id]);
  res.json({ user: pubUser(me), files, sent, folders });
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
  if (!(await requirePermission(req, res, 'view_clients'))) return res.status(403).json({ error: 'permission_denied' });
  const owner = await isOwner(db, req.user.id);
  const clientWhere = owner ? '' : `AND u.id IN (SELECT client_id FROM admin_client_access WHERE admin_id=${req.user.id} AND starts_at <= NOW() AND (expires_at IS NULL OR expires_at > NOW()))`;
  const clientsRow = await db.get(`SELECT COUNT(*)::int AS count FROM users u WHERE u.role='client' ${clientWhere}`);
  const filesRow = await db.get(`SELECT COUNT(*)::int AS count, COALESCE(SUM(f.size), 0)::bigint AS bytes FROM files f JOIN users u ON u.id=f.client_id WHERE f.inbox=0 ${owner ? '' : `AND f.client_id IN (SELECT client_id FROM admin_client_access WHERE admin_id=${req.user.id} AND starts_at <= NOW() AND (expires_at IS NULL OR expires_at > NOW()))`}`);
  const unreadRow = await db.get(`SELECT COUNT(*)::int AS count FROM files f WHERE f.inbox=1 AND f.is_read=0 ${owner ? '' : `AND f.client_id IN (SELECT client_id FROM admin_client_access WHERE admin_id=${req.user.id} AND starts_at <= NOW() AND (expires_at IS NULL OR expires_at > NOW()))`}`);
  const inboxRow = await db.get(`SELECT COUNT(*)::int AS count FROM files f WHERE f.inbox=1 ${owner ? '' : `AND f.client_id IN (SELECT client_id FROM admin_client_access WHERE admin_id=${req.user.id} AND starts_at <= NOW() AND (expires_at IS NULL OR expires_at > NOW()))`}`);

  res.json({
    stats: {
      clients: clientsRow ? clientsRow.count : 0,
      files: filesRow ? filesRow.count : 0,
      unread: unreadRow ? unreadRow.count : 0,
      inbox_count: inboxRow ? inboxRow.count : 0,
      bytes: filesRow ? parseInt(filesRow.bytes, 10) || 0 : 0,
    }
  });
});

app.get('/api/admin/clients', requireAdmin, async (req, res) => {
  if (!(await requirePermission(req, res, 'view_clients'))) return res.status(403).json({ error: 'permission_denied' });
  const owner = await isOwner(db, req.user.id);
  const scope = owner ? '' : `AND u.id IN (SELECT client_id FROM admin_client_access WHERE admin_id=${req.user.id} AND starts_at <= NOW() AND (expires_at IS NULL OR expires_at > NOW()))`;
  const list = await db.all(`
    SELECT u.id, u.name, u.name_ar, u.email, u.phone, u.active, u.created_at, u.group_id, g.name AS group_name,
           COUNT(f.id)::int AS nfiles,
           COALESCE(SUM(f.size), 0)::bigint AS bytes,
           MAX(f.created_at) AS last_upload
    FROM users u
    LEFT JOIN files f ON f.client_id = u.id AND f.inbox = 0
    LEFT JOIN client_groups g ON g.id = u.group_id
    WHERE u.role = 'client' ${scope}
    GROUP BY u.id, g.name
    ORDER BY u.id DESC
  `);
  res.json({ clients: list });
});

app.post('/api/admin/clients/import', requireAdmin, async (req, res) => {
  if (!(await requirePermission(req, res, 'manage_clients'))) return res.status(403).json({ error: 'permission_denied' });
  const raw = req.body && Array.isArray(req.body.clients) ? req.body.clients : null;
  if (!raw) return res.status(400).json({ error: 'invalid_import_format' });
  if (raw.length > 1000) return res.status(400).json({ error: 'import_too_large', max: 1000 });

  const clients = raw.map((item, index) => ({
    index: index + 1,
    name: String(item?.name ?? '').trim(),
    name_ar: String(item?.name_ar ?? '').trim(),
    email: String(item?.email ?? '').trim().toLowerCase(),
    phone: U.normalizePhone(item?.phone ?? ''),
    password: item?.password == null || String(item.password) === '' ? null : String(item.password),
  }));

  const invalid = [];
  for (const c of clients) {
    const reasons = [];
    const cleanName = U.sanitizeName(c.name, 120);
    if (!cleanName || cleanName.length < 2) reasons.push('invalid_name');
    if (!U.validEmail(c.email)) reasons.push('invalid_email');
    if (c.phone.length < 8) reasons.push('invalid_phone');
    if (c.password !== null && c.password.length < 8) reasons.push('weak_password');
    if (reasons.length) invalid.push({ row: c.index, name: c.name, email: c.email, phone: c.phone, reasons });
  }

  const valid = clients.filter(c => !invalid.some(x => x.row === c.index));
  const seenEmail = new Set(), seenPhone = new Set(), internalDuplicates = [];
  for (const c of valid) {
    if (seenEmail.has(c.email) || seenPhone.has(c.phone)) {
      internalDuplicates.push({ row: c.index, name: c.name, email: c.email, phone: c.phone, reason: 'duplicate_in_file' });
      continue;
    }
    seenEmail.add(c.email); seenPhone.add(c.phone);
  }
  const uniqueValid = valid.filter(c => !internalDuplicates.some(x => x.row === c.index));
  const created = [], skipped = [...internalDuplicates];

  try {
    await db.transaction(async ({ query }) => {
      for (const c of uniqueValid) {
        const existing = await query(`SELECT id, email, phone FROM users WHERE lower(email)=$1 OR phone=$2 LIMIT 1`, [c.email, c.phone]);
        if (existing.rows[0]) {
          const e = existing.rows[0];
          skipped.push({ row: c.index, name: c.name, email: c.email, phone: c.phone, reason: String(e.email).toLowerCase() === c.email ? 'email_exists' : 'phone_exists' });
          continue;
        }
        const tempPw = c.password || c.phone;
        const r = await query(
          `INSERT INTO users (role, name, name_ar, email, phone, password_hash, must_change, active)
           VALUES ('client', $1, $2, $3, $4, $5, 1, 1) RETURNING id`,
          [U.sanitizeName(c.name, 120), U.sanitizeName(c.name_ar, 120), c.email, c.phone, bcrypt.hashSync(tempPw, 10)]
        );
        created.push({ id: r.rows[0].id, row: c.index, name: c.name, email: c.email, phone: c.phone, used_phone_as_password: !c.password });
      }
    });
    await audit(req, 'clients_imported', 'clients', null, { created: created.length, skipped: skipped.length, invalid: invalid.length });
    res.json({ ok: true, created, skipped, invalid, counts: { total: raw.length, created: created.length, skipped: skipped.length, invalid: invalid.length } });
  } catch (e) {
    console.error('[clients import]', e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/admin/clients', requireAdmin, async (req, res) => {
  if (!(await requirePermission(req, res, 'manage_clients'))) return res.status(403).json({ error: 'permission_denied' });
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
  if (!(await requirePermission(req, res, 'manage_clients', parseInt(req.params.id, 10)))) return res.status(403).json({ error: 'permission_denied' });
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
  if (!(await requirePermission(req, res, 'manage_clients', parseInt(req.params.id, 10)))) return res.status(403).json({ error: 'permission_denied' });
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
  if (!(await requirePermission(req, res, 'manage_clients', parseInt(req.params.id, 10)))) return res.status(403).json({ error: 'permission_denied' });
  const id = parseInt(req.params.id, 10);
  const c = await db.get(`SELECT id, phone FROM users WHERE id=$1 AND role='client'`, [id]);
  if (!c) return res.status(404).json({ error: 'not_found' });

  const temp = c.phone;
  await db.run(`UPDATE users SET password_hash=$1, must_change=1 WHERE id=$2`, [bcrypt.hashSync(temp, 10), id]);
  res.json({ ok: true, initial_password: temp });
});

app.post('/api/admin/clients/:id/reset-password', requireAdmin, async (req, res) => {
  if (!(await requirePermission(req, res, 'manage_clients', parseInt(req.params.id, 10)))) return res.status(403).json({ error: 'permission_denied' });
  const id = parseInt(req.params.id, 10);
  const c = await db.get(`SELECT id, phone FROM users WHERE id=$1 AND role='client'`, [id]);
  if (!c) return res.status(404).json({ error: 'not_found' });

  const temp = c.phone;
  await db.run(`UPDATE users SET password_hash=$1, must_change=1 WHERE id=$2`, [bcrypt.hashSync(temp, 10), id]);
  res.json({ ok: true, initial_password: temp, temp_password: temp });
});

app.get('/api/admin/client-folders/:id', requireAdmin, async (req, res) => {
  if (!(await requirePermission(req, res, 'view_files', parseInt(req.params.id, 10)))) return res.status(403).json({ error: 'permission_denied' });
  const id = parseInt(req.params.id, 10);
  const c = await db.get(`SELECT id, name, name_ar, email, phone FROM users WHERE id=$1 AND role='client'`, [id]);
  if (!c) return res.status(404).json({ error: 'not_found' });

  const files = await db.all(
    `SELECT f.id, f.name, f.size, f.mime, f.folder, f.folder_id, f.note, f.created_at, f.client_id, s.name AS sender_name,
            EXISTS (SELECT 1 FROM file_notes fn WHERE fn.file_id=f.id AND NOT EXISTS (SELECT 1 FROM file_note_reads fr WHERE fr.note_id=fn.id AND fr.admin_id=$2)) AS has_unread_note
     FROM files f
     LEFT JOIN users s ON s.id = f.sender_id
     WHERE f.client_id=$1 AND f.inbox=0
     ORDER BY f.folder ASC, f.name ASC`,
    [id, req.user.id]
  );

  const folders = [...new Set(files.map(f => f.folder).filter(Boolean))].sort();
  const folderTree = await db.all(`WITH RECURSIVE folder_tree AS (
       SELECT id,client_id,parent_id,name,sort_order,drive_id,name::text AS folder_path,ARRAY[sort_order,id]::int[] AS order_path
       FROM folders WHERE client_id=$1 AND parent_id IS NULL
       UNION ALL
       SELECT f.id,f.client_id,f.parent_id,f.name,f.sort_order,f.drive_id,(ft.folder_path || ' / ' || f.name) AS folder_path,ft.order_path || ARRAY[f.sort_order,f.id]::int[]
       FROM folders f JOIN folder_tree ft ON f.parent_id=ft.id WHERE f.client_id=$1
     )
     SELECT ft.id,ft.client_id,ft.parent_id,ft.name,ft.sort_order,ft.drive_id,ft.folder_path,COUNT(fi.id)::int AS file_count
     FROM folder_tree ft LEFT JOIN files fi ON fi.folder_id=ft.id GROUP BY ft.id,ft.client_id,ft.parent_id,ft.name,ft.sort_order,ft.drive_id,ft.folder_path,ft.order_path
     ORDER BY ft.order_path`, [id]);

  res.json({ client: c, files, folders, folderTree });
});

app.get('/api/admin/clients/:id/files', requireAdmin, async (req, res) => {
  if (!(await requirePermission(req, res, 'view_files', parseInt(req.params.id, 10)))) return res.status(403).json({ error: 'permission_denied' });
  const id = parseInt(req.params.id, 10);
  const c = await db.get(`SELECT id, name, name_ar, email, phone FROM users WHERE id=$1 AND role='client'`, [id]);
  if (!c) return res.status(404).json({ error: 'not_found' });

  const files = await db.all(
    `SELECT f.id, f.name, f.size, f.mime, f.folder, f.folder_id, f.note, f.created_at, f.client_id, s.name AS sender_name,
            EXISTS (SELECT 1 FROM file_notes fn WHERE fn.file_id=f.id AND NOT EXISTS (SELECT 1 FROM file_note_reads fr WHERE fr.note_id=fn.id AND fr.admin_id=$2)) AS has_unread_note
     FROM files f
     LEFT JOIN users s ON s.id = f.sender_id
     WHERE f.client_id=$1 AND f.inbox=0
     ORDER BY f.folder ASC, f.name ASC`,
    [id, req.user.id]
  );

  const folders = [...new Set(files.map(f => f.folder).filter(Boolean))].sort();
  const folderTree = await db.all(`WITH RECURSIVE folder_tree AS (
       SELECT id,client_id,parent_id,name,sort_order,drive_id,name::text AS folder_path,ARRAY[sort_order,id]::int[] AS order_path
       FROM folders WHERE client_id=$1 AND parent_id IS NULL
       UNION ALL
       SELECT f.id,f.client_id,f.parent_id,f.name,f.sort_order,f.drive_id,(ft.folder_path || ' / ' || f.name) AS folder_path,ft.order_path || ARRAY[f.sort_order,f.id]::int[]
       FROM folders f JOIN folder_tree ft ON f.parent_id=ft.id WHERE f.client_id=$1
     )
     SELECT ft.id,ft.client_id,ft.parent_id,ft.name,ft.sort_order,ft.drive_id,ft.folder_path,COUNT(fi.id)::int AS file_count
     FROM folder_tree ft LEFT JOIN files fi ON fi.folder_id=ft.id GROUP BY ft.id,ft.client_id,ft.parent_id,ft.name,ft.sort_order,ft.drive_id,ft.folder_path,ft.order_path
     ORDER BY ft.order_path`, [id]);

  res.json({ client: c, files, folders, folderTree });
});

app.post('/api/admin/clients/:id/files', requireAdmin, withUpload, async (req, res) => {
  if (!(await requirePermission(req, res, 'upload_files', parseInt(req.params.id, 10)))) return res.status(403).json({ error: 'permission_denied' });
  const id = parseInt(req.params.id, 10);
  const c = await db.get(`SELECT id FROM users WHERE id=$1 AND role='client'`, [id]);
  if (!c) return res.status(404).json({ error: 'not_found' });
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'no_files' });

  const folder = U.sanitizeFolder((req.body && req.body.folder) || '');
  const folderId = req.body && req.body.folder_id ? parseInt(req.body.folder_id, 10) : null;
  let driveParentId = null;
  if (folderId) {
    const folderRow = await db.get(`SELECT drive_id, client_id FROM folders WHERE id=$1 AND client_id=$2`, [folderId, c.id]);
    if (!folderRow) return res.status(400).json({ error: 'invalid_folder' });
    driveParentId = folderRow.drive_id;
  }
  const note = U.sanitizeName((req.body && req.body.note) || '', 300);

  try {
    const rows = await saveFiles({ client_id: c.id, sender_id: req.user.id, inbox: 0, folder, note, files: req.files, driveParentId, folderId });
    res.json({ ok: true, saved: rows.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.put('/api/admin/files/:id', requireAdmin, async (req, res) => {
  const f = await db.get(`SELECT * FROM files WHERE id=$1`, [req.params.id]);
  if (!f) return res.status(404).json({ error: 'not_found' });
  if (!(await requirePermission(req, res, 'view_files', f.client_id))) return res.status(403).json({ error: 'permission_denied' });
  const b = req.body || {};
  const newName = b.name !== undefined ? U.sanitizeFilename(String(b.name)) : f.name;
  const newFolder = b.folder !== undefined ? U.sanitizeFolder(String(b.folder)) : f.folder;
  const newClientId = b.client_id !== undefined ? parseInt(b.client_id, 10) : f.client_id;
  const newInbox = b.inbox !== undefined ? parseInt(b.inbox, 10) : f.inbox;
  if (b.name !== undefined && !(await requirePermission(req,res,'rename_files',f.client_id))) return res.status(403).json({error:'permission_denied'});
  if (b.client_id !== undefined && newClientId !== f.client_id) {
    if (!(await requirePermission(req,res,'manage_folders',f.client_id)) || !(await requirePermission(req,res,'manage_folders',newClientId))) return res.status(403).json({error:'permission_denied'});
  }
  let newFolderId = b.folder_id !== undefined ? (b.folder_id ? parseInt(b.folder_id,10) : null) : f.folder_id;
  if (b.folder_id !== undefined) {
    if (!(await requirePermission(req,res,'manage_folders',f.client_id))) return res.status(403).json({error:'permission_denied'});
    if (newFolderId) { const target=await db.get(`SELECT id,drive_id,client_id FROM folders WHERE id=$1 AND client_id=$2`,[newFolderId,f.client_id]); if(!target)return res.status(400).json({error:'invalid_folder'}); await moveFile(f.stored,target.drive_id); }
    else if (f.folder_id) { await moveFile(f.stored,process.env.GOOGLE_DRIVE_FOLDER_ID); }
  }
  await db.run(`UPDATE files SET name=$1, folder=$2, folder_id=$3, client_id=$4, inbox=$5 WHERE id=$6`,[newName,newFolder,newFolderId,newClientId,newInbox,f.id]);
  await audit(req,'file_updated','file',f.id,{name:newName,folder_id:newFolderId}); res.json({ ok: true });
});

app.delete('/api/admin/files/:id', requireAdmin, async (req, res) => {
  const existingForPerm = await db.get(`SELECT client_id FROM files WHERE id=$1`, [req.params.id]);
  if (!existingForPerm) return res.status(404).json({ error: 'not_found' });
  if (!(await requirePermission(req, res, 'delete_files', existingForPerm.client_id))) return res.status(403).json({ error: 'permission_denied' });
  const ok = await deleteFileRow(req.params.id);
  if (!ok) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

app.get('/api/admin/inbox', requireAdmin, async (req, res) => {
  if (!(await requirePermission(req, res, 'view_files'))) return res.status(403).json({ error: 'permission_denied' });
  const items = await db.all(`
    SELECT f.id, f.name, f.size, f.mime, f.note, f.created_at, f.is_read,
           c.id AS client_id, c.name AS sender_name, c.email AS sender_email, c.phone AS sender_phone,
           EXISTS (SELECT 1 FROM file_notes fn WHERE fn.file_id=f.id AND NOT EXISTS (SELECT 1 FROM file_note_reads fr WHERE fr.note_id=fn.id AND fr.admin_id=$1)) AS has_unread_note
    FROM files f
    JOIN users c ON c.id = f.client_id
    WHERE f.inbox = 1
    ORDER BY f.created_at DESC
  `, [req.user.id]);
  await db.run(`UPDATE files SET is_read=1 WHERE inbox=1 AND is_read=0`);
  res.json({ inbox: items });
});

app.post('/api/admin/inbox/:id/file', requireAdmin, async (req, res) => {
  const inboxForPerm = await db.get(`SELECT client_id FROM files WHERE id=$1 AND inbox=1`, [req.params.id]);
  if (!inboxForPerm) return res.status(404).json({ error: 'not_found' });
  if (!(await requirePermission(req, res, 'upload_files', inboxForPerm.client_id))) return res.status(403).json({ error: 'permission_denied' });
  const id = parseInt(req.params.id, 10);
  const f = await db.get(`SELECT id FROM files WHERE id=$1 AND inbox=1`, [id]);
  if (!f) return res.status(404).json({ error: 'not_found' });

  const folder = U.sanitizeFolder((req.body && req.body.folder) || '');
  await db.run(`UPDATE files SET inbox=0, folder=$1, is_read=1 WHERE id=$2`, [folder, id]);
  res.json({ ok: true });
});

app.get('/api/admin/files', requireAdmin, async (req, res) => {
  if (!(await requirePermission(req, res, 'view_files'))) return res.status(403).json({ error: 'permission_denied' });
  const { q = '', client_id = '' } = req.query || {};
  let sql = `
    SELECT f.id, f.name, f.size, f.mime, f.folder, f.folder_id, f.created_at, f.client_id, c.name AS client_name,
           EXISTS (SELECT 1 FROM file_notes fn WHERE fn.file_id=f.id AND NOT EXISTS (SELECT 1 FROM file_note_reads fr WHERE fr.note_id=fn.id AND fr.admin_id=$1)) AS has_unread_note
    FROM files f
    JOIN users c ON c.id = f.client_id
    WHERE f.inbox = 0
  `;
  const params = [req.user.id];
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


/* -------------------------- admin management / permissions ------------------- */
app.get('/api/admin/profile', requireAdmin, async (req, res) => {
  res.json({ admin: pubUser(req.user), ...(await getAdminProfile(db, req.user.id)) });
});

app.get('/api/admin/admins', requireAdmin, async (req, res) => {
  if (!(await isOwner(db, req.user.id))) return res.status(403).json({ error: 'owner_only' });
  const admins = await db.all(`SELECT id,name,name_ar,email,phone,active,is_owner,created_at FROM users WHERE role='admin' ORDER BY is_owner DESC,id ASC`);
  for (const a of admins) {
    a.permissions = (await db.all(`SELECT permission_key, starts_at, expires_at FROM admin_permissions WHERE admin_id=$1 ORDER BY permission_key`, [a.id]));
    a.client_access = (await db.all(`SELECT aca.client_id, u.name, u.name_ar, aca.starts_at, aca.expires_at FROM admin_client_access aca JOIN users u ON u.id=aca.client_id WHERE aca.admin_id=$1 ORDER BY u.name`, [a.id]));
  }
  res.json({ admins, permissions: PERMISSIONS });
});

app.post('/api/admin/admins', requireAdmin, async (req, res) => {
  if (!(await isOwner(db, req.user.id))) return res.status(403).json({ error: 'owner_only' });
  const b=req.body||{}; const name=U.sanitizeName(b.name,120), name_ar=U.sanitizeName(b.name_ar||'',120);
  const email=String(b.email||'').trim().toLowerCase(), phone=U.normalizePhone(b.phone||'');
  if(!name || !U.validEmail(email) || phone.length<8) return res.status(400).json({error:'invalid_data'});
  const dup=await db.get(`SELECT id FROM users WHERE lower(email)=$1 OR phone=$2`,[email,phone]);
  if(dup) return res.status(409).json({error:'email_or_phone_exists'});
  const pw=b.password?String(b.password):phone;
  const r=await db.run(`INSERT INTO users(role,name,name_ar,email,phone,password_hash,must_change,active,is_owner) VALUES('admin',$1,$2,$3,$4,$5,1,1,0) RETURNING id`,[name,name_ar,email,phone,bcrypt.hashSync(pw,10)]);
  const id=r.rows[0].id; await audit(req,'admin_created','user',id,{name,email});
  res.json({ok:true,id,initial_password:pw});
});

app.put('/api/admin/admins/:id', requireAdmin, async (req,res)=>{
  if (!(await isOwner(db, req.user.id))) return res.status(403).json({error:'owner_only'});
  const id=parseInt(req.params.id,10); const a=await db.get(`SELECT * FROM users WHERE id=$1 AND role='admin'`,[id]);
  if(!a) return res.status(404).json({error:'not_found'}); if(a.is_owner) return res.status(400).json({error:'owner_locked'});
  const b=req.body||{}; const name=b.name!==undefined?U.sanitizeName(b.name,120):a.name; const name_ar=b.name_ar!==undefined?U.sanitizeName(b.name_ar,120):a.name_ar;
  const email=b.email!==undefined?String(b.email).trim().toLowerCase():a.email; const phone=b.phone!==undefined?U.normalizePhone(b.phone):a.phone; const active=b.active!==undefined?(b.active?1:0):a.active;
  if(!name||!U.validEmail(email)||phone.length<8)return res.status(400).json({error:'invalid_data'});
  const dup=await db.get(`SELECT id FROM users WHERE (lower(email)=$1 OR phone=$2) AND id<>$3`,[email,phone,id]); if(dup)return res.status(409).json({error:'conflict'});
  await db.run(`UPDATE users SET name=$1,name_ar=$2,email=$3,phone=$4,active=$5 WHERE id=$6`,[name,name_ar,email,phone,active,id]);
  if(b.password){ await db.run(`UPDATE users SET password_hash=$1,must_change=1 WHERE id=$2`,[bcrypt.hashSync(String(b.password),10),id]); }
  await audit(req,'admin_updated','user',id,{active}); res.json({ok:true});
});

app.delete('/api/admin/admins/:id', requireAdmin, async (req,res)=>{
  if (!(await isOwner(db, req.user.id))) return res.status(403).json({error:'owner_only'});
  const id=parseInt(req.params.id,10); const a=await db.get(`SELECT id,is_owner FROM users WHERE id=$1 AND role='admin'`,[id]);
  if(!a) return res.status(404).json({error:'not_found'}); if(a.is_owner || id===req.user.id)return res.status(400).json({error:'owner_locked'});
  await db.run(`DELETE FROM users WHERE id=$1`,[id]); await audit(req,'admin_deleted','user',id); res.json({ok:true});
});

app.put('/api/admin/admins/:id/permissions', requireAdmin, async (req,res)=>{
  if (!(await isOwner(db, req.user.id))) return res.status(403).json({error:'owner_only'});
  const id=parseInt(req.params.id,10); const target=await db.get(`SELECT id,is_owner FROM users WHERE id=$1 AND role='admin'`,[id]);
  if(!target)return res.status(404).json({error:'not_found'}); if(target.is_owner)return res.status(400).json({error:'owner_locked'});
  const allowed=new Set(PERMISSIONS.map(p=>p.key)); const items=Array.isArray(req.body?.permissions)?req.body.permissions:[];
  await db.transaction(async tx=>{ await tx.query(`DELETE FROM admin_permissions WHERE admin_id=$1`,[id]); for(const x of items){ if(!allowed.has(x.permission_key))continue; const starts=x.starts_at?new Date(x.starts_at):new Date(); const expires=x.expires_at?new Date(x.expires_at):null; if(expires && Number.isNaN(expires.getTime()))continue; await tx.query(`INSERT INTO admin_permissions(admin_id,permission_key,granted_by,starts_at,expires_at) VALUES($1,$2,$3,$4,$5)`,[id,x.permission_key,req.user.id,starts,expires]); }});
  await audit(req,'admin_permissions_changed','user',id,{permissions:items}); res.json({ok:true});
});

app.put('/api/admin/admins/:id/client-access', requireAdmin, async (req,res)=>{
  if (!(await isOwner(db, req.user.id))) return res.status(403).json({error:'owner_only'});
  const id=parseInt(req.params.id,10); const target=await db.get(`SELECT id,is_owner FROM users WHERE id=$1 AND role='admin'`,[id]);
  if(!target)return res.status(404).json({error:'not_found'}); if(target.is_owner)return res.status(400).json({error:'owner_locked'});
  const items=Array.isArray(req.body?.clients)?req.body.clients:[];
  await db.transaction(async tx=>{ await tx.query(`DELETE FROM admin_client_access WHERE admin_id=$1`,[id]); for(const x of items){ const cid=parseInt(x.client_id,10); if(!cid)continue; const c=await tx.query(`SELECT id FROM users WHERE id=$1 AND role='client'`,[cid]); if(!c.rows.length)continue; const starts=x.starts_at?new Date(x.starts_at):new Date(); const expires=x.expires_at?new Date(x.expires_at):null; if(expires && Number.isNaN(expires.getTime()))continue; await tx.query(`INSERT INTO admin_client_access(admin_id,client_id,granted_by,starts_at,expires_at) VALUES($1,$2,$3,$4,$5)`,[id,cid,req.user.id,starts,expires]); }});
  await audit(req,'admin_client_access_changed','user',id,{clients:items}); res.json({ok:true});
});

app.get('/api/admin/audit', requireAdmin, async (req,res)=>{
  if (!(await isOwner(db, req.user.id)) && !(await hasPermission(db, req.user.id,'settings'))) return res.status(403).json({error:'permission_denied'});
  const rows=await db.all(`SELECT a.*,u.name AS actor_name FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC LIMIT 500`); res.json({logs:rows});
});

/* ------------------------- client folder visibility ------------------------- */
app.get('/api/admin/clients/:id/folder-visibility', requireAdmin, async (req,res)=>{
  const cid=parseInt(req.params.id,10);
  if (!(await requirePermission(req,res,'manage_clients',cid)) && !(await requirePermission(req,res,'manage_folders',cid))) return res.status(403).json({error:'permission_denied'});
  const client=await db.get(`SELECT id,name,name_ar FROM users WHERE id=$1 AND role='client'`,[cid]);
  if(!client)return res.status(404).json({error:'not_found'});
  const folders=await db.all(`
    SELECT f.id,f.parent_id,f.name,f.sort_order,COUNT(fi.id)::int AS file_count,
           EXISTS(SELECT 1 FROM client_folder_access cfa WHERE cfa.client_id=$1 AND cfa.folder_id=f.id) AS selected
    FROM folders f LEFT JOIN files fi ON fi.folder_id=f.id
    WHERE f.client_id=$1
    GROUP BY f.id
    ORDER BY f.parent_id NULLS FIRST,f.sort_order,f.name`,[cid]);
  const count=await db.get(`SELECT COUNT(*)::int AS n FROM client_folder_access WHERE client_id=$1`,[cid]);
  res.json({client,restricted:count.n>0,folders});
});

app.put('/api/admin/clients/:id/folder-visibility', requireAdmin, async (req,res)=>{
  const cid=parseInt(req.params.id,10);
  if (!(await requirePermission(req,res,'manage_clients',cid)) && !(await requirePermission(req,res,'manage_folders',cid))) return res.status(403).json({error:'permission_denied'});
  const client=await db.get(`SELECT id FROM users WHERE id=$1 AND role='client'`,[cid]);
  if(!client)return res.status(404).json({error:'not_found'});
  const restricted=!!req.body?.restricted;
  const ids=[...new Set((Array.isArray(req.body?.folder_ids)?req.body.folder_ids:[]).map(x=>parseInt(x,10)).filter(Number.isInteger))];
  const valid=ids.length?await db.all(`SELECT id FROM folders WHERE client_id=$1 AND id=ANY($2::int[])`,[cid,ids]):[];
  if(valid.length!==ids.length)return res.status(400).json({error:'invalid_folder'});
  await db.transaction(async tx=>{
    await tx.query(`DELETE FROM client_folder_access WHERE client_id=$1`,[cid]);
    if(restricted && ids.length){
      for(const folderId of ids){
        await tx.query(`INSERT INTO client_folder_access(client_id,folder_id,granted_by) VALUES($1,$2,$3)`,[cid,folderId,req.user.id]);
      }
    }
  });
  await audit(req,'client_folder_visibility_changed','client',cid,{restricted,folder_ids:ids});
  res.json({ok:true,restricted,folder_ids:ids});
});

/* -------------------------------- folders ----------------------------------- */

app.post('/api/admin/clients/:id/folder-upload', requireAdmin, withUploadSingle, async (req,res)=>{
  const cid=parseInt(req.params.id,10);
  if(!(await requirePermission(req,res,'upload_files',cid)))return res.status(403).json({error:'permission_denied'});
  if(!req.file)return res.status(400).json({error:'no_file'});
  const baseParent=req.body?.parent_id?parseInt(req.body.parent_id,10):null;
  const relative=String(req.body?.relative_path||req.file.originalname||'').replaceAll('\\','/').replace(/^\/+|\/+$/g,'');
  const parts=relative.split('/').filter(Boolean);
  const fileName=U.sanitizeFilename(U.latinFix(parts.pop()||req.file.originalname));
  const folderPath=parts.join('/');
  const target=await ensureFolderPath(cid,baseParent,folderPath);
  const uploaded=await uploadFile({...req.file,originalname:fileName},target.driveId);
  const r=await db.run(`INSERT INTO files (client_id,sender_id,inbox,name,stored,size,mime,folder,folder_id,note,is_read) VALUES($1,$2,0,$3,$4,$5,$6,$7,$8,'',0) RETURNING id`,[cid,req.user.id,fileName,uploaded.stored,req.file.size||0,req.file.mimetype||'',folderPath ? parts[parts.length-1] || '' : '',target.folderId||null]);
  await audit(req,'folder_file_uploaded','client',cid,{file_id:r.rows[0].id,relative_path:relative});
  res.json({ok:true,file_id:r.rows[0].id,relative_path:relative});
});

app.get('/api/admin/folders/:id/download', requireAdmin, async (req,res)=>{
  const id=parseInt(req.params.id,10); const folder=await db.get(`SELECT * FROM folders WHERE id=$1`,[id]);
  if(!folder)return res.status(404).json({error:'not_found'});
  if(!(await requirePermission(req,res,'view_files',folder.client_id)))return res.status(403).json({error:'permission_denied'});
  const data=await getFolderZipEntries(id,folder.client_id); if(!data)return res.status(404).json({error:'not_found'});
  if(!data.entries.length)return res.status(400).json({error:'folder_empty'});
  await sendZip(res,data.entries,folder.name);
});

app.get('/api/admin/folders/download-selected', requireAdmin, async (req,res)=>{
  let ids=[]; try{ids=JSON.parse(String(req.query.ids||'[]'));}catch(_){return res.status(400).json({error:'invalid_ids'});}
  ids=[...new Set((Array.isArray(ids)?ids:[]).map(Number).filter(Number.isInteger))].slice(0,50); if(!ids.length)return res.status(400).json({error:'invalid_ids'});
  const all=[]; for(const id of ids){const f=await db.get(`SELECT id,client_id,name FROM folders WHERE id=$1`,[id]); if(!f)continue; if(!(await requirePermission(req,res,'view_files',f.client_id)))return res.status(403).json({error:'permission_denied'}); const data=await getFolderZipEntries(id,f.client_id); if(data)all.push(...data.entries.map(x=>({...x,path:`${f.name}/${x.path}`})));}
  if(!all.length)return res.status(400).json({error:'folder_empty'}); await sendZip(res,all,'selected-folders');
});


app.get('/api/client/download-selected', requireAuth, async (req,res)=>{
  if(req.user.role!=='client')return res.status(403).json({error:'not_allowed'});
  let folderIds=[],fileIds=[]; try{folderIds=JSON.parse(String(req.query.folder_ids||'[]'));fileIds=JSON.parse(String(req.query.file_ids||'[]'));}catch(_){return res.status(400).json({error:'invalid_ids'});}
  folderIds=[...new Set((Array.isArray(folderIds)?folderIds:[]).map(Number).filter(Number.isInteger))].slice(0,50); fileIds=[...new Set((Array.isArray(fileIds)?fileIds:[]).map(Number).filter(Number.isInteger))].slice(0,100);
  const entries=[]; for(const id of folderIds){const data=await getFolderZipEntries(id,req.user.id);if(data)entries.push(...data.entries.map(x=>({...x,path:`${data.root.name}/${x.path}`})));}
  if(fileIds.length){const rows=await db.all(`SELECT id,name,stored,created_at FROM files WHERE client_id=$1 AND inbox=0 AND id=ANY($2::int[])`,[req.user.id,fileIds]);entries.push(...rows.map(f=>({...f,path:f.name})));}
  if(!entries.length)return res.status(404).json({error:'not_found'}); await sendZip(res,entries,'selected-items');
});

app.get('/api/folder/:id/download', requireAuth, async (req,res)=>{
  const id=parseInt(req.params.id,10); const folder=await db.get(`SELECT * FROM folders WHERE id=$1`,[id]); if(!folder)return res.status(404).json({error:'not_found'});
  if(req.user.role==='admin'){if(!(await can(db,req.user,'view_files',folder.client_id)))return res.status(403).json({error:'not_allowed'});} else if(folder.client_id!==req.user.id || !(await can(db,req.user,'view_files',folder.client_id))) return res.status(403).json({error:'not_allowed'});
  const data=await getFolderZipEntries(id,folder.client_id); if(!data)return res.status(404).json({error:'not_found'}); if(!data.entries.length)return res.status(400).json({error:'folder_empty'}); await sendZip(res,data.entries,folder.name);
});

app.get('/api/admin/files/download-selected', requireAdmin, async (req,res)=>{
  let ids=[]; try{ids=JSON.parse(String(req.query.ids||'[]'));}catch(_){return res.status(400).json({error:'invalid_ids'});}
  ids=[...new Set((Array.isArray(ids)?ids:[]).map(Number).filter(Number.isInteger))].slice(0,100); if(!ids.length)return res.status(400).json({error:'invalid_ids'});
  const rows=[]; for(const id of ids){const f=await db.get(`SELECT id,client_id,name,stored,created_at FROM files WHERE id=$1`,[id]); if(!f)continue; if(!(await requirePermission(req,res,'view_files',f.client_id)))return res.status(403).json({error:'permission_denied'}); rows.push({...f,path:f.name});}
  if(!rows.length)return res.status(404).json({error:'not_found'}); await sendZip(res,rows,'selected-files');
});

app.get('/api/admin/clients/:id/folders', requireAdmin, async (req,res)=>{
  const cid=parseInt(req.params.id,10); if(!(await requirePermission(req,res,'view_files',cid)))return res.status(403).json({error:'permission_denied'});
  const folders=await db.all(`WITH RECURSIVE folder_tree AS (
       SELECT id,client_id,parent_id,name,sort_order,drive_id,name::text AS folder_path,ARRAY[sort_order,id]::int[] AS order_path
       FROM folders WHERE client_id=$1 AND parent_id IS NULL
       UNION ALL
       SELECT f.id,f.client_id,f.parent_id,f.name,f.sort_order,f.drive_id,(ft.folder_path || ' / ' || f.name) AS folder_path,ft.order_path || ARRAY[f.sort_order,f.id]::int[]
       FROM folders f JOIN folder_tree ft ON f.parent_id=ft.id WHERE f.client_id=$1
     )
     SELECT ft.id,ft.client_id,ft.parent_id,ft.name,ft.sort_order,ft.drive_id,ft.folder_path,COUNT(fi.id)::int AS file_count
     FROM folder_tree ft LEFT JOIN files fi ON fi.folder_id=ft.id GROUP BY ft.id,ft.client_id,ft.parent_id,ft.name,ft.sort_order,ft.drive_id,ft.folder_path,ft.order_path
     ORDER BY ft.order_path`,[cid]); res.json({folders});
});
app.post('/api/admin/clients/:id/folders', requireAdmin, async (req,res)=>{
  const cid=parseInt(req.params.id,10); if(!(await requirePermission(req,res,'manage_folders',cid)))return res.status(403).json({error:'permission_denied'});
  const name=U.sanitizeName(req.body?.name||'',120); const parentId=req.body?.parent_id?parseInt(req.body.parent_id,10):null; if(!name)return res.status(400).json({error:'invalid_data'});
  let parentDrive=process.env.GOOGLE_DRIVE_FOLDER_ID; if(parentId){const p=await db.get(`SELECT drive_id FROM folders WHERE id=$1 AND client_id=$2`,[parentId,cid]);if(!p)return res.status(400).json({error:'invalid_parent'});parentDrive=p.drive_id;}
  const existing=await db.get(`SELECT id FROM folders WHERE client_id=$1 AND parent_id IS NOT DISTINCT FROM $2 AND name=$3 LIMIT 1`,[cid,parentId,name]);
  if(existing)return res.status(409).json({error:'folder_exists'});
  const drive=await createFolder(name,parentDrive);
  try {
    const r=await db.run(`INSERT INTO folders(client_id,parent_id,name,sort_order,drive_id) VALUES($1,$2,$3,(SELECT COALESCE(MAX(sort_order),0)+1 FROM folders WHERE client_id=$1 AND parent_id IS NOT DISTINCT FROM $2),$4) RETURNING id`,[cid,parentId,name,drive.id]);
    await audit(req,'folder_created','folder',r.rows[0].id,{client_id:cid,name});
    res.json({ok:true,folder:{id:r.rows[0].id,name,parent_id:parentId,drive_id:drive.id,file_count:0}});
  } catch(e) {
    try { await deleteFile(drive.id); } catch(cleanErr) { console.error('[Drive] cleanup after folder insert failure:', cleanErr.message); }
    if(e.code==='23505') return res.status(409).json({error:'folder_exists'});
    throw e;
  }
});
app.put('/api/admin/folders/reorder', requireAdmin, async (req,res)=>{
  const items=Array.isArray(req.body?.items)?req.body.items:[];
  if (!items.length) return res.json({ok:true});
  const clean=[];
  for(const x of items){
    const id=Number(x.id), order=Number(x.sort_order);
    if(!Number.isInteger(id) || id<=0 || !Number.isFinite(order)) return res.status(400).json({error:'invalid_id'});
    const f=await db.get(`SELECT client_id,parent_id FROM folders WHERE id=$1`,[id]);
    if(!f)return res.status(404).json({error:'not_found'});
    if(!(await requirePermission(req,res,'manage_folders',f.client_id)))return res.status(403).json({error:'permission_denied'});
    clean.push({id,order,parent_id:f.parent_id});
  }
  const parentKey=clean[0]?.parent_id ?? null;
  if(clean.some(x => (x.parent_id ?? null) !== parentKey)) return res.status(400).json({error:'invalid_order'});
  await db.transaction(async tx=>{ for(const x of clean) await tx.query(`UPDATE folders SET sort_order=$1,updated_at=NOW() WHERE id=$2`,[x.order,x.id]); });
  await audit(req,'folders_reordered','folder',null,{items:clean.map(x=>({id:x.id,sort_order:x.order}))});
  res.json({ok:true});
});

app.put('/api/admin/folders/:id', requireAdmin, async (req,res)=>{
  const id=parseInt(req.params.id,10); const f=await db.get(`SELECT * FROM folders WHERE id=$1`,[id]); if(!f)return res.status(404).json({error:'not_found'}); if(!(await requirePermission(req,res,'manage_folders',f.client_id)))return res.status(403).json({error:'permission_denied'});
  const name=U.sanitizeName(req.body?.name||'',120);
  if(!name)return res.status(400).json({error:'invalid_data'});
  const duplicate=await db.get(`SELECT id FROM folders WHERE client_id=$1 AND parent_id IS NOT DISTINCT FROM $2 AND name=$3 AND id<>$4 LIMIT 1`,[f.client_id,f.parent_id,name,id]);
  if(duplicate)return res.status(409).json({error:'folder_exists'});
  await renameFolder(f.drive_id,name);
  try { await db.run(`UPDATE folders SET name=$1,updated_at=NOW() WHERE id=$2`,[name,id]); } catch(e) { if(e.code==='23505')return res.status(409).json({error:'folder_exists'}); throw e; }
  await audit(req,'folder_renamed','folder',id,{name}); res.json({ok:true});
});
app.delete('/api/admin/folders/:id', requireAdmin, async (req,res)=>{
  const id=parseInt(req.params.id,10);
  const f=await db.get(`SELECT * FROM folders WHERE id=$1`,[id]);
  if(!f)return res.status(404).json({error:'not_found'});
  if(!(await requirePermission(req,res,'manage_folders',f.client_id)))return res.status(403).json({error:'permission_denied'});
  const child=await db.get(`SELECT id FROM folders WHERE parent_id=$1 LIMIT 1`,[id]);
  const file=await db.get(`SELECT id FROM files WHERE folder_id=$1 LIMIT 1`,[id]);
  if(child||file)return res.status(400).json({error:'folder_not_empty'});
  try {
    await deleteFile(f.drive_id);
  } catch (e) {
    console.error('[Drive] folder delete failed:', e.message);
    return res.status(502).json({error:'folder_drive_delete_failed'});
  }
  await db.run(`DELETE FROM folders WHERE id=$1`,[id]);
  await audit(req,'folder_deleted','folder',id,{client_id:f.client_id});
  res.json({ok:true});
});

app.put('/api/admin/folders/:id/move', requireAdmin, async (req,res)=>{
  const id=parseInt(req.params.id,10); const f=await db.get(`SELECT * FROM folders WHERE id=$1`,[id]); if(!f)return res.status(404).json({error:'not_found'}); if(!(await requirePermission(req,res,'manage_folders',f.client_id)))return res.status(403).json({error:'permission_denied'});
  const parentId=req.body?.parent_id?parseInt(req.body.parent_id,10):null; if(parentId===id)return res.status(400).json({error:'invalid_parent'});
  if(parentId){const p=await db.get(`SELECT * FROM folders WHERE id=$1 AND client_id=$2`,[parentId,f.client_id]);if(!p)return res.status(400).json({error:'invalid_parent'}); let cursor=p; while(cursor?.parent_id){if(cursor.parent_id===id)return res.status(400).json({error:'invalid_parent'});cursor=await db.get(`SELECT id,parent_id FROM folders WHERE id=$1`,[cursor.parent_id]);}}
  const duplicate=await db.get(`SELECT id FROM folders WHERE client_id=$1 AND parent_id IS NOT DISTINCT FROM $2 AND name=$3 AND id<>$4 LIMIT 1`,[f.client_id,parentId,f.name,id]);
  if(duplicate)return res.status(409).json({error:'folder_exists'});
  let driveParent=process.env.GOOGLE_DRIVE_FOLDER_ID; if(parentId){driveParent=(await db.get(`SELECT drive_id FROM folders WHERE id=$1`,[parentId])).drive_id;}
  await moveFolder(f.drive_id,driveParent);
  await db.run(`UPDATE folders SET parent_id=$1,sort_order=(SELECT COALESCE(MAX(sort_order),0)+1 FROM folders WHERE client_id=$2 AND parent_id IS NOT DISTINCT FROM $1),updated_at=NOW() WHERE id=$3`,[parentId,f.client_id,id]); await audit(req,'folder_moved','folder',id,{parent_id:parentId}); res.json({ok:true});
});
app.post('/api/admin/inbox/discard-all', requireAdmin, async (req,res)=>{
  if(!(await requirePermission(req,res,'delete_files')))return res.status(403).json({error:'permission_denied'});
  const rows=await db.all(`SELECT id,stored FROM files WHERE inbox=1`); for(const f of rows){try{await deleteFile(f.stored);}catch(e){console.error('[Drive] discard-all',e.message);}}
  await db.run(`DELETE FROM files WHERE inbox=1`); await audit(req,'inbox_discard_all','inbox',null,{count:rows.length}); res.json({ok:true,count:rows.length});
});

/* -------------------------------- daily chat -------------------------------- */
function todayPortalDate(){ return `((m.created_at AT TIME ZONE 'Africa/Cairo')::date = (NOW() AT TIME ZONE 'Africa/Cairo')::date)`; }
app.get('/api/chat/:clientId', requireAuth, async (req,res)=>{
  const cid=parseInt(req.params.clientId,10); if(req.user.role==='client' && cid!==req.user.id)return res.status(403).json({error:'forbidden'});
  if(req.user.role==='admin' && !(await requirePermission(req,res,'chat',cid)))return res.status(403).json({error:'permission_denied'});
  const rows=await db.all(`SELECT m.id,m.client_id,m.sender_id,m.sender_role,m.message,m.created_at,u.name AS sender_name,u.name_ar AS sender_name_ar FROM chat_messages m LEFT JOIN users u ON u.id=m.sender_id WHERE m.client_id=$1 AND ${todayPortalDate()} ORDER BY m.created_at ASC`,[cid]); res.json({messages:rows});
});
app.post('/api/chat/:clientId', requireAuth, async (req,res)=>{
  const cid=parseInt(req.params.clientId,10); if(req.user.role==='client' && cid!==req.user.id)return res.status(403).json({error:'forbidden'}); if(req.user.role==='admin' && !(await requirePermission(req,res,'chat',cid)))return res.status(403).json({error:'permission_denied'});
  const message=U.sanitizeName(req.body?.message||'',1000); if(!message)return res.status(400).json({error:'empty_message'});
  const r=await db.run(`INSERT INTO chat_messages(client_id,sender_id,sender_role,message) VALUES($1,$2,$3,$4) RETURNING id,created_at`,[cid,req.user.id,req.user.role,message]); await audit(req,'chat_message','client',cid,{}); res.json({ok:true,message:{id:r.rows[0].id,created_at:r.rows[0].created_at}});
});

/* ------------------------------- client groups -------------------------------- */
app.get('/api/admin/client-groups', requireAdmin, async (req,res)=>{
  if(!(await requirePermission(req,res,'settings')))return res.status(403).json({error:'permission_denied'});
  const groups=await db.all(`SELECT g.id,g.name,g.sort_order,COUNT(u.id)::int AS client_count FROM client_groups g LEFT JOIN users u ON u.group_id=g.id AND u.role='client' GROUP BY g.id ORDER BY g.sort_order,g.name`);
  for(const g of groups){ g.client_ids=(await db.all(`SELECT id FROM users WHERE group_id=$1 AND role='client'`,[g.id])).map(r=>r.id); }
  res.json({groups});
});
app.post('/api/admin/client-groups', requireAdmin, async (req,res)=>{
  if(!(await requirePermission(req,res,'settings')))return res.status(403).json({error:'permission_denied'});
  const name=U.sanitizeName(req.body?.name||'',120); if(!name)return res.status(400).json({error:'invalid_data'});
  const clientIds=[...new Set((Array.isArray(req.body?.client_ids)?req.body.client_ids:[]).map(Number).filter(Number.isInteger))];
  try {
    const r=await db.run(`INSERT INTO client_groups(name) VALUES($1) RETURNING id`,[name]);
    const id=r.rows[0].id;
    if(clientIds.length) await db.run(`UPDATE users SET group_id=$1 WHERE id=ANY($2::int[]) AND role='client'`,[id,clientIds]);
    await audit(req,'client_group_created','client_group',id,{name,client_ids:clientIds});
    res.json({ok:true,id});
  } catch(e){ if(e.code==='23505')return res.status(409).json({error:'group_exists'}); throw e; }
});
app.put('/api/admin/client-groups/:id', requireAdmin, async (req,res)=>{
  if(!(await requirePermission(req,res,'settings')))return res.status(403).json({error:'permission_denied'});
  const id=parseInt(req.params.id,10); const g=await db.get(`SELECT id FROM client_groups WHERE id=$1`,[id]); if(!g)return res.status(404).json({error:'not_found'});
  const name=req.body?.name!==undefined?U.sanitizeName(req.body.name,120):undefined;
  if(name!==undefined && !name)return res.status(400).json({error:'invalid_data'});
  try {
    if(name!==undefined) await db.run(`UPDATE client_groups SET name=$1 WHERE id=$2`,[name,id]);
    if(Array.isArray(req.body?.client_ids)){
      const clientIds=[...new Set(req.body.client_ids.map(Number).filter(Number.isInteger))];
      await db.transaction(async ({query})=>{
        await query(`UPDATE users SET group_id=NULL WHERE group_id=$1`,[id]);
        if(clientIds.length) await query(`UPDATE users SET group_id=$1 WHERE id=ANY($2::int[]) AND role='client'`,[id,clientIds]);
      });
    }
    await audit(req,'client_group_updated','client_group',id,{}); res.json({ok:true});
  } catch(e){ if(e.code==='23505')return res.status(409).json({error:'group_exists'}); throw e; }
});
app.delete('/api/admin/client-groups/:id', requireAdmin, async (req,res)=>{
  if(!(await requirePermission(req,res,'settings')))return res.status(403).json({error:'permission_denied'});
  const id=parseInt(req.params.id,10); const g=await db.get(`SELECT id FROM client_groups WHERE id=$1`,[id]); if(!g)return res.status(404).json({error:'not_found'});
  await db.run(`DELETE FROM client_groups WHERE id=$1`,[id]);
  await audit(req,'client_group_deleted','client_group',id,{}); res.json({ok:true});
});

/* ------------------------------ portal settings ------------------------------ */
app.get('/api/settings', requireAdmin, async (req,res)=>{
  if(!(await requirePermission(req,res,'settings')))return res.status(403).json({error:'permission_denied'}); const rows=await db.all(`SELECT key,value,updated_at FROM portal_settings ORDER BY key`); res.json({settings:Object.fromEntries(rows.map(r=>[r.key,r.value]))});
});
app.put('/api/settings', requireAdmin, async (req,res)=>{
  if(!(await requirePermission(req,res,'settings')))return res.status(403).json({error:'permission_denied'}); const allowed=['brand.name_en','brand.name_ar','brand.tagline_en','brand.tagline_ar'];
  for(const key of allowed){if(req.body && req.body[key]!==undefined){const value=U.sanitizeName(String(req.body[key]),200);await db.run(`INSERT INTO portal_settings(key,value,updated_by) VALUES($1,$2,$3) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,[key,value,req.user.id]);}}
  await audit(req,'settings_updated','settings',null,{keys:allowed.filter(k=>req.body&&req.body[k]!==undefined)}); res.json({ok:true});
});

/* -------------------------------- file notes -------------------------------- */
app.get('/api/admin/files/:id/notes', requireAdmin, async (req,res)=>{
  const id=Number(req.params.id);
  const f=await db.get(`SELECT id,client_id,name FROM files WHERE id=$1`,[id]);
  if(!f)return res.status(404).json({error:'not_found'});
  if(!(await requirePermission(req,res,'view_files',f.client_id)))return res.status(403).json({error:'permission_denied'});
  const notes=await db.all(`
    SELECT n.id,n.file_id,n.note,n.created_at,n.author_id,u.name AS author_name,
           EXISTS(SELECT 1 FROM file_note_reads r WHERE r.note_id=n.id AND r.admin_id=$2) AS is_read
    FROM file_notes n LEFT JOIN users u ON u.id=n.author_id
    WHERE n.file_id=$1 ORDER BY n.created_at ASC
  `,[id,req.user.id]);
  await db.run(`INSERT INTO file_note_reads(note_id,admin_id) SELECT n.id,$2 FROM file_notes n WHERE n.file_id=$1 ON CONFLICT(note_id,admin_id) DO NOTHING`,[id,req.user.id]);
  res.json({file:f,notes});
});

app.post('/api/admin/files/:id/notes', requireAdmin, async (req,res)=>{
  const id=Number(req.params.id);
  const f=await db.get(`SELECT id,client_id,name FROM files WHERE id=$1`,[id]);
  if(!f)return res.status(404).json({error:'not_found'});
  if(!(await requirePermission(req,res,'view_files',f.client_id)))return res.status(403).json({error:'permission_denied'});
  const note=String(req.body?.note||'').trim().slice(0,2000);
  if(!note)return res.status(400).json({error:'empty_note'});
  const r=await db.run(`INSERT INTO file_notes(file_id,author_id,note) VALUES($1,$2,$3) RETURNING id,created_at`,[id,req.user.id,note]);
  await audit(req,'file_note_created','file',id,{});
  res.json({ok:true,note:{id:r.rows[0].id,created_at:r.rows[0].created_at}});
});

app.delete('/api/admin/files/:id/notes/:noteId', requireAdmin, async (req,res)=>{
  const id=Number(req.params.id), noteId=Number(req.params.noteId);
  if(!Number.isInteger(noteId) || noteId<=0) return res.status(400).json({error:'invalid_id'});
  const f=await db.get(`SELECT id,client_id FROM files WHERE id=$1`,[id]);
  if(!f)return res.status(404).json({error:'not_found'});
  if(!(await requirePermission(req,res,'view_files',f.client_id)))return res.status(403).json({error:'permission_denied'});
  if(!(await requirePermission(req,res,'delete_notes',f.client_id)))return res.status(403).json({error:'permission_denied'});
  const r=await db.run(`DELETE FROM file_notes WHERE id=$1 AND file_id=$2`,[noteId,id]);
  if(!r.rowCount)return res.status(404).json({error:'not_found'});
  await audit(req,'file_note_deleted','file',id,{note_id:noteId});
  res.json({ok:true});
});

/* --------------------------------- download ---------------------------------- */
app.get('/api/file/:id/download', async (req, res) => {
  const f = await db.get(`SELECT * FROM files WHERE id=$1`, [req.params.id]);
  if (!f) return res.status(404).json({ error: 'not_found' });

  const u = req.user;
  const allowed =
    u && ((u.role === 'admin' && await can(db, u, 'view_files', f.client_id)) || (u.role === 'client' && ((f.inbox === 0 && f.client_id === u.id) || f.sender_id === u.id)));

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

app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'public', '404.html')));

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
