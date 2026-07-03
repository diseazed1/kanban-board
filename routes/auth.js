/**
 * routes/auth.js
 *
 * Authentication endpoints (session-based):
 *   POST /api/auth/login             — credential login, creates session
 *   POST /api/auth/register          — invite-only registration
 *   POST /api/auth/logout            — destroys session
 *   GET  /api/auth/me                — returns current user profile (requires session)
 *   POST /api/auth/change-password   — self-service password change (requires session)
 */

import { Router } from 'express';
import argon2     from 'argon2';
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
            [username.trim()]
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

        // Create session — this is the key authentication step
        const sessionUser = {
            id:       user.id,
            username: user.username,
            email:    user.email,
            role:     user.role,
        };

        // Regenerate session ID to prevent session fixation attacks
        req.session.regenerate((err) => {
            if (err) {
                console.error('Session regenerate error:', err);
                return res.status(500).json({ error: 'Server error during login' });
            }

            req.session.user = sessionUser;

            // Save session explicitly to ensure it's persisted before responding
            req.session.save((saveErr) => {
                if (saveErr) {
                    console.error('Session save error:', saveErr);
                    return res.status(500).json({ error: 'Server error during login' });
                }

                // Update last_login (non-blocking)
                req.db.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id])
                    .catch((e) => console.error('last_login update failed:', e));

                audit(req.db, 'login', user.id, req.ip, { username: user.username });

                res.json(sessionUser);
            });
        });

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
        return res.status(400).json({ error: 'Username must be 3-30 characters (letters, numbers, _ or -)' });
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
             RETURNING id, username, email, role`,
            [username.trim(), email.trim().toLowerCase(), passwordHash]
        );

        // Consume the invite
        await client.query('UPDATE invites SET used = true WHERE token = $1', [token]);

        await client.query('COMMIT');

        const user = userResult.rows[0];

        // Create session for the newly registered user
        const sessionUser = {
            id:       user.id,
            username: user.username,
            email:    user.email,
            role:     user.role,
        };

        req.session.regenerate((err) => {
            if (err) {
                console.error('Session regenerate error:', err);
                return res.status(201).json(sessionUser); // still created, just no auto-login
            }

            req.session.user = sessionUser;
            req.session.save((saveErr) => {
                if (saveErr) console.error('Session save error:', saveErr);
                audit(req.db, 'register', user.id, req.ip, { username: user.username });
                res.status(201).json(sessionUser);
            });
        });

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
    if (!req.session) {
        return res.json({ message: 'Already logged out' });
    }

    const userId   = req.session.user?.id;
    const username = req.session.user?.username;

    req.session.destroy((err) => {
        if (err) {
            console.error('Session destroy error:', err);
            return res.status(500).json({ error: 'Error logging out' });
        }

        res.clearCookie('kanban.sid');

        if (userId) {
            audit(req.db, 'logout', userId, req.ip, { username });
        }

        res.json({ message: 'Logged out successfully' });
    });
});

// ---------------------------------------------------------------------------
// GET /api/auth/me  (requires session)
// ---------------------------------------------------------------------------
router.get('/me', authenticate, async (req, res) => {
    try {
        // Fetch fresh data from DB (role may have changed since session was created)
        const result = await req.db.query(
            `SELECT id, username, email, role, created_at, last_login
             FROM users WHERE id = $1 AND is_active = true`,
            [req.user.id]
        );

        if (!result.rows[0]) {
            // User was deactivated or deleted — destroy session
            req.session.destroy(() => {});
            return res.status(401).json({ error: 'Account no longer active' });
        }

        const freshUser = result.rows[0];

        // Update session if role changed
        if (freshUser.role !== req.session.user.role) {
            req.session.user.role = freshUser.role;
        }

        res.json(freshUser);
    } catch (err) {
        console.error('GET /me error:', err);
        res.status(500).json({ error: 'Server error fetching user info' });
    }
});

// ---------------------------------------------------------------------------
// POST /api/auth/change-password  (self-service — any authenticated user)
// ---------------------------------------------------------------------------
router.post('/change-password', authenticate, async (req, res) => {
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password) {
        return res.status(400).json({ error: 'Both current_password and new_password are required' });
    }

    if (new_password.length < 8) {
        return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    if (current_password === new_password) {
        return res.status(400).json({ error: 'New password must be different from the current password' });
    }

    try {
        // Fetch current hash
        const result = await req.db.query(
            'SELECT password_hash FROM users WHERE id = $1',
            [req.user.id]
        );

        if (!result.rows[0]) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Verify current password
        const valid = await argon2.verify(result.rows[0].password_hash, current_password);
        if (!valid) {
            return res.status(401).json({ error: 'Current password is incorrect' });
        }

        // Hash and store new password
        const newHash = await argon2.hash(new_password, ARGON2_OPTIONS);
        await req.db.query(
            'UPDATE users SET password_hash = $1 WHERE id = $2',
            [newHash, req.user.id]
        );

        audit(req.db, 'password_change', req.user.id, req.ip, { username: req.user.username });

        res.json({ message: 'Password changed successfully' });
    } catch (err) {
        console.error('Change password error:', err);
        res.status(500).json({ error: 'Server error changing password' });
    }
});

export default router;
