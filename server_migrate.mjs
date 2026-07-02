import argon2 from './node_modules/argon2/index.js';
import pg from './node_modules/pg/index.js';

const password = process.argv[2] || 'KanbanBoard_2026!';
const dbUrl = process.env.DATABASE_URL;

if (!dbUrl) { console.error('No DATABASE_URL'); process.exit(1); }

try {
    const hash = await argon2.hash(password, {type: 0, memoryCost: 65536, timeCost: 3, parallelism: 2});
    console.log(`Hashed password for: ${password}`);
    
    // We'll write the hash to a file, then run psql separately
    const fs = await import('fs');
    fs.writeFileSync('/tmp/admin_hash.txt', hash);
    console.log('✅ Hash written to /tmp/admin_hash.txt');
} catch(e) {
    console.error('Error:', e.message);
}
