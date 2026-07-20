-- =============================================================================
-- Migration 004: Due dates, overdue tracking, card tags, search/filters
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Due date support on cards
-- ---------------------------------------------------------------------------
ALTER TABLE cards ADD COLUMN IF NOT EXISTS due_date TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_cards_due_date ON cards(due_date) WHERE due_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cards_overdue ON cards(due_date, column_id)
    WHERE due_date < NOW() AND due_date IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Card tags  (junction table for many-to-many card ↔ tag relationship)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS card_tags (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(30) NOT NULL COLLATE "C",   -- case-sensitive, normalized lowercase on insert via API
    slug        VARCHAR(30) UNIQUE NOT NULL COLLATE "C"  -- canonical lowercase version for lookups
);

CREATE TABLE IF NOT EXISTS card_tag_map (
    card_id     UUID           NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    tag_id      INT            NOT NULL REFERENCES card_tags(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    PRIMARY KEY (card_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_card_tag_map_card   ON card_tag_map(card_id);
CREATE INDEX IF NOT EXISTS idx_card_tag_map_tag     ON card_tag_map(tag_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_card_tags_slug ON card_tags(slug);

-- ---------------------------------------------------------------------------
-- Composite search index on cards (covers title + description GIN trigram)
-- Requires pg_trgm extension for optimal fuzzy matching, but works without it
-- ---------------------------------------------------------------------------
DO $$ BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_cards_title_gin ON cards USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_cards_desc_gin  ON cards USING gin (description gin_trgm_ops);
