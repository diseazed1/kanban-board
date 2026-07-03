// reset_admin_pw.cjs — Reset the admin user's password
// Usage: node reset_admin_pw.cjs <new_password>
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function run() {
  const newPassword = process.argv[2];
  if (!newPassword) {
    console.error('Usage: node reset_admin_pw.cjs <new_password>');
    process.exit(1);
  }

  const hash = await bcrypt.hash(newPassword, 12);
  const result = await pool.query(
    `UPDATE users SET password_hash = $1 WHERE username = 'admin' RETURNING id, username`,
    [hash]
  );

  if (result.rowCount === 0) {
    console.error('No admin user found');
    process.exit(1);
  }

  console.log(`Admin password reset successfully for user id=${result.rows[0].id}`);
  await pool.end();
}

run().catch(e => { console.error(e.message); process.exit(1); });
