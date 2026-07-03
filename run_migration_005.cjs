'use strict';
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const stmts = [
  'ALTER TABLE boards ADD COLUMN IF NOT EXISTS is_default BOOLEAN DEFAULT FALSE',
  'ALTER TABLE boards ADD COLUMN IF NOT EXISTS description TEXT',
  'ALTER TABLE boards ADD COLUMN IF NOT EXISTS owner_id UUID',
  `CREATE TABLE IF NOT EXISTS board_members (
    board_id UUID REFERENCES boards(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(20) DEFAULT 'member',
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (board_id, user_id))`,
  `CREATE TABLE IF NOT EXISTS swimlanes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    position INTEGER DEFAULT 0,
    color VARCHAR(20) DEFAULT '#95a5a6',
    created_at TIMESTAMPTZ DEFAULT NOW())`,
  'ALTER TABLE cards ADD COLUMN IF NOT EXISTS swimlane_id UUID',
  'ALTER TABLE cards ADD COLUMN IF NOT EXISTS time_estimate INTEGER DEFAULT 0',
  'ALTER TABLE cards ADD COLUMN IF NOT EXISTS time_spent INTEGER DEFAULT 0',
  'ALTER TABLE cards ADD COLUMN IF NOT EXISTS recurrence_rule VARCHAR(50)',
  'ALTER TABLE cards ADD COLUMN IF NOT EXISTS recurrence_next_due TIMESTAMPTZ',
  "ALTER TABLE cards ADD COLUMN IF NOT EXISTS watchers JSONB DEFAULT '[]'",
  `CREATE TABLE IF NOT EXISTS card_dependencies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    card_id UUID REFERENCES cards(id) ON DELETE CASCADE,
    depends_on_id UUID REFERENCES cards(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(card_id, depends_on_id))`,
  `CREATE TABLE IF NOT EXISTS time_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    card_id UUID REFERENCES cards(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ,
    duration_minutes INTEGER,
    note TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW())`,
  `CREATE TABLE IF NOT EXISTS board_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    data JSONB NOT NULL,
    card_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW())`,
  `CREATE TABLE IF NOT EXISTS board_activity (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(100) NOT NULL,
    description TEXT,
    entity_type VARCHAR(50),
    entity_id UUID,
    created_at TIMESTAMPTZ DEFAULT NOW())`,
  'CREATE INDEX IF NOT EXISTS idx_board_activity_created ON board_activity(created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_time_logs_card ON time_logs(card_id)',
  'CREATE INDEX IF NOT EXISTS idx_card_deps_card ON card_dependencies(card_id)'
];

async function run() {
  const client = await pool.connect();
  let ok = 0, skipped = 0;
  for (const s of stmts) {
    try {
      await client.query(s);
      ok++;
    } catch(e) {
      console.log('SKIP:', e.message.split('\n')[0]);
      skipped++;
    }
  }
  client.release();
  await pool.end();
  console.log('Migration 005 complete: ' + ok + ' applied, ' + skipped + ' skipped');
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
