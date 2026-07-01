-- Migration: Add card_comments and card_activity tables
-- Run this on existing databases that already have the base schema.
-- New databases using the updated schema.sql do NOT need this migration.

CREATE TABLE IF NOT EXISTS card_comments (
    id          SERIAL       PRIMARY KEY,
    card_id     UUID         NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    user_id     INT          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body        TEXT         NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS card_activity (
    id          SERIAL       PRIMARY KEY,
    card_id     UUID         NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    user_id     INT          REFERENCES users(id) ON DELETE SET NULL,
    action      VARCHAR(50)  NOT NULL,
    details     JSONB        NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_comments_card    ON card_comments(card_id);
CREATE INDEX IF NOT EXISTS idx_comments_user    ON card_comments(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_card    ON card_activity(card_id);
CREATE INDEX IF NOT EXISTS idx_activity_created ON card_activity(created_at DESC);
