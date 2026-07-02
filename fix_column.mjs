#!/usr/bin/env node
import pg from 'pg';

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });

try {
    // Step 1: Check current column type
    const colInfo = await db.query(
        `SELECT data_type FROM information_schema.columns 
         WHERE table_name = 'users' AND column_name = 'password_hash'`
    );
    console.log('Current column type:', colInfo.rows[0].data_type);
    
    // Step 2: ALTER TABLE to change bytea -> text by decoding existing hashes
    await db.query(
        `ALTER TABLE users 
         ALTER COLUMN password_hash TYPE text 
         USING encode(password_hash, 'escape')`
    );
    console.log('✅ Column type altered from bytea to text');
    
    // Step 3: Verify
    const colInfo2 = await db.query(
        `SELECT data_type FROM information_schema.columns 
         WHERE table_name = 'users' AND column_name = 'password_hash'`
    );
    console.log('New column type:', colInfo2.rows[0].data_type);
    
} catch (e) {
    console.error('Fix failed:', e.message);
} finally {
    await db.end();
}
