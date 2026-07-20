/**
 * routes/import.js
 *
 * CSV import endpoint for bulk card creation.
 *
 *   POST /api/import/csv  — upload CSV file, creates cards in bulk (admin only)
 *
 * CSV Format:
 *   Each row becomes a card. Required columns are marked below.
 *
 *   | title         | description       | priority | column_name or column_id | visibility | assignee_username |
 *   |---------------|-------------------|----------|--------------------------|------------|--------------------|
 *   | "Fix login"   | "Redirects to /"  | high     | "In Progress"            | public     | flux               |
 *   | "Add export"  | ""                | medium   | 2                        | private    |                    |
 *
 * Column definitions:
 *   title             — Required. Card title (max 200 chars).
 *   description       — Optional. Body text for the card.
 *   priority          — Optional. One of: critical, high, medium, low, minimal. Defaults to "medium".
 *   column_name       — Conditional (see below). Target column by name. Case-insensitive match.
 *   column_id         — Conditional (see below). Target column by numeric ID.
 *                      Either column_name OR column_id must be provided per row.
 *   visibility        — Optional. "public" or "private". Defaults to "public".
 *   assignee_username — Optional. Username of the user to assign. Skipped silently if not found.
 *
 * Behavior:
 *   - Admin-only endpoint (requires authenticate + requireRole('admin'))
 *   - Accepts multipart/form-data with field name "file"
 *   - Max file size: 5 MB
 *   - All rows processed in a single transaction — partial imports rollback entirely on error
 *   - Duplicate detection: cards with the same title in the same column within the last hour are skipped
 *   - Response includes per-row results (created, skipped, errored) and summary counts
 */

import { Router } from 'express';
import multer     from 'multer';

const router = Router();

// Lightweight CSV parser — handles quoted fields, escaped quotes, newlines in quotes
function parseCSV(text) {
    const rows = [];
    let current = '';
    let inQuotes = false;
    let fields = [];

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const next = text[i + 1];

        if (inQuotes) {
            if (ch === '"' && next === '"') {
                // Escaped quote
                current += '"';
                i++;
            } else if (ch === '"') {
                // End of quoted field
                inQuotes = false;
            } else {
                current += ch;
            }
        } else {
            if (ch === '"') {
                inQuotes = true;
            } else if (ch === ',') {
                fields.push(current.trim());
                current = '';
            } else if ((ch === '\r' && next === '\n') || ch === '\n') {
                fields.push(current.trim());
                current = '';
                if (fields.length > 1 || (fields.length === 1 && fields[0] !== '')) {
                    rows.push(fields);
                }
                fields = [];
                if (ch === '\r') i++; // skip \n after \r\n
            } else {
                current += ch;
            }
        }
    }

    // Handle last field/row without trailing newline
    fields.push(current.trim());
    if (fields.length > 1 || (fields.length === 1 && fields[0] !== '')) {
        rows.push(fields);
    }

    return rows;
}

// Validate a single row and return { cardData, error }
function validateRow(row, headers, columnsMap) {
    const get = (name) => {
        const idx = headers.indexOf(name);
        return idx >= 0 ? (row[idx] || '').trim() : '';
    };

    const title = get('title');
    if (!title) {
        return { error: 'Missing required field: title' };
    }
    if (title.length > 200) {
        return { error: `Title exceeds 200 characters (${title.length})` };
    }

    const description = get('description');

    // Priority validation
    const VALID_PRIORITIES = new Set(['critical', 'high', 'medium', 'low', 'minimal']);
    let priority = get('priority').toLowerCase() || 'medium';
    if (!VALID_PRIORITIES.has(priority)) {
        return { error: `Invalid priority "${get('priority')}". Must be one of: ${[...VALID_PRIORITIES].join(', ')}` };
    }

    // Column resolution — either column_name or column_id required
    let columnId = null;
    const columnName = get('column_name');
    const columnIdStr = get('column_id');

    if (columnName) {
        const key = columnName.toLowerCase();
        columnId = columnsMap[key];
        if (!columnId) {
            return { error: `Column "${columnName}" not found` };
        }
    } else if (columnIdStr) {
        columnId = parseInt(columnIdStr, 10);
        if (isNaN(columnId) || !columnsMap[columnId]) {
            return { error: `Column ID "${columnIdStr}" not found` };
        }
    } else {
        return { error: 'Either column_name or column_id is required' };
    }

    // Visibility validation
    const VALID_VISIBILITY = new Set(['public', 'private']);
    let visibility = get('visibility').toLowerCase() || 'public';
    if (!VALID_VISIBILITY.has(visibility)) {
        return { error: `Invalid visibility "${get('visibility')}". Must be "public" or "private"` };
    }

    const assigneeUsername = get('assignee_username');

    return {
        cardData: { title, description, priority, columnId, visibility, assigneeUsername },
    };
}

// ---------------------------------------------------------------------------
// POST /api/import/csv  — bulk import cards from CSV (admin only)
// ---------------------------------------------------------------------------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }); // 5 MB max

router.post('/csv', upload.single('file'), async (req, res) => {
    const file = req.file;

    if (!file) {
        return res.status(400).json({ error: 'No file provided. Use field name "file"' });
    }

    // Basic MIME/type check
    const allowedMimes = ['text/csv', 'text/plain', 'application/vnd.ms-excel'];
    if (!allowedMimes.includes(file.mimetype) && !file.originalname.toLowerCase().endsWith('.csv')) {
        return res.status(400).json({ error: 'File must be CSV format' });
    }

    const csvText = file.buffer.toString('utf-8');
    const rows = parseCSV(csvText);

    if (rows.length < 2) {
        return res.status(400).json({ error: 'CSV must contain a header row and at least one data row' });
    }

    // First row is the header
    const headers = rows[0].map((h) => h.toLowerCase());
    const dataRows = rows.slice(1);

    // Validate required columns exist in header
    const hasTitle = headers.includes('title');
    if (!hasTitle) {
        return res.status(400).json({ error: 'CSV header must include "title" column' });
    }
    const hasColumn = headers.includes('column_name') || headers.includes('column_id');
    if (!hasColumn) {
        return res.status(400).json({ error: 'CSV header must include either "column_name" or "column_id" column' });
    }

    // Warn about unexpected columns (non-blocking)
    const knownColumns = new Set([
        'title', 'description', 'priority', 'column_name', 'column_id',
        'visibility', 'assignee_username',
    ]);
    const unknownHeaders = headers.filter((h) => !knownColumns.has(h));

    try {
        // Load all columns into a lookup map (name-lowercase → id, and id → id)
        const columnsResult = await req.db.query('SELECT id, name FROM columns ORDER BY position');
        const columnsMap = {};
        for (const col of columnsResult.rows) {
            columnsMap[col.name.toLowerCase()] = col.id;
            columnsMap[col.id] = col.id;
        }

        // Validate all rows before starting transaction
        const validatedRows = [];
        const validationErrors = [];

        for (let i = 0; i < dataRows.length; i++) {
            const rowNum = i + 2; // 1-indexed, header is row 1
            const result = validateRow(dataRows[i], headers, columnsMap);

            if (result.error) {
                validationErrors.push({ row: rowNum, error: result.error });
            } else {
                validatedRows.push({ rowNum, cardData: result.cardData });
            }
        }

        // If ALL rows failed, return early without transaction
        if (validatedRows.length === 0 && validationErrors.length > 0) {
            return res.status(422).json({
                imported: 0,
                skipped: 0,
                errors:   validationErrors.length,
                details:  validationErrors,
                unknown_headers: unknownHeaders.length ? unknownHeaders : undefined,
            });
        }

        // Resolve assignee usernames to IDs (batch lookup)
        const uniqueUsernames = [...new Set(validatedRows.map((r) => r.cardData.assigneeUsername).filter(Boolean))];
        const userIdMap = {};

        if (uniqueUsernames.length > 0) {
            const placeholders = uniqueUsernames.map((_, idx) => `$${idx + 1}`).join(', ');
            const usersResult = await req.db.query(
                `SELECT id, username FROM users WHERE username IN (${placeholders})`,
                uniqueUsernames,
            );
            for (const u of usersResult.rows) {
                userIdMap[u.username] = u.id;
            }
        }

        // Check WIP limits for target columns
        const columnWipLimits = await req.db.query(
            `SELECT c.id, c.wip_limit, COALESCE((SELECT COUNT(*) FROM cards WHERE column_id = c.id), 0) AS current_count
             FROM columns c`,
        );
        const wipMap = {};
        for (const w of columnWipLimits.rows) {
            wipMap[w.id] = { limit: w.wip_limit, current: parseInt(w.current_count, 10) };
        }

        // Start transaction — all or nothing
        const client = await req.db.connect();
        let created = [];
        let skipped = [];

        try {
            await client.query('BEGIN');

            for (const { rowNum, cardData } of validatedRows) {
                const { title, description, priority, columnId, visibility, assigneeUsername } = cardData;

                // Check WIP limit for target column
                const wipInfo = wipMap[columnId];
                if (wipInfo && wipInfo.limit !== null && wipInfo.current >= wipInfo.limit) {
                    skipped.push({ row: rowNum, reason: `Column WIP limit (${wipInfo.limit}) reached`, title });
                    continue;
                }

                // Duplicate detection — same title + same column within last hour
                const dupCheck = await client.query(
                    'SELECT id FROM cards WHERE title = $1 AND column_id = $2 AND created_at > NOW() - INTERVAL \'1 hour\'',
                    [title, columnId],
                );
                if (dupCheck.rows.length > 0) {
                    skipped.push({ row: rowNum, reason: `Duplicate card (same title in same column within last hour)`, title });
                    continue;
                }

                // Determine position (next available in column)
                const posResult = await client.query(
                    'SELECT COALESCE(MAX(position_in_column), -1) + 1 AS next_pos FROM cards WHERE column_id = $1',
                    [columnId],
                );
                const position = posResult.rows[0].next_pos;

                // Resolve assignee ID
                let assigneeId = null;
                if (assigneeUsername && userIdMap[assigneeUsername]) {
                    assigneeId = userIdMap[assigneeUsername];
                }

                // Insert card
                const result = await client.query(
                    `INSERT INTO cards
                       (title, description, priority, column_id, position_in_column,
                        owner_id, assignee_id, visibility)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                     RETURNING *`,
                    [
                        title,
                        description || '',
                        priority,
                        columnId,
                        position,
                        req.user.id, // importer is the owner of imported cards
                        assigneeId,
                        visibility,
                    ],
                );

                const newCard = result.rows[0];

                // Update WIP counter for this column
                if (wipInfo) wipInfo.current++;

                created.push({ row: rowNum, card_id: newCard.id, title });
            }

            await client.query('COMMIT');
        } catch (txErr) {
            await client.query('ROLLBACK');
            throw txErr;
        } finally {
            client.release();
        }

        // Audit log
        req.db.query(
            'INSERT INTO audit_log (action, user_id, ip_address, metadata) VALUES ($1, $2, $3, $4)',
            ['csv_import', req.user.id, req.ip, JSON.stringify({
                total_rows: dataRows.length,
                created: created.length,
                skipped: skipped.length,
                errors: validationErrors.length,
            })],
        ).catch((err) => console.error('Audit log write failed:', err));

        res.json({
            imported:  created.length,
            skipped:   skipped.length,
            errors:    validationErrors.length,
            unknown_headers: unknownHeaders.length ? unknownHeaders : undefined,
            details: {
                created: created,
                skipped: skipped.length > 0 ? skipped : undefined,
                errors:  validationErrors.length > 0 ? validationErrors : undefined,
            },
        });

    } catch (err) {
        console.error('CSV import error:', err);
        res.status(500).json({ error: 'Server error processing CSV import' });
    }
});

export default router;
