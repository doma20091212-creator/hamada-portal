require('dotenv').config();
'use strict';

const bcrypt = require('bcryptjs');
const { db } = require('../lib/db');

async function resetAdmin() {
  const hash = bcrypt.hashSync('01010799378', 10);
  await db.run(
    'UPDATE users SET password_hash=$1, must_change=1 WHERE email=$2 OR role=$3',
    [hash, 'doma20091212@gmail.com', 'admin']
  );
  console.log('Admin password successfully reset to: 01010799378');
  process.exit(0);
}

resetAdmin().catch(err => {
  console.error(err);
  process.exit(1);
});
