'use strict';
const fs = require('fs');
const path = require('path');

const token = process.argv[2];
if (!token) {
  console.error('Usage: node scripts/set-refresh-token.js "YOUR_REFRESH_TOKEN"');
  process.exit(1);
}

const envPath = path.join(__dirname, '..', '.env');
let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

if (envContent.includes('GOOGLE_REFRESH_TOKEN=')) {
  envContent = envContent.replace(/GOOGLE_REFRESH_TOKEN=.*/g, `GOOGLE_REFRESH_TOKEN=${token.trim()}`);
} else {
  envContent += `\nGOOGLE_REFRESH_TOKEN=${token.trim()}\n`;
}

fs.writeFileSync(envPath, envContent);
console.log('[SUCCESS] GOOGLE_REFRESH_TOKEN saved to .env file!');
console.log('Google Drive is now fully enabled.');
