# Hamada Ahmed Ali — Client Documents Portal

This version is prepared for cloud deployment with:

- **Node.js + Express** application
- **PostgreSQL** for users, permissions and document metadata
- **Google Drive** for the actual client documents
- **bcrypt** password hashing and signed HttpOnly sessions

## Environment variables

Copy `.env.example` to `.env` for local testing and fill in:

- `DATABASE_URL` — PostgreSQL connection string
- `SESSION_SECRET` — long random secret
- `GOOGLE_SERVICE_ACCOUNT_JSON` — Google service-account JSON as one line
- `GOOGLE_DRIVE_FOLDER_ID` — Drive folder where portal files will be stored

For production, put these in your hosting provider's environment-variable settings instead of committing `.env`.

## Google Drive setup

1. Create a Google Cloud project.
2. Enable the Google Drive API.
3. Create a service account and download its JSON key.
4. Create a private folder in Google Drive for portal documents.
5. Share that folder with the service-account email as **Editor**.
6. Put the folder ID into `GOOGLE_DRIVE_FOLDER_ID`.

The folder should stay private. The portal downloads files through the authenticated server, so clients do not receive a public Drive link.

## PostgreSQL setup

Create a PostgreSQL database with your provider (for example, Neon or another managed PostgreSQL service) and put its connection string in `DATABASE_URL`. The application creates its tables automatically on first start.

## Run locally

```bash
npm install
npm start
```

The local server uses port 3000 unless `PORT` is set.

First start creates the admin from `config.json`. The initial password is the configured phone number unless `config.admin.password` is supplied.

To reset it later:

```bash
node scripts/reset-admin.js --password "YourNewPassword"
```

## Render deployment

Create a Web Service from this repository/project.

Build command:

```bash
npm install
```

Start command:

```bash
npm start
```

Set `NODE_ENV=production` and the four required secrets/connection values in Render Environment Variables. Render supplies `PORT` automatically.

## Important

Do **not** commit:

- `.env`
- Google service-account JSON files
- database backups
- client documents
- old `data/portal.db` files

The old local SQLite database is intentionally no longer used by this version.
