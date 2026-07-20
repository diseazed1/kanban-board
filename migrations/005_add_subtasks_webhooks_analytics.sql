-- =============================================================================
-- Migration 005: Subtasks, Webhooks, Structured Activity Diff
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Subtasks / checklist items on cards
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS card_subtasks (
    id              SERIAL       PRIMARY KEY,
    card_id         UUID         NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    title           VARCHAR(200) NOT NULL,
    completed       BOOLEAN      NOT NULL DEFAULT FALSE,
    position        INT          NOT NULL DEFAULT 0,
    created_by      INT          REFERENCES users(id) ON DELETE SET NULL,
    completed_by    INT          REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subtasks_card   ON card_subtasks(card_id);
CREATE INDEX IF NOT EXISTS idx_subtasks_pos     ON card_subtasks(card_id, position);

-- ---------------------------------------------------------------------------
-- Webhook integrations (outbound HTTP callbacks on card events)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhooks (
    id              SERIAL       PRIMARY KEY,
    name            VARCHAR(100) NOT NULL,
    url             TEXT         NOT NULL,
    secret          VARCHAR(255) DEFAULT NULL,     -- HMAC signature secret
    events          TEXT[]       NOT NULL,          -- array of event names to subscribe to
    active          BOOLEAN      NOT NULL DEFAULT TRUE,
    created_by      INT          REFERENCES users(id) ON DELETE SET NULL,
    last_response_code INT        DEFAULT NULL,
    last_triggered   TIMESTAMPTZ  DEFAULT NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Valid events for webhooks: card.created, card.updated, card.deleted,
--   card.moved, card.subtask_completed, card.due_reminder, comment.added,
--   tag.added, tag.removed, bulk.action

-- ---------------------------------------------------------------------------
-- Structured change tracking for audit-compliance (Card history diff)
-- Extends existing card_activity with explicit before/after snapshots.
-- ---------------------------------------------------------------------------
ALTER TABLE card_activity ADD COLUMN IF NOT EXISTS field_changed VARCHAR(100);
ALTER TABLE card_activity ADD COLUMN IF NOT EXISTS old_value JSONB;
ALTER TABLE card_activity ADD COLUMN IF NOT EXISTS new_value JSONB;

-- Backfill existing records: set field_changed based on action type where details exist
UPDATE card_activity
SET
    field_changed = CASE
        WHEN action = 'priority_changed' THEN 'priority'
        WHEN action = 'visibility_changed' THEN 'visibility'
        WHEN action = 'assigned' THEN 'assignee_id'
        WHEN action = 'moved' THEN 'column_id'
        ELSE NULL
    END,
    old_value = CASE
        WHEN action = 'priority_changed' THEN ('from'::text) :: jsonb
        WHEN action = 'visibility_changed' THEN ('from'::text) :: jsonb
        WHEN action = 'assigned' THEN NULL::jsonb
        WHEN action = 'moved' THEN ('from_column'::text) :: jsonb
        ELSE details -> 'from'
    END,
    new_value = CASE
        WHEN action = 'priority_changed' THEN ('to'::text) :: jsonb
        WHEN action = 'visibility_changed' THEN ('to'::text) :: jsonb
        WHEN action = 'assigned' THEN ('assignee_id'::text) :: jsonb
        WHEN action = 'moved' THEN ('to_column'::text) :: jsonb
        ELSE details -> 'to'
    END
WHERE field_changed IS NULL AND (old_value IS NULL OR new_value IS NULL)
AND action IN ('priority_changed', 'visibility_changed', 'assigned', 'moved');

-- ---------------------------------------------------------------------------
-- Notification preferences per user (for email digest opt-in)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_prefs (
    id              SERIAL       PRIMARY KEY,
    user_id         INT          NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
    card_created    BOOLEAN      NOT NULL DEFAULT FALSE,
    card_updated    BOOLEAN      NOT NULL DEFAULT FALSE,
    card_assigned   BOOLEAN      NOT NULL DEFAULT TRUE,
    card_moved      BOOLEAN      NOT NULL DEFAULT FALSE,
    card_due_reminder BOOLEAN    NOT NULL DEFAULT TRUE,
    comment_added   BOOLEAN      NOT NULL DEFAULT FALSE,
    digest_enabled  BOOLEAN      NOT NULL DEFAULT TRUE,
    digest_frequency VARCHAR(20) NOT NULL DEFAULT 'realtime', -- realtime | daily | weekly
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Seed notification prefs for existing users (pick up any missing rows)
DO $$
DECLARE
    u RECORD;
BEGIN
    FOR u IN SELECT id FROM users WHERE id NOT IN (SELECT user_id FROM notification_prefs) LOOP
        INSERT INTO notification_prefs (user_id) VALUES (u.id);
    END LOOP;
END $$;
