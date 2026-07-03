/**
 * routes/deps.js
 * Syllego/StratoSense Kanban Board
 *
 * Card Dependencies — "blocked by" relationships between cards.
 *
 *   GET    /api/deps/:card_id              — get blocking + blocked-by cards
 *   POST   /api/deps/:card_id/block        — mark card as blocked by another
 *   DELETE /api/deps/:card_id/block/:bid   — remove a blocking dependency
 */

import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

// GET /api/deps/:card_id
router.get('/:card_id', async (req, res) => {
    const { card_id } = req.params;
    try {
        // Cards that are blocking this card
        const blocking = await req.db.query(
            `SELECT c.id, c.title, c.priority, c.is_archived,
                    col.name AS column_name, u.username AS owner_username
             FROM card_dependencies cd
             JOIN cards c ON c.id = cd.blocking_card_id
             LEFT JOIN columns col ON col.id = c.column_id
             LEFT JOIN users u ON u.id = c.owner_id
             WHERE cd.blocked_card_id = $1`,
            [card_id]
        );
        // Cards that this card is blocking
        const blocked = await req.db.query(
            `SELECT c.id, c.title, c.priority, c.is_archived,
                    col.name AS column_name, u.username AS owner_username
             FROM card_dependencies cd
             JOIN cards c ON c.id = cd.blocked_card_id
             LEFT JOIN columns col ON col.id = c.column_id
             LEFT JOIN users u ON u.id = c.owner_id
             WHERE cd.blocking_card_id = $1`,
            [card_id]
        );
        res.json({ blocking: blocking.rows, blocking_count: blocking.rows.length,
                   blocked: blocked.rows, blocked_count: blocked.rows.length });
    } catch (err) {
        res.status(500).json({ error: 'Server error fetching dependencies' });
    }
});

// POST /api/deps/:card_id/block  — { blocking_card_id }
router.post('/:card_id/block', async (req, res) => {
    const { card_id } = req.params;
    const { blocking_card_id } = req.body;
    if (!blocking_card_id) return res.status(400).json({ error: 'blocking_card_id is required' });
    if (blocking_card_id === card_id) return res.status(400).json({ error: 'A card cannot block itself' });
    try {
        // Check for circular dependency
        const circular = await req.db.query(
            `SELECT 1 FROM card_dependencies
             WHERE blocking_card_id = $1 AND blocked_card_id = $2`,
            [card_id, blocking_card_id]
        );
        if (circular.rows.length) return res.status(409).json({ error: 'Circular dependency detected' });

        await req.db.query(
            `INSERT INTO card_dependencies (blocking_card_id, blocked_card_id, created_by)
             VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
            [blocking_card_id, card_id, req.user.id]
        );
        // Log activity on both cards
        req.db.query(
            `INSERT INTO card_activity (card_id, user_id, action, details)
             VALUES ($1,$2,'dependency_added',$3)`,
            [card_id, req.user.id, JSON.stringify({ blocking_card_id })]
        ).catch(() => {});
        res.status(201).json({ success: true });
    } catch (err) {
        console.error('Add dependency error:', err);
        res.status(500).json({ error: 'Server error adding dependency' });
    }
});

// DELETE /api/deps/:card_id/block/:bid
router.delete('/:card_id/block/:bid', async (req, res) => {
    try {
        await req.db.query(
            `DELETE FROM card_dependencies
             WHERE blocking_card_id = $1 AND blocked_card_id = $2`,
            [req.params.bid, req.params.card_id]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error removing dependency' });
    }
});

export default router;
