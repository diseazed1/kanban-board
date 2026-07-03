/**
 * server.mjs — Syllego/StratoSense Kanban Board API server
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
import authRoutes    from './routes/auth.js';
import columnRoutes  from './routes/columns.js';
import cardRoutes    from './routes/cards.js';
import adminRoutes   from './routes/admin.js';
import boardRoutes   from './routes/boards.js';
import templateRoutes from './routes/templates.js';
import timeRoutes    from './routes/time.js';
import depsRoutes    from './routes/deps.js';
import { takeBoardSnapshot } from './routes/boards.js';

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

// Security headers
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc:  ["'self'", "'unsafe-inline'"],
            styleSrc:   ["'self'", "'unsafe-inline'"],
            imgSrc:     ["'self'", 'data:', 'blob:'],
        },
    },
}));

app.use(express.json({ limit: '2mb' }));

// ---------------------------------------------------------------------------
// Session middleware — stored in PostgreSQL (survives server restarts)
// ---------------------------------------------------------------------------
const PgSession = connectPg(session);

app.use(session({
    store: new PgSession({
        pool: db,
        tableName:    'user_sessions',
        createTableIfMissing: true,
    }),
    secret:            process.env.SESSION_SECRET,
    resave:            false,
    saveUninitialized: false,
    name:              'kanban.sid',
    cookie: {
        httpOnly:  true,
        secure:    process.env.NODE_ENV === 'production',
        sameSite:  'lax',
        maxAge:    8 * 60 * 60 * 1000, // 8 hours
    },
}));

// Serve static files (index.html, admin.html, register.html, theme.css)
app.use(express.static('public'));

// ---------------------------------------------------------------------------
// Rate limiting — protect login endpoint from brute-force
// ---------------------------------------------------------------------------
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 15,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts — please try again later' },
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
app.use('/api/auth',      loginLimiter, authRoutes);
app.use('/api/columns',   authenticate, columnRoutes);
app.use('/api/cards',     authenticate, cardRoutes);
app.use('/api/admin',     authenticate, requireRole('admin'), adminRoutes);
app.use('/api/boards',    authenticate, boardRoutes);
app.use('/api/templates', authenticate, templateRoutes);
app.use('/api/time',      authenticate, timeRoutes);
app.use('/api/deps',      authenticate, depsRoutes);

// ---------------------------------------------------------------------------
// Health check — used by Fly.io TCP/HTTP probes
// ---------------------------------------------------------------------------
app.get('/health', async (_req, res) => {
    try {
        await db.query('SELECT 1');
        res.json({
            status:         'ok',
            app:            'Syllego/StratoSense Kanban Board',
            timestamp:      new Date().toISOString(),
            uptime_seconds: Math.floor(process.uptime()),
        });
    } catch (err) {
        res.status(503).json({ status: 'degraded', error: 'Database unreachable' });
    }
});

// ---------------------------------------------------------------------------
// Global error handler
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
// Scheduled Tasks
// ---------------------------------------------------------------------------
const AUDIT_RETENTION_DAYS = parseInt(process.env.AUDIT_LOG_RETENTION_DAYS || '90', 10);

// 1. Audit log retention — purge old entries daily
async function purgeOldAuditLogs() {
    try {
        const result = await db.query(
            `DELETE FROM audit_log WHERE created_at < NOW() - INTERVAL '1 day' * $1`,
            [AUDIT_RETENTION_DAYS]
        );
        if (result.rowCount > 0) {
            console.log(`[Audit Retention] Purged ${result.rowCount} entries older than ${AUDIT_RETENTION_DAYS} days.`);
        }
    } catch (err) {
        console.error('[Audit Retention] Error:', err.message);
    }
}
setTimeout(purgeOldAuditLogs, 5_000);
setInterval(purgeOldAuditLogs, 24 * 60 * 60 * 1000);

// 2. Due-date reminder — runs every hour
sgMail.setApiKey(process.env.SENDGRID_API_KEY || '');

async function sendDueDateReminders() {
    try {
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
                   WHERE n.card_id = c.id AND n.type = 'due_soon'
                     AND n.created_at > NOW() - INTERVAL '20 hours'
               )`
        );
        for (const card of dueSoon.rows) {
            const recipientId = card.assignee_id || card.owner_id;
            if (!recipientId) continue;
            await db.query(
                `INSERT INTO notifications (user_id, type, card_id, message)
                 VALUES ($1,'due_soon',$2,$3)`,
                [recipientId, card.id, `"${card.title}" is due within 24 hours`]
            );
            if (card.email && process.env.FROM_EMAIL) {
                sgMail.send({
                    to: card.email, from: process.env.FROM_EMAIL,
                    subject: `Due soon: "${card.title}"`,
                    html: `<p>Hi ${card.username},</p><p>The card <strong>"${card.title}"</strong> is due within 24 hours (${new Date(card.due_date).toLocaleString()}).</p><p><a href="${process.env.APP_URL || ''}">View board</a></p>`,
                }).catch(e => console.error('Due-soon email error:', e.message));
            }
        }

        const overdue = await db.query(
            `SELECT c.id, c.title, c.due_date, c.assignee_id, c.owner_id,
                    u.email, u.username
             FROM cards c
             JOIN users u ON u.id = COALESCE(c.assignee_id, c.owner_id)
             WHERE c.due_date IS NOT NULL AND c.due_date < NOW()
               AND NOT EXISTS (
                   SELECT 1 FROM notifications n
                   WHERE n.card_id = c.id AND n.type = 'overdue'
                     AND n.created_at > NOW() - INTERVAL '20 hours'
               )`
        );
        for (const card of overdue.rows) {
            const recipientId = card.assignee_id || card.owner_id;
            if (!recipientId) continue;
            await db.query(
                `INSERT INTO notifications (user_id, type, card_id, message)
                 VALUES ($1,'overdue',$2,$3)`,
                [recipientId, card.id, `"${card.title}" is overdue`]
            );
            if (card.email && process.env.FROM_EMAIL) {
                sgMail.send({
                    to: card.email, from: process.env.FROM_EMAIL,
                    subject: `Overdue: "${card.title}"`,
                    html: `<p>Hi ${card.username},</p><p>The card <strong>"${card.title}"</strong> is overdue (was due ${new Date(card.due_date).toLocaleString()}).</p><p><a href="${process.env.APP_URL || ''}">View board</a></p>`,
                }).catch(e => console.error('Overdue email error:', e.message));
            }
        }
        if (dueSoon.rows.length + overdue.rows.length > 0) {
            console.log(`[Due Reminders] ${dueSoon.rows.length} due-soon, ${overdue.rows.length} overdue notifications sent.`);
        }
    } catch (err) {
        console.error('[Due Reminders] Error:', err.message);
    }
}
setTimeout(sendDueDateReminders, 10_000);
setInterval(sendDueDateReminders, 60 * 60 * 1000);

// 3. Recurring cards — check every hour, create new cards from recurring templates
async function processRecurringCards() {
    try {
        const due = await db.query(
            `SELECT * FROM cards
             WHERE recurrence_freq IS NOT NULL
               AND recurrence_next_at IS NOT NULL
               AND recurrence_next_at <= NOW()
               AND is_archived = FALSE`
        );
        for (const card of due.rows) {
            // Get the first column of the board this card belongs to
            const colResult = await db.query(
                `SELECT col.id FROM columns col
                 WHERE col.id = (
                     SELECT column_id FROM columns
                     ORDER BY position ASC LIMIT 1
                 ) LIMIT 1`
            );
            const targetColId = colResult.rows[0]?.id || card.column_id;

            // Create the new card
            const pos = await db.query(
                'SELECT COALESCE(MAX(position_in_column)+1,0) AS next FROM cards WHERE column_id=$1',
                [targetColId]
            );
            await db.query(
                `INSERT INTO cards
                   (title, description, priority, column_id, position_in_column,
                    owner_id, assignee_id, visibility, recurrence_freq,
                    recurrence_next_at, recurrence_template_id)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
                    CASE $9::text
                      WHEN 'daily'   THEN NOW() + INTERVAL '1 day'
                      WHEN 'weekly'  THEN NOW() + INTERVAL '7 days'
                      WHEN 'monthly' THEN NOW() + INTERVAL '1 month'
                    END, $10)`,
                [card.title, card.description, card.priority, targetColId,
                 pos.rows[0].next, card.owner_id, card.assignee_id,
                 card.visibility, card.recurrence_freq, card.id]
            );

            // Update next_at on the template card
            await db.query(
                `UPDATE cards SET recurrence_next_at =
                    CASE recurrence_freq::text
                      WHEN 'daily'   THEN NOW() + INTERVAL '1 day'
                      WHEN 'weekly'  THEN NOW() + INTERVAL '7 days'
                      WHEN 'monthly' THEN NOW() + INTERVAL '1 month'
                    END
                 WHERE id = $1`,
                [card.id]
            );
        }
        if (due.rows.length > 0) {
            console.log(`[Recurring Cards] Created ${due.rows.length} recurring card(s).`);
        }
    } catch (err) {
        console.error('[Recurring Cards] Error:', err.message);
    }
}
setTimeout(processRecurringCards, 15_000);
setInterval(processRecurringCards, 60 * 60 * 1000);

// 4. Daily board snapshots — runs once per day at midnight UTC
async function takeDailySnapshots() {
    try {
        const boards = await db.query('SELECT id FROM boards');
        for (const board of boards.rows) {
            await takeBoardSnapshot(db, board.id);
        }
        // Keep only 90 days of snapshots
        await db.query(
            `DELETE FROM board_snapshots WHERE snapshot_at < NOW() - INTERVAL '90 days'`
        );
        console.log(`[Snapshots] Daily snapshots taken for ${boards.rows.length} board(s).`);
    } catch (err) {
        console.error('[Snapshots] Error:', err.message);
    }
}

// Calculate ms until next midnight UTC
function msUntilMidnightUTC() {
    const now = new Date();
    const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    return midnight - now;
}
setTimeout(() => {
    takeDailySnapshots();
    setInterval(takeDailySnapshots, 24 * 60 * 60 * 1000);
}, msUntilMidnightUTC());

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Syllego/StratoSense Kanban Board running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
    console.log(`[Audit Retention] Purging logs older than ${AUDIT_RETENTION_DAYS} days.`);
});
