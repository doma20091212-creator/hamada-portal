const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const CREDENTIALS_PATH = path.join(
  __dirname,
  "..",
  "google-oauth-client.json"
);

const TOKEN_PATH = path.join(
  __dirname,
  "..",
  "google-token.json"
);

const SCOPES = [
  "https://www.googleapis.com/auth/drive.file"
];

function getOAuthClient() {
  const credentials = JSON.parse(
    fs.readFileSync(CREDENTIALS_PATH, "utf8")
  );

  const config = credentials.web || credentials.installed;

  return new google.auth.OAuth2(
    config.client_id,
    config.client_secret,
    config.redirect_uris[0]
  );
}

function getAuthUrl() {
  const oauth2Client = getOAuthClient();

  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES
  });
}

async function getAuthorizedClient() {
  const oauth2Client = getOAuthClient();

  if (!fs.existsSync(TOKEN_PATH)) {
    return null;
  }

  const token = JSON.parse(
    fs.readFileSync(TOKEN_PATH, "utf8")
  );

  oauth2Client.setCredentials(token);

  return oauth2Client;
}

async function saveToken(code) {
  const oauth2Client = getOAuthClient();

  const { tokens } = await oauth2Client.getToken(code);

  fs.writeFileSync(
    TOKEN_PATH,
    JSON.stringify(tokens, null, 2)
  );

  oauth2Client.setCredentials(tokens);

  return oauth2Client;
}

module.exports = {
  getAuthUrl,
  getAuthorizedClient,
  saveToken
};