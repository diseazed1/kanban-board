/**
 * routes/boards.js
 * Syllego/StratoSense Kanban Board
 *
 * Endpoints:
 *   GET    /api/boards                     — list boards accessible to the user
 *   POST   /api/boards                     — create a new board (admin)
 *   GET    /api/boards/:id                 — get board details + columns
 *   PUT    /api/boards/:id                 — rename / update board (admin)
 *   DELETE /api/boards/:id                 — delete board (admin, not default)
 *
 *   GET    /api/boards/:id/members         — list board members
 *   POST   /api/boards/:id/members         — add member to board (admin)
 *   DELETE /api/boards/:id/members/:uid    — remove member (admin)
 *
 *   GET    /api/boards/:id/swimlanes       — list swimlanes for a board
 *   POST   /api/boards/:id/swimlanes       — create swimlane (admin)
 *   PUT    /api/boards/:id/swimlanes/:sid  — rename/reorder swimlane (admin)
 *   DELETE /api/boards/:id/swimlanes/:sid  — delete swimlane (admin)
 *
 *   GET    /api/boards/:id/snapshots       — list snapshots (admin)
 *   POST   /api/boards/:id/snapshots       — manually trigger a snapshot (admin)
 *   GET    /api/boards/:id/snapshots/:sid  — get snapshot data (admin)
 *
 *   GET    /api/boards/:id/analytics       — board analytics / dashboard metrics
 */

import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

// ---------------------------------------------------------------------------
// Helper: audit log
// ---------------------------------------------------------------------------
function audit(db, action, userId, ip, meta = {}) {
    db.query(
        'INSERT INTO audit_log (action, user_id, ip_address, metadata) VALUES ($1,$2,$3,$4)',
        [action, userId, ip, JSON.stringify(meta)]
    ).catch(() => {});
}

// ---------------------------------------------------------------------------
// GET /api/boards — list all boards the user has access to
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
    const { id: userId, role } = req.user;
    try {
        let rows;
        if (role === 'admin') {
            // Admins see all boards
            const r = await req.db.query(
                `SELECT b.*, u.username AS created_by_username,
                        COUNT(DISTINCT bm.user_id) AS member_count
                 FROM boards b
                 LEFT JOIN users u ON u.id = b.created_by
                 LEFT JOIN board_members bm ON bm.board_id = b.id
                 GROUP BY b.id, u.username
                 ORDER BY b.is_default DESC, b.created_at ASC`
            );
            rows = r.rows;
        } else {
            // Regular users see boards they're a member of + default board
            const r = await req.db.query(
                `SELECT b.*, u.username AS created_by_username,
                        COUNT(DISTINCT bm2.user_id) AS member_count
                 FROM boards b
                 LEFT JOIN users u ON u.id = b.created_by
                 LEFT JOIN board_members bm ON bm.board_id = b.id AND bm.user_id = $1
                 LEFT JOIN board_members bm2 ON bm2.board_id = b.id
                 WHERE b.is_default = TRUE OR bm.user_id IS NOT NULL
                 GROUP BY b.id, u.username
                 ORDER BY b.is_default DESC, b.created_at ASC`,
                [userId]
            );
            rows = r.rows;
        }
        res.json(rows);
    } catch (err) {
        console.error('GET /boards error:', err);
        res.status(500).json({ error: 'Server error fetching boards' });
    }
});

// ---------------------------------------------------------------------------
// POST /api/boards — create a new board (admin only)
// ---------------------------------------------------------------------------
router.post('/', requireRole('admin'), async (req, res) => {
    const { name, description = '' } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Board name is required' });
    try {
        const r = await req.db.query(
            `INSERT INTO boards (name, description, created_by)
             VALUES ($1, $2, $3) RETURNING *`,
            [name.trim(), description.trim(), req.user.id]
        );
        audit(req.db, 'board_create', req.user.id, req.ip, { name });
        res.status(201).json(r.rows[0]);
    } catch (err) {
        console.error('POST /boards error:', err);
        res.status(500).json({ error: 'Server error creating board' });
    }
});

// ---------------------------------------------------------------------------
// GET /api/boards/:id — board details with columns and card counts
// ---------------------------------------------------------------------------
router.get('/:id', async (req, res) => {
    try {
        const board = await req.db.query('SELECT * FROM boards WHERE id = $1', [req.params.id]);
        if (!board.rows[0]) return res.status(404).json({ error: 'Board not found' });

        const columns = await req.db.query(
            `SELECT c.*, COUNT(cards.id) AS card_count
             FROM columns c
             LEFT JOIN cards ON cards.column_id = c.id AND cards.is_archived = FALSE
             WHERE c.board_id = $1
             GROUP BY c.id
             ORDER BY c.position ASC`,
            [req.params.id]
        );
        res.json({ ...board.rows[0], columns: columns.rows });
    } catch (err) {
        console.error('GET /boards/:id error:', err);
        res.status(500).json({ error: 'Server error fetching board' });
    }
});

// ---------------------------------------------------------------------------
// PUT /api/boards/:id — update board name/description (admin)
// ---------------------------------------------------------------------------
router.put('/:id', requireRole('admin'), async (req, res) => {
    const { name, description } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Board name is required' });
    try {
        const r = await req.db.query(
            `UPDATE boards SET name=$1, description=$2, updated_at=NOW()
             WHERE id=$3 RETURNING *`,
            [name.trim(), (description || '').trim(), req.params.id]
        );
        if (!r.rows[0]) return res.status(404).json({ error: 'Board not found' });
        audit(req.db, 'board_update', req.user.id, req.ip, { board_id: req.params.id, name });
        res.json(r.rows[0]);
    } catch (err) {
        console.error('PUT /boards/:id error:', err);
        res.status(500).json({ error: 'Server error updating board' });
    }
});

// ---------------------------------------------------------------------------
// DELETE /api/boards/:id — delete board (admin, cannot delete default)
// ---------------------------------------------------------------------------
router.delete('/:id', requireRole('admin'), async (req, res) => {
    try {
        const board = await req.db.query('SELECT * FROM boards WHERE id=$1', [req.params.id]);
        if (!board.rows[0]) return res.status(404).json({ error: 'Board not found' });
        if (board.rows[0].is_default) return res.status(409).json({ error: 'Cannot delete the default board' });
        await req.db.query('DELETE FROM boards WHERE id=$1', [req.params.id]);
        audit(req.db, 'board_delete', req.user.id, req.ip, { board_id: req.params.id });
        res.json({ success: true });
    } catch (err) {
        console.error('DELETE /boards/:id error:', err);
        res.status(500).json({ error: 'Server error deleting board' });
    }
});

// ---------------------------------------------------------------------------
// Board Members
// ---------------------------------------------------------------------------
router.get('/:id/members', async (req, res) => {
    try {
        const r = await req.db.query(
            `SELECT bm.*, u.username, u.email, u.role AS user_role
             FROM board_members bm
             JOIN users u ON u.id = bm.user_id
             WHERE bm.board_id = $1
             ORDER BY bm.added_at ASC`,
            [req.params.id]
        );
        res.json(r.rows);
    } catch (err) {
        res.status(500).json({ error: 'Server error fetching members' });
    }
});

router.post('/:id/members', requireRole('admin'), async (req, res) => {
    const { user_id, role: memberRole = 'member' } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });
    try {
        const r = await req.db.query(
            `INSERT INTO board_members (board_id, user_id, role)
             VALUES ($1, $2, $3)
             ON CONFLICT (board_id, user_id) DO UPDATE SET role = EXCLUDED.role
             RETURNING *`,
            [req.params.id, user_id, memberRole]
        );
        res.status(201).json(r.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Server error adding member' });
    }
});

router.delete('/:id/members/:uid', requireRole('admin'), async (req, res) => {
    try {
        await req.db.query(
            'DELETE FROM board_members WHERE board_id=$1 AND user_id=$2',
            [req.params.id, req.params.uid]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error removing member' });
    }
});

// ---------------------------------------------------------------------------
// Swimlanes
// ---------------------------------------------------------------------------
router.get('/:id/swimlanes', async (req, res) => {
    try {
        const r = await req.db.query(
            'SELECT * FROM swimlanes WHERE board_id=$1 ORDER BY position ASC',
            [req.params.id]
        );
        res.json(r.rows);
    } catch (err) {
        res.status(500).json({ error: 'Server error fetching swimlanes' });
    }
});

router.post('/:id/swimlanes', requireRole('admin'), async (req, res) => {
    const { name, color = '#e2e8f0' } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Swimlane name is required' });
    try {
        const pos = await req.db.query(
            'SELECT COALESCE(MAX(position)+1, 0) AS next_pos FROM swimlanes WHERE board_id=$1',
            [req.params.id]
        );
        const r = await req.db.query(
            `INSERT INTO swimlanes (board_id, name, color, position, created_by)
             VALUES ($1,$2,$3,$4,$5) RETURNING *`,
            [req.params.id, name.trim(), color, pos.rows[0].next_pos, req.user.id]
        );
        res.status(201).json(r.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Server error creating swimlane' });
    }
});

router.put('/:id/swimlanes/:sid', requireRole('admin'), async (req, res) => {
    const { name, color, position } = req.body;
    try {
        const updates = [];
        const vals = [];
        let i = 1;
        if (name !== undefined) { updates.push(`name=$${i++}`); vals.push(name.trim()); }
        if (color !== undefined) { updates.push(`color=$${i++}`); vals.push(color); }
        if (position !== undefined) { updates.push(`position=$${i++}`); vals.push(position); }
        if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
        vals.push(req.params.sid);
        const r = await req.db.query(
            `UPDATE swimlanes SET ${updates.join(',')} WHERE id=$${i} RETURNING *`,
            vals
        );
        if (!r.rows[0]) return res.status(404).json({ error: 'Swimlane not found' });
        res.json(r.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Server error updating swimlane' });
    }
});

router.delete('/:id/swimlanes/:sid', requireRole('admin'), async (req, res) => {
    try {
        // Null out swimlane_id on cards that used this swimlane
        await req.db.query('UPDATE cards SET swimlane_id=NULL WHERE swimlane_id=$1', [req.params.sid]);
        await req.db.query('DELETE FROM swimlanes WHERE id=$1', [req.params.sid]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error deleting swimlane' });
    }
});

// ---------------------------------------------------------------------------
// Board Snapshots
// ---------------------------------------------------------------------------
router.get('/:id/snapshots', requireRole('admin'), async (req, res) => {
    try {
        const r = await req.db.query(
            `SELECT id, board_id, snapshot_at,
                    jsonb_array_length(snapshot_data->'columns') AS column_count
             FROM board_snapshots
             WHERE board_id=$1
             ORDER BY snapshot_at DESC
             LIMIT 90`,
            [req.params.id]
        );
        res.json(r.rows);
    } catch (err) {
        res.status(500).json({ error: 'Server error fetching snapshots' });
    }
});

router.post('/:id/snapshots', requireRole('admin'), async (req, res) => {
    try {
        const snapshot = await takeBoardSnapshot(req.db, req.params.id);
        res.status(201).json(snapshot);
    } catch (err) {
        console.error('Snapshot error:', err);
        res.status(500).json({ error: 'Server error creating snapshot' });
    }
});

router.get('/:id/snapshots/:sid', requireRole('admin'), async (req, res) => {
    try {
        const r = await req.db.query(
            'SELECT * FROM board_snapshots WHERE id=$1 AND board_id=$2',
            [req.params.sid, req.params.id]
        );
        if (!r.rows[0]) return res.status(404).json({ error: 'Snapshot not found' });
        res.json(r.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Server error fetching snapshot' });
    }
});

// ---------------------------------------------------------------------------
// Analytics / Dashboard
// ---------------------------------------------------------------------------
router.get('/:id/analytics', async (req, res) => {
    const boardId = req.params.id;
    try {
        // Cards per column
        const byColumn = await req.db.query(
            `SELECT col.name AS column_name, COUNT(c.id) AS card_count,
                    COUNT(c.id) FILTER (WHERE c.is_archived = FALSE) AS active_count
             FROM columns col
             LEFT JOIN cards c ON c.column_id = col.id
             WHERE col.board_id = $1
             GROUP BY col.id, col.name, col.position
             ORDER BY col.position ASC`,
            [boardId]
        );

        // Cards per priority
        const byPriority = await req.db.query(
            `SELECT c.priority, COUNT(*) AS count
             FROM cards c
             JOIN columns col ON col.id = c.column_id
             WHERE col.board_id = $1 AND c.is_archived = FALSE
             GROUP BY c.priority
             ORDER BY CASE c.priority
                WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3
                WHEN 'low' THEN 4 WHEN 'minimal' THEN 5 END`,
            [boardId]
        );

        // Cards per assignee (top 10)
        const byAssignee = await req.db.query(
            `SELECT u.username, COUNT(c.id) AS card_count
             FROM cards c
             JOIN users u ON u.id = c.assignee_id
             JOIN columns col ON col.id = c.column_id
             WHERE col.board_id = $1 AND c.is_archived = FALSE
             GROUP BY u.username
             ORDER BY card_count DESC
             LIMIT 10`,
            [boardId]
        );

        // Overdue cards count
        const overdue = await req.db.query(
            `SELECT COUNT(*) AS count
             FROM cards c
             JOIN columns col ON col.id = c.column_id
             WHERE col.board_id = $1
               AND c.is_archived = FALSE
               AND c.due_date IS NOT NULL
               AND c.due_date < NOW()`,
            [boardId]
        );

        // Cards completed per week (last 8 weeks) — cards in last column
        const lastCol = await req.db.query(
            `SELECT id FROM columns WHERE board_id=$1 ORDER BY position DESC LIMIT 1`,
            [boardId]
        );
        let completedByWeek = [];
        if (lastCol.rows[0]) {
            const r = await req.db.query(
                `SELECT DATE_TRUNC('week', updated_at) AS week,
                        COUNT(*) AS completed
                 FROM cards
                 WHERE column_id = $1
                   AND is_archived = FALSE
                   AND updated_at >= NOW() - INTERVAL '8 weeks'
                 GROUP BY week
                 ORDER BY week ASC`,
                [lastCol.rows[0].id]
            );
            completedByWeek = r.rows;
        }

        // Average cycle time per column (from card_column_history)
        const cycleTime = await req.db.query(
            `SELECT cch.column_name,
                    ROUND(AVG(EXTRACT(EPOCH FROM (cch.left_at - cch.entered_at))/3600)::numeric, 1) AS avg_hours
             FROM card_column_history cch
             JOIN cards c ON c.id = cch.card_id
             JOIN columns col ON col.id = cch.column_id
             WHERE col.board_id = $1
               AND cch.left_at IS NOT NULL
             GROUP BY cch.column_name
             ORDER BY MIN(col.position) ASC`,
            [boardId]
        );

        // Total time tracked per card (top 10 by time)
        const timeTracked = await req.db.query(
            `SELECT c.title, SUM(te.duration_s) AS total_seconds
             FROM time_entries te
             JOIN cards c ON c.id = te.card_id
             JOIN columns col ON col.id = c.column_id
             WHERE col.board_id = $1 AND te.duration_s IS NOT NULL
             GROUP BY c.id, c.title
             ORDER BY total_seconds DESC
             LIMIT 10`,
            [boardId]
        );

        // WIP violations (columns over their limit)
        const wipViolations = await req.db.query(
            `SELECT col.name, col.wip_limit, COUNT(c.id) AS current_count
             FROM columns col
             LEFT JOIN cards c ON c.column_id = col.id AND c.is_archived = FALSE
             WHERE col.board_id = $1 AND col.wip_limit IS NOT NULL
             GROUP BY col.id, col.name, col.wip_limit
             HAVING COUNT(c.id) > col.wip_limit`,
            [boardId]
        );

        res.json({
            by_column: byColumn.rows,
            by_priority: byPriority.rows,
            by_assignee: byAssignee.rows,
            overdue_count: parseInt(overdue.rows[0].count),
            completed_by_week: completedByWeek,
            cycle_time: cycleTime.rows,
            time_tracked: timeTracked.rows,
            wip_violations: wipViolations.rows
        });
    } catch (err) {
        console.error('Analytics error:', err);
        res.status(500).json({ error: 'Server error fetching analytics' });
    }
});

// ---------------------------------------------------------------------------
// Exported helper: take a board snapshot (used by scheduler in server.mjs)
// ---------------------------------------------------------------------------
export async function takeBoardSnapshot(db, boardId) {
    const cols = await db.query(
        `SELECT col.id, col.name, col.position,
                json_agg(
                    json_build_object(
                        'id', c.id, 'title', c.title,
                        'priority', c.priority, 'assignee_id', c.assignee_id,
                        'due_date', c.due_date, 'position_in_column', c.position_in_column
                    ) ORDER BY c.position_in_column
                ) FILTER (WHERE c.id IS NOT NULL) AS cards
         FROM columns col
         LEFT JOIN cards c ON c.column_id = col.id AND c.is_archived = FALSE
         WHERE col.board_id = $1
         GROUP BY col.id
         ORDER BY col.position ASC`,
        [boardId]
    );
    const snapshotData = { columns: cols.rows };
    const r = await db.query(
        `INSERT INTO board_snapshots (board_id, snapshot_data) VALUES ($1,$2) RETURNING *`,
        [boardId, JSON.stringify(snapshotData)]
    );
    return r.rows[0];
}

export default router;
