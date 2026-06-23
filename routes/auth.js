/**
 * routes/auth.js
 *
 * Authentication endpoints:
 *   POST /api/auth/login     — credential login, issues JWT cookie
 *   POST /api/auth/register  — invite-only registration
 *   POST /api/auth/logout    — clears JWT cookie
 *   GET  /api/auth/me        — returns current user profile (requires auth)
 */

import { Router }   from 'express';
import jwt          from 'jsonwebtoken';
import argon2       from 'argon2';
import { authenticate } from '../middleware/auth.js';

const router = Router();

// ---------------------------------------------------------------------------
// Argon2id configuration (OWASP recommended minimums)
// ---------------------------------------------------------------------------
const ARGON2_OPTIONS = {
    type:        argon2.argon2id,
    memoryCost:  65536,   // 64 MB
    timeCost:    3,       // 3 iterations
    parallelism: 2,
};

// ---------------------------------------------------------------------------
// JWT cookie options
// ---------------------------------------------------------------------------
const cookieOptions = () => ({
    httpOnly: true,
    sameSite: 'strict',
    secure:   process.env.NODE_ENV === 'production',
    maxAge:   8 * 60 * 60 * 1000,   // 8 hours
});

// ---------------------------------------------------------------------------
// Helper: write an audit log entry (fire-and-forget — never blocks response)
// ---------------------------------------------------------------------------
const audit = (db, action, userId, ip, metadata = {}) => {
    db.query(
        'INSERT INTO audit_log (action, user_id, ip_address, metadata) VALUES ($1, $2, $3, $4)',
        [action, userId, ip, JSON.stringify(metadata)]
    ).catch((err) => console.error('Audit log write failed:', err));
};

// ---------------------------------------------------------------------------
// POST /api/auth/login
// ---------------------------------------------------------------------------
router.post('/login', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
    }

    try {
        const result = await req.db.query(
            `SELECT id, username, email, password_hash, role
             FROM users
             WHERE username = $1 AND is_active = true`,
            [username]
        );

        const user = result.rows[0];

        // Use a single generic message to prevent username enumeration
        const INVALID = 'Invalid username or password';

        if (!user) {
            return res.status(401).json({ error: INVALID });
        }

        const valid = await argon2.verify(user.password_hash, password);
        if (!valid) {
            return res.status(401).json({ error: INVALID });
        }

        // Issue JWT
        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: '8h' }
        );

        res.cookie('token', token, cookieOptions());

        // Update last_login (non-blocking)
        req.db.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id])
            .catch((err) => console.error('last_login update failed:', err));

        audit(req.db, 'login', user.id, req.ip, { username: user.username });

        res.json({ username: user.username, role: user.role });

    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Server error during login' });
    }
});

// ---------------------------------------------------------------------------
// POST /api/auth/register  (invite-only)
// ---------------------------------------------------------------------------
router.post('/register', async (req, res) => {
    const { token, username, email, password } = req.body;

    if (!token || !username || !email || !password) {
        return res.status(400).json({ error: 'Invite token, username, email, and password are required' });
    }

    // Basic input validation
    if (username.length < 3 || username.length > 30 || !/^[a-zA-Z0-9_-]+$/.test(username)) {
        return res.status(400).json({ error: 'Username must be 3–30 characters (letters, numbers, _ or -)' });
    }
    if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Use a dedicated client for the transaction
    const client = await req.db.connect();

    try {
        await client.query('BEGIN');

        // Validate invite token (lock row to prevent race conditions)
        const inviteResult = await client.query(
            `SELECT token, email FROM invites
             WHERE token = $1 AND used = false AND expires_at > NOW()
             FOR UPDATE`,
            [token]
        );

        if (!inviteResult.rows[0]) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Invalid or expired invite token' });
        }

        // Optionally enforce that the email matches the invite
        const inviteEmail = inviteResult.rows[0].email;
        if (inviteEmail && inviteEmail.toLowerCase() !== email.toLowerCase()) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Email does not match the invite' });
        }

        // Hash password
        const passwordHash = await argon2.hash(password, ARGON2_OPTIONS);

        // Insert user
        const userResult = await client.query(
            `INSERT INTO users (username, email, password_hash)
             VALUES ($1, $2, $3)
             RETURNING id, username, role`,
            [username, email, passwordHash]
        );

        // Consume the invite
        await client.query('UPDATE invites SET used = true WHERE token = $1', [token]);

        await client.query('COMMIT');

        const user = userResult.rows[0];

        // Issue JWT
        const jwtToken = jwt.sign(
            { id: user.id, username: user.username, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: '8h' }
        );

        res.cookie('token', jwtToken, cookieOptions());

        audit(req.db, 'register', user.id, req.ip, { username: user.username });

        res.status(201).json({ username: user.username, role: user.role });

    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});

        if (err.code === '23505') {   // unique_violation
            return res.status(409).json({ error: 'Username or email already taken' });
        }

        console.error('Registration error:', err);
        res.status(500).json({ error: 'Server error during registration' });
    } finally {
        client.release();
    }
});

// ---------------------------------------------------------------------------
// POST /api/auth/logout
// ---------------------------------------------------------------------------
router.post('/logout', (req, res) => {
    res.clearCookie('token', {
        httpOnly: true,
        sameSite: 'strict',
        secure:   process.env.NODE_ENV === 'production',
    });
    res.json({ message: 'Logged out successfully' });
});

// ---------------------------------------------------------------------------
// GET /api/auth/me  (requires authentication)
// ---------------------------------------------------------------------------
router.get('/me', authenticate, async (req, res) => {
    try {
        const result = await req.db.query(
            `SELECT id, username, email, role, created_at, last_login
             FROM users WHERE id = $1`,
            [req.user.id]
        );

        if (!result.rows[0]) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error('GET /me error:', err);
        res.status(500).json({ error: 'Server error fetching user info' });
    }
});

export default router;
