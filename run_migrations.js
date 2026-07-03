// run_migrations.js — Run all schema and migration files
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function run() {
  try {
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(schema);
    console.log('Schema applied successfully');
  } catch (e) {
    console.error('Schema error:', e.message);
  }

  const migrationsDir = path.join(__dirname, 'migrations');
  if (fs.existsSync(migrationsDir)) {
    const files = fs.readdirSync(migrationsDir).sort();
    for (const file of files) {
      if (file.endsWith('.sql')) {
        try {
          const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
          await pool.query(sql);
          console.log(`Migration ${file} applied`);
        } catch (e) {
          console.error(`Migration ${file}: ${e.message}`);
        }
      }
    }
  }

  await pool.end();
  console.log('All migrations complete');
}

run().catch(e => { console.error(e); process.exit(1); });
