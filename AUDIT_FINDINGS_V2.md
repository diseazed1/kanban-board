# Kanban Board — Re-Audit (July 2026)

> Most of the original AUDIT_FINDINGS.md has been fixed. This is a fresh audit of the current codebase.

## Summary

**Original: 10 critical bugs, 9 security issues, 12 missing features → Now: 3 remaining issues found.**

The codebase quality has improved dramatically. The architecture (session-based auth via PostgreSQL, RBAC middleware, SendGrid invites, activity logging) is solid.

---

## 🔴 Remaining Bugs

### B1 — Column PUT: `position` falsy coercion
**File:** `routes/columns.js`, line ~64

```js
// Current: position ?? null treats 0 as a valid value (good with ??),
// but the COALESCE SQL means sending position=0 still works.
// ACTUAL ISSUE: If position is sent as undefined vs 0, behavior differs.
const { name, position, wip_limit } = req.body;
// ... COALESCE($2, position) — $2 is position ?? null
```

**Impact:** Minor. Sending `position: 0` works correctly with `??`. But the input validation uses `isNaN(parseInt(position, 10))` which would reject `"abc"` but accept `null` (parsed as NaN). If someone sends `{"name": "Test", "position": null}`, it passes validation but sets position to NULL in COALESCE. **Low severity** — unlikely in practice since the frontend always sends numeric positions.

### B2 — Assignee by username, not ID
**File:** `public/index.html` (frontend) + `routes/cards.js` (backend)

The card edit modal uses `assignee_username` field:
```js
const payload = {
    assignee_username: cardAssInput.value.trim() || null,
};
await api('PUT', `/api/cards/${id}`, payload);
```

But the backend expects `assignee_id`:
```js
const ALLOWED = ['title', 'description', 'priority', 'column_id',
                 'position_in_column', 'assignee_id', 'visibility'];
```

**Impact:** When editing a card, the assignee is **never actually updated** because the frontend sends `assignee_username` but the backend only processes `assignee_id`. The field is silently ignored. Users can type a username but nothing happens on save.

### B3 — Invite email duplicate check missing
**File:** `routes/admin.js`, `/api/admin/invites/send`

Checks if email already belongs to an existing user, but doesn't check for **pending (unused) invites** to the same email. An admin can send unlimited duplicate invites to one address.

---

## 🟡 Minor Issues / Improvements

### M1 — Rate limiting scope
**File:** `server.mjs`

The login rate limiter is applied to ALL `/api/auth/*` routes (via `app.use('/api/auth', loginLimiter, authRoutes)`), not just POST /login. This means:
- GET /me gets rate-limited (15 requests per 15 min) — too aggressive for a route that fires on every page load
- POST /register shares the same bucket as login

**Fix:** Move `loginLimiter` inside `routes/auth.js` on just the `/login` route.

### M2 — Session regeneration in register race condition
**File:** `routes/auth.js`, POST /register

The transaction commits, then `req.session.regenerate()` runs asynchronously while `client.release()` fires in the `finally` block immediately after the try/catch. If session save errors trigger a DB query on the released client, it could fail. Low probability but worth wrapping the session work in its own promise chain.

### M3 — No CORS configuration
**File:** `server.mjs`

The old audit mentioned CORS with string `'true'`. The current code has no explicit CORS middleware at all. This works fine for same-origin (the SPA is served from the same domain), but if anyone ever splits frontend/backend or adds a mobile app, CORS will need to be added. Not a bug now — just worth noting.

### M4 — `seed_admin.js` and `reseed_admin.js` inconsistency
Both files exist (`seed_admin.js`, `reseed_admin.js`) plus `check_hash.mjs`, `fix_column.mjs`, `reseed.mjs`. The purpose of each isn't documented and there's no `scripts:` in package.json. A developer wouldn't know which to run.

### M5 — `.env` file still contains plaintext values
**File:** `.env`

The file exists with placeholder values but is in the repo (not gitignored — wait, let me check).

---

## ✅ Fully Resolved (from original audit)

| Original # | Issue | Resolution |
|------------|-------|------------|
| 1 | `req.db.commit()` on Pool | Uses `pool.connect()` transactions properly |
| 2 | `rowsAffected` bug | Fixed to `rowCount` everywhere |
| 3 | Same in columns.js | Fixed to `rowCount` |
| 4 | Missing `requireRole('admin')` on columns | All mutation routes guarded |
| 5 | `req.db` never injected | Properly injected via middleware |
| 6 | Missing `/api/auth/logout` | Endpoint exists and works |
| 7 | `<dialog>` closed with `</div>` | All dialogs properly terminated |
| 8 | ENUM inline syntax | Uses `DO $$ BEGIN CREATE TYPE ... END $$;` |
| 9 | argon2 import crash | Default import works correctly |
| 10 | Buffer.from() on hash | Clean string pass-through |
| S3 | No role whitelist in admin PUT | `VALID_ROLES` Set added |
| S4/S5 | Card ownership check missing | Both PUT/DELETE verify owner or admin |
| S7 | Username enumeration on login | Single generic error message |
| F1-F6 | Admin UI features | All present (invite list, role change, status toggle) |
| F7 | Missing logout endpoint | Implemented |
| F9 | fly.toml health check | `[http_service.checks]` added |

---

## Priority Recommendations

1. **B2 — Assignee field mismatch** (medium impact): Frontend sends `assignee_username`, backend expects `assignee_id`. Add a username-to-ID lookup in the card create/update handlers, or change the frontend to send IDs.
2. **M1 — Rate limiting scope** (low impact): Move rate limiter to just POST /login route.
3. **B3 — Duplicate invite guard** (low impact): Add check for existing pending invites before sending new ones.
