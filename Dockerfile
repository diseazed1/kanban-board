# =============================================================================
# Kanban Board — Multi-stage Docker build (FIXED & OPTIMIZED)
# =============================================================================

# ---- Stage 1: Install production dependencies --------------------------------
FROM node:20-alpine AS deps
WORKDIR /app

COPY package*.json ./
# Use npm install to ensure it works even if the lockfile is missing/incomplete
RUN npm install --omit=dev

# ---- Stage 2: Runtime image --------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app

# Set production environment for optimized performance
ENV NODE_ENV=production

# Create a non-root user and group first
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copy production node_modules from the deps stage with correct ownership
COPY --from=deps --chown=appuser:appgroup /app/node_modules ./node_modules

# Copy application source files with correct ownership
COPY --chown=appuser:appgroup server.mjs package.json ./
COPY --chown=appuser:appgroup middleware/ ./middleware/
COPY --chown=appuser:appgroup routes/ ./routes/
COPY --chown=appuser:appgroup public/ ./public/

# Copy database scripts (used during initial setup, not at runtime)
COPY --chown=appuser:appgroup schema.sql columns_default.sql seed_admin.js ./

# Switch to non-root user
USER appuser

EXPOSE 3000

# Fly.io sends SIGTERM before SIGKILL — Node handles it gracefully by default
CMD ["node", "server.mjs"]