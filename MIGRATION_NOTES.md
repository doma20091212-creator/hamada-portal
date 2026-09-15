# Hamada Portal upgrade notes

This version upgrades the existing portal without dropping the existing `users` or `files` tables.

## Database

On startup, `lib/db.js` creates the new tables/columns if they do not exist:

- `is_owner` on `users`
- `folders` + `files.folder_id`
- `admin_permissions`
- `admin_client_access`
- `audit_logs`
- `chat_messages`
- `portal_settings`

The first existing admin is marked as the owner. Existing text-based folders are migrated into portal folders when Google Drive is available; existing files are not deleted.

## Production secrets

Do not commit or upload `.env` or Google credential JSON files. Set these in Render instead:

- `DATABASE_URL`
- `DATABASE_SSL`
- `SESSION_SECRET`
- `NODE_ENV=production`
- `GOOGLE_DRIVE_FOLDER_ID`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`
- `GOOGLE_REFRESH_TOKEN`

After a credential-bearing archive has been exposed, rotate the affected secrets before production.

## New owner controls

The owner can create admins and assign permissions/client access with optional expiry timestamps. Backend checks enforce these permissions even if an admin calls an API directly.


## Fixed v4
- Added Express route-parameter validation for numeric `:id` and `:clientId` values.
- Malformed URLs now return HTTP 400 instead of sending `NaN` to PostgreSQL and terminating the Express 4 process.
