/**
 * routes/templates.js
 * Syllego/StratoSense Kanban Board
 *
 * Card Templates — reusable card blueprints with pre-filled fields.
 *
 *   GET    /api/templates          — list all templates
 *   POST   /api/templates          — create template (admin)
 *   PUT    /api/templates/:id      — update template (admin)
 *   DELETE /api/templates/:id      — delete template (admin)
 *   POST   /api/templates/:id/use  — create a card from a template
 */

import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

// ---------------------------------------------------------------------------
// GET /api/templates
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
    try {
        const r = await req.db.query(
            `SELECT t.*, u.username AS created_by_username,
                    u2.username AS default_assignee_username
             FROM card_templates t
             LEFT JOIN users u  ON u.id  = t.created_by
             LEFT JOIN users u2 ON u2.id = t.default_assignee_id
             ORDER BY t.name ASC`
        );
        res.json(r.rows);
    } catch (err) {
        console.error('GET /templates error:', err);
        res.status(500).json({ error: 'Server error fetching templates' });
    }
});

// ---------------------------------------------------------------------------
// POST /api/templates  (admin)
// ---------------------------------------------------------------------------
router.post('/', requireRole('admin'), async (req, res) => {
    const {
        name, description = '', priority = 'medium',
        default_assignee_id = null, label_ids = [], subtask_titles = []
    } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Template name is required' });
    try {
        const r = await req.db.query(
            `INSERT INTO card_templates
               (name, description, priority, default_assignee_id, label_ids, subtask_titles, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [name.trim(), description.trim(), priority,
             default_assignee_id || null,
             JSON.stringify(label_ids), JSON.stringify(subtask_titles),
             req.user.id]
        );
        res.status(201).json(r.rows[0]);
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'Template name already exists' });
        console.error('POST /templates error:', err);
        res.status(500).json({ error: 'Server error creating template' });
    }
});

// ---------------------------------------------------------------------------
// PUT /api/templates/:id  (admin)
// ---------------------------------------------------------------------------
router.put('/:id', requireRole('admin'), async (req, res) => {
    const {
        name, description, priority,
        default_assignee_id, label_ids, subtask_titles
    } = req.body;
    try {
        const existing = await req.db.query('SELECT * FROM card_templates WHERE id=$1', [req.params.id]);
        if (!existing.rows[0]) return res.status(404).json({ error: 'Template not found' });
        const t = existing.rows[0];
        const r = await req.db.query(
            `UPDATE card_templates SET
               name=$1, description=$2, priority=$3,
               default_assignee_id=$4, label_ids=$5, subtask_titles=$6,
               updated_at=NOW()
             WHERE id=$7 RETURNING *`,
            [
                (name ?? t.name).trim(),
                (description ?? t.description).trim(),
                priority ?? t.priority,
                default_assignee_id !== undefined ? (default_assignee_id || null) : t.default_assignee_id,
                JSON.stringify(label_ids ?? t.label_ids),
                JSON.stringify(subtask_titles ?? t.subtask_titles),
                req.params.id
            ]
        );
        res.json(r.rows[0]);
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'Template name already exists' });
        console.error('PUT /templates/:id error:', err);
        res.status(500).json({ error: 'Server error updating template' });
    }
});

// ---------------------------------------------------------------------------
// DELETE /api/templates/:id  (admin)
// ---------------------------------------------------------------------------
router.delete('/:id', requireRole('admin'), async (req, res) => {
    try {
        const r = await req.db.query('DELETE FROM card_templates WHERE id=$1 RETURNING id', [req.params.id]);
        if (!r.rows[0]) return res.status(404).json({ error: 'Template not found' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error deleting template' });
    }
});

// ---------------------------------------------------------------------------
// POST /api/templates/:id/use — create a card from a template
// ---------------------------------------------------------------------------
router.post('/:id/use', async (req, res) => {
    const { column_id, title: customTitle, due_date } = req.body;
    if (!column_id) return res.status(400).json({ error: 'column_id is required' });
    try {
        const tmpl = await req.db.query('SELECT * FROM card_templates WHERE id=$1', [req.params.id]);
        if (!tmpl.rows[0]) return res.status(404).json({ error: 'Template not found' });
        const t = tmpl.rows[0];

        // Determine position
        const pos = await req.db.query(
            'SELECT COALESCE(MAX(position_in_column)+1,0) AS next FROM cards WHERE column_id=$1',
            [column_id]
        );

        // Create the card
        const card = await req.db.query(
            `INSERT INTO cards
               (title, description, priority, column_id, position_in_column,
                owner_id, assignee_id, due_date)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
            [
                (customTitle ?? t.name).trim(),
                t.description,
                t.priority,
                column_id,
                pos.rows[0].next,
                req.user.id,
                t.default_assignee_id,
                due_date || null
            ]
        );
        const cardId = card.rows[0].id;

        // Apply labels
        if (Array.isArray(t.label_ids) && t.label_ids.length) {
            for (const lid of t.label_ids) {
                await req.db.query(
                    'INSERT INTO card_labels (card_id, label_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
                    [cardId, lid]
                ).catch(() => {});
            }
        }

        // Create subtasks
        if (Array.isArray(t.subtask_titles) && t.subtask_titles.length) {
            for (let i = 0; i < t.subtask_titles.length; i++) {
                await req.db.query(
                    `INSERT INTO card_subtasks (card_id, title, position, created_by)
                     VALUES ($1,$2,$3,$4)`,
                    [cardId, t.subtask_titles[i], i, req.user.id]
                ).catch(() => {});
            }
        }

        // Log activity
        req.db.query(
            `INSERT INTO card_activity (card_id, user_id, action, details)
             VALUES ($1,$2,'created_from_template',$3)`,
            [cardId, req.user.id, JSON.stringify({ template: t.name })]
        ).catch(() => {});

        res.status(201).json(card.rows[0]);
    } catch (err) {
        console.error('POST /templates/:id/use error:', err);
        res.status(500).json({ error: 'Server error creating card from template' });
    }
});

export default router;
