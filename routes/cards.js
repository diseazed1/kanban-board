/**
 * routes/cards.js
 *
 * Card CRUD with per-card publish/visibility control, activity tracking,
 * comments, and position reordering.
 *
 * Endpoints:
 *   GET    /api/cards                    — list cards (filtered by visibility)
 *   POST   /api/cards                    — create a new card
 *   GET    /api/cards/:id                — get a single card (with activity + comments)
 *   PUT    /api/cards/:id                — update a card (owner or admin only)
 *   PATCH  /api/cards/:id/visibility     — toggle public/private (owner or admin)
 *   PATCH  /api/cards/:id/reorder        — move card to column + position
 *   DELETE /api/cards/:id                — delete a card (owner or admin only)
 *   GET    /api/cards/:id/comments       — list comments on a card
 *   POST   /api/cards/:id/comments       — add a comment
 *   DELETE /api/cards/:id/comments/:cid  — delete a comment (author or admin)
 *   GET    /api/cards/:id/activity       — get activity timeline for a card
 */

import { Router } from 'express';

const router = Router();

const VALID_PRIORITIES  = new Set(['critical', 'high', 'medium', 'low', 'minimal']);
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
// Helper: record card activity (fire-and-forget)
// ---------------------------------------------------------------------------
const logActivity = (db, cardId, userId, action, details = {}) => {
    db.query(
        'INSERT INTO card_activity (card_id, user_id, action, details) VALUES ($1, $2, $3, $4)',
        [cardId, userId, action, JSON.stringify(details)]
    ).catch((err) => console.error('Activity log write failed:', err));
};

// ---------------------------------------------------------------------------
// Helper: check card access for non-admins
// ---------------------------------------------------------------------------
function canView(card, userId, role) {
    if (role === 'admin') return true;
    if (card.visibility === 'public') return true;
    if (card.owner_id === userId || card.assignee_id === userId) return true;
    return false;
}

// ---------------------------------------------------------------------------
// GET /api/cards
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
    const { id: userId, role } = req.user;

    try {
        let query;
        let params;

        if (role === 'admin') {
            query  = `SELECT c.*, 
                             o.username AS owner_username,
                             a.username AS assignee_username
                      FROM cards c
                      LEFT JOIN users o ON o.id = c.owner_id
                      LEFT JOIN users a ON a.id = c.assignee_id
                      ORDER BY c.column_id, c.position_in_column`;
            params = [];
        } else {
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
// GET /api/cards/:id  — includes activity and comment counts
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

        if (!canView(card, userId, role)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        // Attach comment count
        const commentCount = await req.db.query(
            'SELECT COUNT(*) AS cnt FROM card_comments WHERE card_id = $1',
            [req.params.id]
        );
        card.comment_count = parseInt(commentCount.rows[0].cnt, 10);

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
        return res.status(400).json({ error: 'priority must be critical, high, medium, low, or minimal' });
    }
    if (visibility && !VALID_VISIBILITY.has(visibility)) {
        return res.status(400).json({ error: 'visibility must be public or private' });
    }

    try {
        // Verify the target column exists
        const colCheck = await req.db.query('SELECT id, name, wip_limit FROM columns WHERE id = $1', [column_id]);
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

        // Determine position: place at end of column by default
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
                owner_id, assignee_id, visibility)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
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
            ]
        );

        const newCard = result.rows[0];

        // Log activity
        logActivity(req.db, newCard.id, req.user.id, 'created', {
            column: colCheck.rows[0].name,
        });

        audit(req.db, 'card_create', req.user.id, req.ip, { card_id: newCard.id, title });

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
        const existing = await req.db.query('SELECT * FROM cards WHERE id = $1', [req.params.id]);
        const card = existing.rows[0];

        if (!card) return res.status(404).json({ error: 'Card not found' });

        if (role !== 'admin' && card.owner_id !== userId) {
            return res.status(403).json({ error: 'Only the card owner or an admin can edit this card' });
        }

        const updates = req.body;

        if (updates.priority && !VALID_PRIORITIES.has(updates.priority)) {
            return res.status(400).json({ error: 'priority must be critical, high, medium, low, or minimal' });
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

        const updatedCard = result.rows[0];

        // Log specific activity events
        if ('column_id' in updates && updates.column_id !== card.column_id) {
            // Get column names for the activity log
            const colNames = await req.db.query(
                'SELECT id, name FROM columns WHERE id = ANY($1)',
                [[card.column_id, updates.column_id]]
            );
            const colMap = Object.fromEntries(colNames.rows.map(r => [r.id, r.name]));
            logActivity(req.db, card.id, userId, 'moved', {
                from_column: colMap[card.column_id] || `Column ${card.column_id}`,
                to_column:   colMap[updates.column_id] || `Column ${updates.column_id}`,
            });
        }
        if ('priority' in updates && updates.priority !== card.priority) {
            logActivity(req.db, card.id, userId, 'priority_changed', {
                from: card.priority,
                to:   updates.priority,
            });
        }
        if ('visibility' in updates && updates.visibility !== card.visibility) {
            logActivity(req.db, card.id, userId, 'visibility_changed', {
                from: card.visibility,
                to:   updates.visibility,
            });
        }
        if ('title' in updates && updates.title !== card.title) {
            logActivity(req.db, card.id, userId, 'edited', {
                field: 'title',
                from:  card.title,
                to:    updates.title,
            });
        }
        if ('assignee_id' in updates && updates.assignee_id !== card.assignee_id) {
            logActivity(req.db, card.id, userId, 'assigned', {
                assignee_id: updates.assignee_id,
            });
        }

        res.json(updatedCard);
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
        const existing = await req.db.query('SELECT owner_id, visibility AS old_vis FROM cards WHERE id = $1', [req.params.id]);
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

        logActivity(req.db, req.params.id, userId, 'visibility_changed', {
            from: card.old_vis,
            to:   visibility,
        });

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
// PATCH /api/cards/:id/reorder  — move card to specific column + position
// Used by drag-and-drop to reorder within and across columns.
// Body: { column_id: number, position: number }
// ---------------------------------------------------------------------------
router.patch('/:id/reorder', async (req, res) => {
    const { id: userId, role } = req.user;
    const { column_id, position } = req.body;

    if (column_id === undefined || position === undefined) {
        return res.status(400).json({ error: 'column_id and position are required' });
    }

    try {
        const existing = await req.db.query('SELECT * FROM cards WHERE id = $1', [req.params.id]);
        const card = existing.rows[0];

        if (!card) return res.status(404).json({ error: 'Card not found' });

        if (role !== 'admin' && card.owner_id !== userId) {
            return res.status(403).json({ error: 'Only the card owner or an admin can move this card' });
        }

        const oldColumnId = card.column_id;
        const oldPosition = card.position_in_column;
        const newColumnId = parseInt(column_id, 10);
        const newPosition = parseInt(position, 10);

        // Verify target column exists
        const colCheck = await req.db.query('SELECT id, name, wip_limit FROM columns WHERE id = $1', [newColumnId]);
        if (!colCheck.rows[0]) {
            return res.status(404).json({ error: 'Target column not found' });
        }

        // Enforce WIP limit (only if moving to a different column)
        if (newColumnId !== oldColumnId && colCheck.rows[0].wip_limit !== null) {
            const wipCheck = await req.db.query(
                'SELECT COUNT(*) AS cnt FROM cards WHERE column_id = $1',
                [newColumnId]
            );
            if (parseInt(wipCheck.rows[0].cnt, 10) >= colCheck.rows[0].wip_limit) {
                return res.status(409).json({ error: `Column WIP limit (${colCheck.rows[0].wip_limit}) reached` });
            }
        }

        // Use a transaction for atomic reordering
        const client = await req.db.connect();
        try {
            await client.query('BEGIN');

            if (newColumnId === oldColumnId) {
                // Reordering within the same column
                if (newPosition > oldPosition) {
                    // Moving down: shift cards between old+1 and new up by 1
                    await client.query(
                        `UPDATE cards SET position_in_column = position_in_column - 1
                         WHERE column_id = $1 AND position_in_column > $2 AND position_in_column <= $3 AND id != $4`,
                        [newColumnId, oldPosition, newPosition, card.id]
                    );
                } else if (newPosition < oldPosition) {
                    // Moving up: shift cards between new and old-1 down by 1
                    await client.query(
                        `UPDATE cards SET position_in_column = position_in_column + 1
                         WHERE column_id = $1 AND position_in_column >= $2 AND position_in_column < $3 AND id != $4`,
                        [newColumnId, newPosition, oldPosition, card.id]
                    );
                }
            } else {
                // Moving to a different column
                // Close gap in old column
                await client.query(
                    `UPDATE cards SET position_in_column = position_in_column - 1
                     WHERE column_id = $1 AND position_in_column > $2`,
                    [oldColumnId, oldPosition]
                );
                // Make space in new column
                await client.query(
                    `UPDATE cards SET position_in_column = position_in_column + 1
                     WHERE column_id = $1 AND position_in_column >= $2`,
                    [newColumnId, newPosition]
                );
            }

            // Place the card at its new position
            await client.query(
                `UPDATE cards SET column_id = $1, position_in_column = $2, updated_at = NOW()
                 WHERE id = $3`,
                [newColumnId, newPosition, card.id]
            );

            await client.query('COMMIT');
        } catch (txErr) {
            await client.query('ROLLBACK');
            throw txErr;
        } finally {
            client.release();
        }

        // Log activity if column changed
        if (newColumnId !== oldColumnId) {
            const colNames = await req.db.query(
                'SELECT id, name FROM columns WHERE id = ANY($1)',
                [[oldColumnId, newColumnId]]
            );
            const colMap = Object.fromEntries(colNames.rows.map(r => [r.id, r.name]));
            logActivity(req.db, card.id, userId, 'moved', {
                from_column: colMap[oldColumnId] || `Column ${oldColumnId}`,
                to_column:   colMap[newColumnId] || `Column ${newColumnId}`,
            });
        }

        // Fetch the updated card
        const updated = await req.db.query(
            `SELECT c.*, o.username AS owner_username, a.username AS assignee_username
             FROM cards c
             LEFT JOIN users o ON o.id = c.owner_id
             LEFT JOIN users a ON a.id = c.assignee_id
             WHERE c.id = $1`,
            [card.id]
        );

        res.json(updated.rows[0]);
    } catch (err) {
        console.error('Card reorder error:', err);
        res.status(500).json({ error: 'Server error reordering card' });
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

// ===========================================================================
// COMMENTS
// ===========================================================================

// ---------------------------------------------------------------------------
// GET /api/cards/:id/comments
// ---------------------------------------------------------------------------
router.get('/:id/comments', async (req, res) => {
    const { id: userId, role } = req.user;

    try {
        // Verify card exists and user can access it
        const cardResult = await req.db.query('SELECT * FROM cards WHERE id = $1', [req.params.id]);
        const card = cardResult.rows[0];
        if (!card) return res.status(404).json({ error: 'Card not found' });
        if (!canView(card, userId, role)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const result = await req.db.query(
            `SELECT cc.*, u.username
             FROM card_comments cc
             JOIN users u ON u.id = cc.user_id
             WHERE cc.card_id = $1
             ORDER BY cc.created_at ASC`,
            [req.params.id]
        );

        res.json(result.rows);
    } catch (err) {
        console.error('Comments fetch error:', err);
        res.status(500).json({ error: 'Server error fetching comments' });
    }
});

// ---------------------------------------------------------------------------
// POST /api/cards/:id/comments
// ---------------------------------------------------------------------------
router.post('/:id/comments', async (req, res) => {
    const { id: userId, role } = req.user;
    const { body } = req.body;

    if (!body?.trim()) {
        return res.status(400).json({ error: 'Comment body is required' });
    }

    try {
        // Verify card exists and user can access it
        const cardResult = await req.db.query('SELECT * FROM cards WHERE id = $1', [req.params.id]);
        const card = cardResult.rows[0];
        if (!card) return res.status(404).json({ error: 'Card not found' });
        if (!canView(card, userId, role)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const result = await req.db.query(
            `INSERT INTO card_comments (card_id, user_id, body)
             VALUES ($1, $2, $3) RETURNING *`,
            [req.params.id, userId, body.trim()]
        );

        // Get username for the response
        const comment = result.rows[0];
        comment.username = req.user.username;

        logActivity(req.db, req.params.id, userId, 'comment_added', {
            comment_id: comment.id,
        });

        res.status(201).json(comment);
    } catch (err) {
        console.error('Comment create error:', err);
        res.status(500).json({ error: 'Server error creating comment' });
    }
});

// ---------------------------------------------------------------------------
// DELETE /api/cards/:id/comments/:commentId  — author or admin only
// ---------------------------------------------------------------------------
router.delete('/:id/comments/:commentId', async (req, res) => {
    const { id: userId, role } = req.user;

    try {
        const result = await req.db.query(
            'SELECT * FROM card_comments WHERE id = $1 AND card_id = $2',
            [req.params.commentId, req.params.id]
        );
        const comment = result.rows[0];

        if (!comment) return res.status(404).json({ error: 'Comment not found' });

        if (role !== 'admin' && comment.user_id !== userId) {
            return res.status(403).json({ error: 'Only the comment author or an admin can delete this comment' });
        }

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

// ---------------------------------------------------------------------------
// GET /api/cards/:id/activity
// ---------------------------------------------------------------------------
router.get('/:id/activity', async (req, res) => {
    const { id: userId, role } = req.user;

    try {
        // Verify card exists and user can access it
        const cardResult = await req.db.query('SELECT * FROM cards WHERE id = $1', [req.params.id]);
        const card = cardResult.rows[0];
        if (!card) return res.status(404).json({ error: 'Card not found' });
        if (!canView(card, userId, role)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const result = await req.db.query(
            `SELECT ca.*, u.username
             FROM card_activity ca
             LEFT JOIN users u ON u.id = ca.user_id
             WHERE ca.card_id = $1
             ORDER BY ca.created_at DESC
             LIMIT 50`,
            [req.params.id]
        );

        res.json(result.rows);
    } catch (err) {
        console.error('Activity fetch error:', err);
        res.status(500).json({ error: 'Server error fetching activity' });
    }
});

export default router;
