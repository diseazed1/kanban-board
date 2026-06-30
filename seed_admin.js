#!/usr/bin/env node
/**
 * seed_admin.js — Bootstrap the first admin user and default board columns.
 *
 * Usage:
 *   DATABASE_URL="postgres://..." node seed_admin.js <username> <email> <password>
 *
 * Example:
 *   DATABASE_URL="postgres://..." node seed_admin.js admin admin@example.com "S3cur3P@ss!"
 *
 * This script will:
 *   1. Create the admin user (idempotent — skips if already exists)
 *   2. Seed default board columns (if the columns table is empty)
 *
 * The password is hashed with Argon2id using OWASP-recommended settings.
 */

import argon2 from 'argon2';
import pg from 'pg';

const [username, email, password] = process.argv.slice(2);

if (!username || !email || !password) {
    console.error('Usage: node seed_admin.js <username> <email> <password>');
    process.exit(1);
}

if (password.length < 8) {
    console.error('Error: Password must be at least 8 characters.');
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
const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

try {
    // -------------------------------------------------------------------------
    // Step 1: Create admin user
    // -------------------------------------------------------------------------
    const existing = await pool.query(
        'SELECT id FROM users WHERE username = $1 OR email = $2',
        [username, email]
    );

    let adminId;

    if (existing.rowCount > 0) {
        adminId = existing.rows[0].id;
        console.log(`Admin user "${username}" already exists (id: ${adminId}) — skipping user creation.`);
    } else {
        const result = await pool.query(
            `INSERT INTO users (username, email, password_hash, role)
             VALUES ($1, $2, $3, 'admin')
             RETURNING id, username, email, role`,
            [username, email, hash]
        );

        const user = result.rows[0];
        adminId = user.id;
        console.log(`\nAdmin user created successfully:`);
        console.log(`  ID:       ${user.id}`);
        console.log(`  Username: ${user.username}`);
        console.log(`  Email:    ${user.email}`);
        console.log(`  Role:     ${user.role}`);
    }

    // -------------------------------------------------------------------------
    // Step 2: Seed default columns (if table is empty)
    // -------------------------------------------------------------------------
    const colCount = await pool.query('SELECT COUNT(*) AS cnt FROM columns');

    if (parseInt(colCount.rows[0].cnt, 10) === 0) {
        await pool.query(`
            INSERT INTO columns (name, position, wip_limit, created_by)
            VALUES
                ('Backlog',      1, NULL, $1),
                ('Ready',        2, 5,    $1),
                ('In Progress',  3, 3,    $1),
                ('Review',       4, 3,    $1),
                ('Done',         5, NULL, $1)
            ON CONFLICT DO NOTHING
        `, [adminId]);
        console.log('\nDefault board columns seeded: Backlog, Ready, In Progress, Review, Done');
    } else {
        console.log('\nColumns already exist — skipping column seed.');
    }

    console.log(`\nSetup complete. You can now start the server with: npm start\n`);
} finally {
    await pool.end();
}
