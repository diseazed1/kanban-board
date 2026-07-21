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
                    CASE WHEN c.due_date IS NOT NULL AND c.due_date < NOW() THEN true ELSE false END AS is_overdue,
                    COALESCE((
                        SELECT json_agg(ct.name) 
                        FROM card_tag_map ctm 
                        INNER JOIN card_tags ct ON ct.id = ctm.tag_id 
                        WHERE ctm.card_id = c.id
                    ), '[]') AS tags
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

        // Log activity with structured diff
        logActivity(req.db, newCard.id, req.user.id, 'created', {
            column: colCheck.rows[0].name,
        });

        audit(req.db, 'card_create', req.user.id, req.ip, { card_id: newCard.id, title });

        // Dispatch webhook event (fire-and-forget)
        dispatchWebhookEvent(req.db, 'card.created', {
            event: 'card.created',
            timestamp: new Date().toISOString(),
            card: { id: newCard.id, title },
            user_id: req.user.id,
            column: colCheck.rows[0].name,
        }).catch(() => {});

        // Dispatch email notification (fire-and-forget)
        notifyCardEvent(req.db, 'card.created', newCard.id, {
            actorId: req.user.id,
        }).catch(() => {});

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

        // Log specific activity events with structured before/after diff
        const changedFields = [];
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
            // Structured diff
            await req.db.query(
                `UPDATE card_activity SET field_changed = 'column_id',
                                         old_value = $1::jsonb,
                                         new_value = $2::jsonb
                 WHERE card_id = $3 AND action = 'moved'
                   AND details->>'from_column' = $4
                   AND created_at >= NOW() - INTERVAL '1 second'`,
                [JSON.stringify(card.column_id), JSON.stringify(updates.column_id), card.id,
                 colMap[card.column_id] || `Column ${card.column_id}`]
            ).catch(() => {});
            changedFields.push('column');
        }
        if ('priority' in updates && updates.priority !== card.priority) {
            logActivity(req.db, card.id, userId, 'priority_changed', {
                from: card.priority,
                to:   updates.priority,
            });
            // Structured diff
            await req.db.query(
                `UPDATE card_activity SET field_changed = 'priority',
                                         old_value = $1::jsonb,
                                         new_value = $2::jsonb
                 WHERE card_id = $3 AND action = 'priority_changed'
                   AND details->>'from' = $4
                   AND created_at >= NOW() - INTERVAL '1 second'`,
                [JSON.stringify(card.priority), JSON.stringify(updates.priority), card.id, card.priority]
            ).catch(() => {});
            changedFields.push('priority');
        }
        if ('visibility' in updates && updates.visibility !== card.visibility) {
            logActivity(req.db, card.id, userId, 'visibility_changed', {
                from: card.visibility,
                to:   updates.visibility,
            });
            // Structured diff
            await req.db.query(
                `UPDATE card_activity SET field_changed = 'visibility',
                                         old_value = $1::jsonb,
                                         new_value = $2::jsonb
                 WHERE card_id = $3 AND action = 'visibility_changed'
                   AND details->>'from' = $4
                   AND created_at >= NOW() - INTERVAL '1 second'`,
                [JSON.stringify(card.visibility), JSON.stringify(updates.visibility), card.id, card.visibility]
            ).catch(() => {});
            changedFields.push('visibility');
        }
        if ('title' in updates && updates.title !== card.title) {
            logActivity(req.db, card.id, userId, 'edited', {
                field: 'title',
                from:  card.title,
                to:    updates.title,
            });
            // Structured diff
            await req.db.query(
                `UPDATE card_activity SET field_changed = 'title',
                                         old_value = $1::jsonb,
                                         new_value = $2::jsonb
                 WHERE card_id = $3 AND action = 'edited'
                   AND details->>'from' = $4
                   AND created_at >= NOW() - INTERVAL '1 second'`,
                [JSON.stringify(card.title), JSON.stringify(updates.title), card.id, card.title]
            ).catch(() => {});
            changedFields.push('title');
        }
        if ('assignee_id' in updates && String(updates.assignee_id || '') !== String(card.assignee_id || '')) {
            logActivity(req.db, card.id, userId, 'assigned', {
                from: card.assignee_id,
                to:   resolvedAssigneeId,
            });
            // Structured diff
            await req.db.query(
                `UPDATE card_activity SET field_changed = 'assignee_id',
                                         old_value = $1::jsonb,
                                         new_value = $2::jsonb
                 WHERE card_id = $3 AND action = 'assigned'
                   AND created_at >= NOW() - INTERVAL '1 second'`,
                [JSON.stringify(card.assignee_id), JSON.stringify(resolvedAssigneeId), card.id]
            ).catch(() => {});
            changedFields.push('assignee');

            // Email notification for assignee change
            if (resolvedAssigneeId) {
                notifyCardEvent(req.db, 'card.assigned', card.id, {
                    actorId: userId,
                    assignee_id: resolvedAssigneeId,
                }).catch(() => {});
            }
        }
        if ('due_date' in updates && String(updates.due_date || '') !== String(card.due_date || '')) {
            logActivity(req.db, card.id, userId, 'edited', {
                field: 'due_date',
                from:  card.due_date,
                to:    parsedDueDate,
            });
            await req.db.query(
                `UPDATE card_activity SET field_changed = 'due_date',
                                         old_value = $1::jsonb,
                                         new_value = $2::jsonb
                 WHERE card_id = $3 AND action = 'edited'
                   AND details->>'field' = 'due_date'
                   AND created_at >= NOW() - INTERVAL '1 second'`,
                [JSON.stringify(card.due_date), JSON.stringify(parsedDueDate), card.id]
            ).catch(() => {});
        }

        // Dispatch webhook event if anything changed meaningfully
        if (changedFields.length > 0) {
            dispatchWebhookEvent(req.db, 'card.updated', {
                event: 'card.updated',
                timestamp: new Date().toISOString(),
                card: { id: updatedCard.id, title: updatedCard.title },
                user_id: userId,
                changed_fields: changedFields,
            }).catch(() => {});

            // Email notification for card updates
            notifyCardEvent(req.db, 'card.updated', card.id, {
                actorId: userId,
            }).catch(() => {});
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

            // Dispatch webhook + email for move events
            dispatchWebhookEvent(req.db, 'card.moved', {
                event: 'card.moved',
                timestamp: new Date().toISOString(),
                card: { id: card.id },
                user_id: userId,
                from_column: colMap[oldColumnId] || `Column ${oldColumnId}`,
                to_column:   colMap[newColumnId] || `Column ${newColumnId}`,
            }).catch(() => {});

            notifyCardEvent(req.db, 'card.moved', card.id, {
                actorId: userId,
                from_column: colMap[oldColumnId],
                to_column:   colMap[newColumnId],
            }).catch(() => {});
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

        // Dispatch webhook for deletion
        dispatchWebhookEvent(req.db, 'card.deleted', {
            event: 'card.deleted',
            timestamp: new Date().toISOString(),
            card: { id: req.params.id, title: card.title },
            user_id: userId,
        }).catch(() => {});

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

        // Dispatch webhook + email for comments
        dispatchWebhookEvent(req.db, 'comment.added', {
            event: 'comment.added',
            timestamp: new Date().toISOString(),
            card_id: req.params.id,
            comment_id: comment.id,
            user_id: userId,
            body: body.trim().substring(0, 500),
        }).catch(() => {});

        notifyCardEvent(req.db, 'comment.added', req.params.id, {
            actorId: userId,
        }).catch(() => {});

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
// GET /api/cards/:id/activity  — card activity timeline (with structured diff)
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

        // Return activity with structured before/after diff fields
        const result = await req.db.query(
            `SELECT ca.id,
                    ca.card_id,
                    ca.user_id,
                    ca.action,
                    ca.details,
                    ca.field_changed,
                    ca.old_value,
                    ca.new_value,
                    ca.created_at,
                    u.username
             FROM card_activity ca
             LEFT JOIN users u ON u.id = ca.user_id
             WHERE ca.card_id = $1
             ORDER BY ca.created_at DESC
             LIMIT 100`,
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

        // Dispatch webhook for bulk action
        dispatchWebhookEvent(req.db, 'bulk.action', {
            event: 'bulk.action',
            action_type: 'move',
            timestamp: new Date().toISOString(),
            user_id: userId,
            card_ids,
            column_id,
        }).catch(() => {});

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
// GET /api/cards/:id/tags  — list tags on a specific card
// (Must be placed before the generic :id/:param routes like tags/:tagId)
// ===========================================================================
router.get('/:id/tags', async (req, res) => {
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
            `SELECT ct.* FROM card_tag_map ctm
             JOIN card_tags ct ON ct.id = ctm.tag_id
             WHERE ctm.card_id = $1 ORDER BY ct.name`,
            [req.params.id]
        );

        res.json(result.rows);
    } catch (err) {
        console.error('Card tags fetch error:', err);
        res.status(500).json({ error: 'Server error fetching card tags' });
    }
});

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

        // Dispatch webhook for tag events
        dispatchWebhookEvent(req.db, 'tag.added', {
            event: 'tag.added',
            timestamp: new Date().toISOString(),
            card_id: req.params.id,
            user_id: userId,
            tags: normalizedTags,
        }).catch(() => {});

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

        // Dispatch webhook for tag removal
        dispatchWebhookEvent(req.db, 'tag.removed', {
            event: 'tag.removed',
            timestamp: new Date().toISOString(),
            card_id: req.params.id,
            user_id: userId,
            tag: removedTag.slug,
        }).catch(() => {});

        res.json({ success: true, removed_tag: removedTag });
    } catch (err) {
        console.error('Card remove tag error:', err);
        res.status(500).json({ error: 'Server error removing tag' });
    }
});

// ===========================================================================
// SUBTASKS / CHECKLIST ITEMS
// ===========================================================================

// ---------------------------------------------------------------------------
// GET /api/cards/:id/subtasks  — list subtasks for a card
// ---------------------------------------------------------------------------
router.get('/:id/subtasks', async (req, res) => {
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
            `SELECT cs.*,
                    cr.username AS created_by_username,
                    cb.username AS completed_by_username
             FROM card_subtasks cs
             LEFT JOIN users cr ON cr.id = cs.created_by
             LEFT JOIN users cb ON cb.id = cs.completed_by
             WHERE cs.card_id = $1
             ORDER BY cs.position ASC, cs.id ASC`,
            [req.params.id]
        );

        res.json(result.rows);
    } catch (err) {
        console.error('Subtasks fetch error:', err);
        res.status(500).json({ error: 'Server error fetching subtasks' });
    }
});

// ---------------------------------------------------------------------------
// POST /api/cards/:id/subtasks  — create a subtask
// Body: { title, position? }
// ---------------------------------------------------------------------------
router.post('/:id/subtasks', async (req, res) => {
    const { id: userId, role } = req.user;
    const { title, position } = req.body;

    if (!title?.trim()) {
        return res.status(400).json({ error: 'Subtask title is required' });
    }

    try {
        // Verify card exists and user can access it
        const cardResult = await req.db.query('SELECT * FROM cards WHERE id = $1', [req.params.id]);
        const card = cardResult.rows[0];
        if (!card) return res.status(404).json({ error: 'Card not found' });
        if (!canView(card, userId, role)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        // Determine position — append at end if not provided
        let pos = position;
        if (pos === undefined || pos === null) {
            const maxPos = await req.db.query(
                'SELECT COALESCE(MAX(position), -1) + 1 AS next_pos FROM card_subtasks WHERE card_id = $1',
                [req.params.id]
            );
            pos = maxPos.rows[0].next_pos;
        }

        const result = await req.db.query(
            `INSERT INTO card_subtasks (card_id, title, position, created_by)
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [req.params.id, title.trim(), pos, userId]
        );

        const subtask = result.rows[0];
        logActivity(req.db, req.params.id, userId, 'subtask_added', {
            subtask_id: subtask.id,
            title: subtask.title,
        });

        res.status(201).json(subtask);
    } catch (err) {
        console.error('Subtask create error:', err);
        res.status(500).json({ error: 'Server error creating subtask' });
    }
});

// ---------------------------------------------------------------------------
// PUT /api/cards/:id/subtasks/:subtaskId  — update a subtask (title/completed/position)
// ---------------------------------------------------------------------------
router.put('/:id/subtasks/:subtaskId', async (req, res) => {
    const { id: userId, role } = req.user;

    try {
        // Verify card access
        const cardResult = await req.db.query('SELECT * FROM cards WHERE id = $1', [req.params.id]);
        const card = cardResult.rows[0];
        if (!card) return res.status(404).json({ error: 'Card not found' });
        if (!canView(card, userId, role)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        // Fetch existing subtask (snapshot for diff)
        const subResult = await req.db.query(
            'SELECT * FROM card_subtasks WHERE id = $1 AND card_id = $2',
            [parseInt(req.params.subtaskId, 10), req.params.id]
        );
        const subtask = subResult.rows[0];
        if (!subtask) return res.status(404).json({ error: 'Subtask not found' });

        const updates = req.body;
        const fields = [];
        const values = [];
        let idx = 1;

        if ('title' in updates && updates.title?.trim()) {
            fields.push(`title = $${idx++}`);
            values.push(updates.title.trim());
        }
        if ('completed' in updates) {
            const oldCompleted = subtask.completed;
            const newCompleted = Boolean(updates.completed);
            fields.push(`completed = $${idx++}`);
            values.push(newCompleted);

            // Log completion event with structured diff
            logActivity(req.db, req.params.id, userId,
                newCompleted ? 'subtask_completed' : 'subtask_unchecked',
                {
                    subtask_id: subtask.id,
                    title: subtask.title,
                }
            );

            // Structured before/after diff on the activity row
            await req.db.query(
                `UPDATE card_activity SET field_changed = 'completed',
                                         old_value = $1::jsonb,
                                         new_value = $2::jsonb
                 WHERE card_id = $3 AND action IN ('subtask_completed', 'subtask_unchecked')
                   AND details->>'subtask_id' = $4
                   AND created_at >= NOW() - INTERVAL '1 second'`,
                [JSON.stringify(oldCompleted), JSON.stringify(newCompleted), req.params.id, String(subtask.id)]
            ).catch(() => {});
        }
        if ('position' in updates) {
            fields.push(`position = $${idx++}`);
            values.push(parseInt(updates.position, 10));
        }

        // Also track title changes with structured diff
        if ('title' in updates && updates.title?.trim() && updates.title.trim() !== subtask.title) {
            logActivity(req.db, req.params.id, userId, 'subtask_edited', {
                subtask_id: subtask.id,
                field: 'title',
            });

            // Defer structured diff to a follow-up query after insert
        }

        if (fields.length === 0) {
            return res.status(400).json({ error: 'No valid fields provided for update' });
        }

        fields.push(`updated_at = NOW()`);
        values.push(req.params.id);
        values.push(parseInt(req.params.subtaskId, 10));

        const result = await req.db.query(
            `UPDATE card_subtasks SET ${fields.join(', ')} WHERE id = $${idx + 1} AND card_id = $${idx} RETURNING *`,
            values
        );

        // Add structured diff for title changes
        if ('title' in updates && updates.title?.trim() && updates.title.trim() !== subtask.title) {
            await req.db.query(
                `UPDATE card_activity SET field_changed = 'subtask_title',
                                         old_value = $1::jsonb,
                                         new_value = $2::jsonb
                 WHERE card_id = $3 AND action = 'subtask_edited'
                   AND details->>'subtask_id' = $4
                   AND created_at >= NOW() - INTERVAL '1 second'`,
                [JSON.stringify(subtask.title), JSON.stringify(updates.title.trim()), req.params.id, String(subtask.id)]
            ).catch(() => {});
        }

        const updatedSubtask = result.rows[0];
        res.json(updatedSubtask);
    } catch (err) {
        console.error('Subtask update error:', err);
        res.status(500).json({ error: 'Server error updating subtask' });
    }
});

// ---------------------------------------------------------------------------
// DELETE /api/cards/:id/subtasks/:subtaskId  — remove a subtask
// ---------------------------------------------------------------------------
router.delete('/:id/subtasks/:subtaskId', async (req, res) => {
    const { id: userId, role } = req.user;

    try {
        // Verify card access
        const cardResult = await req.db.query('SELECT * FROM cards WHERE id = $1', [req.params.id]);
        const card = cardResult.rows[0];
        if (!card) return res.status(404).json({ error: 'Card not found' });
        if (!canView(card, userId, role)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const subResult = await req.db.query(
            'SELECT * FROM card_subtasks WHERE id = $1 AND card_id = $2',
            [parseInt(req.params.subtaskId, 10), req.params.id]
        );
        const subtask = subResult.rows[0];
        if (!subtask) return res.status(404).json({ error: 'Subtask not found' });

        await req.db.query('DELETE FROM card_subtasks WHERE id = $1', [parseInt(req.params.subtaskId, 10)]);

        logActivity(req.db, req.params.id, userId, 'subtask_removed', {
            subtask_id: subtask.id,
            title: subtask.title,
        });

        res.json({ success: true });
    } catch (err) {
        console.error('Subtask delete error:', err);
        res.status(500).json({ error: 'Server error deleting subtask' });
    }
});

// ===========================================================================
// WEBHOOK INTEGRATIONS
// ===========================================================================

const crypto = await import('crypto');

// Use native fetch (Node 18+) or fallback to node-fetch if available
let globalFetch;
try {
    const nf = await import('node-fetch');
    globalFetch = nf.default || nf.fetch;
} catch (_) {
    // Node.js v18+ has built-in globalThis.fetch
    globalFetch = globalThis.fetch.bind(globalThis);
}

// ---------------------------------------------------------------------------
// GET /api/cards/webhooks  — list all active webhooks (admin + creators)
// ---------------------------------------------------------------------------
router.get('/webhooks', async (req, res) => {
    const { id: userId, role } = req.user;

    try {
        let whereClause = 'TRUE';
        const params = [];
        if (role !== 'admin') {
            whereClause = 'created_by = $1 OR active = FALSE';
            params.push(userId);
        }

        const result = await req.db.query(
            `SELECT * FROM webhooks WHERE ${whereClause} ORDER BY created_at DESC`,
            params
        );

        res.json(result.rows);
    } catch (err) {
        console.error('Webhooks list error:', err);
        res.status(500).json({ error: 'Server error fetching webhooks' });
    }
});

// ---------------------------------------------------------------------------
// POST /api/cards/webhooks  — register a new webhook endpoint (admin only)
// Body: { name, url, events[], secret? }
// ---------------------------------------------------------------------------
router.post('/webhooks', async (req, res) => {
    const { id: userId, role } = req.user;
    const { name, url, events, secret } = req.body;

    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
    if (!url?.trim()) return res.status(400).json({ error: 'url is required' });
    if (!Array.isArray(events) || events.length === 0) {
        return res.status(400).json({ error: 'events must be a non-empty array' });
    }

    const VALID_EVENTS = new Set([
        'card.created', 'card.updated', 'card.deleted', 'card.moved',
        'card.subtask_completed', 'card.due_reminder', 'comment.added',
        'tag.added', 'tag.removed', 'bulk.action'
    ]);

    const invalidEvents = events.filter(e => !VALID_EVENTS.has(e));
    if (invalidEvents.length) {
        return res.status(400).json({ error: `Invalid event(s): ${invalidEvents.join(', ')}`, valid_events: [...VALID_EVENTS] });
    }

    try {
        const result = await req.db.query(
            `INSERT INTO webhooks (name, url, events, secret, created_by)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [name.trim(), url.trim(), events, secret || null, userId]
        );

        audit(req.db, 'webhook_created', userId, req.ip, { webhook_id: result.rows[0].id, name });
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Webhook create error:', err);
        res.status(500).json({ error: 'Server error creating webhook' });
    }
});

// ---------------------------------------------------------------------------
// PUT /api/cards/webhooks/:id  — update a webhook
// ---------------------------------------------------------------------------
router.put('/webhooks/:id', async (req, res) => {
    const { id: userId } = req.user;

    try {
        const whResult = await req.db.query('SELECT * FROM webhooks WHERE id = $1', [parseInt(req.params.id, 10)]);
        const webhook = whResult.rows[0];
        if (!webhook) return res.status(404).json({ error: 'Webhook not found' });

        if (req.user.role !== 'admin' && webhook.created_by !== userId) {
            return res.status(403).json({ error: 'Only the creator or an admin can update this webhook' });
        }

        const updates = req.body;
        const fields = [];
        const values = [];
        let idx = 1;

        if ('name' in updates) { fields.push(`name = $${idx++}`); values.push(updates.name.trim()); }
        if ('url' in updates) { fields.push(`url = $${idx++}`); values.push(updates.url.trim()); }
        if ('events' in updates && Array.isArray(updates.events)) { fields.push(`events = $${idx++}`); values.push(updates.events); }
        if ('secret' in updates) { fields.push(`secret = $${idx++}`); values.push(updates.secret || null); }
        if ('active' in updates) { fields.push(`active = $${idx++}`); values.push(Boolean(updates.active)); }

        if (fields.length === 0) return res.status(400).json({ error: 'No valid fields provided' });

        fields.push(`updated_at = NOW()`);
        values.push(parseInt(req.params.id, 10));

        const result = await req.db.query(
            `UPDATE webhooks SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
            values
        );

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Webhook update error:', err);
        res.status(500).json({ error: 'Server error updating webhook' });
    }
});

// ---------------------------------------------------------------------------
// DELETE /api/cards/webhooks/:id  — remove a webhook (admin or creator)
// ---------------------------------------------------------------------------
router.delete('/webhooks/:id', async (req, res) => {
    const { id: userId } = req.user;

    try {
        const whResult = await req.db.query('SELECT * FROM webhooks WHERE id = $1', [parseInt(req.params.id, 10)]);
        const webhook = whResult.rows[0];
        if (!webhook) return res.status(404).json({ error: 'Webhook not found' });

        if (req.user.role !== 'admin' && webhook.created_by !== userId) {
            return res.status(403).json({ error: 'Only the creator or an admin can delete this webhook' });
        }

        await req.db.query('DELETE FROM webhooks WHERE id = $1', [parseInt(req.params.id, 10)]);

        audit(req.db, 'webhook_deleted', userId, req.ip, { webhook_id: parseInt(req.params.id, 10) });
        res.json({ success: true });
    } catch (err) {
        console.error('Webhook delete error:', err);
        res.status(500).json({ error: 'Server error deleting webhook' });
    }
});

// ---------------------------------------------------------------------------
// POST /api/cards/webhooks/:id/test  — fire a test payload to the webhook URL
// ---------------------------------------------------------------------------
router.post('/webhooks/:id/test', async (req, res) => {
    const { id: userId } = req.user;

    try {
        const whResult = await req.db.query('SELECT * FROM webhooks WHERE id = $1', [parseInt(req.params.id, 10)]);
        const webhook = whResult.rows[0];
        if (!webhook) return res.status(404).json({ error: 'Webhook not found' });

        if (req.user.role !== 'admin' && webhook.created_by !== userId) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const testPayload = {
            event: 'webhook.test',
            webhook_id: webhook.id,
            name: webhook.name,
            timestamp: new Date().toISOString(),
            data: { message: 'Webhook test payload from Kanban Board' },
        };

        const fetchFn = globalFetch;
        let statusCode, responseBody;
        try {
            const response = await fetchFn(webhook.url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Webhook-ID': String(webhook.id),
                    ...(webhook.secret ? {
                        'X-Webhook-Signature': crypto.createHmac('sha256', webhook.secret)
                            .update(JSON.stringify(testPayload)).digest('hex'),
                    } : {}),
                },
                body: JSON.stringify(testPayload),
                signal: AbortSignal.timeout(10000),
            });
            statusCode = response.status;
            responseBody = await response.text().catch(() => '(binary)');
        } catch (fetchErr) {
            statusCode = 'error';
            responseBody = fetchErr.message;
        }

        await req.db.query(
            `UPDATE webhooks SET last_response_code = $1, last_triggered = NOW()
             WHERE id = $2`,
            [statusCode !== 'error' ? statusCode : null, webhook.id]
        );

        res.json({ success: true, status_code: statusCode, response_body: responseBody.substring(0, 500) });
    } catch (err) {
        console.error('Webhook test error:', err);
        res.status(500).json({ error: 'Server error testing webhook' });
    }
});

// ---------------------------------------------------------------------------
// Internal helper: dispatch a webhook event to all matching active webhooks
// Fire-and-forget — does not block the caller.
// ---------------------------------------------------------------------------
const dispatchWebhookEvent = async (db, eventName, payload) => {
    try {
        const result = await db.query(
            `SELECT * FROM webhooks WHERE active = TRUE AND $1 = ANY(events)`,
            [eventName]
        );

        for (const wh of result.rows) {
            (async (webhook, data) => {
                try {
                    const body = JSON.stringify(data);
                    const response = await globalFetch(webhook.url, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Webhook-ID': String(webhook.id),
                            'X-Webhook-Event': eventName,
                            ...(webhook.secret ? {
                                'X-Webhook-Signature': crypto.createHmac('sha256', webhook.secret)
                                    .update(body).digest('hex'),
                            } : {}),
                        },
                        body,
                        signal: AbortSignal.timeout(8000),
                    });

                    await db.query(
                        `UPDATE webhooks SET last_response_code = $1, last_triggered = NOW(), updated_at = NOW()
                         WHERE id = $2`,
                        [response.status, webhook.id]
                    );
                } catch (err) {
                    console.error(`Webhook dispatch failed for ${webhook.name} (#${webhook.id}):`, err.message);
                    await db.query(
                        `UPDATE webhooks SET last_response_code = 0, updated_at = NOW()
                         WHERE id = $1`,
                        [webhook.id]
                    ).catch(() => {});
                }
            })(wh, payload).catch((err) => console.error('Webhook dispatch error:', err));
        }
    } catch (dbErr) {
        // Webhooks table might not exist yet — non-fatal
        if (!dbErr.message.includes('webhooks')) {
            console.error('dispatchWebhookEvent DB error:', dbErr);
        }
    }
};

// ===========================================================================
// BOARD ANALYTICS API (public to authenticated users, enriched for admins)
// ===========================================================================

// ---------------------------------------------------------------------------
// GET /api/cards/analytics  — board-level analytics dashboard data
// Query params: period=daily|weekly|monthly (default: monthly), days=N (default 30)
// ---------------------------------------------------------------------------
router.get('/analytics', async (req, res) => {
    const { id: userId, role } = req.user;
    const days = parseInt(req.query.days || '30', 10);

    try {
        // Cards per column
        const perColumn = await req.db.query(
            `SELECT c.column_id,
                    col.name AS column_name,
                    COUNT(c.id) AS card_count,
                    AVG(CASE WHEN c.due_date < NOW() AND c.due_date IS NOT NULL THEN 1 ELSE 0 END)::INT AS overdue_count
             FROM cards c
             LEFT JOIN columns col ON col.id = c.column_id
             GROUP BY c.column_id, col.name
             ORDER BY col.position`
        );

        // Cards per priority
        const perPriority = await req.db.query(
            `SELECT priority, COUNT(*)::INT AS count FROM cards GROUP BY priority`
        );

        // Due date distribution: overdue, due_this_week, future, no_due
        const dueDist = await req.db.query(
            `SELECT
                 COUNT(CASE WHEN due_date < NOW() THEN 1 END)::INT AS overdue,
                 COUNT(CASE WHEN due_date >= NOW() AND due_date <= NOW() + INTERVAL '7 days' THEN 1 END)::INT AS due_this_week,
                 COUNT(CASE WHEN due_date > NOW() + INTERVAL '7 days' THEN 1 END)::INT AS future,
                 COUNT(CASE WHEN due_date IS NULL THEN 1 END)::INT AS no_due
             FROM cards`
        );

        // Creation rate over the requested period (daily buckets)
        const creationRate = await req.db.query(
            `SELECT DATE(created_at) AS date, COUNT(*)::INT AS created_count
             FROM cards WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
             GROUP BY DATE(created_at) ORDER BY date DESC`,
            [days]
        );

        // Activity heatmap (last N days)
        const activityHeat = await req.db.query(
            `SELECT DATE(created_at) AS date, action,
                    COUNT(*)::INT AS event_count
             FROM card_activity WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
             GROUP BY DATE(created_at), action ORDER BY date DESC`,
            [days]
        );

        // User contribution stats (cards created per user)
        const userStats = await req.db.query(
            `SELECT u.id, u.username,
                    COUNT(c.id)::INT AS cards_created,
                    COUNT(CASE WHEN c.assignee_id IS NOT NULL THEN 1 END)::INT AS cards_assigned
             FROM users u
             LEFT JOIN cards c ON c.owner_id = u.id
             GROUP BY u.id, u.username ORDER BY cards_created DESC`
        );

        // Average cycle time: avg days from creation to moved out of first column (approximation)
        const cycleTime = await req.db.query(
            `SELECT AVG(EXTRACT(EPOCH FROM (MAX(created_at) - MIN(created_at))) / 86400)::NUMERIC(10,2) AS avg_days
             FROM card_activity WHERE action IN ('created', 'moved') GROUP BY card_id`,
            []
        );

        // Completion rate: subtasks completed vs total (if table exists)
        let subtaskStats = { total: 0, completed: 0 };
        try {
            const stResult = await req.db.query(
                `SELECT COUNT(*)::INT AS total,
                        COUNT(CASE WHEN completed THEN 1 END)::INT AS completed
                 FROM card_subtasks`
            );
            subtaskStats = stResult.rows[0];
        } catch (_) { /* table may not exist yet */ }

        res.json({
            period_days: days,
            per_column: perColumn.rows,
            per_priority: perPriority.rows,
            due_distribution: dueDist.rows[0],
            creation_rate: creationRate.rows,
            activity_heatmap: activityHeat.rows,
            user_contributions: userStats.rows,
            avg_cycle_time_days: cycleTime.rows[0]?.avg_days || null,
            subtask_stats: subtaskStats,
        });
    } catch (err) {
        console.error('Analytics fetch error:', err);
        res.status(500).json({ error: 'Server error fetching analytics' });
    }
});

// ===========================================================================
// EMAIL / NOTIFICATION HELPERS
// ===========================================================================

const sgMail = (await import('@sendgrid/mail')).default;

// ---------------------------------------------------------------------------
// Helper: send a notification email via SendGrid (fire-and-forget)
// ---------------------------------------------------------------------------
const sendNotificationEmail = async (db, toEmail, subject, htmlContent) => {
    try {
        const sgKey = process.env.SENDGRID_API_KEY;
        if (!sgKey) return;  // no key configured — skip silently

        sgMail.setApiKey(sgKey);
        await sgMail.send({
            to: toEmail,
            from: process.env.FROM_EMAIL || 'noreply@kanban.local',
            subject,
            html: htmlContent,
        });
    } catch (err) {
        console.error('Notification email error:', err.message);
    }
};

// ---------------------------------------------------------------------------
// Helper: check notification prefs and dispatch emails for a card event
// ---------------------------------------------------------------------------
const notifyCardEvent = async (db, eventName, cardId, eventData) => {
    try {
        // Get card details for the email body
        const cardResult = await db.query('SELECT * FROM cards WHERE id = $1', [cardId]);
        const card = cardResult.rows[0];
        if (!card) return;

        // Map event names to notification preference fields
        const prefMap = {
            'card.created': 'card_created',
            'card.updated': 'card_updated',
            'card.deleted': null,       // deletion doesn't usually need email
            'card.moved': 'card_moved',
            'card.assigned': 'card_assigned',
            'comment.added': 'comment_added',
        };
        const prefField = prefMap[eventName];
        if (!prefField) return;

        // Find users who want this notification and are not the actor
        const result = await db.query(
            `SELECT u.email, u.username, np.${prefField} AS enabled
             FROM notification_prefs np
             JOIN users u ON u.id = np.user_id
             WHERE ${eventName === 'card.assigned' ? 'u.id = $1 AND np.card_assigned = TRUE' : `np.${prefField} = TRUE AND u.id != $1`}`,
            [eventData.actorId || eventData.assignee_id]
        );

        for (const row of result.rows) {
            if (!row.enabled && eventName !== 'card.assigned') continue;
            const eventLabel = eventName.replace('card.', '').replace('_', ' ');
            const htmlContent = `
                <h3>📋 ${eventLabel} — Kanban Board</h3>
                <p><strong>Card:</strong> ${escapeHtml(card.title)}</p>
                ${eventData.from_column ? `<p>Moved from: ${escapeHtml(eventData.from_column)} → <strong>${escapeHtml(eventData.to_column)}</strong></p>` : ''}
                ${eventData.priority ? `<p>New priority: <strong>${escapeHtml(eventData.priority)}</strong></p>` : ''}
                <p><em>Check the board for details.</em></p>
            `;
            sendNotificationEmail(db, row.email,
                `[Kanban] Card "${card.title}" — ${eventLabel}`, htmlContent);
        }
    } catch (err) {
        console.error('notifyCardEvent error:', err.message);
    }
};

// ---------------------------------------------------------------------------
// Helper: escape HTML for email bodies
// ---------------------------------------------------------------------------
function escapeHtml(str) {
    if (!str && str !== 0) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// ===========================================================================
// NOTIFICATION PREFERENCES API
// ===========================================================================

// ---------------------------------------------------------------------------
// GET /api/cards/notification-prefs  — get current user's notification prefs
// ---------------------------------------------------------------------------
router.get('/notification-prefs', async (req, res) => {
    const { id: userId } = req.user;
    try {
        const result = await req.db.query(
            'SELECT * FROM notification_prefs WHERE user_id = $1',
            [userId]
        );

        // If no row exists (new user), create defaults
        if (!result.rows[0]) {
            const created = await req.db.query(
                'INSERT INTO notification_prefs (user_id) VALUES ($1) RETURNING *',
                [userId]
            );
            res.json(created.rows[0]);
        } else {
            res.json(result.rows[0]);
        }
    } catch (err) {
        console.error('Notification prefs fetch error:', err);
        res.status(500).json({ error: 'Server error fetching notification preferences' });
    }
});

// ---------------------------------------------------------------------------
// PUT /api/cards/notification-prefs  — update notification preferences
// ---------------------------------------------------------------------------
router.put('/notification-prefs', async (req, res) => {
    const { id: userId } = req.user;
    const updates = req.body;

    try {
        const fields = [];
        const values = [];
        let idx = 1;

        const ALLOWED_PREF_FIELDS = [
            'card_created', 'card_updated', 'card_assigned', 'card_moved',
            'card_due_reminder', 'comment_added', 'digest_enabled', 'digest_frequency'
        ];

        for (const key of ALLOWED_PREF_FIELDS) {
            if (key in updates) {
                fields.push(`${key} = $${idx++}`);
                values.push(updates[key]);
            }
        }

        if (fields.length === 0) {
            return res.status(400).json({ error: 'No valid preference fields provided' });
        }

        fields.push(`updated_at = NOW()`);
        values.push(userId);

        const result = await req.db.query(
            `UPDATE notification_prefs SET ${fields.join(', ')} WHERE user_id = $${idx} RETURNING *`,
            values
        );

        // Upsert: if no row existed, insert
        if (!result.rows[0]) {
            const created = await req.db.query(
                `INSERT INTO notification_prefs (user_id) VALUES ($1) RETURNING *`,
                [userId]
            );
            res.json(created.rows[0]);
        } else {
            res.json(result.rows[0]);
        }
    } catch (err) {
        console.error('Notification prefs update error:', err);
        res.status(500).json({ error: 'Server error updating notification preferences' });
    }
});

// ---------------------------------------------------------------------------
// POST /api/cards/notification-prefs/test  — send a test notification email
// ---------------------------------------------------------------------------
router.post('/notification-prefs/test', async (req, res) => {
    const { id: userId } = req.user;

    try {
        const userResult = await req.db.query('SELECT email FROM users WHERE id = $1', [userId]);
        const user = userResult.rows[0];
        if (!user) return res.status(404).json({ error: 'User not found' });

        sendNotificationEmail(req.db, user.email,
            '[Kanban] Test Notification',
            '<h3>✅ Test Notification</h3><p>If you received this, email notifications are working.</p>'
        );

        res.json({ success: true, sent_to: user.email });
    } catch (err) {
        console.error('Notification test error:', err);
        res.status(500).json({ error: 'Server error sending test notification' });
    }
});

export default router;
