#!/usr/bin/env node
/**
 * reseed_admin.js — Re-hash admin password with proper argon2id and update DB.
 * 
 * Usage:
 *   DATABASE_URL="postgres://..." node reseed_admin.js <password>
 */

import argon2 from 'argon2';
import pg from 'pg';

const password = process.argv[2];

if (!password) {
    console.error('Usage: node reseed_admin.js <new_password>');
    process.exit(1);
}

if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL environment variable is not set.');
    process.exit(1);
}

// Hash with proper argon2id settings (matching routes/auth.js)
const hash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536,   // 64 MB
    timeCost: 3,          // 3 iterations
    parallelism: 2,
});

console.log('Generated hash:', hash);

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

try {
    const result = await pool.query(
        `UPDATE users SET password_hash = $1 
         WHERE username = 'admin' AND email = 'neo@stratosense.ai'
         RETURNING id, username`,
        [hash]
    );

    if (result.rows.length > 0) {
        console.log('✅ Admin user updated successfully:');
        console.log(`   ID: ${result.rows[0].id}`);
        console.log(`   Username: ${result.rows[0].username}`);
    } else {
        console.warn('No admin user found matching username=admin, email=neo@stratosense.ai');
    }

} catch (e) {
    console.error('Update failed:', e.message);
} finally {
    await pool.end();
}