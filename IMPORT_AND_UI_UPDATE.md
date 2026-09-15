# Hamada Portal — Client Import + UI Update

## Client JSON import

The admin Clients page now has **Import JSON** next to **New client**.

Accepted format:

```json
{
  "clients": [
    {
      "name": "Ahmed Ali",
      "name_ar": "أحمد علي",
      "email": "ahmed@example.com",
      "phone": "01012345678",
      "password": "temporary123"
    }
  ]
}
```

A plain JSON array is also accepted by the UI and converted to the format above before sending.

- Maximum: 1,000 clients per import.
- Existing clients are skipped, never overwritten.
- Duplicate emails/phones inside the import are skipped.
- Invalid records are skipped and reported by row.
- If `password` is omitted, the phone number becomes the temporary password, matching the existing manual client creation behavior.
- Passwords are hashed on the server.
- The import is admin/permission protected and recorded in the audit log.

## UI direction

The visual update keeps the existing Hamada navy/gold professional identity and avoids decorative neon/glowing gradients. It adds restrained motion, hover feedback, entrance transitions, a subtle live-status indicator, and a polished import preview/results flow.

## Applying the update

This archive is a source update. Keep your existing `.env`, Google OAuth credentials, local data, and `node_modules` from your working project. Replace the corresponding source files with the versions in this archive, then run:

```powershell
npm start
```

The included `CLIENT_IMPORT_EXAMPLE.json` can be used as a starting template.
