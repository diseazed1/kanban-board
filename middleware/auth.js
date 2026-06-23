/**
 * middleware/auth.js
 *
 * Shared authentication and authorisation middleware.
 * Imported by server.mjs and referenced by route modules.
 */

import jwt from 'jsonwebtoken';

// Role hierarchy: higher number = more privilege
const ROLE_LEVEL = { admin: 3, user: 2, viewer: 1 };

// ---------------------------------------------------------------------------
// authenticate — verify JWT from httpOnly cookie or Authorization header
// ---------------------------------------------------------------------------
export const authenticate = (req, res, next) => {
    const token =
        req.cookies?.token ||
        req.headers.authorization?.replace(/^Bearer\s+/i, '');

    if (!token) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    try {
        req.user = jwt.verify(token, process.env.JWT_SECRET);
        next();
    } catch (err) {
        // Distinguish expired tokens so the client can prompt re-login
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Session expired — please log in again' });
        }
        return res.status(401).json({ error: 'Invalid token' });
    }
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
