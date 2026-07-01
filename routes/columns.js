/**
 * routes/columns.js
 *
 * Board column management.
 *
 *   GET    /api/columns      — list all columns (any authenticated user)
 *   POST   /api/columns      — create column (admin only)
 *   PUT    /api/columns/:id  — update column (admin only)
 *   DELETE /api/columns/:id  — delete column (admin only)
 */

import { Router }      from 'express';
import { requireRole } from '../middleware/auth.js';

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/columns
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
    try {
        const result = await req.db.query(
            `SELECT id, name, position, wip_limit, updated_at
             FROM columns
             ORDER BY position ASC`
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Column list error:', err);
        res.status(500).json({ error: 'Server error fetching columns' });
    }
});

// ---------------------------------------------------------------------------
// POST /api/columns  (admin only)
// ---------------------------------------------------------------------------
router.post('/', requireRole('admin'), async (req, res) => {
    const { name, position, wip_limit } = req.body;

    if (!name?.trim()) {
        return res.status(400).json({ error: 'Column name is required' });
    }
    if (position === undefined || isNaN(parseInt(position, 10))) {
        return res.status(400).json({ error: 'A numeric position is required' });
    }

    try {
        const result = await req.db.query(
            `INSERT INTO columns (name, position, wip_limit, created_by)
             VALUES ($1, $2, $3, $4)
             RETURNING *`,
            [name.trim(), parseInt(position, 10), wip_limit ?? null, req.user.id]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Column create error:', err);
        res.status(500).json({ error: 'Server error creating column' });
    }
});

// ---------------------------------------------------------------------------
// PUT /api/columns/:id  (admin only)
// ---------------------------------------------------------------------------
router.put('/:id', requireRole('admin'), async (req, res) => {
    const { name, position, wip_limit } = req.body;
    const colId = parseInt(req.params.id, 10);

    if (isNaN(colId)) {
        return res.status(400).json({ error: 'Invalid column ID' });
    }

    try {
        const result = await req.db.query(
            `UPDATE columns
             SET name      = COALESCE($1, name),
                 position  = COALESCE($2, position),
                 wip_limit = COALESCE($3, wip_limit),
                 updated_at = NOW()
             WHERE id = $4
             RETURNING *`,
            [name ?? null, position ?? null, wip_limit ?? null, colId]
        );

        if (result.rowCount === 0) {      // fixed: was result.rowsAffected
            return res.status(404).json({ error: 'Column not found' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Column update error:', err);
        res.status(500).json({ error: 'Server error updating column' });
    }
});

// ---------------------------------------------------------------------------
// DELETE /api/columns/:id  (admin only)
// ---------------------------------------------------------------------------
router.delete('/:id', requireRole('admin'), async (req, res) => {
    const colId = parseInt(req.params.id, 10);

    if (isNaN(colId)) {
        return res.status(400).json({ error: 'Invalid column ID' });
    }

    try {
        // Check for cards still in this column
        const cardCheck = await req.db.query(
            'SELECT COUNT(*) AS cnt FROM cards WHERE column_id = $1',
            [colId]
        );
        if (parseInt(cardCheck.rows[0].cnt, 10) > 0) {
            return res.status(409).json({
                error: 'Column still contains cards — move or delete them before removing the column',
            });
        }

        const result = await req.db.query(
            'DELETE FROM columns WHERE id = $1',
            [colId]
        );

        if (result.rowCount === 0) {      // fixed: was result.rowsAffected
            return res.status(404).json({ error: 'Column not found' });
        }

        res.json({ success: true });
    } catch (err) {
        console.error('Column delete error:', err);
        res.status(500).json({ error: 'Server error deleting column' });
    }
});

export default router;
