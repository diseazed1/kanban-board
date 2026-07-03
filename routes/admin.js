/**
 * routes/admin.js
 *
 * Admin-only endpoints (all require authenticate + requireRole('admin')):
 *
 *   GET    /api/admin/users              — list all users
 *   PUT    /api/admin/users/:id          — update role and/or active status
 *   POST   /api/admin/users/:id/reset-password — force-reset a user's password
 *   DELETE /api/admin/users/:id          — permanently delete a user
 *
 *   GET    /api/admin/invites            — list pending (unused) invites
 *   POST   /api/admin/invites/send       — create invite token + send email
 *   DELETE /api/admin/invites/:token     — revoke an unused invite
 *
 *   GET    /api/admin/audit-log          — paginated audit log
 */

import { Router } from 'express';
import sgMail     from '@sendgrid/mail';
import argon2     from 'argon2';

const router = Router();

// Allowed role values (whitelist to prevent arbitrary role injection)
const VALID_ROLES = new Set(['admin', 'user', 'viewer']);

// ---------------------------------------------------------------------------
// Helper: write an audit log entry (fire-and-forget)
// ---------------------------------------------------------------------------
const audit = (db, action, userId, ip, metadata = {}) => {
    db.query(
        'INSERT INTO audit_log (action, user_id, ip_address, metadata) VALUES ($1, $2, $3, $4)',
        [action, userId, ip, JSON.stringify(metadata)]
    ).catch((err) => console.error('Audit log write failed:', err));
};

// ---------------------------------------------------------------------------
// GET /api/admin/users
// ---------------------------------------------------------------------------
router.get('/users', async (req, res) => {
    try {
        const result = await req.db.query(
            `SELECT id, username, email, role, is_active, created_at, last_login
             FROM users
             ORDER BY created_at DESC`
        );
        res.json(result.rows);
    } catch (err) {
        console.error('User list error:', err);
        res.status(500).json({ error: 'Server error fetching users' });
    }
});

// ---------------------------------------------------------------------------
// PUT /api/admin/users/:id  — update role and/or is_active
// ---------------------------------------------------------------------------
router.put('/users/:id', async (req, res) => {
    const targetId = parseInt(req.params.id, 10);

    if (isNaN(targetId)) {
        return res.status(400).json({ error: 'Invalid user ID' });
    }

    // Prevent an admin from demoting or deactivating themselves
    if (targetId === req.user.id) {
        return res.status(400).json({ error: 'You cannot modify your own account via the admin panel' });
    }

    const { role, is_active } = req.body;

    // Validate role if provided
    if (role !== undefined && !VALID_ROLES.has(role)) {
        return res.status(400).json({ error: `Invalid role. Allowed values: ${[...VALID_ROLES].join(', ')}` });
    }

    const fields = [];
    const values = [];
    let idx = 1;

    if (role      !== undefined) { fields.push(`role = $${idx++}`);      values.push(role); }
    if (is_active !== undefined) { fields.push(`is_active = $${idx++}`); values.push(Boolean(is_active)); }

    if (fields.length === 0) {
        return res.status(400).json({ error: 'Provide at least one field to update (role, is_active)' });
    }

    values.push(targetId);

    try {
        const result = await req.db.query(
            `UPDATE users SET ${fields.join(', ')} WHERE id = $${idx} RETURNING id, username, role, is_active`,
            values
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        audit(req.db, 'admin_user_update', req.user.id, req.ip, {
            target_user_id: targetId,
            changes: req.body,
        });

        res.json(result.rows[0]);
    } catch (err) {
        console.error('User update error:', err);
        res.status(500).json({ error: 'Server error updating user' });
    }
});

// ---------------------------------------------------------------------------
// POST /api/admin/users/:id/reset-password  — admin force-resets a user's password
// ---------------------------------------------------------------------------
router.post('/users/:id/reset-password', async (req, res) => {
    const targetId = parseInt(req.params.id, 10);

    if (isNaN(targetId)) {
        return res.status(400).json({ error: 'Invalid user ID' });
    }

    const { new_password } = req.body;

    if (!new_password || new_password.length < 8) {
        return res.status(400).json({ error: 'new_password is required and must be at least 8 characters' });
    }

    try {
        // Verify target user exists
        const userCheck = await req.db.query('SELECT id, username FROM users WHERE id = $1', [targetId]);
        if (userCheck.rowCount === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Hash and store new password
        const newHash = await argon2.hash(new_password, {
            type:        argon2.argon2id,
            memoryCost:  65536,
            timeCost:    3,
            parallelism: 2,
        });

        await req.db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, targetId]);

        audit(req.db, 'admin_password_reset', req.user.id, req.ip, {
            target_user_id: targetId,
            target_username: userCheck.rows[0].username,
        });

        res.json({ message: `Password reset successfully for user "${userCheck.rows[0].username}"` });
    } catch (err) {
        console.error('Admin password reset error:', err);
        res.status(500).json({ error: 'Server error resetting password' });
    }
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/users/:id  — hard delete (use with caution)
// ---------------------------------------------------------------------------
router.delete('/users/:id', async (req, res) => {
    const targetId = parseInt(req.params.id, 10);

    if (isNaN(targetId)) {
        return res.status(400).json({ error: 'Invalid user ID' });
    }

    if (targetId === req.user.id) {
        return res.status(400).json({ error: 'You cannot delete your own account' });
    }

    try {
        const result = await req.db.query(
            'DELETE FROM users WHERE id = $1 RETURNING id, username',
            [targetId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        audit(req.db, 'admin_user_delete', req.user.id, req.ip, {
            deleted_user_id: targetId,
            deleted_username: result.rows[0].username,
        });

        res.json({ success: true, deleted: result.rows[0] });
    } catch (err) {
        console.error('User delete error:', err);
        res.status(500).json({ error: 'Server error deleting user' });
    }
});

// ---------------------------------------------------------------------------
// GET /api/admin/invites  — list pending (unused, non-expired) invites
// ---------------------------------------------------------------------------
router.get('/invites', async (req, res) => {
    try {
        const result = await req.db.query(
            `SELECT i.token, i.email, i.expires_at, i.created_at,
                    u.username AS invited_by_username
             FROM invites i
             LEFT JOIN users u ON u.id = i.invited_by
             WHERE i.used = false AND i.expires_at > NOW()
             ORDER BY i.created_at DESC`
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Invite list error:', err);
        res.status(500).json({ error: 'Server error fetching invites' });
    }
});

// ---------------------------------------------------------------------------
// POST /api/admin/invites/send
// ---------------------------------------------------------------------------
router.post('/invites/send', async (req, res) => {
    const { email } = req.body;

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'A valid email address is required' });
    }

    // Check if the email already belongs to an active user
    const existing = await req.db.query(
        'SELECT id FROM users WHERE email = $1',
        [email]
    );
    if (existing.rowCount > 0) {
        return res.status(409).json({ error: 'A user with that email already exists' });
    }

    try {
        // Insert invite record (expires in 48 hours)
        const inviteResult = await req.db.query(
            `INSERT INTO invites (email, invited_by, expires_at)
             VALUES ($1, $2, NOW() + INTERVAL '48 hours')
             RETURNING token, email, expires_at`,
            [email, req.user.id]
        );

        const invite = inviteResult.rows[0];
        const registrationUrl = `${process.env.APP_URL || process.env.ORIGIN || 'http://localhost:3000'}/register.html?token=${invite.token}`;

        // Send invite email via SendGrid
        sgMail.setApiKey(process.env.SENDGRID_API_KEY);

        await sgMail.send({
            to:      invite.email,
            from:    process.env.FROM_EMAIL,
            subject: `You've been invited to join ${process.env.APP_NAME || 'Kanban Board'}`,
            text: [
                `Hello,`,
                ``,
                `You have been invited to join the Kanban Board by ${req.user.username}.`,
                ``,
                `Click the link below to create your account:`,
                `${registrationUrl}`,
                ``,
                `This invitation expires in 48 hours.`,
                ``,
                `If you did not expect this invitation, you can safely ignore this email.`,
            ].join('\n'),
            html: `
                <p>Hello,</p>
                <p>You have been invited to join the <strong>${process.env.APP_NAME || 'Kanban Board'}</strong>
                   by <strong>${req.user.username}</strong>.</p>
                <p>
                  <a href="${registrationUrl}"
                     style="display:inline-block;padding:10px 20px;background:#3498db;color:white;
                            text-decoration:none;border-radius:4px;">
                    Create your account
                  </a>
                </p>
                <p><small>This invitation expires in 48 hours.<br>
                If you did not expect this invitation, you can safely ignore this email.</small></p>
            `,
        });

        audit(req.db, 'invite_send', req.user.id, req.ip, { invited_email: email });

        // Do NOT return the token in the response — it was sent via email only
        res.status(201).json({
            sent_to:    invite.email,
            expires_at: invite.expires_at,
        });

    } catch (err) {
        console.error('Invite send error:', err);

        if (err.response?.body) {
            console.error('SendGrid error body:', JSON.stringify(err.response.body));
            return res.status(502).json({ error: 'Email delivery failed — check SendGrid configuration' });
        }

        res.status(500).json({ error: 'Server error sending invite' });
    }
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/invites/:token  — revoke an unused invite
// ---------------------------------------------------------------------------
router.delete('/invites/:token', async (req, res) => {
    const { token } = req.params;

    try {
        const result = await req.db.query(
            `UPDATE invites SET used = true
             WHERE token = $1 AND used = false
             RETURNING token, email`,
            [token]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Invite not found or already used' });
        }

        audit(req.db, 'invite_revoke', req.user.id, req.ip, {
            revoked_token: token,
            revoked_email: result.rows[0].email,
        });

        res.json({ success: true, revoked: result.rows[0] });
    } catch (err) {
        console.error('Invite revoke error:', err);
        res.status(500).json({ error: 'Server error revoking invite' });
    }
});

// ---------------------------------------------------------------------------
// GET /api/admin/audit-log  — paginated audit log
// ---------------------------------------------------------------------------
router.get('/audit-log', async (req, res) => {
    const limit  = Math.min(parseInt(req.query.limit  || '100', 10), 500);
    const offset = Math.max(parseInt(req.query.offset || '0',   10), 0);

    try {
        const result = await req.db.query(
            `SELECT al.id, al.action, al.ip_address, al.metadata, al.created_at,
                    u.username
             FROM audit_log al
             LEFT JOIN users u ON u.id = al.user_id
             ORDER BY al.created_at DESC
             LIMIT $1 OFFSET $2`,
            [limit, offset]
        );

        const countResult = await req.db.query('SELECT COUNT(*) FROM audit_log');

        res.json({
            total:   parseInt(countResult.rows[0].count, 10),
            limit,
            offset,
            entries: result.rows,
        });
    } catch (err) {
        console.error('Audit log error:', err);
        res.status(500).json({ error: 'Server error fetching audit log' });
    }
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/audit-log  — clear all audit log entries
// ---------------------------------------------------------------------------
router.delete('/audit-log', async (req, res) => {
    try {
        const result = await req.db.query('DELETE FROM audit_log');

        // Log the clear action itself (this entry will be the only one remaining)
        audit(req.db, 'audit_log_cleared', req.user.id, req.ip, {
            entries_deleted: result.rowCount,
        });

        res.json({ success: true, entries_deleted: result.rowCount });
    } catch (err) {
        console.error('Audit log clear error:', err);
        res.status(500).json({ error: 'Server error clearing audit log' });
    }
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/audit-log/older-than/:days  — purge entries older than N days
// ---------------------------------------------------------------------------
router.delete('/audit-log/older-than/:days', async (req, res) => {
    const days = parseInt(req.params.days, 10);

    if (isNaN(days) || days < 1) {
        return res.status(400).json({ error: 'days must be a positive integer (minimum 1)' });
    }

    try {
        const result = await req.db.query(
            `DELETE FROM audit_log WHERE created_at < NOW() - INTERVAL '1 day' * $1`,
            [days]
        );

        audit(req.db, 'audit_log_purged', req.user.id, req.ip, {
            older_than_days: days,
            entries_deleted: result.rowCount,
        });

        res.json({ success: true, entries_deleted: result.rowCount, older_than_days: days });
    } catch (err) {
        console.error('Audit log purge error:', err);
        res.status(500).json({ error: 'Server error purging audit log' });
    }
});

export default router;
