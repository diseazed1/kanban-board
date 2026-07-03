-- =============================================================================
-- Migration 004: Add labels/tags, card archiving, and board activity feed
-- Run against an existing database to add the new features.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Labels table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS labels (
    id          SERIAL       PRIMARY KEY,
    name        VARCHAR(50)  NOT NULL,
    color       VARCHAR(7)   NOT NULL DEFAULT '#6c757d',
    created_by  INT          REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE(name)
);

-- Card ↔ Label join table
CREATE TABLE IF NOT EXISTS card_labels (
    card_id     UUID         NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    label_id    INT          NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    PRIMARY KEY (card_id, label_id)
);

CREATE INDEX IF NOT EXISTS idx_card_labels_card  ON card_labels(card_id);
CREATE INDEX IF NOT EXISTS idx_card_labels_label ON card_labels(label_id);

-- Seed a default set of useful labels
INSERT INTO labels (name, color) VALUES
    ('Frontend',  '#3498db'),
    ('Backend',   '#9b59b6'),
    ('Design',    '#e91e63'),
    ('Bug',       '#e74c3c'),
    ('Feature',   '#2ecc71'),
    ('Blocked',   '#e67e22'),
    ('Urgent',    '#c0392b'),
    ('Research',  '#1abc9c')
ON CONFLICT (name) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Archiving columns on cards
-- ---------------------------------------------------------------------------
ALTER TABLE cards
    ADD COLUMN IF NOT EXISTS is_archived  BOOLEAN     NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS archived_at  TIMESTAMPTZ DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS archived_by  INT         REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_cards_archived ON cards(is_archived);

-- ---------------------------------------------------------------------------
-- Board-wide activity feed table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS board_activity (
    id          SERIAL       PRIMARY KEY,
    user_id     INT          REFERENCES users(id) ON DELETE SET NULL,
    action      VARCHAR(50)  NOT NULL,
    card_id     UUID         REFERENCES cards(id) ON DELETE CASCADE,
    card_title  VARCHAR(200),
    details     JSONB        NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_board_activity ON board_activity(created_at DESC);
