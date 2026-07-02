#!/usr/bin/env node
import pg from 'pg';

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });

try {
    // Check column type first
    const colInfo = await db.query(
        `SELECT column_name, data_type 
         FROM information_schema.columns 
         WHERE table_name = 'users' AND column_name = 'password_hash'`
    );
    console.log('Column info:', JSON.stringify(colInfo.rows));
    
    // Get raw hash without cast
    const r = await db.query(
        "SELECT id, username, password_hash FROM users WHERE username = 'admin'"
    );
    
    console.log('Raw result:', JSON.stringify(r.rows[0]));
    const hash = r.rows[0].password_hash;
    console.log('Hash type:', typeof hash);
    console.log('Hash length:', hash.length);
    console.log('First 50 chars:', hash.substring(0, 50));
    
} catch (e) {
    console.error('Query failed:', e.message);
} finally {
    await db.end();
}
