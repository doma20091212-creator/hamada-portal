'use strict';
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 5,
});

async function initDb() {
  // Neon can occasionally reset an idle/new TLS connection. Retry startup a few times
  // so a transient ECONNRESET does not crash the whole portal.
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await pool.query('SELECT 1');
      lastError = null;
      break;
    } catch (e) {
      lastError = e;
      if (attempt === 5) throw e;
      const delay = attempt * 1000;
      console.warn(`[db] Connection attempt ${attempt}/5 failed (${e.code || e.message}); retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      role TEXT NOT NULL CHECK (role IN ('admin','client')),
      name TEXT NOT NULL,
      name_ar TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL UNIQUE,
      phone TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      must_change INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      is_owner INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_owner INTEGER NOT NULL DEFAULT 0;

    CREATE TABLE IF NOT EXISTS client_groups (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS group_id INTEGER REFERENCES client_groups(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_users_group ON users(group_id);

    CREATE TABLE IF NOT EXISTS folders (
      id SERIAL PRIMARY KEY,
      client_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      drive_id TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(client_id,parent_id,name)
    );

    CREATE TABLE IF NOT EXISTS files (
      id SERIAL PRIMARY KEY,
      client_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sender_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      inbox INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL,
      stored TEXT NOT NULL UNIQUE,
      size BIGINT NOT NULL DEFAULT 0,
      mime TEXT NOT NULL DEFAULT '',
      folder TEXT NOT NULL DEFAULT '',
      folder_id INTEGER,
      note TEXT NOT NULL DEFAULT '',
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_files_client ON files(client_id, inbox);
    CREATE INDEX IF NOT EXISTS idx_files_inbox ON files(inbox, is_read);
    CREATE INDEX IF NOT EXISTS idx_files_sender ON files(sender_id);
    ALTER TABLE files ADD COLUMN IF NOT EXISTS folder_id INTEGER;
    CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder_id);

    CREATE TABLE IF NOT EXISTS admin_permissions (
      id SERIAL PRIMARY KEY,
      admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      permission_key TEXT NOT NULL,
      granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(admin_id, permission_key)
    );
    CREATE INDEX IF NOT EXISTS idx_admin_permissions_active ON admin_permissions(admin_id, permission_key, starts_at, expires_at);

    CREATE TABLE IF NOT EXISTS admin_client_access (
      id SERIAL PRIMARY KEY,
      admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      client_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(admin_id, client_id)
    );
    CREATE INDEX IF NOT EXISTS idx_admin_client_access_active ON admin_client_access(admin_id, client_id, starts_at, expires_at);

    CREATE TABLE IF NOT EXISTS client_folder_access (
      id SERIAL PRIMARY KEY,
      client_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
      granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(client_id, folder_id)
    );
    CREATE INDEX IF NOT EXISTS idx_client_folder_access_client ON client_folder_access(client_id, folder_id);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id BIGSERIAL PRIMARY KEY,
      actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL DEFAULT '',
      entity_id TEXT,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);

    CREATE TABLE IF NOT EXISTS chat_messages (
      id BIGSERIAL PRIMARY KEY,
      client_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sender_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      sender_role TEXT NOT NULL CHECK (sender_role IN ('admin','client')),
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_chat_day ON chat_messages(client_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS file_notes (
      id BIGSERIAL PRIMARY KEY,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      note TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_file_notes_file ON file_notes(file_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS file_note_reads (
      note_id BIGINT NOT NULL REFERENCES file_notes(id) ON DELETE CASCADE,
      admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(note_id, admin_id)
    );

    CREATE INDEX IF NOT EXISTS idx_file_note_reads_admin ON file_note_reads(admin_id, note_id);

    CREATE TABLE IF NOT EXISTS portal_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Convert legacy text folders into portal folders. Existing files are not deleted or moved.
  const legacy = await pool.query(`SELECT DISTINCT f.client_id,f.folder,u.name AS client_name FROM files f JOIN users u ON u.id=f.client_id WHERE f.inbox=0 AND f.folder<>'' AND f.folder_id IS NULL`);
  for (const row of legacy.rows) {
    let folder = (await pool.query(`SELECT id FROM folders WHERE client_id=$1 AND parent_id IS NULL AND name=$2 LIMIT 1`, [row.client_id,row.folder])).rows[0];
    if (!folder) {
      try {
        const driveId=(await require('./drive').createFolder(`${row.client_name} - ${row.folder}`)).id;
        folder=(await pool.query(`INSERT INTO folders(client_id,parent_id,name,sort_order,drive_id) VALUES($1,NULL,$2,(SELECT COALESCE(MAX(sort_order),0)+1 FROM folders WHERE client_id=$1 AND parent_id IS NULL),$3) RETURNING id`,[row.client_id,row.folder,driveId])).rows[0];
      } catch(e) { console.error('[db] legacy folder migration:',e.message); continue; }
    }
    await pool.query(`UPDATE files SET folder_id=$1 WHERE client_id=$2 AND folder=$3 AND folder_id IS NULL`,[folder.id,row.client_id,row.folder]);
  }

  const defaults = {
    'brand.name_en': process.env.BRAND_NAME_EN || 'Hamada Ahmed Ali for Accounting',
    'brand.name_ar': process.env.BRAND_NAME_AR || 'حمادة أحمد علي للمحاسبة والمراجعة',
    'brand.tagline_en': process.env.BRAND_TAGLINE_EN || 'Accounting & Auditing — Client Documents Portal',
    'brand.tagline_ar': process.env.BRAND_TAGLINE_AR || 'المحاسبة والمراجعة — بوابة مستندات العملاء'
  };
  for (const [key,value] of Object.entries(defaults)) await pool.query(`INSERT INTO portal_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO NOTHING`,[key,value]);

  // The first existing admin is the permanent owner. This is additive and does not alter clients/files.
  await pool.query(`
    UPDATE users SET is_owner=1
    WHERE id=(SELECT id FROM users WHERE role='admin' ORDER BY id ASC LIMIT 1)
      AND NOT EXISTS (SELECT 1 FROM users WHERE role='admin' AND is_owner=1);
  `);
}

const db = {
  async get(text, params = []) { const r = await pool.query(text, params); return r.rows[0] || undefined; },
  async all(text, params = []) { const r = await pool.query(text, params); return r.rows; },
  async run(text, params = []) { return pool.query(text, params); },
  async transaction(fn) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const result = await fn({ query: (text, params=[]) => client.query(text, params) }); await client.query('COMMIT'); return result; }
    catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  }
};

module.exports = { db, initDb };
