/**
 * routes/cards.js
 *
 * Card CRUD with per-card publish/visibility control.
 *
 * Visibility model (stored in cards.visibility):
 *   'public'  — visible to every authenticated user on the board
 *   'private' — visible only to the card owner, the assignee, and admins
 *
 *   GET    /api/cards        — list cards (filtered by visibility)
 *   POST   /api/cards        — create a new card
 *   GET    /api/cards/:id    — get a single card
 *   PUT    /api/cards/:id    — update a card (owner or admin only)
 *   PATCH  /api/cards/:id/visibility — toggle public/private (owner or admin)
 *   DELETE /api/cards/:id    — delete a card (owner or admin only)
 */

import { Router } from 'express';

const router = Router();

const VALID_PRIORITIES  = new Set(['high', 'medium', 'low']);
const VALID_VISIBILITY  = new Set(['public', 'private']);

// ---------------------------------------------------------------------------
// Helper: audit log (fire-and-forget)
// ---------------------------------------------------------------------------
const audit = (db, action, userId, ip, metadata = {}) => {
    db.query(
        'INSERT INTO audit_log (action, user_id, ip_address, metadata) VALUES ($1, $2, $3, $4)',
        [action, userId, ip, JSON.stringify(metadata)]
    ).catch((err) => console.error('Audit log write failed:', err));
};

// ---------------------------------------------------------------------------
// GET /api/cards
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
    const { id: userId, role } = req.user;

    try {
        let query;
        let params;

        if (role === 'admin') {
            // Admins see every card on the board
            query  = `SELECT c.*, 
                             o.username AS owner_username,
                             a.username AS assignee_username
                      FROM cards c
                      LEFT JOIN users o ON o.id = c.owner_id
                      LEFT JOIN users a ON a.id = c.assignee_id
                      ORDER BY c.column_id, c.position_in_column`;
            params = [];
        } else {
            // Regular users see public cards + their own private cards
            query  = `SELECT c.*,
                             o.username AS owner_username,
                             a.username AS assignee_username
                      FROM cards c
                      LEFT JOIN users o ON o.id = c.owner_id
                      LEFT JOIN users a ON a.id = c.assignee_id
                      WHERE c.visibility = 'public'
                         OR c.owner_id    = $1
                         OR c.assignee_id = $1
                      ORDER BY c.column_id, c.position_in_column`;
            params = [userId];
        }

        const result = await req.db.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error('Card list error:', err);
        res.status(500).json({ error: 'Server error fetching cards' });
    }
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
                    a.username AS assignee_username
             FROM cards c
             LEFT JOIN users o ON o.id = c.owner_id
             LEFT JOIN users a ON a.id = c.assignee_id
             WHERE c.id = $1`,
            [req.params.id]
        );

        const card = result.rows[0];
        if (!card) return res.status(404).json({ error: 'Card not found' });

        // Enforce visibility for non-admins
        if (role !== 'admin' &&
            card.visibility === 'private' &&
            card.owner_id    !== userId &&
            card.assignee_id !== userId) {
            return res.status(403).json({ error: 'Access denied' });
        }

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
        title,
        description,
        priority,
        column_id,
        position_in_column,
        assignee_id,
        visibility,
    } = req.body;

    if (!title?.trim()) {
        return res.status(400).json({ error: 'Card title is required' });
    }
    if (!column_id) {
        return res.status(400).json({ error: 'column_id is required' });
    }
    if (priority && !VALID_PRIORITIES.has(priority)) {
        return res.status(400).json({ error: 'priority must be high, medium, or low' });
    }
    if (visibility && !VALID_VISIBILITY.has(visibility)) {
        return res.status(400).json({ error: 'visibility must be public or private' });
    }

    try {
        // Verify the target column exists
        const colCheck = await req.db.query('SELECT id, wip_limit FROM columns WHERE id = $1', [column_id]);
        if (!colCheck.rows[0]) {
            return res.status(404).json({ error: 'Target column not found' });
        }

        // Enforce WIP limit
        if (colCheck.rows[0].wip_limit !== null) {
            const wipCheck = await req.db.query(
                'SELECT COUNT(*) AS cnt FROM cards WHERE column_id = $1',
                [column_id]
            );
            if (parseInt(wipCheck.rows[0].cnt, 10) >= colCheck.rows[0].wip_limit) {
                return res.status(409).json({ error: `Column WIP limit (${colCheck.rows[0].wip_limit}) reached` });
            }
        }

        const result = await req.db.query(
            `INSERT INTO cards
               (title, description, priority, column_id, position_in_column,
                owner_id, assignee_id, visibility)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING *`,
            [
                title.trim(),
                description || '',
                priority    || 'medium',
                column_id,
                position_in_column ?? 0,
                req.user.id,
                assignee_id || null,
                visibility  || 'public',
            ]
        );

        audit(req.db, 'card_create', req.user.id, req.ip, { card_id: result.rows[0].id, title });

        res.status(201).json(result.rows[0]);
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
        // Fetch existing card to verify ownership
        const existing = await req.db.query('SELECT * FROM cards WHERE id = $1', [req.params.id]);
        const card = existing.rows[0];

        if (!card) return res.status(404).json({ error: 'Card not found' });

        if (role !== 'admin' && card.owner_id !== userId) {
            return res.status(403).json({ error: 'Only the card owner or an admin can edit this card' });
        }

        const updates = req.body;

        // Validate enum fields if present
        if (updates.priority   && !VALID_PRIORITIES.has(updates.priority)) {
            return res.status(400).json({ error: 'priority must be high, medium, or low' });
        }
        if (updates.visibility && !VALID_VISIBILITY.has(updates.visibility)) {
            return res.status(400).json({ error: 'visibility must be public or private' });
        }

        const ALLOWED = ['title', 'description', 'priority', 'column_id',
                         'position_in_column', 'assignee_id', 'visibility'];

        const fields = [];
        const values = [];
        let idx = 1;

        for (const key of ALLOWED) {
            if (key in updates) {
                fields.push(`${key} = $${idx++}`);
                values.push(key === 'assignee_id' ? (updates[key] || null) : updates[key]);
            }
        }

        if (fields.length === 0) {
            return res.status(400).json({ error: 'No valid fields provided for update' });
        }

        // Always bump updated_at
        fields.push(`updated_at = NOW()`);
        values.push(req.params.id);

        const result = await req.db.query(
            `UPDATE cards SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
            values
        );

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Card update error:', err);
        res.status(500).json({ error: 'Server error updating card' });
    }
});

// ---------------------------------------------------------------------------
// PATCH /api/cards/:id/visibility  — toggle publish/private (owner or admin)
// ---------------------------------------------------------------------------
router.patch('/:id/visibility', async (req, res) => {
    const { id: userId, role } = req.user;
    const { visibility } = req.body;

    if (!VALID_VISIBILITY.has(visibility)) {
        return res.status(400).json({ error: 'visibility must be "public" or "private"' });
    }

    try {
        const existing = await req.db.query('SELECT owner_id FROM cards WHERE id = $1', [req.params.id]);
        const card = existing.rows[0];

        if (!card) return res.status(404).json({ error: 'Card not found' });

        if (role !== 'admin' && card.owner_id !== userId) {
            return res.status(403).json({ error: 'Only the card owner or an admin can change visibility' });
        }

        const result = await req.db.query(
            `UPDATE cards SET visibility = $1, updated_at = NOW()
             WHERE id = $2
             RETURNING id, title, visibility`,
            [visibility, req.params.id]
        );

        audit(req.db, 'card_visibility_change', userId, req.ip, {
            card_id:    req.params.id,
            visibility,
        });

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Card visibility update error:', err);
        res.status(500).json({ error: 'Server error updating card visibility' });
    }
});

// ---------------------------------------------------------------------------
// DELETE /api/cards/:id  — owner or admin only
// ---------------------------------------------------------------------------
router.delete('/:id', async (req, res) => {
    const { id: userId, role } = req.user;

    try {
        const existing = await req.db.query('SELECT owner_id, title FROM cards WHERE id = $1', [req.params.id]);
        const card = existing.rows[0];

        if (!card) return res.status(404).json({ error: 'Card not found' });

        if (role !== 'admin' && card.owner_id !== userId) {
            return res.status(403).json({ error: 'Only the card owner or an admin can delete this card' });
        }

        await req.db.query('DELETE FROM cards WHERE id = $1', [req.params.id]);

        audit(req.db, 'card_delete', userId, req.ip, { card_id: req.params.id, title: card.title });

        res.json({ success: true });
    } catch (err) {
        console.error('Card delete error:', err);
        res.status(500).json({ error: 'Server error deleting card' });
    }
});

export default router;
