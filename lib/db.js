'use strict';
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 5,
});

async function initDb() {
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
      note TEXT NOT NULL DEFAULT '',
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_files_client ON files(client_id, inbox);
    CREATE INDEX IF NOT EXISTS idx_files_inbox ON files(inbox, is_read);
    CREATE INDEX IF NOT EXISTS idx_files_sender ON files(sender_id);
  `);
}

const db = {
  async get(text, params = []) { const r = await pool.query(text, params); return r.rows[0] || undefined; },
  async all(text, params = []) { const r = await pool.query(text, params); return r.rows; },
  async run(text, params = []) { const r = await pool.query(text, params); return r; },
  async transaction(fn) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const result = await fn({ query: (text, params=[]) => client.query(text, params) }); await client.query('COMMIT'); return result; }
    catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  }
};

module.exports = { db, initDb };
