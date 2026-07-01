# Kanban Board

A collaborative Kanban board application with admin-managed user accounts, per-card publish/visibility controls, and invite-only registration via SendGrid.

## Features

- **Server-side sessions** stored in PostgreSQL (reliable behind Fly.io reverse proxy)
- **Admin dashboard** for user management (create, deactivate, delete, change roles, reset passwords)
- **Invite-only registration** with SendGrid email delivery
- **Per-card visibility toggle** — users choose whether each card is published (visible to all) or private
- **Self-service password change** for all authenticated users
- **Drag-and-drop** card movement between columns
- **WIP limits** per column with visual indicators
- **Audit log** tracking all significant actions
- **Rate limiting** on login to prevent brute-force attacks
- **Helmet security headers** and input validation throughout

## Tech Stack

| Component        | Technology                            |
|------------------|---------------------------------------|
| Runtime          | Node.js 20+ (ES Modules)             |
| Framework        | Express 4                             |
| Database         | PostgreSQL                            |
| Sessions         | express-session + connect-pg-simple   |
| Password hashing | Argon2id (OWASP recommended)          |
| Email            | SendGrid (@sendgrid/mail)             |
| Deployment       | Fly.io (Docker)                       |
| CI/CD            | GitHub Actions                        |

## Local Development Setup

### Prerequisites

- Node.js 20+
- PostgreSQL 14+
- A SendGrid account with a verified sender

### Steps

```bash
# 1. Clone the repository
git clone https://github.com/diseazed1/kanban-board.git
cd kanban-board

# 2. Install dependencies
npm install

# 3. Create the database and apply schema
createdb kanban
psql kanban -f schema.sql

# 4. Configure environment variables
cp .env.example .env
# Edit .env — you MUST set: DATABASE_URL, SESSION_SECRET, SENDGRID_API_KEY, FROM_EMAIL

# 5. Create the first admin user (also seeds default board columns automatically)
node seed_admin.js admin admin@example.com "YourSecurePassword123"

# 6. Start the server
npm run dev
```

The app will be running at `http://localhost:3000`.

## Environment Variables

| Variable           | Required | Description                                              |
|--------------------|----------|----------------------------------------------------------|
| `DATABASE_URL`     | Yes      | PostgreSQL connection string                             |
| `SESSION_SECRET`   | Yes      | Random string (min 32 chars) for signing session cookies |
| `SENDGRID_API_KEY` | Yes      | SendGrid API key for sending invite emails               |
| `FROM_EMAIL`       | Yes      | Verified sender email in SendGrid                        |
| `APP_URL`          | No       | Public app URL for invite links (defaults to localhost)  |
| `APP_NAME`         | No       | Name shown in invite emails (defaults to "Kanban Board") |
| `PORT`             | No       | Server port (defaults to 3000; Fly.io sets this)         |
| `NODE_ENV`         | No       | Set to `production` on Fly.io                            |

## Deployment to Fly.io

### First-time setup

```bash
# 1. Install the Fly CLI
curl -L https://fly.io/install.sh | sh

# 2. Log in
fly auth login

# 3. Launch the app (uses existing fly.toml)
fly launch --no-deploy

# 4. Create a PostgreSQL database
fly postgres create --name kanban-db
fly postgres attach kanban-db

# 5. Set all required secrets
fly secrets set \
  SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")" \
  SENDGRID_API_KEY="SG.your-key-here" \
  FROM_EMAIL="noreply@yourdomain.com" \
  APP_URL="https://your-app-name.fly.dev"

# 6. Deploy
fly deploy

# 7. Apply database schema (from inside the deployed machine)
fly ssh console -C "node -e \"
  const pg = require('pg');
  const fs = require('fs');
  const pool = new pg.Pool({connectionString: process.env.DATABASE_URL});
  pool.query(fs.readFileSync('schema.sql','utf8')).then(() => {
    console.log('Schema applied');
    pool.end();
  });
\""

# 8. Create the first admin user (also seeds default columns)
fly ssh console -C "node seed_admin.js admin admin@example.com 'YourSecurePassword123'"
```

### Subsequent deployments

Push to the `main` branch — GitHub Actions will deploy automatically via `.github/workflows/deploy.yml`.

## Authentication Flow

This application uses **server-side sessions** stored in PostgreSQL:

1. User submits username + password to `POST /api/auth/login`
2. Server verifies credentials with Argon2id
3. Server creates a session in the `user_sessions` table (auto-created by connect-pg-simple)
4. A session cookie (`kanban.sid`) is set with `httpOnly`, `sameSite: lax`, and `secure: true` in production
5. All subsequent requests include the cookie automatically (same-origin, no CORS needed)
6. The `authenticate` middleware checks `req.session.user` on protected routes

This approach is more reliable than JWT cookies behind reverse proxies because:
- No CORS origin matching is required (same-origin requests from static files)
- `sameSite: lax` works correctly with Fly.io's HTTPS proxy
- `trust proxy` is enabled so Express correctly detects HTTPS connections
- Session state is stored server-side, so logout truly invalidates the session
- No token expiry edge cases — the session simply exists or it does not

## API Endpoints

### Authentication (`/api/auth`)

| Method | Path               | Auth Required | Description                   |
|--------|--------------------|---------------|-------------------------------|
| POST   | `/login`           | No            | Log in with username/password |
| POST   | `/register`        | No            | Register with invite token    |
| POST   | `/logout`          | No            | Destroy session               |
| GET    | `/me`              | Yes           | Get current user profile      |
| POST   | `/change-password` | Yes           | Change own password           |

### Columns (`/api/columns`)

| Method | Path    | Auth Required | Description       |
|--------|---------|---------------|-------------------|
| GET    | `/`     | Yes           | List all columns  |
| POST   | `/`     | Admin         | Create a column   |
| PUT    | `/:id`  | Admin         | Update a column   |
| DELETE | `/:id`  | Admin         | Delete a column   |

### Cards (`/api/cards`)

| Method | Path    | Auth Required | Description       |
|--------|---------|---------------|-------------------|
| GET    | `/`     | Yes           | List visible cards|
| POST   | `/`     | Yes           | Create a card     |
| PUT    | `/:id`  | Yes (owner)   | Update a card     |
| DELETE | `/:id`  | Yes (owner)   | Delete a card     |

### Admin (`/api/admin`)

| Method | Path                        | Auth Required | Description                |
|--------|-----------------------------|---------------|----------------------------|
| GET    | `/users`                    | Admin         | List all users             |
| PUT    | `/users/:id`                | Admin         | Update user role/status    |
| POST   | `/users/:id/reset-password` | Admin         | Force-reset user password  |
| DELETE | `/users/:id`                | Admin         | Delete a user              |
| GET    | `/invites`                  | Admin         | List pending invites       |
| POST   | `/invites/send`             | Admin         | Send invite email          |
| DELETE | `/invites/:token`           | Admin         | Revoke an invite           |
| GET    | `/audit-log`                | Admin         | View paginated audit log   |

## Troubleshooting

### Login not working on Fly.io

1. **Verify secrets are set:** `fly secrets list` — you must see `DATABASE_URL`, `SESSION_SECRET`, `SENDGRID_API_KEY`, `FROM_EMAIL`
2. **Check the health endpoint:** `curl https://your-app.fly.dev/health` — should return `{"status":"ok"}`
3. **Check logs:** `fly logs` — look for startup errors or missing env vars
4. **Verify the admin user exists:**
   ```bash
   fly ssh console -C "node -e \"const pg=require('pg');const p=new pg.Pool({connectionString:process.env.DATABASE_URL});p.query('SELECT username,role,is_active FROM users').then(r=>{console.log(r.rows);p.end()})\""
   ```

### Empty column dropdown when creating cards

The `seed_admin.js` script automatically creates default columns. If you skipped it or columns were deleted, re-run:
```bash
fly ssh console -C "node seed_admin.js admin admin@example.com 'YourPassword'"
```
Or manually run the column seed:
```bash
fly ssh console -C "psql \$DATABASE_URL -f columns_default.sql"
```

## License

MIT
