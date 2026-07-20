#!/usr/bin/env node
/**
 * Run a single SQL migration file against the database.
 * Usage: node scripts/run_migration.js <migration_file>
 */

import { Pool } from 'pg';
import fs       from 'fs/promises';
import path     from 'path';

const migrationFile = process.argv[2];
if (!migrationFile) {
    console.error('Usage: node scripts/run_migration.js <file.sql>');
    process.exit(1);
}

const filePath = path.resolve(process.cwd(), migrationFile);
const sql      = await fs.readFile(filePath, 'utf-8');

// Track executed migrations in a pg table
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

try {
    // Create migration tracking table if needed
    await pool.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            id       SERIAL PRIMARY KEY,
            filename VARCHAR(255) UNIQUE NOT NULL,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    // Check if already applied
    const name = path.basename(filePath);
    const existing = await pool.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [name]);
    if (existing.rows[0]) {
        console.log(`✅ Migration ${name} already applied`);
        process.exit(0);
    }

    // Run the migration SQL
    await pool.query(sql);
    await pool.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [name]);
    console.log(`✅ Applied migration: ${name}`);
} catch (err) {
    console.error(`❌ Migration failed (${path.basename(filePath)}):`, err.message);
    process.exit(1);
} finally {
    await pool.end();
}
