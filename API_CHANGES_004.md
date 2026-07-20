# API Changes — Migration 004 (Due Dates, Tags, Bulk Ops, Cloning)

## Overview

This document describes all new and changed endpoints introduced in migration 004. The changes add due date support with overdue indicators, a card tagging system, bulk operations, and card cloning to the Kanban Board API.

---

## Schema Changes (Database Migration `004_add_due_dates_tags.sql`)

| Change | Details |
|--------|---------|
| `cards.due_date` | New column `TIMESTAMPTZ` — nullable timestamp with timezone for card deadlines |
| `card_tags` table | Stores distinct tag definitions (`id`, `name`, `slug`) |
| `card_tag_map` table | Junction table linking cards to tags (`card_id UUID`, `tag_id INT`) |
| `pg_trgm` extension | Enables trigram-based fuzzy text search on card title/description |
| Indexes | `idx_cards_due_date`, `idx_cards_overdue`, tag map indexes, GIN trigram indexes |

---

## Changed Endpoints (Backward-Compatible)

### `GET /api/cards/:id` — Single Card Detail

**Change:** Response now includes a computed field `is_overdue: boolean`.

- `true` when `due_date IS NOT NULL AND due_date < NOW()`
- `false` otherwise

The card list endpoint (`GET /api/cards`) already included this in the previous partial update.

---

## New Endpoints

### Card Cloning

#### `POST /api/cards/:id/clone`

Duplicate an existing card with all metadata and tags. The cloned card is placed at the end of the same column.

**Auth:** Bearer token required (authenticated user).

**Response:**
- **201 Created** — Returns the new card object (with `is_overdue` field)
- **403 Forbidden** — Source card not accessible to current user
- **404 Not Found** — Source card or column not found
- **409 Conflict** — Column WIP limit reached

**Response shape:**
```json
{
  "id": "new-uuid-here",
  "title": "Clone of: Original Card Title",
  "description": "...",
  "priority": "medium",
  "column_id": 1,
  "position_in_column": 5,
  "owner_id": 2,
  "assignee_id": null,
  "visibility": "public",
  "due_date": "2026-08-01T00:00:00Z",
  "is_overdue": false,
  "created_at": "...",
  "updated_at": "..."
}
```

**Notes:**
- Title is prefixed with `"Clone of: "`
- The cloner becomes the owner (`owner_id`) of the cloned card
- Original assignee and due_date are copied over
- Tags from the source card are copied to the clone (if tag tables exist)
- Activity log entries created on both source (`cloned`) and clone (`created`)

---

### Bulk Operations

#### `PATCH /api/cards/bulk/move`

Move multiple cards into a target column, appended at the end.

**Auth:** Bearer token required. User must be card owner or admin for each card.

**Request body:**
```json
{
  "card_ids": ["uuid-1", "uuid-2", "uuid-3"],
  "column_id": 3
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `card_ids` | `string[]` | Yes | Array of card UUIDs to move |
| `column_id` | `number` | Yes | Target column ID |

**Response:**
- **200 OK** — `{ "success": true, "moved": 3 }`
- **400 Bad Request** — Missing or empty `card_ids`, missing `column_id`
- **403 Forbidden** — Access denied for one or more cards
- **404 Not Found** — One or more card UUIDs not found

---

#### `PATCH /api/cards/bulk/assign`

Reassign multiple cards to a new assignee (or unassign by passing `null`).

**Auth:** Bearer token required. User must be card owner or admin for each card.

**Request body:**
```json
{
  "card_ids": ["uuid-1", "uuid-2"],
  "assignee_id": 5,
  "assignee_username": "alice"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `card_ids` | `string[]` | Yes | Array of card UUIDs to reassign |
| `assignee_id` | `number \| null` | Yes | New assignee user ID (pass `null` to unassign) |
| `assignee_username` | `string` | Optional | Alternative: username string resolved to user ID |

**Response:**
- **200 OK** — `{ "success": true, "updated": 2 }`
- **400 Bad Request** — Missing fields
- **403 Forbidden** — Access denied for one or more cards
- **404 Not Found** — One or more card UUIDs not found

---

#### `DELETE /api/cards/bulk`

Delete multiple cards in a single request.

**Auth:** Bearer token required. User must be card owner or admin for each card.

**Request body:**
```json
{
  "card_ids": ["uuid-1", "uuid-2", "uuid-3"]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `card_ids` | `string[]` | Yes | Array of card UUIDs to delete |

**Response:**
- **200 OK** — `{ "success": true, "deleted": 3 }`
- **400 Bad Request** — Missing or empty `card_ids`
- **403 Forbidden** — Access denied for one or more cards
- **404 Not Found** — One or more card UUIDs not found

---

### Tag Endpoints

#### `GET /api/cards/tags`

List all distinct tags currently in use across cards, ordered alphabetically. Includes usage count.

**Auth:** Bearer token required (authenticated user).

**Query params:** None

**Response:**
- **200 OK** — Array of tag objects

```json
[
  { "id": 1, "name": "Bug", "slug": "bug", "card_count": 5 },
  { "id": 3, "name": "Feature", "slug": "feature", "card_count": 2 }
]
```

---

#### `POST /api/cards/:id/tags`

Add one or more tags to a card. Tags are upserted into the tag table (created if not existing). Duplicates on the same card are silently ignored.

**Auth:** Bearer token required. User must have access to the card.

**Request body:**
```json
{
  "tags": ["bug", "feature", "urgent"]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `tags` | `string[]` | Yes | Array of tag slugs to add (normalized to lowercase) |

**Response:**
- **200 OK** — `{ "success": true, "tags": [...] }` — returns the complete current tag list for this card
- **400 Bad Request** — Missing/empty `tags` array or empty string elements
- **403 Forbidden** — Access denied to card
- **404 Not Found** — Card not found

---

#### `DELETE /api/cards/:id/tags/:tagId`

Remove a specific tag from a card.

**Auth:** Bearer token required. User must have access to the card.

**Path params:**
| Param | Type | Description |
|-------|------|-------------|
| `:id` | UUID | Card ID |
| `:tagId` | Integer | Tag ID (from the `card_tags` table) |

**Response:**
- **200 OK** — `{ "success": true, "removed_tag": { "id": 1, "name": "Bug", "slug": "bug" } }`
- **403 Forbidden** — Access denied to card
- **404 Not Found** — Card or tag mapping not found

---

## Overdue Indicator (All Card Responses)

Every endpoint that returns card data now includes a computed `is_overdue` boolean field:

```sql
CASE WHEN c.due_date IS NOT NULL AND c.due_date < NOW() THEN true ELSE false END AS is_overdue
```

This applies to:
- `GET /api/cards` — list/search/filter (already present from prior partial update)
- `GET /api/cards/:id` — single card detail (added in this migration)

---

## Due Date Field (Existing CRUD Endpoints)

The following existing endpoints now support the `due_date` field:

| Endpoint | Support |
|----------|---------|
| `POST /api/cards` | `body.due_date` — ISO 8601 string or omitted for no deadline |
| `PUT /api/cards/:id` | `body.due_date` — ISO 8601 string, `null` to clear, or omitted to keep existing value |

**Validation:**
- Must be a valid ISO date string if provided (non-null)
- Pass `null` or empty string in PUT to explicitly clear the due date
- Invalid dates return **400 Bad Request**: `"due_date must be a valid ISO date string"`

---

## Search/Filter Query Parameters (`GET /api/cards`)

The following query parameters are supported for filtering cards:

| Param | Type | Description |
|-------|------|-------------|
| `search` | string | Keyword search on title/description (ILIKE pattern `%value%`) |
| `priority` | string | Filter by priority: `critical`, `high`, `medium`, `low`, `minimal` |
| `column_id` | number | Filter cards in a specific column |
| `assignee_id` | number | Filter by assignee user ID |
| `tag` | string | Filter by tag slug (joins through `card_tag_map`) |
| `due_before` | ISO date | Return cards with due_date ≤ specified time |
| `overdue` | `"true"` | Return only overdue cards (`due_date < NOW()` AND NOT NULL) |
| `status` | string | Special filters: `"overdue"`, `"due_week"` (next 7 days), `"no_due"` (null due date) |

---

## Migration Status

- **SQL migration file:** `migrations/004_add_due_dates_tags.sql` — ✅ Idempotent (all statements use `IF NOT EXISTS`)
- **Syntax verification:** `node --check server.mjs` — ✅ Passes cleanly
- **Route ordering verified:** Literal paths (`/tags`, `/bulk/*`) do not collide with parametric routes (`/:id`)
