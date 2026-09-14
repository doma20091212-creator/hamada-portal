'use strict';
const path = require('path');

/** Normalize a phone/number to digits; Egyptian-friendly (+20 / 0020 → leading 0). */
function normalizePhone(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.length === 13 && d.startsWith('0020')) d = '0' + d.slice(4);
  if (d.length === 12 && d.startsWith('20')) d = '0' + d.slice(2);
  if (d.length === 10 && /^1[0125]/.test(d)) d = '0' + d;
  return d;
}

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
function validEmail(v) {
  return typeof v === 'string' && v.length <= 254 && EMAIL_RE.test(v);
}

/** multer decodes multipart filenames as latin1; fix UTF-8 (e.g. Arabic names). */
function latinFix(s) {
  try {
    const fixed = Buffer.from(String(s), 'latin1').toString('utf8');
    // only adopt if it round-trips cleanly
    return Buffer.from(fixed, 'utf8').toString('latin1') === String(s) ? fixed : String(s);
  } catch {
    return String(s);
  }
}

function sanitizeName(s, max = 80) {
  const v = String(s || '')
    .replace(/[\u0000-\u001f\u007f\u200e\u200f]/g, '')
    .trim()
    .slice(0, max);
  return v;
}

/** Single-level folder label: no path separators. */
function sanitizeFolder(s) {
  return sanitizeName(s, 60).replace(/[\\/:*?"<>|]/g, '').trim();
}

/** Display filename: basename only, no control chars, no quotes. */
function sanitizeFilename(s) {
  let v = path.basename(String(s || ''))
    .replace(/[\u0000-\u001f\u007f"\\]/g, '')
    .trim();
  if (!v) v = 'file';
  return v.slice(0, 160);
}

module.exports = { normalizePhone, validEmail, latinFix, sanitizeName, sanitizeFolder, sanitizeFilename, path };
