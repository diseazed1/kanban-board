#!/usr/bin/env node
/**
 * seed_admin.js — Bootstrap the first admin user directly into the database.
 *
 * Usage:
 *   DATABASE_URL="postgres://..." node seed_admin.js <username> <email> <password>
 *
 * Example:
 *   DATABASE_URL="postgres://..." node seed_admin.js admin admin@example.com "S3cur3P@ss!"
 *
 * The script hashes the password with Argon2id and inserts the user with
 * role = 'admin'.  It is idempotent: running it twice with the same username
 * will print a warning and exit cleanly rather than creating a duplicate.
 */

import argon2 from 'argon2';
import pg from 'pg';

const [username, email, password] = process.argv.slice(2);

if (!username || !email || !password) {
    console.error('Usage: node seed_admin.js <username> <email> <password>');
    process.exit(1);
}

if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL environment variable is not set.');
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Hash the password using Argon2id (same settings as auth routes)
// ---------------------------------------------------------------------------
const hash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536,   // 64 MB
    timeCost: 3,         // 3 iterations (OWASP minimum for Argon2id)
    parallelism: 2,
});

// ---------------------------------------------------------------------------
// Insert into the database
// ---------------------------------------------------------------------------
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

try {
    const existing = await pool.query(
        'SELECT id FROM users WHERE username = $1 OR email = $2',
        [username, email]
    );

    if (existing.rowCount > 0) {
        console.warn(`WARNING: A user with username "${username}" or email "${email}" already exists.`);
        console.warn('No changes were made.');
        process.exit(0);
    }

    const result = await pool.query(
        `INSERT INTO users (username, email, password_hash, role)
         VALUES ($1, $2, $3, 'admin')
         RETURNING id, username, email, role`,
        [username, email, hash]
    );

    const user = result.rows[0];
    console.log(`\nAdmin user created successfully:`);
    console.log(`  ID:       ${user.id}`);
    console.log(`  Username: ${user.username}`);
    console.log(`  Email:    ${user.email}`);
    console.log(`  Role:     ${user.role}`);
    console.log(`\nYou can now log in at your Kanban Board URL.\n`);
} finally {
    await pool.end();
}
