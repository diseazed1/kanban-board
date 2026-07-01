-- Migration: Expand card_priority enum from 3 levels to 5 levels
-- Run this on existing databases that already have the old enum.
-- New databases using the updated schema.sql do NOT need this migration.

-- Add 'critical' (above high) and 'minimal' (below low) to the enum
ALTER TYPE card_priority ADD VALUE IF NOT EXISTS 'critical' BEFORE 'high';
ALTER TYPE card_priority ADD VALUE IF NOT EXISTS 'minimal' AFTER 'low';
