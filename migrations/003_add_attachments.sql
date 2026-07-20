-- Migration: Add card_attachments table for document attachments on cards
-- Run this on existing databases. New databases using the updated schema.sql do NOT need this migration.

CREATE TABLE IF NOT EXISTS card_attachments (
    id                 SERIAL       PRIMARY KEY,
    card_id            UUID         NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    user_id            INT          NOT NULL REFERENCES users(id) ON DELETE SET NULL,
    filename           VARCHAR(255) NOT NULL,              -- stored filename (unique hash + ext)
    original_filename  VARCHAR(255) NOT NULL,              -- original uploaded name
    mime_type          VARCHAR(100),                       -- detected MIME type
    size_bytes         BIGINT                      ,       -- file size in bytes
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attachments_card ON card_attachments(card_id);
CREATE INDEX IF NOT EXISTS idx_attachments_user ON card_attachments(user_id);
