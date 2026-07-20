-- =============================================================================
-- Kanban Board Database Schema
-- PostgreSQL 15+ required
-- Run once on a fresh database: psql $DATABASE_URL -f schema.sql
-- =============================================================================

-- ---------------------------------------------------------------------------
-- ENUM types  (must be declared before the tables that reference them)
-- ---------------------------------------------------------------------------
DO $$ BEGIN
    CREATE TYPE user_role   AS ENUM ('admin', 'user', 'viewer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 5-level priority: critical > high > medium > low > minimal
DO $$ BEGIN
    CREATE TYPE card_priority AS ENUM ('critical', 'high', 'medium', 'low', 'minimal');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE visibility AS ENUM ('public', 'private');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id           SERIAL PRIMARY KEY,
    username     VARCHAR(30)  UNIQUE NOT NULL,
    email        VARCHAR(100) UNIQUE NOT NULL,
    password_hash TEXT        NOT NULL,          -- Argon2id encoded string
    role         user_role    NOT NULL DEFAULT 'user',
    is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    last_login   TIMESTAMPTZ
);

-- ---------------------------------------------------------------------------
-- Invite tokens  (admin-invite registration flow)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invites (
    token        UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    email        VARCHAR(100) NOT NULL,           -- pre-filled recipient address
    invited_by   INT          REFERENCES users(id) ON DELETE SET NULL,
    expires_at   TIMESTAMPTZ  NOT NULL,
    used         BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Board columns  (workflow stages)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS columns (
    id          SERIAL       PRIMARY KEY,
    name        VARCHAR(50)  NOT NULL,
    position    INT          NOT NULL,            -- left-to-right ordering index
    wip_limit   INT          DEFAULT NULL,        -- NULL = unlimited
    created_by  INT          REFERENCES users(id) ON DELETE SET NULL,
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Cards  (tasks / work items)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cards (
    id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    title             VARCHAR(200) NOT NULL,
    description       TEXT         NOT NULL DEFAULT '',
    priority          card_priority NOT NULL DEFAULT 'medium',
    column_id         INT          REFERENCES columns(id) ON DELETE SET NULL,
    position_in_column INT         NOT NULL DEFAULT 0,
    owner_id          INT          REFERENCES users(id) ON DELETE SET NULL,
    assignee_id       INT          REFERENCES users(id) ON DELETE SET NULL,
    -- 'public'  = visible to every authenticated user on the board
    -- 'private' = visible only to owner, assignee, and admins
    visibility        visibility   NOT NULL DEFAULT 'public',
    due_date          TIMESTAMPTZ  DEFAULT NULL,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Card comments  (user discussion on individual cards)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS card_comments (
    id          SERIAL       PRIMARY KEY,
    card_id     UUID         NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    user_id     INT          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body        TEXT         NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Card activity log  (timeline of card events: moves, edits, etc.)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS card_activity (
    id          SERIAL       PRIMARY KEY,
    card_id     UUID         NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    user_id     INT          REFERENCES users(id) ON DELETE SET NULL,
    action      VARCHAR(50)  NOT NULL,
    -- e.g. 'created', 'moved', 'edited', 'priority_changed',
    --      'visibility_changed', 'assigned', 'comment_added'
    details     JSONB        NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Audit log  (admin dashboard metrics)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
    id          SERIAL       PRIMARY KEY,
    action      VARCHAR(50)  NOT NULL,   -- 'login', 'card_create', 'invite_send', ...
    user_id     INT          REFERENCES users(id) ON DELETE SET NULL,
    ip_address  INET,
    metadata    JSONB        NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Card attachments  (documents / files attached to cards)
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- Card tags  (many-to-many via junction table)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS card_tags (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(30) NOT NULL COLLATE "C",
    slug        VARCHAR(30) UNIQUE NOT NULL COLLATE "C"
);

CREATE TABLE IF NOT EXISTS card_tag_map (
    card_id     UUID         NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    tag_id      INT          NOT NULL REFERENCES card_tags(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (card_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_attachments_card   ON card_attachments(card_id);
CREATE INDEX IF NOT EXISTS idx_attachments_user   ON card_attachments(user_id);
CREATE INDEX IF NOT EXISTS idx_card_tag_map_card  ON card_tag_map(card_id);
CREATE INDEX IF NOT EXISTS idx_card_tag_map_tag   ON card_tag_map(tag_id);

-- ---------------------------------------------------------------------------
-- Card subtasks / checklist items
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
    secret          VARCHAR(255) DEFAULT NULL,
    events          TEXT[]       NOT NULL,
    active          BOOLEAN      NOT NULL DEFAULT TRUE,
    created_by      INT          REFERENCES users(id) ON DELETE SET NULL,
    last_response_code INT        DEFAULT NULL,
    last_triggered   TIMESTAMPTZ  DEFAULT NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Notification preferences per user (email digest opt-in)
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
    digest_frequency VARCHAR(20) NOT NULL DEFAULT 'realtime',
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Structured change tracking columns (audit-compliance)
-- Extends existing card_activity with explicit before/after snapshots.
-- ---------------------------------------------------------------------------
ALTER TABLE card_activity ADD COLUMN IF NOT EXISTS field_changed VARCHAR(100);
ALTER TABLE card_activity ADD COLUMN IF NOT EXISTS old_value JSONB;
ALTER TABLE card_activity ADD COLUMN IF NOT EXISTS new_value JSONB;
-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_cards_column       ON cards(column_id);
CREATE INDEX IF NOT EXISTS idx_cards_owner        ON cards(owner_id);
CREATE INDEX IF NOT EXISTS idx_cards_assignee     ON cards(assignee_id);
CREATE INDEX IF NOT EXISTS idx_cards_visibility   ON cards(visibility);
CREATE INDEX IF NOT EXISTS idx_comments_card      ON card_comments(card_id);
CREATE INDEX IF NOT EXISTS idx_comments_user      ON card_comments(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_card      ON card_activity(card_id);
CREATE INDEX IF NOT EXISTS idx_activity_created   ON card_activity(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user         ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_created      ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invites_used       ON invites(used);
CREATE INDEX IF NOT EXISTS idx_invites_email      ON invites(email);
