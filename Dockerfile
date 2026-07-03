# =============================================================================
# Kanban Board — Multi-stage Docker build
# =============================================================================

# ---- Stage 1: Install production dependencies --------------------------------
FROM node:20-alpine AS deps
WORKDIR /app

COPY package.json ./

# Install only production dependencies
# Using `npm install --omit=dev` instead of `npm ci` because no lockfile is committed.
# For deterministic builds, commit package-lock.json and switch to `npm ci --omit=dev`.
RUN npm install --omit=dev

# ---- Stage 2: Runtime image --------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app

# Copy production node_modules from the deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source files
COPY server.mjs        ./
COPY package.json      ./
COPY middleware/       ./middleware/
COPY routes/           ./routes/
COPY public/           ./public/

# Copy database scripts (used during initial setup, not at runtime)
COPY schema.sql        ./
COPY columns_default.sql ./
COPY seed_admin.js     ./
COPY migrations/       ./migrations/

# Non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 3000

# Fly.io sends SIGTERM before SIGKILL — Node handles it gracefully by default
CMD ["node", "server.mjs"]
