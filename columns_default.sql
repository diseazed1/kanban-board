-- =============================================================================
-- Default board columns seed
-- Run AFTER schema.sql and AFTER the first admin user has been created.
-- =============================================================================
INSERT INTO columns (name, position, wip_limit, created_by)
SELECT name, position, wip_limit, (SELECT id FROM users WHERE role = 'admin' LIMIT 1)
FROM (VALUES
    ('Backlog',     1, NULL),
    ('Ready',       2, 5),
    ('In Progress', 3, 3),
    ('Review',      4, 3),
    ('Done',        5, NULL)
) AS t(name, position, wip_limit)
ON CONFLICT DO NOTHING;
