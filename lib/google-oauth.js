'use strict';

const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/drive'];

function getOAuthClient(redirectUri = process.env.GOOGLE_REDIRECT_URI) {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri
  );
}

function getAuthUrl(state, redirectUri) {
  const oauth2Client = getOAuthClient(redirectUri);

  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state
  });
}

async function getTokens(code, redirectUri) {
  const oauth2Client = getOAuthClient(redirectUri);
  const { tokens } = await oauth2Client.getToken(code);
  return tokens;
}

module.exports = {
  getOAuthClient,
  getAuthUrl,
  getTokens
};