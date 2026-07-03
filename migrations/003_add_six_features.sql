-- =============================================================================
-- Migration 003: Add 6 UX features
--   1. Due dates on cards
--   2. Subtasks / checklists
--   3. File attachments
--   4. Notifications (assignments, @mentions, due alerts)
--   5. Saved filter views
--   6. notification_type enum (required for notifications table)
-- =============================================================================

-- 1. notification_type enum
DO $$ BEGIN
    CREATE TYPE notification_type AS ENUM (
        'assigned',
        'mentioned',
        'due_soon',
        'overdue',
        'comment_added'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Due date column on cards
ALTER TABLE cards ADD COLUMN IF NOT EXISTS due_date TIMESTAMPTZ DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_cards_due_date ON cards(due_date) WHERE due_date IS NOT NULL;

-- 3. Subtasks table
CREATE TABLE IF NOT EXISTS card_subtasks (
    id          SERIAL       PRIMARY KEY,
    card_id     UUID         NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    title       VARCHAR(200) NOT NULL,
    is_done     BOOLEAN      NOT NULL DEFAULT FALSE,
    position    INT          NOT NULL DEFAULT 0,
    created_by  INT          REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_subtasks_card ON card_subtasks(card_id);

-- 4. File attachments table
CREATE TABLE IF NOT EXISTS card_attachments (
    id          SERIAL       PRIMARY KEY,
    card_id     UUID         NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    uploaded_by INT          REFERENCES users(id) ON DELETE SET NULL,
    filename    VARCHAR(255) NOT NULL,
    stored_name VARCHAR(255) NOT NULL,
    mime_type   VARCHAR(100) NOT NULL,
    size_bytes  BIGINT       NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_attachments_card ON card_attachments(card_id);

-- 5. Notifications table
CREATE TABLE IF NOT EXISTS notifications (
    id          SERIAL            PRIMARY KEY,
    user_id     INT               NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type        notification_type NOT NULL,
    card_id     UUID              REFERENCES cards(id) ON DELETE CASCADE,
    actor_id    INT               REFERENCES users(id) ON DELETE SET NULL,
    message     TEXT              NOT NULL,
    is_read     BOOLEAN           NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ       NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);

-- 6. Saved filter views table
CREATE TABLE IF NOT EXISTS saved_views (
    id          SERIAL       PRIMARY KEY,
    user_id     INT          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        VARCHAR(100) NOT NULL,
    filters     JSONB        NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_saved_views_user ON saved_views(user_id);

-- Confirm migration applied
DO $$ BEGIN
    RAISE NOTICE 'Migration 003 applied successfully.';
END $$;
