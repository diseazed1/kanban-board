-- =============================================================================
-- Migration 005: Add support for all 14 new UX features
-- Syllego/StratoSense Kanban Board
-- Run against an existing database that already has migrations 001-004 applied.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Card Watchers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS card_watchers (
    card_id    UUID  NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    user_id    INT   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (card_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_card_watchers_card ON card_watchers(card_id);
CREATE INDEX IF NOT EXISTS idx_card_watchers_user ON card_watchers(user_id);

-- Add 'watcher_event' to notification_type enum
DO $$ BEGIN
    ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'watcher_event';
EXCEPTION WHEN others THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- 2. Card Templates
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS card_templates (
    id           SERIAL        PRIMARY KEY,
    name         VARCHAR(100)  NOT NULL,
    description  TEXT          NOT NULL DEFAULT '',
    priority     card_priority NOT NULL DEFAULT 'medium',
    default_assignee_id INT    REFERENCES users(id) ON DELETE SET NULL,
    label_ids    INT[]         NOT NULL DEFAULT '{}',
    subtask_titles TEXT[]      NOT NULL DEFAULT '{}',
    created_by   INT           REFERENCES users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    UNIQUE(name)
);

-- ---------------------------------------------------------------------------
-- 3. Multiple Boards
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS boards (
    id          SERIAL        PRIMARY KEY,
    name        VARCHAR(100)  NOT NULL,
    description TEXT          NOT NULL DEFAULT '',
    is_default  BOOLEAN       NOT NULL DEFAULT FALSE,
    created_by  INT           REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Insert default board for existing data
INSERT INTO boards (name, description, is_default, created_at)
VALUES ('Main Board', 'Default project board', TRUE, NOW())
ON CONFLICT DO NOTHING;

-- Add board_id to columns (existing columns belong to board 1)
ALTER TABLE columns
    ADD COLUMN IF NOT EXISTS board_id INT REFERENCES boards(id) ON DELETE CASCADE DEFAULT 1;

-- Update existing columns to belong to board 1
UPDATE columns SET board_id = 1 WHERE board_id IS NULL;

-- Board membership / access control
CREATE TABLE IF NOT EXISTS board_members (
    board_id   INT  NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    user_id    INT  NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
    role       VARCHAR(20) NOT NULL DEFAULT 'member', -- 'owner', 'member', 'viewer'
    added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (board_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_board_members_user ON board_members(user_id);

-- ---------------------------------------------------------------------------
-- 4. Card Dependencies  (blocked-by relationships)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS card_dependencies (
    blocking_card_id UUID NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    blocked_card_id  UUID NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    created_by       INT  REFERENCES users(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (blocking_card_id, blocked_card_id),
    CHECK (blocking_card_id <> blocked_card_id)
);
CREATE INDEX IF NOT EXISTS idx_deps_blocking ON card_dependencies(blocking_card_id);
CREATE INDEX IF NOT EXISTS idx_deps_blocked  ON card_dependencies(blocked_card_id);

-- ---------------------------------------------------------------------------
-- 5. Recurring Cards
-- ---------------------------------------------------------------------------
DO $$ BEGIN
    CREATE TYPE recurrence_freq AS ENUM ('daily', 'weekly', 'monthly');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE cards
    ADD COLUMN IF NOT EXISTS recurrence_freq    recurrence_freq DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS recurrence_next_at TIMESTAMPTZ     DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS recurrence_template_id UUID        DEFAULT NULL;
-- recurrence_template_id links a generated card back to its source template card

-- ---------------------------------------------------------------------------
-- 6. Swimlanes  (horizontal grouping dimension)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS swimlanes (
    id         SERIAL       PRIMARY KEY,
    board_id   INT          NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    name       VARCHAR(100) NOT NULL,
    position   INT          NOT NULL DEFAULT 0,
    color      VARCHAR(7)   NOT NULL DEFAULT '#e2e8f0',
    created_by INT          REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_swimlanes_board ON swimlanes(board_id);

-- Add swimlane_id to cards (NULL = no swimlane / default row)
ALTER TABLE cards
    ADD COLUMN IF NOT EXISTS swimlane_id INT REFERENCES swimlanes(id) ON DELETE SET NULL DEFAULT NULL;

-- ---------------------------------------------------------------------------
-- 7. Time Tracking
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS time_entries (
    id          SERIAL       PRIMARY KEY,
    card_id     UUID         NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    user_id     INT          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    started_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    stopped_at  TIMESTAMPTZ  DEFAULT NULL,   -- NULL = timer still running
    duration_s  INT          GENERATED ALWAYS AS (
                    CASE WHEN stopped_at IS NOT NULL
                         THEN EXTRACT(EPOCH FROM (stopped_at - started_at))::INT
                         ELSE NULL END
                ) STORED,
    note        TEXT         NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_time_entries_card ON time_entries(card_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_user ON time_entries(user_id);

-- ---------------------------------------------------------------------------
-- 8. Column WIP Limits  (already in schema as wip_limit column on columns)
-- No new table needed — wip_limit INT DEFAULT NULL already exists.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 9. Board Snapshots  (daily automated state snapshots for retrospectives)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS board_snapshots (
    id           SERIAL       PRIMARY KEY,
    board_id     INT          NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    snapshot_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    snapshot_data JSONB       NOT NULL DEFAULT '{}'
    -- stores: { columns: [{id, name, cards: [{id, title, priority, assignee, ...}]}] }
);
CREATE INDEX IF NOT EXISTS idx_snapshots_board ON board_snapshots(board_id, snapshot_at DESC);

-- ---------------------------------------------------------------------------
-- 10. Inline Quick-Edit  (no schema changes needed — handled entirely in frontend)
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 11. Bulk Actions  (no schema changes needed — uses existing endpoints)
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 12. Analytics / Dashboard metrics view
-- ---------------------------------------------------------------------------
-- Cycle time: track when a card enters/leaves each column
CREATE TABLE IF NOT EXISTS card_column_history (
    id          SERIAL       PRIMARY KEY,
    card_id     UUID         NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    column_id   INT          REFERENCES columns(id) ON DELETE SET NULL,
    column_name VARCHAR(50)  NOT NULL,
    entered_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    left_at     TIMESTAMPTZ  DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_col_history_card   ON card_column_history(card_id);
CREATE INDEX IF NOT EXISTS idx_col_history_column ON card_column_history(column_id);

-- ---------------------------------------------------------------------------
-- 13. Mobile-responsive layout  (no schema changes — CSS/HTML only)
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Rebrand: update schema comment
-- ---------------------------------------------------------------------------
COMMENT ON TABLE boards IS 'Syllego/StratoSense Kanban Board — project boards';
