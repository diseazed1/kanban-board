/**
 * routes/cards.js
 *
 * Card CRUD with all features:
 *   - Per-card visibility (public/private)
 *   - Activity timeline & comments with @mention notifications
 *   - Due dates with overdue detection
 *   - Subtasks / checklists
 *   - File attachments (stored on Fly.io volume at /data/uploads)
 *   - Assignment notifications via in-app notifications + SendGrid email
 *   - Saved filter views (per-user)
 *
 * Endpoints:
 *   GET    /api/cards                          — list cards
 *   POST   /api/cards                          — create card
 *   GET    /api/cards/:id                      — get single card
 *   PUT    /api/cards/:id                      — update card
 *   PATCH  /api/cards/:id/visibility           — toggle visibility
 *   PATCH  /api/cards/:id/reorder              — drag-and-drop reorder
 *   DELETE /api/cards/:id                      — delete card
 *
 *   GET    /api/cards/:id/comments             — list comments
 *   POST   /api/cards/:id/comments             — add comment (@mentions parsed)
 *   DELETE /api/cards/:id/comments/:cid        — delete comment
 *   GET    /api/cards/:id/activity             — activity timeline
 *
 *   GET    /api/cards/:id/subtasks             — list subtasks
 *   POST   /api/cards/:id/subtasks             — add subtask
 *   PATCH  /api/cards/:id/subtasks/:sid        — toggle/rename subtask
 *   DELETE /api/cards/:id/subtasks/:sid        — delete subtask
 *
 *   GET    /api/cards/:id/attachments          — list attachments
 *   POST   /api/cards/:id/attachments          — upload file
 *   GET    /api/cards/:id/attachments/:aid     — download file
 *   DELETE /api/cards/:id/attachments/:aid     — delete attachment
 *
 *   GET    /api/cards/notifications            — user's notifications
 *   PATCH  /api/cards/notifications/:nid/read  — mark notification read
 *   PATCH  /api/cards/notifications/read-all   — mark all read
 *
 *   GET    /api/cards/views                    — list saved views
 *   POST   /api/cards/views                    — save a view
 *   DELETE /api/cards/views/:vid               — delete a saved view
 */

import { Router }   from 'express';
import path         from 'path';
import fs           from 'fs';
import { randomUUID } from 'crypto';
import multer       from 'multer';
import sgMail       from '@sendgrid/mail';

sgMail.setApiKey(process.env.SENDGRID_API_KEY || '');

const router = Router();

const VALID_PRIORITIES = new Set(['critical', 'high', 'medium', 'low', 'minimal']);
const VALID_VISIBILITY = new Set(['public', 'private']);

// File upload directory (Fly.io persistent volume mounted at /data)
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/data/uploads';
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_MIME  = new Set([
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'application/pdf',
    'text/plain', 'text/csv',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/zip',
]);

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename:    (_req, _file, cb) => cb(null, `${randomUUID()}`),
});

const upload = multer({
    storage,
    limits: { fileSize: MAX_FILE_SIZE },
    fileFilter: (_req, file, cb) => {
        if (ALLOWED_MIME.has(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error(`File type "${file.mimetype}" is not allowed`));
        }
    },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const audit = (db, action, userId, ip, metadata = {}) => {
    db.query(
        'INSERT INTO audit_log (action, user_id, ip_address, metadata) VALUES ($1, $2, $3, $4)',
        [action, userId, ip, JSON.stringify(metadata)]
    ).catch((err) => console.error('Audit log write failed:', err));
};

const logActivity = (db, cardId, userId, action, details = {}) => {
    db.query(
        'INSERT INTO card_activity (card_id, user_id, action, details) VALUES ($1, $2, $3, $4)',
        [cardId, userId, action, JSON.stringify(details)]
    ).catch((err) => console.error('Activity log write failed:', err));
};

const createNotification = (db, userId, type, cardId, actorId, message) => {
    db.query(
        `INSERT INTO notifications (user_id, type, card_id, actor_id, message)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, type, cardId, actorId, message]
    ).catch((err) => console.error('Notification write failed:', err));
};

async function sendEmail(to, subject, html) {
    if (!process.env.SENDGRID_API_KEY || !process.env.FROM_EMAIL) return;
    try {
        await sgMail.send({
            to,
            from: process.env.FROM_EMAIL,
            subject,
            html,
        });
    } catch (err) {
        console.error('SendGrid email error:', err.message);
    }
}

function canView(card, userId, role) {
    if (role === 'admin') return true;
    if (card.visibility === 'public') return true;
    if (card.owner_id === userId || card.assignee_id === userId) return true;
    return false;
}

// Parse @mentions from comment body, return array of usernames
function parseMentions(body) {
    const matches = body.match(/@([a-zA-Z0-9_]+)/g) || [];
    return [...new Set(matches.map(m => m.slice(1).toLowerCase()))];
}

// Log to the board-wide activity feed
const logBoardActivity = (db, userId, action, cardId, cardTitle, details = {}) => {
    db.query(
        `INSERT INTO board_activity (user_id, action, card_id, card_title, details)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, action, cardId, cardTitle, JSON.stringify(details)]
    ).catch((err) => console.error('Board activity write failed:', err));
};

// Format due date status for display
function dueDateStatus(dueDate) {
    if (!dueDate) return null;
    const now  = new Date();
    const due  = new Date(dueDate);
    const diff = due - now;
    if (diff < 0)                    return 'overdue';
    if (diff < 24 * 60 * 60 * 1000) return 'due_soon';
    return 'upcoming';
}

// ===========================================================================
// CARDS — CRUD
// ===========================================================================

// ---------------------------------------------------------------------------
// GET /api/cards
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
    const { id: userId, role } = req.user;
    const showArchived = req.query.archived === 'true';

    try {
        const labelSubquery = `
            COALESCE(
                (SELECT json_agg(json_build_object('id', l.id, 'name', l.name, 'color', l.color))
                 FROM card_labels cl JOIN labels l ON l.id = cl.label_id
                 WHERE cl.card_id = c.id),
                '[]'::json
            ) AS labels`;

        let query, params;
        const archiveFilter = showArchived ? 'c.is_archived = TRUE' : 'c.is_archived = FALSE';

        if (role === 'admin') {
            query  = `SELECT c.*,
                             o.username AS owner_username,
                             a.username AS assignee_username,
                             (SELECT COUNT(*) FROM card_subtasks WHERE card_id = c.id)::int AS subtask_total,
                             (SELECT COUNT(*) FROM card_subtasks WHERE card_id = c.id AND is_done = TRUE)::int AS subtask_done,
                             (SELECT COUNT(*) FROM card_attachments WHERE card_id = c.id)::int AS attachment_count,
                             ${labelSubquery}
                      FROM cards c
                      LEFT JOIN users o ON o.id = c.owner_id
                      LEFT JOIN users a ON a.id = c.assignee_id
                      WHERE ${archiveFilter}
                      ORDER BY c.column_id, c.position_in_column`;
            params = [];
        } else {
            query  = `SELECT c.*,
                             o.username AS owner_username,
                             a.username AS assignee_username,
                             (SELECT COUNT(*) FROM card_subtasks WHERE card_id = c.id)::int AS subtask_total,
                             (SELECT COUNT(*) FROM card_subtasks WHERE card_id = c.id AND is_done = TRUE)::int AS subtask_done,
                             (SELECT COUNT(*) FROM card_attachments WHERE card_id = c.id)::int AS attachment_count,
                             ${labelSubquery}
                      FROM cards c
                      LEFT JOIN users o ON o.id = c.owner_id
                      LEFT JOIN users a ON a.id = c.assignee_id
                      WHERE ${archiveFilter}
                        AND (c.visibility = 'public' OR c.owner_id = $1 OR c.assignee_id = $1)
                      ORDER BY c.column_id, c.position_in_column`;
            params = [userId];
        }

        const result = await req.db.query(query, params);
        const rows = result.rows.map(card => ({ ...card, due_status: dueDateStatus(card.due_date) }));
        res.json(rows);
    } catch (err) {
        console.error('Card list error:', err);
        res.status(500).json({ error: 'Server error fetching cards' });
    }
});

// ---------------------------------------------------------------------------
// NOTIFICATIONS — must be declared before /:id to avoid route collision
// ---------------------------------------------------------------------------
router.get('/notifications', async (req, res) => {
    const { id: userId } = req.user;
    try {
        const result = await req.db.query(
            `SELECT n.*, c.title AS card_title, a.username AS actor_username
             FROM notifications n
             LEFT JOIN cards c ON c.id = n.card_id
             LEFT JOIN users a ON a.id = n.actor_id
             WHERE n.user_id = $1
             ORDER BY n.created_at DESC
             LIMIT 50`,
            [userId]
        );
        const unread = result.rows.filter(n => !n.is_read).length;
        res.json({ notifications: result.rows, unread_count: unread });
    } catch (err) {
        console.error('Notifications fetch error:', err);
        res.status(500).json({ error: 'Server error fetching notifications' });
    }
});
router.patch('/notifications/read-all', async (req, res) => {
    const { id: userId } = req.user;
    try {
        await req.db.query(
            'UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND is_read = FALSE',
            [userId]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error marking notifications read' });
    }
});
router.patch('/notifications/:notificationId/read', async (req, res) => {
    const { id: userId } = req.user;
    try {
        await req.db.query(
            'UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2',
            [req.params.notificationId, userId]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error marking notification read' });
    }
});
// ---------------------------------------------------------------------------
// SAVED VIEWS — must be declared before /:id to avoid route collision
// ---------------------------------------------------------------------------
router.get('/views', async (req, res) => {
    const { id: userId } = req.user;
    try {
        const result = await req.db.query(
            'SELECT * FROM saved_views WHERE user_id = $1 ORDER BY created_at ASC',
            [userId]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Server error fetching saved views' });
    }
});
router.post('/views', async (req, res) => {
    const { id: userId } = req.user;
    const { name, filters } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'View name is required' });
    if (!filters || typeof filters !== 'object')
        return res.status(400).json({ error: 'filters must be an object' });
    try {
        const result = await req.db.query(
            `INSERT INTO saved_views (user_id, name, filters)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id, name) DO UPDATE SET filters = EXCLUDED.filters
             RETURNING *`,
            [userId, name.trim(), JSON.stringify(filters)]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Server error saving view' });
    }
});
router.delete('/views/:viewId', async (req, res) => {
    const { id: userId } = req.user;
    try {
        await req.db.query(
            'DELETE FROM saved_views WHERE id = $1 AND user_id = $2',
            [req.params.viewId, userId]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error deleting view' });
    }
});
// ---------------------------------------------------------------------------
// LABELS — must be before /:id
// ---------------------------------------------------------------------------
router.get('/labels', async (req, res) => {
    try {
        const result = await req.db.query('SELECT * FROM labels ORDER BY name ASC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Server error fetching labels' }); }
});
router.post('/labels', async (req, res) => {
    const { name, color } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Label name is required' });
    if (color && !/^#[0-9a-fA-F]{6}$/.test(color))
        return res.status(400).json({ error: 'Color must be a valid hex code e.g. #3498db' });
    try {
        const result = await req.db.query(
            `INSERT INTO labels (name, color, created_by) VALUES ($1, $2, $3)
             ON CONFLICT (name) DO UPDATE SET color = EXCLUDED.color RETURNING *`,
            [name.trim(), color || '#6c757d', req.user.id]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: 'Server error creating label' }); }
});
router.delete('/labels/:labelId', async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    try {
        await req.db.query('DELETE FROM labels WHERE id = $1', [req.params.labelId]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Server error deleting label' }); }
});
// ---------------------------------------------------------------------------
// BOARD ACTIVITY FEED — must be before /:id
// ---------------------------------------------------------------------------
router.get('/feed', async (req, res) => {
    const limit  = Math.min(parseInt(req.query.limit  || '50', 10), 200);
    const offset = parseInt(req.query.offset || '0', 10);
    try {
        const result = await req.db.query(
            `SELECT ba.*, u.username AS actor_username
             FROM board_activity ba
             LEFT JOIN users u ON u.id = ba.user_id
             ORDER BY ba.created_at DESC
             LIMIT $1 OFFSET $2`,
            [limit, offset]
        );
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Server error fetching activity feed' }); }
});
// ---------------------------------------------------------------------------
// ARCHIVE — must be before /:id
// ---------------------------------------------------------------------------
router.get('/archive', async (req, res) => {
    const { id: userId, role } = req.user;
    try {
        const labelSubquery = `COALESCE(
            (SELECT json_agg(json_build_object('id', l.id, 'name', l.name, 'color', l.color))
             FROM card_labels cl JOIN labels l ON l.id = cl.label_id WHERE cl.card_id = c.id),
            '[]'::json) AS labels`;
        let query, params;
        if (role === 'admin') {
            query = `SELECT c.*, o.username AS owner_username, a.username AS assignee_username, ${labelSubquery}
                     FROM cards c LEFT JOIN users o ON o.id = c.owner_id LEFT JOIN users a ON a.id = c.assignee_id
                     WHERE c.is_archived = TRUE ORDER BY c.archived_at DESC`;
            params = [];
        } else {
            query = `SELECT c.*, o.username AS owner_username, a.username AS assignee_username, ${labelSubquery}
                     FROM cards c LEFT JOIN users o ON o.id = c.owner_id LEFT JOIN users a ON a.id = c.assignee_id
                     WHERE c.is_archived = TRUE AND (c.visibility = 'public' OR c.owner_id = $1 OR c.assignee_id = $1)
                     ORDER BY c.archived_at DESC`;
            params = [userId];
        }
        const result = await req.db.query(query, params);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Server error fetching archive' }); }
});
// ---------------------------------------------------------------------------
// CSV EXPORT — must be before /:id
// ---------------------------------------------------------------------------
router.get('/export/csv', async (req, res) => {
    const { id: userId, role } = req.user;
    const showArchived = req.query.archived === 'true';
    try {
        let query, params;
        const archiveFilter = showArchived ? 'c.is_archived = TRUE' : 'c.is_archived = FALSE';
        if (role === 'admin') {
            query = `SELECT c.id, c.title, c.description, c.priority, c.visibility,
                            col.name AS column_name, o.username AS owner, a.username AS assignee,
                            c.due_date, c.is_archived, c.created_at, c.updated_at
                     FROM cards c
                     LEFT JOIN columns col ON col.id = c.column_id
                     LEFT JOIN users o ON o.id = c.owner_id
                     LEFT JOIN users a ON a.id = c.assignee_id
                     WHERE ${archiveFilter}
                     ORDER BY col.position, c.position_in_column`;
            params = [];
        } else {
            query = `SELECT c.id, c.title, c.description, c.priority, c.visibility,
                            col.name AS column_name, o.username AS owner, a.username AS assignee,
                            c.due_date, c.is_archived, c.created_at, c.updated_at
                     FROM cards c
                     LEFT JOIN columns col ON col.id = c.column_id
                     LEFT JOIN users o ON o.id = c.owner_id
                     LEFT JOIN users a ON a.id = c.assignee_id
                     WHERE ${archiveFilter}
                       AND (c.visibility = 'public' OR c.owner_id = $1 OR c.assignee_id = $1)
                     ORDER BY col.position, c.position_in_column`;
            params = [userId];
        }
        const result = await req.db.query(query, params);
        const headers = ['ID','Title','Description','Priority','Visibility','Column','Owner','Assignee','Due Date','Archived','Created','Updated'];
        const escape = v => v == null ? '' : `"${String(v).replace(/"/g, '""')}"`;
        const lines  = [headers.join(',')];
        for (const r of result.rows) {
            lines.push([
                escape(r.id), escape(r.title), escape(r.description), escape(r.priority),
                escape(r.visibility), escape(r.column_name), escape(r.owner), escape(r.assignee),
                escape(r.due_date ? new Date(r.due_date).toISOString() : ''),
                escape(r.is_archived), escape(new Date(r.created_at).toISOString()),
                escape(new Date(r.updated_at).toISOString()),
            ].join(','));
        }
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="kanban-export-${Date.now()}.csv"`);
        res.send(lines.join('\n'));
    } catch (err) { res.status(500).json({ error: 'Server error generating CSV' }); }
});
// ---------------------------------------------------------------------------
// GET /api/cards/:id
// ---------------------------------------------------------------------------
router.get('/:id', async (req, res) => {
    const { id: userId, role } = req.user;

    try {
        const result = await req.db.query(
            `SELECT c.*,
                    o.username AS owner_username,
                    a.username AS assignee_username,
                    (SELECT COUNT(*) FROM card_subtasks WHERE card_id = c.id)::int AS subtask_total,
                    (SELECT COUNT(*) FROM card_subtasks WHERE card_id = c.id AND is_done = TRUE)::int AS subtask_done,
                    (SELECT COUNT(*) FROM card_attachments WHERE card_id = c.id)::int AS attachment_count,
                    (SELECT COUNT(*) FROM card_comments WHERE card_id = c.id)::int AS comment_count
             FROM cards c
             LEFT JOIN users o ON o.id = c.owner_id
             LEFT JOIN users a ON a.id = c.assignee_id
             WHERE c.id = $1`,
            [req.params.id]
        );

        const card = result.rows[0];
        if (!card) return res.status(404).json({ error: 'Card not found' });
        if (!canView(card, userId, role)) return res.status(403).json({ error: 'Access denied' });

        card.due_status = dueDateStatus(card.due_date);
        res.json(card);
    } catch (err) {
        console.error('Card get error:', err);
        res.status(500).json({ error: 'Server error fetching card' });
    }
});

// ---------------------------------------------------------------------------
// POST /api/cards
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
    const {
        title, description, priority, column_id,
        position_in_column, assignee_id, visibility, due_date,
    } = req.body;

    if (!title?.trim())  return res.status(400).json({ error: 'Card title is required' });
    if (!column_id)      return res.status(400).json({ error: 'column_id is required' });
    if (priority && !VALID_PRIORITIES.has(priority))
        return res.status(400).json({ error: 'Invalid priority value' });
    if (visibility && !VALID_VISIBILITY.has(visibility))
        return res.status(400).json({ error: 'visibility must be public or private' });

    try {
        const colCheck = await req.db.query('SELECT id, name, wip_limit FROM columns WHERE id = $1', [column_id]);
        if (!colCheck.rows[0]) return res.status(404).json({ error: 'Target column not found' });

        if (colCheck.rows[0].wip_limit !== null) {
            const wipCheck = await req.db.query(
                'SELECT COUNT(*) AS cnt FROM cards WHERE column_id = $1', [column_id]
            );
            if (parseInt(wipCheck.rows[0].cnt, 10) >= colCheck.rows[0].wip_limit) {
                return res.status(409).json({ error: `Column WIP limit (${colCheck.rows[0].wip_limit}) reached` });
            }
        }

        let pos = position_in_column;
        if (pos === undefined || pos === null) {
            const maxPos = await req.db.query(
                'SELECT COALESCE(MAX(position_in_column), -1) + 1 AS next_pos FROM cards WHERE column_id = $1',
                [column_id]
            );
            pos = maxPos.rows[0].next_pos;
        }

        const result = await req.db.query(
            `INSERT INTO cards
               (title, description, priority, column_id, position_in_column,
                owner_id, assignee_id, visibility, due_date)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING *`,
            [
                title.trim(),
                description || '',
                priority    || 'medium',
                column_id,
                pos,
                req.user.id,
                assignee_id || null,
                visibility  || 'public',
                due_date    || null,
            ]
        );

        const newCard = result.rows[0];

        logActivity(req.db, newCard.id, req.user.id, 'created', { column: colCheck.rows[0].name });
        logBoardActivity(req.db, req.user.id, 'card_created', newCard.id, title, { column: colCheck.rows[0].name });
        audit(req.db, 'card_create', req.user.id, req.ip, { card_id: newCard.id, title });

        // Apply labels if provided
        if (Array.isArray(req.body.label_ids) && req.body.label_ids.length > 0) {
            for (const lid of req.body.label_ids) {
                await req.db.query(
                    'INSERT INTO card_labels (card_id, label_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                    [newCard.id, lid]
                );
            }
        }

        // Notify assignee if assigned at creation
        if (assignee_id && assignee_id !== req.user.id) {
            const assignee = await req.db.query('SELECT username, email FROM users WHERE id = $1', [assignee_id]);
            if (assignee.rows[0]) {
                createNotification(
                    req.db, assignee_id, 'assigned', newCard.id, req.user.id,
                    `${req.user.username} assigned you to "${title}"`
                );
                sendEmail(
                    assignee.rows[0].email,
                    `You've been assigned to "${title}"`,
                    `<p>Hi ${assignee.rows[0].username},</p>
                     <p><strong>${req.user.username}</strong> assigned you to the card <strong>"${title}"</strong>.</p>
                     <p><a href="${process.env.APP_URL || ''}">View the board</a></p>`
                );
            }
        }

        newCard.due_status = dueDateStatus(newCard.due_date);
        res.status(201).json(newCard);
    } catch (err) {
        console.error('Card create error:', err);
        res.status(500).json({ error: 'Server error creating card' });
    }
});

// ---------------------------------------------------------------------------
// PUT /api/cards/:id  — full update (owner or admin)
// ---------------------------------------------------------------------------
router.put('/:id', async (req, res) => {
    const { id: userId, role } = req.user;

    try {
        const existing = await req.db.query(
            `SELECT c.*, a.username AS assignee_username, a.email AS assignee_email
             FROM cards c
             LEFT JOIN users a ON a.id = c.assignee_id
             WHERE c.id = $1`,
            [req.params.id]
        );
        const card = existing.rows[0];
        if (!card) return res.status(404).json({ error: 'Card not found' });

        if (role !== 'admin' && card.owner_id !== userId) {
            return res.status(403).json({ error: 'Only the card owner or an admin can edit this card' });
        }

        const updates = req.body;

        if (updates.priority && !VALID_PRIORITIES.has(updates.priority))
            return res.status(400).json({ error: 'Invalid priority value' });
        if (updates.visibility && !VALID_VISIBILITY.has(updates.visibility))
            return res.status(400).json({ error: 'visibility must be public or private' });

        const ALLOWED = ['title', 'description', 'priority', 'column_id',
                         'position_in_column', 'assignee_id', 'visibility', 'due_date'];

        const fields = [];
        const values = [];
        let idx = 1;

        for (const key of ALLOWED) {
            if (key in updates) {
                fields.push(`${key} = $${idx++}`);
                if (key === 'assignee_id' || key === 'due_date') {
                    values.push(updates[key] || null);
                } else {
                    values.push(updates[key]);
                }
            }
        }

        if (fields.length === 0) return res.status(400).json({ error: 'No valid fields provided' });

        fields.push(`updated_at = NOW()`);
        values.push(req.params.id);

        const result = await req.db.query(
            `UPDATE cards SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
            values
        );

        const updatedCard = result.rows[0];

        // Activity logging
        if ('column_id' in updates && updates.column_id !== card.column_id) {
            const colNames = await req.db.query(
                'SELECT id, name FROM columns WHERE id = ANY($1)', [[card.column_id, updates.column_id]]
            );
            const colMap = Object.fromEntries(colNames.rows.map(r => [r.id, r.name]));
            logActivity(req.db, card.id, userId, 'moved', {
                from_column: colMap[card.column_id] || `Column ${card.column_id}`,
                to_column:   colMap[updates.column_id] || `Column ${updates.column_id}`,
            });
        }
        if ('priority' in updates && updates.priority !== card.priority) {
            logActivity(req.db, card.id, userId, 'priority_changed', { from: card.priority, to: updates.priority });
        }
        if ('visibility' in updates && updates.visibility !== card.visibility) {
            logActivity(req.db, card.id, userId, 'visibility_changed', { from: card.visibility, to: updates.visibility });
        }
        if ('title' in updates && updates.title !== card.title) {
            logActivity(req.db, card.id, userId, 'edited', { field: 'title', from: card.title, to: updates.title });
        }
        if ('due_date' in updates) {
            logActivity(req.db, card.id, userId, 'due_date_set', { due_date: updates.due_date });
        }

        // Assignment notification
        if ('assignee_id' in updates && updates.assignee_id && updates.assignee_id !== card.assignee_id) {
            const newAssigneeId = parseInt(updates.assignee_id, 10);
            if (newAssigneeId !== userId) {
                const assignee = await req.db.query('SELECT username, email FROM users WHERE id = $1', [newAssigneeId]);
                if (assignee.rows[0]) {
                    createNotification(
                        req.db, newAssigneeId, 'assigned', card.id, userId,
                        `${req.user.username} assigned you to "${card.title}"`
                    );
                    sendEmail(
                        assignee.rows[0].email,
                        `You've been assigned to "${card.title}"`,
                        `<p>Hi ${assignee.rows[0].username},</p>
                         <p><strong>${req.user.username}</strong> assigned you to the card <strong>"${card.title}"</strong>.</p>
                         <p><a href="${process.env.APP_URL || ''}">View the board</a></p>`
                    );
                    logActivity(req.db, card.id, userId, 'assigned', { assignee_id: newAssigneeId });
                }
            }
        }

        updatedCard.due_status = dueDateStatus(updatedCard.due_date);
        res.json(updatedCard);
    } catch (err) {
        console.error('Card update error:', err);
        res.status(500).json({ error: 'Server error updating card' });
    }
});

// ---------------------------------------------------------------------------
// PATCH /api/cards/:id/visibility
// ---------------------------------------------------------------------------
router.patch('/:id/visibility', async (req, res) => {
    const { id: userId, role } = req.user;
    const { visibility } = req.body;

    if (!VALID_VISIBILITY.has(visibility))
        return res.status(400).json({ error: 'visibility must be "public" or "private"' });

    try {
        const existing = await req.db.query(
            'SELECT owner_id, visibility AS old_vis FROM cards WHERE id = $1', [req.params.id]
        );
        const card = existing.rows[0];
        if (!card) return res.status(404).json({ error: 'Card not found' });
        if (role !== 'admin' && card.owner_id !== userId)
            return res.status(403).json({ error: 'Only the card owner or an admin can change visibility' });

        const result = await req.db.query(
            `UPDATE cards SET visibility = $1, updated_at = NOW() WHERE id = $2 RETURNING id, title, visibility`,
            [visibility, req.params.id]
        );

        logActivity(req.db, req.params.id, userId, 'visibility_changed', { from: card.old_vis, to: visibility });
        audit(req.db, 'card_visibility_change', userId, req.ip, { card_id: req.params.id, visibility });

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Visibility update error:', err);
        res.status(500).json({ error: 'Server error updating visibility' });
    }
});

// ---------------------------------------------------------------------------
// PATCH /api/cards/:id/reorder
// ---------------------------------------------------------------------------
router.patch('/:id/reorder', async (req, res) => {
    const { id: userId, role } = req.user;
    const { column_id, position } = req.body;

    if (column_id === undefined || position === undefined)
        return res.status(400).json({ error: 'column_id and position are required' });

    try {
        const existing = await req.db.query('SELECT * FROM cards WHERE id = $1', [req.params.id]);
        const card = existing.rows[0];
        if (!card) return res.status(404).json({ error: 'Card not found' });
        if (role !== 'admin' && card.owner_id !== userId)
            return res.status(403).json({ error: 'Only the card owner or an admin can move this card' });

        const oldColumnId = card.column_id;
        const oldPosition = card.position_in_column;
        const newColumnId = parseInt(column_id, 10);
        const newPosition = parseInt(position, 10);

        const colCheck = await req.db.query('SELECT id, name, wip_limit FROM columns WHERE id = $1', [newColumnId]);
        if (!colCheck.rows[0]) return res.status(404).json({ error: 'Target column not found' });

        if (newColumnId !== oldColumnId && colCheck.rows[0].wip_limit !== null) {
            const wipCheck = await req.db.query(
                'SELECT COUNT(*) AS cnt FROM cards WHERE column_id = $1', [newColumnId]
            );
            if (parseInt(wipCheck.rows[0].cnt, 10) >= colCheck.rows[0].wip_limit)
                return res.status(409).json({ error: `Column WIP limit (${colCheck.rows[0].wip_limit}) reached` });
        }

        const client = await req.db.connect();
        try {
            await client.query('BEGIN');

            if (newColumnId === oldColumnId) {
                if (newPosition > oldPosition) {
                    await client.query(
                        `UPDATE cards SET position_in_column = position_in_column - 1
                         WHERE column_id = $1 AND position_in_column > $2 AND position_in_column <= $3 AND id != $4`,
                        [newColumnId, oldPosition, newPosition, card.id]
                    );
                } else if (newPosition < oldPosition) {
                    await client.query(
                        `UPDATE cards SET position_in_column = position_in_column + 1
                         WHERE column_id = $1 AND position_in_column >= $2 AND position_in_column < $3 AND id != $4`,
                        [newColumnId, newPosition, oldPosition, card.id]
                    );
                }
            } else {
                await client.query(
                    `UPDATE cards SET position_in_column = position_in_column - 1
                     WHERE column_id = $1 AND position_in_column > $2`,
                    [oldColumnId, oldPosition]
                );
                await client.query(
                    `UPDATE cards SET position_in_column = position_in_column + 1
                     WHERE column_id = $1 AND position_in_column >= $2`,
                    [newColumnId, newPosition]
                );
            }

            await client.query(
                `UPDATE cards SET column_id = $1, position_in_column = $2, updated_at = NOW() WHERE id = $3`,
                [newColumnId, newPosition, card.id]
            );

            await client.query('COMMIT');
        } catch (txErr) {
            await client.query('ROLLBACK');
            throw txErr;
        } finally {
            client.release();
        }

        if (newColumnId !== oldColumnId) {
            const colNames = await req.db.query(
                'SELECT id, name FROM columns WHERE id = ANY($1)', [[oldColumnId, newColumnId]]
            );
            const colMap = Object.fromEntries(colNames.rows.map(r => [r.id, r.name]));
            logActivity(req.db, card.id, userId, 'moved', {
                from_column: colMap[oldColumnId] || `Column ${oldColumnId}`,
                to_column:   colMap[newColumnId] || `Column ${newColumnId}`,
            });
        }

        const updated = await req.db.query(
            `SELECT c.*, o.username AS owner_username, a.username AS assignee_username
             FROM cards c
             LEFT JOIN users o ON o.id = c.owner_id
             LEFT JOIN users a ON a.id = c.assignee_id
             WHERE c.id = $1`,
            [card.id]
        );

        const updatedCard = updated.rows[0];
        updatedCard.due_status = dueDateStatus(updatedCard.due_date);
        res.json(updatedCard);
    } catch (err) {
        console.error('Card reorder error:', err);
        res.status(500).json({ error: 'Server error reordering card' });
    }
});

// ---------------------------------------------------------------------------
// DELETE /api/cards/:id
// ---------------------------------------------------------------------------
router.delete('/:id', async (req, res) => {
    const { id: userId, role } = req.user;

    try {
        const existing = await req.db.query(
            'SELECT owner_id, title FROM cards WHERE id = $1', [req.params.id]
        );
        const card = existing.rows[0];
        if (!card) return res.status(404).json({ error: 'Card not found' });
        if (role !== 'admin' && card.owner_id !== userId)
            return res.status(403).json({ error: 'Only the card owner or an admin can delete this card' });

        // Delete attachment files from disk
        const attachments = await req.db.query(
            'SELECT stored_name FROM card_attachments WHERE card_id = $1', [req.params.id]
        );
        for (const att of attachments.rows) {
            const filePath = path.join(UPLOAD_DIR, att.stored_name);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }

        await req.db.query('DELETE FROM cards WHERE id = $1', [req.params.id]);

        audit(req.db, 'card_delete', userId, req.ip, { card_id: req.params.id, title: card.title });

        res.json({ success: true });
    } catch (err) {
        console.error('Card delete error:', err);
        res.status(500).json({ error: 'Server error deleting card' });
    }
});

// ---------------------------------------------------------------------------
// PATCH /api/cards/:id/archive  — soft-delete a card (owner or admin)
// PATCH /api/cards/:id/unarchive — restore a card (owner or admin)
// ---------------------------------------------------------------------------
router.patch('/:id/archive', async (req, res) => {
    const { id: userId, role } = req.user;
    try {
        const existing = await req.db.query('SELECT owner_id, title, is_archived FROM cards WHERE id = $1', [req.params.id]);
        const card = existing.rows[0];
        if (!card) return res.status(404).json({ error: 'Card not found' });
        if (role !== 'admin' && card.owner_id !== userId)
            return res.status(403).json({ error: 'Only the card owner or an admin can archive this card' });
        if (card.is_archived) return res.status(409).json({ error: 'Card is already archived' });

        const result = await req.db.query(
            `UPDATE cards SET is_archived = TRUE, archived_at = NOW(), archived_by = $1, updated_at = NOW()
             WHERE id = $2 RETURNING *`,
            [userId, req.params.id]
        );
        logActivity(req.db, req.params.id, userId, 'archived', { title: card.title });
        logBoardActivity(req.db, userId, 'card_archived', req.params.id, card.title, {});
        audit(req.db, 'card_archive', userId, req.ip, { card_id: req.params.id, title: card.title });
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Archive error:', err);
        res.status(500).json({ error: 'Server error archiving card' });
    }
});

router.patch('/:id/unarchive', async (req, res) => {
    const { id: userId, role } = req.user;
    try {
        const existing = await req.db.query('SELECT owner_id, title, is_archived FROM cards WHERE id = $1', [req.params.id]);
        const card = existing.rows[0];
        if (!card) return res.status(404).json({ error: 'Card not found' });
        if (role !== 'admin' && card.owner_id !== userId)
            return res.status(403).json({ error: 'Only the card owner or an admin can unarchive this card' });
        if (!card.is_archived) return res.status(409).json({ error: 'Card is not archived' });

        const result = await req.db.query(
            `UPDATE cards SET is_archived = FALSE, archived_at = NULL, archived_by = NULL, updated_at = NOW()
             WHERE id = $1 RETURNING *`,
            [req.params.id]
        );
        logActivity(req.db, req.params.id, userId, 'unarchived', { title: card.title });
        logBoardActivity(req.db, userId, 'card_unarchived', req.params.id, card.title, {});
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Unarchive error:', err);
        res.status(500).json({ error: 'Server error unarchiving card' });
    }
});

// ---------------------------------------------------------------------------
// PATCH /api/cards/:id/labels  — set labels on a card (replaces all existing)
// ---------------------------------------------------------------------------
router.patch('/:id/labels', async (req, res) => {
    const { id: userId, role } = req.user;
    const { label_ids } = req.body;
    if (!Array.isArray(label_ids)) return res.status(400).json({ error: 'label_ids must be an array' });
    try {
        const existing = await req.db.query('SELECT owner_id, title FROM cards WHERE id = $1', [req.params.id]);
        const card = existing.rows[0];
        if (!card) return res.status(404).json({ error: 'Card not found' });
        if (role !== 'admin' && card.owner_id !== userId)
            return res.status(403).json({ error: 'Only the card owner or an admin can update labels' });

        await req.db.query('DELETE FROM card_labels WHERE card_id = $1', [req.params.id]);
        for (const lid of label_ids) {
            await req.db.query(
                'INSERT INTO card_labels (card_id, label_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                [req.params.id, lid]
            );
        }
        logActivity(req.db, req.params.id, userId, 'labels_updated', { label_ids });
        const labelsResult = await req.db.query(
            `SELECT l.* FROM labels l JOIN card_labels cl ON cl.label_id = l.id WHERE cl.card_id = $1`,
            [req.params.id]
        );
        res.json(labelsResult.rows);
    } catch (err) {
        console.error('Labels update error:', err);
        res.status(500).json({ error: 'Server error updating labels' });
    }
});

// ===========================================================================
// COMMENTS  (with @mention parsing)
// ===========================================================================

router.get('/:id/comments', async (req, res) => {
    const { id: userId, role } = req.user;
    try {
        const cardResult = await req.db.query('SELECT * FROM cards WHERE id = $1', [req.params.id]);
        const card = cardResult.rows[0];
        if (!card) return res.status(404).json({ error: 'Card not found' });
        if (!canView(card, userId, role)) return res.status(403).json({ error: 'Access denied' });

        const result = await req.db.query(
            `SELECT cc.*, u.username FROM card_comments cc
             JOIN users u ON u.id = cc.user_id
             WHERE cc.card_id = $1 ORDER BY cc.created_at ASC`,
            [req.params.id]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Comments fetch error:', err);
        res.status(500).json({ error: 'Server error fetching comments' });
    }
});

router.post('/:id/comments', async (req, res) => {
    const { id: userId, role } = req.user;
    const { body } = req.body;

    if (!body?.trim()) return res.status(400).json({ error: 'Comment body is required' });

    try {
        const cardResult = await req.db.query('SELECT * FROM cards WHERE id = $1', [req.params.id]);
        const card = cardResult.rows[0];
        if (!card) return res.status(404).json({ error: 'Card not found' });
        if (!canView(card, userId, role)) return res.status(403).json({ error: 'Access denied' });

        const result = await req.db.query(
            `INSERT INTO card_comments (card_id, user_id, body) VALUES ($1, $2, $3) RETURNING *`,
            [req.params.id, userId, body.trim()]
        );

        const comment = result.rows[0];
        comment.username = req.user.username;

        logActivity(req.db, req.params.id, userId, 'comment_added', { comment_id: comment.id });

        // Notify card owner if someone else commented
        if (card.owner_id && card.owner_id !== userId) {
            createNotification(
                req.db, card.owner_id, 'comment_added', card.id, userId,
                `${req.user.username} commented on "${card.title}"`
            );
        }

        // Parse @mentions and notify each mentioned user
        const mentionedUsernames = parseMentions(body);
        if (mentionedUsernames.length > 0) {
            const mentionedUsers = await req.db.query(
                `SELECT id, username, email FROM users WHERE LOWER(username) = ANY($1) AND id != $2`,
                [mentionedUsernames, userId]
            );
            for (const user of mentionedUsers.rows) {
                createNotification(
                    req.db, user.id, 'mentioned', card.id, userId,
                    `${req.user.username} mentioned you in a comment on "${card.title}"`
                );
                sendEmail(
                    user.email,
                    `${req.user.username} mentioned you in "${card.title}"`,
                    `<p>Hi ${user.username},</p>
                     <p><strong>${req.user.username}</strong> mentioned you in a comment on <strong>"${card.title}"</strong>:</p>
                     <blockquote>${body.replace(/</g, '&lt;')}</blockquote>
                     <p><a href="${process.env.APP_URL || ''}">View the board</a></p>`
                );
            }
        }

        res.status(201).json(comment);
    } catch (err) {
        console.error('Comment create error:', err);
        res.status(500).json({ error: 'Server error creating comment' });
    }
});

router.delete('/:id/comments/:commentId', async (req, res) => {
    const { id: userId, role } = req.user;
    try {
        const result = await req.db.query(
            'SELECT * FROM card_comments WHERE id = $1 AND card_id = $2',
            [req.params.commentId, req.params.id]
        );
        const comment = result.rows[0];
        if (!comment) return res.status(404).json({ error: 'Comment not found' });
        if (role !== 'admin' && comment.user_id !== userId)
            return res.status(403).json({ error: 'Only the comment author or an admin can delete this comment' });

        await req.db.query('DELETE FROM card_comments WHERE id = $1', [req.params.commentId]);
        res.json({ success: true });
    } catch (err) {
        console.error('Comment delete error:', err);
        res.status(500).json({ error: 'Server error deleting comment' });
    }
});

// ===========================================================================
// ACTIVITY TIMELINE
// ===========================================================================

router.get('/:id/activity', async (req, res) => {
    const { id: userId, role } = req.user;
    try {
        const cardResult = await req.db.query('SELECT * FROM cards WHERE id = $1', [req.params.id]);
        const card = cardResult.rows[0];
        if (!card) return res.status(404).json({ error: 'Card not found' });
        if (!canView(card, userId, role)) return res.status(403).json({ error: 'Access denied' });

        const result = await req.db.query(
            `SELECT ca.*, u.username FROM card_activity ca
             LEFT JOIN users u ON u.id = ca.user_id
             WHERE ca.card_id = $1 ORDER BY ca.created_at DESC LIMIT 50`,
            [req.params.id]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Activity fetch error:', err);
        res.status(500).json({ error: 'Server error fetching activity' });
    }
});

// ===========================================================================
// SUBTASKS / CHECKLISTS
// ===========================================================================

router.get('/:id/subtasks', async (req, res) => {
    const { id: userId, role } = req.user;
    try {
        const cardResult = await req.db.query('SELECT * FROM cards WHERE id = $1', [req.params.id]);
        const card = cardResult.rows[0];
        if (!card) return res.status(404).json({ error: 'Card not found' });
        if (!canView(card, userId, role)) return res.status(403).json({ error: 'Access denied' });

        const result = await req.db.query(
            `SELECT cs.*, u.username AS created_by_username FROM card_subtasks cs
             LEFT JOIN users u ON u.id = cs.created_by
             WHERE cs.card_id = $1 ORDER BY cs.position ASC, cs.id ASC`,
            [req.params.id]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Subtasks fetch error:', err);
        res.status(500).json({ error: 'Server error fetching subtasks' });
    }
});

router.post('/:id/subtasks', async (req, res) => {
    const { id: userId, role } = req.user;
    const { title } = req.body;

    if (!title?.trim()) return res.status(400).json({ error: 'Subtask title is required' });

    try {
        const cardResult = await req.db.query('SELECT * FROM cards WHERE id = $1', [req.params.id]);
        const card = cardResult.rows[0];
        if (!card) return res.status(404).json({ error: 'Card not found' });
        if (!canView(card, userId, role)) return res.status(403).json({ error: 'Access denied' });

        const maxPos = await req.db.query(
            'SELECT COALESCE(MAX(position), -1) + 1 AS next_pos FROM card_subtasks WHERE card_id = $1',
            [req.params.id]
        );

        const result = await req.db.query(
            `INSERT INTO card_subtasks (card_id, title, position, created_by)
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [req.params.id, title.trim(), maxPos.rows[0].next_pos, userId]
        );

        logActivity(req.db, req.params.id, userId, 'subtask_added', { title: title.trim() });

        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Subtask create error:', err);
        res.status(500).json({ error: 'Server error creating subtask' });
    }
});

router.patch('/:id/subtasks/:subtaskId', async (req, res) => {
    const { id: userId, role } = req.user;
    const { is_done, title } = req.body;

    try {
        const cardResult = await req.db.query('SELECT * FROM cards WHERE id = $1', [req.params.id]);
        const card = cardResult.rows[0];
        if (!card) return res.status(404).json({ error: 'Card not found' });
        if (!canView(card, userId, role)) return res.status(403).json({ error: 'Access denied' });

        const fields = [];
        const values = [];
        let idx = 1;

        if (is_done !== undefined) { fields.push(`is_done = $${idx++}`); values.push(is_done); }
        if (title !== undefined)   { fields.push(`title = $${idx++}`);   values.push(title.trim()); }
        if (fields.length === 0)   return res.status(400).json({ error: 'No fields to update' });

        fields.push(`updated_at = NOW()`);
        values.push(req.params.subtaskId, req.params.id);

        const result = await req.db.query(
            `UPDATE card_subtasks SET ${fields.join(', ')}
             WHERE id = $${idx} AND card_id = $${idx + 1} RETURNING *`,
            values
        );

        if (!result.rows[0]) return res.status(404).json({ error: 'Subtask not found' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Subtask update error:', err);
        res.status(500).json({ error: 'Server error updating subtask' });
    }
});

router.delete('/:id/subtasks/:subtaskId', async (req, res) => {
    const { id: userId, role } = req.user;
    try {
        const cardResult = await req.db.query('SELECT * FROM cards WHERE id = $1', [req.params.id]);
        const card = cardResult.rows[0];
        if (!card) return res.status(404).json({ error: 'Card not found' });
        if (role !== 'admin' && card.owner_id !== userId)
            return res.status(403).json({ error: 'Only the card owner or an admin can delete subtasks' });

        await req.db.query(
            'DELETE FROM card_subtasks WHERE id = $1 AND card_id = $2',
            [req.params.subtaskId, req.params.id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Subtask delete error:', err);
        res.status(500).json({ error: 'Server error deleting subtask' });
    }
});

// ===========================================================================
// FILE ATTACHMENTS
// ===========================================================================

router.get('/:id/attachments', async (req, res) => {
    const { id: userId, role } = req.user;
    try {
        const cardResult = await req.db.query('SELECT * FROM cards WHERE id = $1', [req.params.id]);
        const card = cardResult.rows[0];
        if (!card) return res.status(404).json({ error: 'Card not found' });
        if (!canView(card, userId, role)) return res.status(403).json({ error: 'Access denied' });

        const result = await req.db.query(
            `SELECT ca.*, u.username AS uploaded_by_username FROM card_attachments ca
             LEFT JOIN users u ON u.id = ca.uploaded_by
             WHERE ca.card_id = $1 ORDER BY ca.created_at DESC`,
            [req.params.id]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Attachments fetch error:', err);
        res.status(500).json({ error: 'Server error fetching attachments' });
    }
});

router.post('/:id/attachments', upload.single('file'), async (req, res) => {
    const { id: userId, role } = req.user;

    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    try {
        const cardResult = await req.db.query('SELECT * FROM cards WHERE id = $1', [req.params.id]);
        const card = cardResult.rows[0];
        if (!card) {
            fs.unlinkSync(req.file.path);
            return res.status(404).json({ error: 'Card not found' });
        }
        if (!canView(card, userId, role)) {
            fs.unlinkSync(req.file.path);
            return res.status(403).json({ error: 'Access denied' });
        }

        const result = await req.db.query(
            `INSERT INTO card_attachments (card_id, uploaded_by, filename, stored_name, mime_type, size_bytes)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [
                req.params.id,
                userId,
                req.file.originalname,
                req.file.filename,
                req.file.mimetype,
                req.file.size,
            ]
        );

        logActivity(req.db, req.params.id, userId, 'file_attached', { filename: req.file.originalname });

        res.status(201).json(result.rows[0]);
    } catch (err) {
        if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        console.error('Attachment upload error:', err);
        res.status(500).json({ error: 'Server error uploading attachment' });
    }
});

router.get('/:id/attachments/:attachmentId', async (req, res) => {
    const { id: userId, role } = req.user;
    try {
        const cardResult = await req.db.query('SELECT * FROM cards WHERE id = $1', [req.params.id]);
        const card = cardResult.rows[0];
        if (!card) return res.status(404).json({ error: 'Card not found' });
        if (!canView(card, userId, role)) return res.status(403).json({ error: 'Access denied' });

        const attResult = await req.db.query(
            'SELECT * FROM card_attachments WHERE id = $1 AND card_id = $2',
            [req.params.attachmentId, req.params.id]
        );
        const att = attResult.rows[0];
        if (!att) return res.status(404).json({ error: 'Attachment not found' });

        const filePath = path.join(UPLOAD_DIR, att.stored_name);
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found on disk' });

        res.setHeader('Content-Disposition', `attachment; filename="${att.filename}"`);
        res.setHeader('Content-Type', att.mime_type);
        res.sendFile(path.resolve(filePath));
    } catch (err) {
        console.error('Attachment download error:', err);
        res.status(500).json({ error: 'Server error downloading attachment' });
    }
});

router.delete('/:id/attachments/:attachmentId', async (req, res) => {
    const { id: userId, role } = req.user;
    try {
        const attResult = await req.db.query(
            `SELECT ca.*, c.owner_id FROM card_attachments ca
             JOIN cards c ON c.id = ca.card_id
             WHERE ca.id = $1 AND ca.card_id = $2`,
            [req.params.attachmentId, req.params.id]
        );
        const att = attResult.rows[0];
        if (!att) return res.status(404).json({ error: 'Attachment not found' });

        if (role !== 'admin' && att.uploaded_by !== userId && att.owner_id !== userId)
            return res.status(403).json({ error: 'Only the uploader, card owner, or admin can delete this attachment' });

        const filePath = path.join(UPLOAD_DIR, att.stored_name);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

        await req.db.query('DELETE FROM card_attachments WHERE id = $1', [req.params.attachmentId]);
        res.json({ success: true });
    } catch (err) {
        console.error('Attachment delete error:', err);
        res.status(500).json({ error: 'Server error deleting attachment' });
    }
});

export default router;
