/**
 * server.mjs — Kanban Board API server
 *
 * Stack: Express 4 · PostgreSQL (pg) · Argon2id · express-session · SendGrid · Fly.io
 *
 * Authentication: Server-side sessions stored in PostgreSQL via connect-pg-simple.
 * This avoids all JWT/cookie edge cases that break behind reverse proxies (Fly.io).
 */

import express      from 'express';
import pg           from 'pg';
import session      from 'express-session';
import connectPg    from 'connect-pg-simple';
import helmet       from 'helmet';
import rateLimit    from 'express-rate-limit';

import sgMail       from '@sendgrid/mail';
import { authenticate, requireRole } from './middleware/auth.js';
import authRoutes   from './routes/auth.js';
import columnRoutes from './routes/columns.js';
import cardRoutes   from './routes/cards.js';
import adminRoutes  from './routes/admin.js';

// ---------------------------------------------------------------------------
// Validate required environment variables at startup
// ---------------------------------------------------------------------------
const REQUIRED_ENV = ['DATABASE_URL', 'SESSION_SECRET', 'SENDGRID_API_KEY', 'FROM_EMAIL'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
    console.error(`FATAL: Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Database connection pool
// ---------------------------------------------------------------------------
const db = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

db.on('error', (err) => console.error('PostgreSQL pool error:', err));

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();

// Fly.io uses a reverse proxy — trust it so secure cookies and rate limiting work
app.set('trust proxy', 1);

// Security headers (helmet defaults are safe; CSP is configured for the SPA)
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc:  ["'self'", "'unsafe-inline'"],
            styleSrc:   ["'self'", "'unsafe-inline'"],
            imgSrc:     ["'self'", 'data:'],
        },
    },
}));

app.use(express.json({ limit: '1mb' }));

// ---------------------------------------------------------------------------
// Session middleware — stored in PostgreSQL (survives server restarts)
// ---------------------------------------------------------------------------
const PgSession = connectPg(session);

app.use(session({
    store: new PgSession({
        pool: db,
        tableName:    'user_sessions',
        createTableIfMissing: true,   // auto-creates the session table
    }),
    secret:            process.env.SESSION_SECRET,
    resave:            false,
    saveUninitialized: false,
    name:              'kanban.sid',
    cookie: {
        httpOnly:  true,
        secure:    process.env.NODE_ENV === 'production',
        sameSite:  'lax',             // 'lax' works reliably behind proxies
        maxAge:    8 * 60 * 60 * 1000, // 8 hours
    },
}));

// Serve static files (index.html, admin.html, register.html)
app.use(express.static('public'));

// ---------------------------------------------------------------------------
// Rate limiting — protect login endpoint from brute-force
// ---------------------------------------------------------------------------
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,   // 15 minutes
    max: 15,                     // 15 login attempts per window
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts — please try again later' },
    // Only apply to the login endpoint (not /me, /logout, etc.)
    skip: (req) => req.path !== '/login' || req.method !== 'POST',
});

// ---------------------------------------------------------------------------
// Inject database pool into every request
// ---------------------------------------------------------------------------
app.use((req, _res, next) => {
    req.db = db;
    next();
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.use('/api/auth',    loginLimiter, authRoutes);
app.use('/api/columns', authenticate, columnRoutes);
app.use('/api/cards',   authenticate, cardRoutes);
app.use('/api/admin',   authenticate, requireRole('admin'), adminRoutes);

// ---------------------------------------------------------------------------
// Health check — used by Fly.io TCP/HTTP probes
// ---------------------------------------------------------------------------
app.get('/health', async (_req, res) => {
    try {
        await db.query('SELECT 1');
        res.json({
            status:          'ok',
            timestamp:       new Date().toISOString(),
            uptime_seconds:  Math.floor(process.uptime()),
        });
    } catch (err) {
        res.status(503).json({ status: 'degraded', error: 'Database unreachable' });
    }
});

// ---------------------------------------------------------------------------
// Global error handler (also handles multer file upload errors)
// ---------------------------------------------------------------------------
app.use((err, _req, res, _next) => {
    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'File too large. Maximum size is 10 MB.' });
    }
    if (err.message && err.message.startsWith('File type')) {
        return res.status(415).json({ error: err.message });
    }
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Automatic audit log retention — purge entries older than AUDIT_LOG_RETENTION_DAYS
// Runs once on startup and then every 24 hours.
// Default retention: 90 days (configurable via environment variable)
// ---------------------------------------------------------------------------
const AUDIT_RETENTION_DAYS = parseInt(process.env.AUDIT_LOG_RETENTION_DAYS || '90', 10);

async function purgeOldAuditLogs() {
    try {
        const result = await db.query(
            `DELETE FROM audit_log WHERE created_at < NOW() - INTERVAL '1 day' * $1`,
            [AUDIT_RETENTION_DAYS]
        );
        if (result.rowCount > 0) {
            console.log(`[Audit Retention] Purged ${result.rowCount} log entries older than ${AUDIT_RETENTION_DAYS} days.`);
        }
    } catch (err) {
        console.error('[Audit Retention] Error purging old logs:', err.message);
    }
}

// Run on startup (after a short delay to let the DB pool warm up)
setTimeout(purgeOldAuditLogs, 5_000);
// Then run every 24 hours
setInterval(purgeOldAuditLogs, 24 * 60 * 60 * 1000);

// ---------------------------------------------------------------------------
// Due-date reminder scheduler
// Runs every hour. Sends email + in-app notification for cards due within 24h
// or already overdue, once per card per day (tracked via notification table).
// ---------------------------------------------------------------------------
sgMail.setApiKey(process.env.SENDGRID_API_KEY || '');

async function sendDueDateReminders() {
    try {
        // Cards due within the next 24 hours that haven't had a due_soon notification today
        const dueSoon = await db.query(
            `SELECT c.id, c.title, c.due_date, c.assignee_id, c.owner_id,
                    u.email, u.username
             FROM cards c
             JOIN users u ON u.id = COALESCE(c.assignee_id, c.owner_id)
             WHERE c.due_date IS NOT NULL
               AND c.due_date > NOW()
               AND c.due_date <= NOW() + INTERVAL '24 hours'
               AND NOT EXISTS (
                   SELECT 1 FROM notifications n
                   WHERE n.card_id = c.id
                     AND n.type = 'due_soon'
                     AND n.created_at > NOW() - INTERVAL '20 hours'
               )`
        );

        for (const card of dueSoon.rows) {
            const recipientId = card.assignee_id || card.owner_id;
            if (!recipientId) continue;

            await db.query(
                `INSERT INTO notifications (user_id, type, card_id, message)
                 VALUES ($1, 'due_soon', $2, $3)`,
                [recipientId, card.id, `Card "${card.title}" is due within 24 hours`]
            );

            if (process.env.SENDGRID_API_KEY && process.env.FROM_EMAIL && card.email) {
                await sgMail.send({
                    to:      card.email,
                    from:    process.env.FROM_EMAIL,
                    subject: `Due soon: "${card.title}"`,
                    html:    `<p>Hi ${card.username},</p>
                              <p>The card <strong>"${card.title}"</strong> is due within 24 hours.</p>
                              <p><strong>Due:</strong> ${new Date(card.due_date).toLocaleString()}</p>
                              <p><a href="${process.env.APP_URL || ''}">View the board</a></p>`,
                }).catch(e => console.error('Due-soon email error:', e.message));
            }
        }

        // Cards that are overdue and haven't had an overdue notification today
        const overdue = await db.query(
            `SELECT c.id, c.title, c.due_date, c.assignee_id, c.owner_id,
                    u.email, u.username
             FROM cards c
             JOIN users u ON u.id = COALESCE(c.assignee_id, c.owner_id)
             WHERE c.due_date IS NOT NULL
               AND c.due_date < NOW()
               AND NOT EXISTS (
                   SELECT 1 FROM notifications n
                   WHERE n.card_id = c.id
                     AND n.type = 'overdue'
                     AND n.created_at > NOW() - INTERVAL '20 hours'
               )`
        );

        for (const card of overdue.rows) {
            const recipientId = card.assignee_id || card.owner_id;
            if (!recipientId) continue;

            await db.query(
                `INSERT INTO notifications (user_id, type, card_id, message)
                 VALUES ($1, 'overdue', $2, $3)`,
                [recipientId, card.id, `Card "${card.title}" is overdue`]
            );

            if (process.env.SENDGRID_API_KEY && process.env.FROM_EMAIL && card.email) {
                await sgMail.send({
                    to:      card.email,
                    from:    process.env.FROM_EMAIL,
                    subject: `Overdue: "${card.title}"`,
                    html:    `<p>Hi ${card.username},</p>
                              <p>The card <strong>"${card.title}"</strong> is <strong>overdue</strong>.</p>
                              <p><strong>Was due:</strong> ${new Date(card.due_date).toLocaleString()}</p>
                              <p><a href="${process.env.APP_URL || ''}">View the board</a></p>`,
                }).catch(e => console.error('Overdue email error:', e.message));
            }
        }

        if (dueSoon.rows.length + overdue.rows.length > 0) {
            console.log(`[Due Reminders] Sent ${dueSoon.rows.length} due-soon and ${overdue.rows.length} overdue notifications.`);
        }
    } catch (err) {
        console.error('[Due Reminders] Error:', err.message);
    }
}

// Run due-date check on startup and every hour
setTimeout(sendDueDateReminders, 10_000);
setInterval(sendDueDateReminders, 60 * 60 * 1000);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Kanban Board server running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
    console.log(`[Audit Retention] Log entries older than ${AUDIT_RETENTION_DAYS} days will be automatically purged.`);
});
