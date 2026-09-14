'use strict';
/* Demo data for previews/testing. SAFE: refuses to run unless SEED_DEMO=1 and DB has no clients.
 * Run: SEED_DEMO=1 node scripts/seed-demo.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db, FILES_DIR } = require('../lib/db');
const U = require('../lib/util');

if (process.env.SEED_DEMO !== '1') {
  console.error('Refusing to run. Set SEED_DEMO=1 to seed demo data.');
  process.exit(1);
}

const insUser = db.prepare(
  `INSERT INTO users (role,name,name_ar,email,phone,password_hash,must_change,active) VALUES ('client',?,?,?,?,?,0,1)`
);
const clients = [
  { name: 'Delta Textiles Co.', name_ar: 'شركة دلتا للغزل والنسيج', email: 'delta.textiles@example.com', phone: '01001234567' },
  { name: 'Nile Trade & Import', name_ar: 'شركة النيل للتجارة والاستيراد', email: 'niletrade@example.com', phone: '01119876543' },
  { name: 'Ahmed Hassan — Free Practitioner', name_ar: 'أحمد حسن — محاسب قانوني حر', email: 'ahmed.hassan@example.com', phone: '01223456789' },
];
const made = [];
for (const c of clients) {
  try {
    const phone = U.normalizePhone(c.phone);
    const info = insUser.run(c.name, c.name_ar, c.email.toLowerCase(), phone, bcrypt.hashSync(phone, 10));
    made.push({ id: info.lastInsertRowid, ...c, phone });
  } catch (e) {
    console.log('skip (already seeded?):', c.email, e.message);
  }
}

function fakeDoc(title) {
  return Buffer.from(
    `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n` +
    `3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n` +
    `4 0 obj<</Length 60>>stream\nBT /F1 18 Tf 60 760 Td (${title}) Tj ET\nendstream endobj\n` +
    `5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
    'utf8'
  );
}
const CSV = Buffer.from('قيد,بيان,مدين,دائن\n1,VAT return Q2,12500,0\n2,Withholding tax,0,4800\n', 'utf8');

const insFile = db.prepare(
  `INSERT INTO files (client_id,sender_id,inbox,name,stored,size,mime,folder,note,is_read,created_at) VALUES (?,?,?,?,?,?,?,?,'',0,?)`
);
const admin = db.prepare(`SELECT id FROM users WHERE role='admin' LIMIT 1`).get();
const now = () => new Date(Date.now() - Math.floor(Math.random() * 20) * 864e5).toISOString().slice(0, 19).replace('T', ' ');

const demo = [
  { c: 0, name: 'VAT Return Q2 2026.pdf', data: fakeDoc('VAT Return Q2 2026 - Delta Textiles'), folder: 'Tax 2026' },
  { c: 0, name: 'Invoices list - March.pdf', data: fakeDoc('Invoices March'), folder: 'Tax 2026' },
  { c: 0, name: 'Financial statements 2025.pdf', data: fakeDoc('FS 2025'), folder: 'Financial Statements' },
  { c: 1, name: 'Customs declarations batch 7.pdf', data: fakeDoc('Customs batch 7'), folder: 'Customs' },
  { c: 2, name: 'withholding-tax-ledger.csv', data: CSV, folder: '' },
  { c: 2, name: 'contracts scan 001.pdf', data: fakeDoc('Contracts scan'), folder: 'Contracts' },
];
for (const d of demo) {
  const cid = made[d.c] && made[d.c].id;
  if (!cid || db.prepare(`SELECT id FROM files WHERE name=? AND client_id=?`).get(d.name, cid)) continue;
  const ext = (d.name.match(/\.[A-Za-z0-9]+$/) || ['.pdf'])[0].toLowerCase();
  const stored = crypto.randomUUID().replaceAll('-', '') + ext;
  const p = path.join(FILES_DIR, stored);
  if (!fs.existsSync(p)) fs.writeFileSync(p, d.data);
  insFile.run(cid, admin ? admin.id : cid, 0, d.name, stored, d.data.length, 'application/pdf', d.folder, now());
}

// one pending item in the admin inbox from client 1
const pendName = 'bank-statement-sept.png';
{
  const cid = made[0] && made[0].id;
  if (cid && !db.prepare(`SELECT id FROM files WHERE name=?`).get(pendName)) {
    const stored = crypto.randomUUID().replaceAll('-', '') + '.png';
    // tiny 1x1 png bytes as placeholder
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    fs.writeFileSync(path.join(FILES_DIR, stored), Buffer.from(b64, 'base64'));
    db.prepare(
      `INSERT INTO files (client_id,sender_id,inbox,name,stored,size,mime,folder,note,is_read,created_at)
       VALUES (?,?,1,?,?,?,?,?,'',0,datetime('now'))`
    ).run(cid, cid, pendName, stored, 70, 'image/png', 'Please add my September bank statement to my folder.');
  }
}

console.log('Demo clients created:');
for (const m of made) console.log(`  ${m.name.padEnd(38)} login: ${m.email}  password: ${m.phone}`);
