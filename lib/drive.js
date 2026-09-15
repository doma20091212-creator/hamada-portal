'use strict';

const { google } = require('googleapis');
const { Readable } = require('stream');

function getDriveClient() {
  if (!process.env.GOOGLE_REFRESH_TOKEN) {
    throw new Error('GOOGLE_REFRESH_TOKEN is not configured');
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  });

  return google.drive({
    version: 'v3',
    auth: oauth2Client,
  });
}

async function uploadFile(file, parentId) {
  const drive = getDriveClient();

  const folderId = parentId || process.env.GOOGLE_DRIVE_FOLDER_ID;

  if (!folderId) {
    throw new Error('GOOGLE_DRIVE_FOLDER_ID is not configured');
  }

  const result = await drive.files.create({
    requestBody: {
      name: file.originalname,
      parents: [folderId],
    },
    media: {
      mimeType: file.mimetype || 'application/octet-stream',
      body: Readable.from(file.buffer),
    },
    fields: 'id,name,size,mimeType',
  });

  return {
    stored: result.data.id,
    name: result.data.name,
    size: Number(result.data.size || file.size || 0),
    mime: result.data.mimeType || file.mimetype || '',
  };
}

async function createFolder(name, parentId) {
  const drive = getDriveClient();
  const parent = parentId || process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!parent) throw new Error('GOOGLE_DRIVE_FOLDER_ID is not configured');
  const result = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parent] },
    fields: 'id,name',
  });
  return result.data;
}

async function renameFolder(folderId, name) {
  const drive = getDriveClient();
  const result = await drive.files.update({ fileId: folderId, requestBody: { name }, fields: 'id,name' });
  return result.data;
}

async function moveFile(fileId, newParentId) {
  const drive = getDriveClient();
  const current = await drive.files.get({ fileId, fields: 'parents' });
  const oldParents = (current.data.parents || []).join(',');
  await drive.files.update({ fileId, addParents: newParentId, removeParents: oldParents || undefined, fields: 'id,parents' });
}


async function moveFolder(folderId, newParentId) {
  const drive = getDriveClient();
  const current = await drive.files.get({ fileId: folderId, fields: 'parents' });
  const oldParents = (current.data.parents || []).join(',');
  const parent = newParentId || process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!parent) throw new Error('GOOGLE_DRIVE_FOLDER_ID is not configured');
  await drive.files.update({ fileId: folderId, addParents: parent, removeParents: oldParents || undefined, fields: 'id,parents' });
}

async function deleteFile(fileId) {
  if (!fileId) return;

  const drive = getDriveClient();

  try {
    await drive.files.delete({ fileId });
  } catch (err) {
    if (err.code === 404) return;
    throw err;
  }
}

async function downloadFileBuffer(fileId) {
  const drive = getDriveClient();
  const response = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
  return Buffer.from(response.data);
}

async function downloadFile(fileId, res, fileName, mimeType) {
  const drive = getDriveClient();

  const response = await drive.files.get(
    {
      fileId,
      alt: 'media',
    },
    {
      responseType: 'stream',
    }
  );

  res.setHeader(
    'Content-Type',
    mimeType || 'application/octet-stream'
  );

  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${encodeURIComponent(fileName || 'download')}"`
  );

  response.data.on('error', (err) => {
    console.error('[Drive] Download error:', err);

    if (!res.headersSent) {
      res.status(500).end();
    } else {
      res.end();
    }
  });

  response.data.pipe(res);
}

module.exports = {
  uploadFile,
  createFolder,
  renameFolder,
  moveFile,
  moveFolder,
  deleteFile,
  downloadFile,
  downloadFileBuffer,
};