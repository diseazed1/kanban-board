/**
 * routes/cards.js
 *
 * Card CRUD with per-card publish/visibility control, activity tracking,
 * comments, and position reordering.
 *
 * Endpoints:
 *   GET    /api/cards                    — list/search/filter cards (with due_date + overdue)
 *   POST   /api/cards                    — create a new card (with due_date support)
 *   GET    /api/cards/:id                — get a single card (with activity + comments)
 *   PUT    /api/cards/:id                — update a card (owner or admin only) [due_date]
 *   PATCH  /api/cards/:id/visibility     — toggle public/private (owner or admin)
 *   PATCH  /api/cards/:id/reorder        — move card to column + position
 *   DELETE /api/cards/:id                — delete a card (owner or admin only)
 *   POST   /api/cards/:id/clone          — clone a card
 *   GET    /api/cards/tags               — list all tags in use
 *   POST   /api/cards/:id/tags           — add tag(s) to a card
 *   DELETE /api/cards/:id/tags/:tagId    — remove tag from card
 */

import { Router } from 'express';
import path       from 'path';
import fs         from 'fs/promises';

const router = Router();

const VALID_PRIORITIES  = new Set(['critical', 'high', 'medium', 'low', 'minimal']);
const VALID_VISIBILITY  = new Set(['public', 'private']);

// ---------------------------------------------------------------------------
// Helper: build visibility WHERE clause + params for card queries
// ---------------------------------------------------------------------------
function buildVisibilityWhere(userId, role, paramOffset = 1) {
    if (role === 'admin') {
        return { whereClause: '', params: [] };
    }
    return {
        whereClause: `(c.visibility = 'public' OR c.owner_id = $${paramOffset} OR c.assignee_id = $${paramOffset})`,
        params: [userId],
    };
}

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
// GET /api/cards  — list/search/filter cards
// Query params:
//   search         - keyword (matches title/description via trigram)
//   priority       - filter by priority level
//   column_id      - filter by column
//   assignee_id    - filter by assignee user ID
//   tag            - filter by tag slug
//   due_before     - ISO date, return cards due before this time
//   overdue        - "true" returns only overdue cards
//   status         - "overdue", "due_week", "no_due" for special filters
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
    const { id: userId, role } = req.user;
    const {
        search,
        priority,
        column_id,
        assignee_id,
        tag,
        due_before,
        overdue,
        status,
    } = req.query;

    try {
        const vis = buildVisibilityWhere(userId, role, 1);
        let whereClauses = [vis.whereClause];
        let params = [...vis.params];
        let idx = 2;

        // Text search (title + description)
        if (search) {
            whereClauses.push(`(c.title ILIKE $${idx} OR c.description ILIKE $${idx})`);
            params.push(`%${search}%`);
            idx++;
        }

        // Priority filter
        if (priority && VALID_PRIORITIES.has(priority)) {
            whereClauses.push(`c.priority = $${idx}`);
            params.push(priority);
            idx++;
        } else if (priority && !VALID_PRIORITIES.has(priority)) {
            return res.status(400).json({ error: `priority must be one of: ${[...VALID_PRIORITIES].join(', ')}` });
        }

        // Column filter
        if (column_id) {
            whereClauses.push(`c.column_id = $${idx}`);
            params.push(parseInt(column_id, 10));
            idx++;
        }

        // Assignee filter
        if (assignee_id) {
            whereClauses.push(`c.assignee_id = $${idx}`);
            params.push(parseInt(assignee_id, 10));
            idx++;
        }

        // Tag filter — join through card_tag_map + card_tags
        let tagJoin = '';
        if (tag) {
            tagJoin = `INNER JOIN card_tag_map ctm ON ctm.card_id = c.id INNER JOIN card_tags ct ON ct.id = ctm.tag_id`;
            whereClauses.push(`ct.slug = $${idx}`);
            params.push(tag.toLowerCase());
            idx++;
        }

        // Due date filters
        if (due_before) {
            whereClauses.push(`c.due_date <= $${idx}`);
            params.push(new Date(due_before));
            idx++;
        }

        if (overdue === 'true') {
            whereClauses.push(`c.due_date < NOW()`);
            whereClauses.push(`c.due_date IS NOT NULL`);
        }

        if (status === 'overdue') {
            whereClauses.push(`c.due_date < NOW()`);
            whereClauses.push(`c.due_date IS NOT NULL`);
        } else if (status === 'due_week') {
            whereClauses.push(`c.due_date >= NOW() AND c.due_date <= NOW() + INTERVAL '7 days'`);
        } else if (status === 'no_due') {
            whereClauses.push(`c.due_date IS NULL`);
        }

        // Build final WHERE clause
        const activeClauses = whereClauses.filter(c => c.length > 0);
        const whereSql = activeClauses.length ? `WHERE ${activeClauses.join(' AND ')}` : '';

        const query = `
            SELECT DISTINCT c.*, o.username AS owner_username, a.username AS assignee_username,
                    CASE WHEN c.due_date IS NOT NULL AND c.due_date < NOW() THEN true ELSE false END AS is_overdue
            FROM cards c
            LEFT JOIN users o ON o.id = c.owner_id
            LEFT JOIN users a ON a.id = c.assignee_id
            ${tagJoin}
            ${whereSql}
            ORDER BY c.column_id, c.position_in_column
        `;

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
                    a.username AS assignee_username,
                    CASE WHEN c.due_date IS NOT NULL AND c.due_date < NOW() THEN true ELSE false END AS is_overdue
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
        due_date,
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

        // Validate due_date if provided
        let parsedDueDate = null;
        const body_due_date = req.body.due_date;
        if (body_due_date) {
            parsedDueDate = new Date(body_due_date);
            if (Number.isNaN(parsedDueDate.getTime())) {
                return res.status(400).json({ error: 'due_date must be a valid ISO date string' });
            }
        }

    // Resolve assignee_username to assignee_id if provided
    let resolvedAssigneeId = assignee_id;
    const { assignee_username } = req.body;
    if (assignee_username && !resolvedAssigneeId) {
        const userCheck = await req.db.query(
            'SELECT id FROM users WHERE username = $1',
            [assignee_username.trim()]
        );
        if (userCheck.rows[0]) {
            resolvedAssigneeId = userCheck.rows[0].id;
        }
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
                resolvedAssigneeId || null,
                visibility  || 'public',
                parsedDueDate,
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

        // Resolve assignee_username to assignee_id if provided
        let resolvedAssigneeId = updates.assignee_id;
        if (updates.assignee_username && !resolvedAssigneeId) {
            const userCheck = await req.db.query(
                'SELECT id FROM users WHERE username = $1',
                [updates.assignee_username.trim()]
            );
            if (userCheck.rows[0]) {
                resolvedAssigneeId = userCheck.rows[0].id;
            }
        }

        // Validate due_date if provided in update
        let parsedDueDate = null;
        if ('due_date' in updates) {
            if (updates.due_date === null || updates.due_date === '') {
                parsedDueDate = null;  // explicitly clear
            } else {
                parsedDueDate = new Date(updates.due_date);
                if (Number.isNaN(parsedDueDate.getTime())) {
                    return res.status(400).json({ error: 'due_date must be a valid ISO date string or null' });
                }
            }
        }

        const ALLOWED = ['title', 'description', 'priority', 'column_id',
                         'position_in_column', 'assignee_id', 'visibility', 'due_date'];

        const fields = [];
        const values = [];
        let idx = 1;

        for (const key of ALLOWED) {
            if (key in updates) {
                fields.push(`${key} = $${idx++}`);
                values.push(key === 'assignee_id' ? (resolvedAssigneeId || null)
                              : key === 'due_date' ? parsedDueDate
                              : updates[key]);
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

// ---------------------------------------------------------------------------
// Helper: log card attachment activity (fire-and-forget)
// ---------------------------------------------------------------------------
const logAttachmentActivity = (db, cardId, userId, action, details = {}) => {
    db.query(
        'INSERT INTO card_activity (card_id, user_id, action, details) VALUES ($1, $2, $3, $4)',
        [cardId, userId, action, JSON.stringify(details)]
    ).catch((err) => console.error('Attachment activity log write failed:', err));
};

// ===========================================================================
// ATTACHMENTS
// ===========================================================================
const UPLOAD_DIR   = path.resolve(process.env.UPLOAD_DIR || './uploads');
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

// ---------------------------------------------------------------------------
// POST /api/cards/:id/attachments  — upload a document (expects FormData)
// ---------------------------------------------------------------------------
router.post('/:id/attachments', async (req, res) => {
    const { id: userId, role } = req.user;
    const cardId   = req.params.id;
    const file     = req.file;

    if (!file) {
        return res.status(400).json({ error: 'No file provided' });
    }

    try {
        // Verify card exists and user can access it
        const cardResult = await req.db.query('SELECT * FROM cards WHERE id = $1', [cardId]);
        const card = cardResult.rows[0];
        if (!card) return res.status(404).json({ error: 'Card not found' });
        if (!canView(card, userId, role)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        // Ensure upload directory exists
        await fs.mkdir(UPLOAD_DIR, { recursive: true });

        const storedPath = path.join(UPLOAD_DIR, file.filename);

        // Record in database
        const result = await req.db.query(
            `INSERT INTO card_attachments (card_id, user_id, filename, original_filename, mime_type, size_bytes)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [cardId, userId, file.filename, file.originalname, file.mimetype, file.size]
        );

        const attachment = result.rows[0];

        logAttachmentActivity(req.db, cardId, userId, 'document_added', {
            filename: file.originalname,
            attachment_id: attachment.id,
        });

        audit(req.db, 'card_attachment_upload', userId, req.ip, {
            card_id: cardId,
            filename: file.originalname,
            size_bytes: file.size,
        });

        res.status(201).json({ ...attachment, download_url: `/uploads/${file.filename}` });
    } catch (err) {
        console.error('Attachment upload error:', err);
        res.status(500).json({ error: 'Server error uploading attachment' });
    }
});

// ---------------------------------------------------------------------------
// GET /api/cards/:id/attachments  — list attachments on a card
// ---------------------------------------------------------------------------
router.get('/:id/attachments', async (req, res) => {
    const { id: userId, role } = req.user;

    try {
        const cardResult = await req.db.query('SELECT * FROM cards WHERE id = $1', [req.params.id]);
        const card = cardResult.rows[0];
        if (!card) return res.status(404).json({ error: 'Card not found' });
        if (!canView(card, userId, role)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const result = await req.db.query(
            `SELECT ca.*, u.username AS uploaded_by
             FROM card_attachments ca
             LEFT JOIN users u ON u.id = ca.user_id
             WHERE ca.card_id = $1
             ORDER BY ca.created_at ASC`,
            [req.params.id]
        );

        // Add download_url to each row
        const rows = result.rows.map(r => ({ ...r, download_url: `/uploads/${r.filename}` }));
        res.json(rows);
    } catch (err) {
        console.error('Attachments fetch error:', err);
        res.status(500).json({ error: 'Server error fetching attachments' });
    }
});

// ---------------------------------------------------------------------------
// DELETE /api/cards/:id/attachments/:aid  — remove an attachment (uploader or admin)
// ---------------------------------------------------------------------------
router.delete('/:id/attachments/:aid', async (req, res) => {
    const { id: userId, role } = req.user;

    try {
        // Fetch the attachment record
        const attResult = await req.db.query(
            'SELECT * FROM card_attachments WHERE id = $1 AND card_id = $2',
            [req.params.aid, req.params.id]
        );
        const att = attResult.rows[0];
        if (!att) return res.status(404).json({ error: 'Attachment not found' });

        // Check card access
        const cardResult = await req.db.query('SELECT * FROM cards WHERE id = $1', [req.params.id]);
        const card = cardResult.rows[0];
        if (!card) return res.status(404).json({ error: 'Card not found' });

        // Authorizer: uploader, assignee, owner, or admin
        const canDelete = role === 'admin'
            || card.owner_id === userId
            || att.user_id === userId;
        if (!canDelete) {
            return res.status(403).json({ error: 'Only the uploader, card owner, or an admin can remove this attachment' });
        }

        // Delete physical file
        try {
            const filePath = path.join(UPLOAD_DIR, att.filename);
            await fs.unlink(filePath);
        } catch (fileErr) {
            console.error('File unlink warning:', fileErr.message);
        }

        // Delete DB record
        await req.db.query('DELETE FROM card_attachments WHERE id = $1', [req.params.aid]);

        logAttachmentActivity(req.db, req.params.id, userId, 'document_removed', {
            filename: att.original_filename,
            attachment_id: att.id,
        });

        res.json({ success: true });
    } catch (err) {
        console.error('Attachment delete error:', err);
        res.status(500).json({ error: 'Server error deleting attachment' });
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

// ===========================================================================
// CLONING
// ===========================================================================

// ---------------------------------------------------------------------------
// POST /api/cards/:id/clone  — duplicate a card with all metadata and tags
// ---------------------------------------------------------------------------
router.post('/:id/clone', async (req, res) => {
    const { id: userId, role } = req.user;

    try {
        // Fetch source card
        const srcResult = await req.db.query('SELECT * FROM cards WHERE id = $1', [req.params.id]);
        const srcCard = srcResult.rows[0];
        if (!srcCard) return res.status(404).json({ error: 'Source card not found' });

        // Visibility check on source
        if (!canView(srcCard, userId, role)) {
            return res.status(403).json({ error: 'Access denied to source card' });
        }

        // Verify the target column exists (clone stays in same column)
        const colCheck = await req.db.query('SELECT id, name, wip_limit FROM columns WHERE id = $1', [srcCard.column_id]);
        if (!colCheck.rows[0]) {
            return res.status(404).json({ error: 'Target column not found' });
        }

        // Enforce WIP limit
        if (colCheck.rows[0].wip_limit !== null) {
            const wipCheck = await req.db.query(
                'SELECT COUNT(*) AS cnt FROM cards WHERE column_id = $1',
                [srcCard.column_id]
            );
            if (parseInt(wipCheck.rows[0].cnt, 10) >= colCheck.rows[0].wip_limit) {
                return res.status(409).json({ error: `Column WIP limit (${colCheck.rows[0].wip_limit}) reached` });
            }
        }

        // Determine position at end of column
        const maxPos = await req.db.query(
            'SELECT COALESCE(MAX(position_in_column), -1) + 1 AS next_pos FROM cards WHERE column_id = $1',
            [srcCard.column_id]
        );
        const pos = maxPos.rows[0].next_pos;

        // Create cloned card
        const cloneTitle = `Clone of: ${srcCard.title}`;
        const result = await req.db.query(
            `INSERT INTO cards
               (title, description, priority, column_id, position_in_column,
                owner_id, assignee_id, visibility, due_date)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING *`,
            [
                cloneTitle,
                srcCard.description || '',
                srcCard.priority    || 'medium',
                srcCard.column_id,
                pos,
                userId,       // cloner becomes owner
                srcCard.assignee_id,
                srcCard.visibility || 'public',
                srcCard.due_date,
            ]
        );

        const clone = result.rows[0];

        // Copy tags from source card to clone (if tag system tables exist)
        try {
            const tagsResult = await req.db.query(
                `SELECT ct.id AS tag_id FROM card_tag_map ctm
                 JOIN card_tags ct ON ct.id = ctm.tag_id
                 WHERE ctm.card_id = $1`,
                [srcCard.id]
            );
            for (const { tag_id } of tagsResult.rows) {
                await req.db.query(
                    `INSERT INTO card_tag_map (card_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                    [clone.id, tag_id]
                );
            }
        } catch (tagErr) {
            // Tag tables might not exist yet — non-fatal
            console.debug('Card clone: tag copy skipped:', tagErr.message);
        }

        // Log activity on both source and clone
        logActivity(req.db, srcCard.id, userId, 'cloned', { cloned_card_id: clone.id });
        logActivity(req.db, clone.id, userId, 'created', { from_clone_of: srcCard.id, column: colCheck.rows[0].name });

        audit(req.db, 'card_clone', userId, req.ip, { source_id: srcCard.id, cloned_id: clone.id });

        // Return the new card with is_overdue
        const enrichedClone = { ...clone };
        if (enrichedClone.due_date) {
            enrichedClone.is_overdue = new Date(enrichedClone.due_date) < new Date();
        } else {
            enrichedClone.is_overdue = false;
        }

        res.status(201).json(enrichedClone);
    } catch (err) {
        console.error('Card clone error:', err);
        res.status(500).json({ error: 'Server error cloning card' });
    }
});

// ===========================================================================
// BULK OPERATIONS
// ===========================================================================

// ---------------------------------------------------------------------------
// PATCH /api/cards/bulk/move  — move multiple cards to a column at once
// Body: { card_ids: [uuid...], column_id: number }
// ---------------------------------------------------------------------------
router.patch('/bulk/move', async (req, res) => {
    const { id: userId, role } = req.user;
    const { card_ids, column_id } = req.body;

    if (!Array.isArray(card_ids) || card_ids.length === 0) {
        return res.status(400).json({ error: 'card_ids must be a non-empty array' });
    }
    if (column_id === undefined) {
        return res.status(400).json({ error: 'column_id is required' });
    }

    try {
        // Verify target column exists
        const colCheck = await req.db.query('SELECT id, name, wip_limit FROM columns WHERE id = $1', [column_id]);
        if (!colCheck.rows[0]) {
            return res.status(404).json({ error: 'Target column not found' });
        }

        // Fetch source cards
        const cardsResult = await req.db.query(
            'SELECT id, owner_id, visibility FROM cards WHERE id = ANY($1)',
            [card_ids]
        );

        if (cardsResult.rows.length !== card_ids.length) {
            const foundIds = new Set(cardsResult.rows.map(r => String(r.id)));
            const missing = card_ids.filter(id => !foundIds.has(String(id)));
            return res.status(404).json({ error: `Cards not found: ${missing.join(', ')}` });
        }

        // Check access (owner or admin for each)
        const inaccessible = cardsResult.rows.filter(c => role !== 'admin' && c.owner_id !== userId);
        if (inaccessible.length > 0) {
            return res.status(403).json({ error: `Access denied for ${inaccessible.length} card(s)` });
        }

        // Get next position in target column
        const maxPos = await req.db.query(
            'SELECT COALESCE(MAX(position_in_column), -1) + 1 AS next_pos FROM cards WHERE column_id = $1',
            [column_id]
        );

        let pos = maxPos.rows[0].next_pos;
        const movedCards = [];

        for (const card of cardsResult.rows) {
            await req.db.query(
                `UPDATE cards SET column_id = $1, position_in_column = $2, updated_at = NOW() WHERE id = $3`,
                [column_id, pos, card.id]
            );
            movedCards.push({ id: card.id, new_position: pos });
            pos++;
        }

        logActivity(req.db, movedCards[0].id, userId, 'bulk_moved', {
            column_id,
            cards_count: movedCards.length,
        });

        audit(req.db, 'card_bulk_move', userId, req.ip, { card_ids, column_id });

        res.json({ success: true, moved: movedCards.length });
    } catch (err) {
        console.error('Bulk move error:', err);
        res.status(500).json({ error: 'Server error during bulk move' });
    }
});

// ---------------------------------------------------------------------------
// PATCH /api/cards/bulk/assign  — reassign multiple cards to a new assignee
// Body: { card_ids: [uuid...], assignee_id: number|null }
// ---------------------------------------------------------------------------
router.patch('/bulk/assign', async (req, res) => {
    const { id: userId, role } = req.user;
    const { card_ids, assignee_id } = req.body;

    if (!Array.isArray(card_ids) || card_ids.length === 0) {
        return res.status(400).json({ error: 'card_ids must be a non-empty array' });
    }
    if (assignee_id === undefined) {
        return res.status(400).json({ error: 'assignee_id is required (pass null to unassign)' });
    }

    try {
        // Resolve assignee_username to id if provided via body
        let resolvedAssigneeId = assignee_id;
        const { assignee_username } = req.body;
        if (assignee_username && !resolvedAssigneeId) {
            const userCheck = await req.db.query('SELECT id FROM users WHERE username = $1', [assignee_username.trim()]);
            if (userCheck.rows[0]) {
                resolvedAssigneeId = userCheck.rows[0].id;
            }
        }

        // Fetch source cards
        const cardsResult = await req.db.query(
            'SELECT id, owner_id, visibility FROM cards WHERE id = ANY($1)',
            [card_ids]
        );

        if (cardsResult.rows.length !== card_ids.length) {
            const foundIds = new Set(cardsResult.rows.map(r => String(r.id)));
            const missing = card_ids.filter(id => !foundIds.has(String(id)));
            return res.status(404).json({ error: `Cards not found: ${missing.join(', ')}` });
        }

        // Check access
        const inaccessible = cardsResult.rows.filter(c => role !== 'admin' && c.owner_id !== userId);
        if (inaccessible.length > 0) {
            return res.status(403).json({ error: `Access denied for ${inaccessible.length} card(s)` });
        }

        const updatedCards = [];
        for (const card of cardsResult.rows) {
            await req.db.query(
                `UPDATE cards SET assignee_id = $1, updated_at = NOW() WHERE id = $2`,
                [resolvedAssigneeId || null, card.id]
            );
            updatedCards.push(card.id);
            logActivity(req.db, card.id, userId, 'bulk_assigned', { new_assignee_id: resolvedAssigneeId });
        }

        audit(req.db, 'card_bulk_assign', userId, req.ip, { card_ids, assignee_id: resolvedAssigneeId });

        res.json({ success: true, updated: updatedCards.length });
    } catch (err) {
        console.error('Bulk assign error:', err);
        res.status(500).json({ error: 'Server error during bulk assign' });
    }
});

// ---------------------------------------------------------------------------
// DELETE /api/cards/bulk  — delete selected cards in one call
// Body: { card_ids: [uuid...] }
// ---------------------------------------------------------------------------
router.delete('/bulk', async (req, res) => {
    const { id: userId, role } = req.user;
    const { card_ids } = req.body;

    if (!Array.isArray(card_ids) || card_ids.length === 0) {
        return res.status(400).json({ error: 'card_ids must be a non-empty array' });
    }

    try {
        // Fetch source cards for access check + title collection
        const cardsResult = await req.db.query(
            'SELECT id, owner_id, visibility, title FROM cards WHERE id = ANY($1)',
            [card_ids]
        );

        if (cardsResult.rows.length !== card_ids.length) {
            const foundIds = new Set(cardsResult.rows.map(r => String(r.id)));
            const missing = card_ids.filter(id => !foundIds.has(String(id)));
            return res.status(404).json({ error: `Cards not found: ${missing.join(', ')}` });
        }

        // Check access (owner or admin for each)
        const inaccessible = cardsResult.rows.filter(c => role !== 'admin' && c.owner_id !== userId);
        if (inaccessible.length > 0) {
            return res.status(403).json({ error: `Access denied for ${inaccessible.length} card(s)` });
        }

        await req.db.query('DELETE FROM cards WHERE id = ANY($1)', [card_ids]);

        audit(req.db, 'card_bulk_delete', userId, req.ip, { card_ids, count: cardsResult.rows.length });

        res.json({ success: true, deleted: cardsResult.rows.length });
    } catch (err) {
        console.error('Bulk delete error:', err);
        res.status(500).json({ error: 'Server error during bulk delete' });
    }
});

// ===========================================================================
// TAG ENDPOINTS
// ===========================================================================

// ---------------------------------------------------------------------------
// GET /api/cards/tags  — list all distinct tags in use (alphabetical)
// Note: must be registered BEFORE any :id parametric routes.
// It is already placed before this block; the route '/tags' will match literally.
// ---------------------------------------------------------------------------
router.get('/tags', async (req, res) => {
    try {
        const result = await req.db.query(
            `SELECT ct.id, ct.name, ct.slug, COUNT(ctm.card_id) AS card_count
             FROM card_tags ct
             INNER JOIN card_tag_map ctm ON ctm.tag_id = ct.id
             GROUP BY ct.id, ct.name, ct.slug
             ORDER BY ct.name ASC`
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Tags list error:', err);
        res.status(500).json({ error: 'Server error fetching tags' });
    }
});

// ---------------------------------------------------------------------------
// POST /api/cards/:id/tags  — add tag slugs to a card (upserts into card_tags)
// Body: { tags: ['bug', 'feature'] }
// ---------------------------------------------------------------------------
router.post('/:id/tags', async (req, res) => {
    const { id: userId, role } = req.user;
    const { tags } = req.body;

    if (!Array.isArray(tags) || tags.length === 0) {
        return res.status(400).json({ error: 'tags must be a non-empty array of strings' });
    }

    try {
        // Verify card exists and user can access it
        const cardResult = await req.db.query('SELECT * FROM cards WHERE id = $1', [req.params.id]);
        const card = cardResult.rows[0];
        if (!card) return res.status(404).json({ error: 'Card not found' });
        if (!canView(card, userId, role)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        // Normalize slugs (lowercase, trimmed)
        const normalizedTags = tags.map(t => String(t).toLowerCase().trim());
        if (!normalizedTags.every(t => t.length > 0)) {
            return res.status(400).json({ error: 'Each tag must be a non-empty string' });
        }

        // Upsert tags into card_tags table, then map them to the card
        const addedTagIds = [];
        for (const slug of normalizedTags) {
            const name = slug.charAt(0).toUpperCase() + slug.slice(1);  // capitalize first letter for display
            const tagResult = await req.db.query(
                `INSERT INTO card_tags (name, slug) VALUES ($1, $2) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
                [name, slug]
            );
            addedTagIds.push(tagResult.rows[0].id);
        }

        // Map tags to card (ON CONFLICT handles duplicates silently)
        for (const tagId of addedTagIds) {
            await req.db.query(
                `INSERT INTO card_tag_map (card_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                [req.params.id, tagId]
            );
        }

        // Fetch updated tags for this card
        const currentTags = await req.db.query(
            `SELECT ct.* FROM card_tag_map ctm
             JOIN card_tags ct ON ct.id = ctm.tag_id
             WHERE ctm.card_id = $1 ORDER BY ct.name`,
            [req.params.id]
        );

        logActivity(req.db, req.params.id, userId, 'tags_added', { tags: normalizedTags });

        res.json({ success: true, tags: currentTags.rows });
    } catch (err) {
        console.error('Card add tags error:', err);
        res.status(500).json({ error: 'Server error adding tags' });
    }
});

// ---------------------------------------------------------------------------
// DELETE /api/cards/:id/tags/:tagId  — remove a specific tag from a card
// ---------------------------------------------------------------------------
router.delete('/:id/tags/:tagId', async (req, res) => {
    const { id: userId, role } = req.user;

    try {
        // Verify card exists and user can access it
        const cardResult = await req.db.query('SELECT * FROM cards WHERE id = $1', [req.params.id]);
        const card = cardResult.rows[0];
        if (!card) return res.status(404).json({ error: 'Card not found' });
        if (!canView(card, userId, role)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        // Check tag exists and is mapped to this card
        const mapResult = await req.db.query(
            `SELECT ct.id, ct.name, ct.slug FROM card_tag_map ctm
             JOIN card_tags ct ON ct.id = ctm.tag_id
             WHERE ctm.card_id = $1 AND ctm.tag_id = $2`,
            [req.params.id, parseInt(req.params.tagId, 10)]
        );

        if (!mapResult.rows[0]) {
            return res.status(404).json({ error: 'Tag not found on this card' });
        }

        const removedTag = mapResult.rows[0];

        await req.db.query('DELETE FROM card_tag_map WHERE card_id = $1 AND tag_id = $2', [req.params.id, parseInt(req.params.tagId, 10)]);

        logActivity(req.db, req.params.id, userId, 'tag_removed', { tag: removedTag.slug });

        res.json({ success: true, removed_tag: removedTag });
    } catch (err) {
        console.error('Card remove tag error:', err);
        res.status(500).json({ error: 'Server error removing tag' });
    }
});

export default router;
