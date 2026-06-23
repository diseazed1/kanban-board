# Kanban Board (Improved)

A full-stack Kanban board application built with Express, PostgreSQL, and native HTML/JS. Features robust Argon2id authentication, role-based access control, per-card visibility toggles, and invite-only registration via SendGrid.

## Features

- **Authentication & Security:** Secure JWT cookies, Argon2id password hashing, Helmet security headers, and rate limiting.
- **Admin Dashboard:** Oversee users, manage roles (Admin, User, Viewer), view audit logs, and send email invitations.
- **Publish/Visibility Controls:** Cards can be marked as "Public" (visible to everyone) or "Private" (visible only to the owner, assignee, and admins).
- **Invite-Only Registration:** New users must be invited by an admin via a SendGrid email containing a secure token.
- **Fly.io Ready:** Optimized `fly.toml`, Dockerfile, and GitHub Actions CI/CD workflow.

## Local Development

### 1. Prerequisites
- Node.js v20+
- PostgreSQL 15+

### 2. Environment Setup
Copy the example environment file and configure it:
```bash
cp .env.example .env
```
Ensure you set `DATABASE_URL`, `JWT_SECRET`, `SENDGRID_API_KEY`, and `FROM_EMAIL`.

### 3. Database Initialization
Run the schema script to set up tables and types:
```bash
npm run db:schema
```

### 4. Create the First Admin
Bootstrap your first admin account (this does not require an email invite):
```bash
npm run seed-admin admin admin@example.com "S3cur3P@ssw0rd!"
```

*(Optional)* Seed default columns:
```bash
npm run db:seed-columns
```

### 5. Start the Server
```bash
npm install
npm run dev
```
The application will be available at `http://localhost:3000`.

## Deployment (Fly.io)

This project is configured for automated deployment to Fly.io via GitHub Actions.

### 1. Initial Fly Setup
Create the app and attach a PostgreSQL cluster:
```bash
flyctl launch --no-deploy
flyctl postgres create
flyctl postgres attach <db-app-name> --app <your-app-name>
```

### 2. Set Secrets
**Never** commit secrets to your repository. Set them securely via the Fly CLI:
```bash
flyctl secrets set \
  JWT_SECRET="your-random-secret" \
  SENDGRID_API_KEY="SG.your-key" \
  FROM_EMAIL="no-reply@yourdomain.com" \
  ORIGIN="https://your-app-name.fly.dev"
```

### 3. Initialize Production Database
Connect to your production database and run the schema and seed scripts:
```bash
flyctl postgres connect -a <db-app-name>
# Inside psql, copy/paste the contents of schema.sql and columns_default.sql
```

Create your production admin:
```bash
flyctl console
# Inside the machine:
node seed_admin.js admin admin@example.com "YourSecurePassword"
```

### 4. GitHub Actions CI/CD
1. Generate a Fly API token: `flyctl tokens create deploy -x 999999h`
2. Add the token to your GitHub repository secrets as `FLY_API_TOKEN`.
3. Push to the `main` branch to trigger an automatic deployment.
