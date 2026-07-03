/**
 * routes/time.js
 * Syllego/StratoSense Kanban Board
 *
 * Time Tracking endpoints:
 *   POST   /api/time/:card_id/start   — start a timer on a card
 *   POST   /api/time/:card_id/stop    — stop the running timer
 *   GET    /api/time/:card_id         — get all time entries for a card
 *   DELETE /api/time/:entry_id        — delete a time entry (owner or admin)
 *
 * Card Dependencies endpoints:
 *   GET    /api/deps/:card_id         — get blocking/blocked-by cards
 *   POST   /api/deps/:card_id/block   — add a "blocked by" dependency
 *   DELETE /api/deps/:card_id/block/:blocking_id — remove a dependency
 */

import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

// ---------------------------------------------------------------------------
// Time Tracking
// ---------------------------------------------------------------------------

// POST /api/time/:card_id/start
router.post('/:card_id/start', async (req, res) => {
    const { id: userId } = req.user;
    const { card_id } = req.params;
    const { note = '' } = req.body;
    try {
        // Stop any running timer for this user first
        await req.db.query(
            `UPDATE time_entries SET stopped_at = NOW()
             WHERE user_id = $1 AND stopped_at IS NULL`,
            [userId]
        );
        const r = await req.db.query(
            `INSERT INTO time_entries (card_id, user_id, note) VALUES ($1,$2,$3) RETURNING *`,
            [card_id, userId, note]
        );
        res.status(201).json(r.rows[0]);
    } catch (err) {
        console.error('Start timer error:', err);
        res.status(500).json({ error: 'Server error starting timer' });
    }
});

// POST /api/time/:card_id/stop
router.post('/:card_id/stop', async (req, res) => {
    const { id: userId } = req.user;
    const { card_id } = req.params;
    try {
        const r = await req.db.query(
            `UPDATE time_entries SET stopped_at = NOW()
             WHERE card_id = $1 AND user_id = $2 AND stopped_at IS NULL
             RETURNING *`,
            [card_id, userId]
        );
        if (!r.rows[0]) return res.status(404).json({ error: 'No running timer found for this card' });
        res.json(r.rows[0]);
    } catch (err) {
        console.error('Stop timer error:', err);
        res.status(500).json({ error: 'Server error stopping timer' });
    }
});

// GET /api/time/:card_id
router.get('/:card_id', async (req, res) => {
    try {
        const r = await req.db.query(
            `SELECT te.*, u.username
             FROM time_entries te
             JOIN users u ON u.id = te.user_id
             WHERE te.card_id = $1
             ORDER BY te.started_at DESC`,
            [req.params.card_id]
        );
        // Also return total seconds
        const total = r.rows.reduce((sum, e) => sum + (e.duration_s || 0), 0);
        res.json({ entries: r.rows, total_seconds: total });
    } catch (err) {
        res.status(500).json({ error: 'Server error fetching time entries' });
    }
});

// DELETE /api/time/:entry_id  (owner or admin)
router.delete('/entry/:entry_id', async (req, res) => {
    const { id: userId, role } = req.user;
    try {
        const existing = await req.db.query('SELECT * FROM time_entries WHERE id=$1', [req.params.entry_id]);
        if (!existing.rows[0]) return res.status(404).json({ error: 'Time entry not found' });
        if (role !== 'admin' && existing.rows[0].user_id !== userId)
            return res.status(403).json({ error: 'Not authorized to delete this time entry' });
        await req.db.query('DELETE FROM time_entries WHERE id=$1', [req.params.entry_id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error deleting time entry' });
    }
});

export default router;
