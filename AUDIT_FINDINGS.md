# Kanban Board — Full Audit Findings & Improvement Plan

## Critical Bugs

| # | File | Issue | Impact |
|---|------|-------|--------|
| 1 | `routes/auth.js` | `req.db.commit()` / `req.db.rollback()` do not exist on a `pg.Pool` — must use a dedicated client via `pool.connect()` | Registration always throws a runtime error |
| 2 | `routes/cards.js` | `result.rowsAffected` is not a valid `pg` field — should be `result.rowCount` | DELETE always returns 404 even on success |
| 3 | `routes/columns.js` | Same `result.rowsAffected` bug on DELETE | Same as above |
| 4 | `routes/columns.js` | POST/PUT/DELETE have no `requireRole('admin')` guard despite comments saying "admin only" | Any authenticated user can create/delete columns |
| 5 | `server.mjs` | `withDb` helper is defined but never used; `req.db` is never injected into route handlers | All routes that call `req.db` will throw `Cannot read properties of undefined` |
| 6 | `public/index.html` | Logout calls `/api/auth/logout` which does not exist in `routes/auth.js` | Logout button does nothing / throws 404 |
| 7 | `public/index.html` | `<dialog>` element is closed with `</div>` instead of `</dialog>` | Malformed HTML; modal never opens |
| 8 | `schema.sql` | Uses `ENUM(...)` inline syntax which is not valid PostgreSQL — must use `CREATE TYPE` first | Schema migration fails entirely |
| 9 | `seed_admin.ts` | Imports `{ argon2id }` as a named export but the `argon2` package exports a default object | Admin seeding script crashes on import |
| 10 | `routes/auth.js` | `hashPassword` wraps the argon2 string output in `Buffer.from()` unnecessarily; `verifyPassword` then tries to verify a Buffer against a password, not a hash string | Password verification always fails |

## Security Issues

| # | File | Issue | Recommendation |
|---|------|-------|----------------|
| S1 | `app.toml` | `SENDGRID_API_KEY` and `FROM_EMAIL` committed in plaintext to the repository | Move all secrets to `fly secrets set`; remove from `app.toml` |
| S2 | `routes/auth.js` | JWT cookie missing `secure: true` flag | Set `secure: true` in production |
| S3 | `routes/admin.js` | No input validation on `role` field — any string can be set as a user's role | Whitelist allowed values: `['admin', 'user', 'viewer']` |
| S4 | `routes/cards.js` | `PUT /:id` has no ownership check — any authenticated user can edit any card | Verify `owner_id = req.user.id OR req.user.role = 'admin'` |
| S5 | `routes/cards.js` | `DELETE /:id` has no ownership check | Same as S4 |
| S6 | `server.mjs` | CORS `credentials` should be boolean `true`, not string `'true'` | Fix to `credentials: true` |
| S7 | `routes/auth.js` | Login error message distinguishes "Invalid credentials" vs "Invalid password" — enables username enumeration | Return a single generic message for both cases |
| S8 | `middleware/auth.js` | Duplicate of `server.mjs` auth middleware — unused but creates maintenance confusion | Remove the duplicate; import from a single shared module |
| S9 | `routes/admin.js` | Invite token returned in API response body — unnecessary exposure | Only return `{ sent_to: email, expires_at }` |

## Missing Features

| # | Feature | Status |
|---|---------|--------|
| F1 | Admin: "Toggle Status" button in `admin.html` has no event handler wired | Not functional |
| F2 | Admin: No role-change UI in `admin.html` | Missing |
| F3 | Admin: No invite list / pending invites view | Missing |
| F4 | Publish toggle: No UI control in card modal for `visibility_level` | Missing |
| F5 | Publish toggle: Visual indicator on cards showing visibility state | Missing |
| F6 | Registration page: No `/register` HTML page for invite-based signup | Missing |
| F7 | Auth: No `/api/auth/logout` endpoint to clear the cookie | Missing |
| F8 | Auth: No `/api/auth/me` protection (route exists but `req.db` injection missing) | Broken |
| F9 | Fly.io: Health check endpoint exists but `fly.toml` has no `[checks]` block | Not wired |
| F10 | Fly.io: No `DATABASE_URL` / `JWT_SECRET` documented as required secrets | Deployment gap |
| F11 | CI/CD: `deploy.yml` triggers on `pull_request` — deploys unreviewed code | Security risk |
| F12 | DB: `audit_log` table exists but nothing writes to it | Dead table |

## Improvement Plan

### Phase 3 — Admin & User Management
- Fix `req.db` injection (use `app.locals.db` pattern)
- Fix transaction handling in `routes/auth.js` (use `pool.connect()` client)
- Add `POST /api/auth/logout` endpoint
- Add `requireRole('admin')` to column mutation routes
- Validate role values in `PUT /api/admin/users/:id`
- Wire "Toggle Status" and "Change Role" actions in `admin.html`
- Add pending invites list to admin dashboard
- Fix `seed_admin.ts` import and argon2 API usage
- Add audit log writes for login, register, card create/delete, user status change

### Phase 4 — Publish/Visibility Toggle
- Simplify `visibility_level` to a boolean `is_published` for clarity
- Add publish toggle button to card UI (eye icon)
- Show visual badge on cards indicating published vs private
- Enforce visibility filter correctly in GET /api/cards
- Add ownership check to PUT/DELETE card routes

### Phase 5 — SendGrid & Fly.io
- Remove secrets from `app.toml`; document required `fly secrets set` commands
- Consolidate `app.toml` and `fly.toml` into a single canonical `fly.toml`
- Add `[http_service.checks]` health probe block to `fly.toml`
- Fix CI/CD workflow (only deploy on push to main, not PRs)
- Add `flyctl install` step to workflow
- Fix `seed_admin.ts` to be a proper Node.js script

### Phase 6 — Best Practice Improvements
- Fix all `rowsAffected` → `rowCount` bugs
- Fix CORS `credentials` string → boolean
- Fix JWT cookie `secure: true` in production
- Fix `schema.sql` ENUM syntax for PostgreSQL
- Fix card modal HTML (`</div>` → `</dialog>`)
- Add `/register` HTML page for invite-based signup
- Remove duplicate `middleware/auth.js`
- Add rate limiting on auth endpoints
- Add `helmet` for HTTP security headers
- Add `.env.example` file documenting all required environment variables
- Add comprehensive `README.md`
