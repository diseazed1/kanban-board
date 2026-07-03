/**
 * middleware/auth.js
 *
 * Shared authentication and authorisation middleware.
 * Uses server-side sessions (express-session + connect-pg-simple).
 */

// Role hierarchy: higher number = more privilege
const ROLE_LEVEL = { admin: 3, user: 2, viewer: 1 };

// ---------------------------------------------------------------------------
// authenticate — verify that the user has a valid session
// ---------------------------------------------------------------------------
export const authenticate = (req, res, next) => {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    // Attach user to req for downstream handlers
    req.user = req.session.user;
    next();
};

// ---------------------------------------------------------------------------
// requireRole — factory that enforces a minimum role level
// ---------------------------------------------------------------------------
export const requireRole = (minRole) => (req, res, next) => {
    const userLevel = ROLE_LEVEL[req.user?.role] ?? 0;
    const required  = ROLE_LEVEL[minRole]         ?? 99;

    if (userLevel >= required) return next();

    res.status(403).json({ error: 'Insufficient privileges' });
};
