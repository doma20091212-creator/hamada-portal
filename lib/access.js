'use strict';

const PERMISSIONS = [
  { key: 'view_clients', label: 'View clients' },
  { key: 'view_files', label: 'View / download files' },
  { key: 'upload_files', label: 'Upload files' },
  { key: 'rename_files', label: 'Rename files' },
  { key: 'delete_files', label: 'Delete files' },
  { key: 'manage_folders', label: 'Create / rename / move folders' },
  { key: 'chat', label: 'Use chat' },
  { key: 'manage_clients', label: 'Manage clients' },
  { key: 'manage_admins', label: 'Manage admins' },
  { key: 'settings', label: 'Edit portal settings' },
  { key: 'delete_notes', label: 'Delete file notes' },
];

async function isOwner(db, userId) {
  const row = await db.get(`SELECT is_owner FROM users WHERE id=$1 AND role='admin'`, [userId]);
  return !!(row && row.is_owner);
}

async function hasPermission(db, userId, permission) {
  if (await isOwner(db, userId)) return true;
  const row = await db.get(`
    SELECT 1 FROM admin_permissions
    WHERE admin_id=$1 AND permission_key=$2
      AND starts_at <= NOW()
      AND (expires_at IS NULL OR expires_at > NOW())
  `, [userId, permission]);
  return !!row;
}

async function hasClientAccess(db, userId, clientId) {
  if (await isOwner(db, userId)) return true;
  const row = await db.get(`
    SELECT 1 FROM admin_client_access
    WHERE admin_id=$1 AND client_id=$2
      AND starts_at <= NOW()
      AND (expires_at IS NULL OR expires_at > NOW())
  `, [userId, clientId]);
  return !!row;
}

async function can(db, user, permission, clientId) {
  if (!user || user.role !== 'admin') return false;
  if (!(await hasPermission(db, user.id, permission))) return false;
  if (clientId !== undefined && clientId !== null) return hasClientAccess(db, user.id, Number(clientId));
  return true;
}

async function getAdminProfile(db, userId) {
  const owner = await isOwner(db, userId);
  const permissions = owner
    ? PERMISSIONS.map(p => p.key)
    : (await db.all(`SELECT permission_key FROM admin_permissions WHERE admin_id=$1 AND starts_at <= NOW() AND (expires_at IS NULL OR expires_at > NOW())`, [userId])).map(r => r.permission_key);
  return { is_owner: owner, permissions };
}

module.exports = { PERMISSIONS, isOwner, hasPermission, hasClientAccess, can, getAdminProfile };
