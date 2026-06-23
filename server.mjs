/**
 * server.mjs — Kanban Board API server
 *
 * Stack: Express 4 · PostgreSQL (pg) · Argon2id · JWT · SendGrid · Fly.io
 */

import express      from 'express';
import pg           from 'pg';
import cookieParser from 'cookie-parser';
import cors         from 'cors';
import helmet       from 'helmet';
import rateLimit    from 'express-rate-limit';

import { authenticate, requireRole } from './middleware/auth.js';
import authRoutes   from './routes/auth.js';
import columnRoutes from './routes/columns.js';
import cardRoutes   from './routes/cards.js';
import adminRoutes  from './routes/admin.js';

// ---------------------------------------------------------------------------
// Validate required environment variables at startup
// ---------------------------------------------------------------------------
const REQUIRED_ENV = ['DATABASE_URL', 'JWT_SECRET', 'SENDGRID_API_KEY', 'FROM_EMAIL'];
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

// Security headers (helmet defaults are safe; CSP is configured for the SPA)
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc:  ["'self'", "'unsafe-inline'"],   // inline scripts in SPA pages
            styleSrc:   ["'self'", "'unsafe-inline'"],
            imgSrc:     ["'self'", 'data:'],
        },
    },
}));

// CORS — only allow the configured origin in production
app.use(cors({
    origin:      process.env.ORIGIN || 'http://localhost:3000',
    credentials: true,                  // boolean, not string
    methods:     ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
}));

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// Serve static files (index.html, admin.html, register.html)
app.use(express.static('public'));

// ---------------------------------------------------------------------------
// Rate limiting — protect auth endpoints from brute-force
// ---------------------------------------------------------------------------
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,   // 15 minutes
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests — please try again later' },
});

// ---------------------------------------------------------------------------
// Inject database pool into every request via app.locals
// ---------------------------------------------------------------------------
app.use((req, _res, next) => {
    req.db = db;
    next();
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.use('/api/auth',    authLimiter, authRoutes);
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
// Global error handler
// ---------------------------------------------------------------------------
app.use((err, _req, res, _next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Kanban Board server running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
});
