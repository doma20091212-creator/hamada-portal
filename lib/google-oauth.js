'use strict';

const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/drive'];

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

function getAuthUrl(state) {
  const oauth2Client = getOAuthClient();

  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state
  });
}

async function getTokens(code) {
  const oauth2Client = getOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);
  return tokens;
}

module.exports = {
  getOAuthClient,
  getAuthUrl,
  getTokens
};