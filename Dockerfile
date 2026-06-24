# =============================================================================
# Kanban Board — Multi-stage Docker build (FIXED & OPTIMIZED)
# =============================================================================

# ---- Stage 1: Install production dependencies --------------------------------
FROM node:20-alpine AS deps
WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

# ---- Stage 2: Runtime image --------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY --from=deps --chown=appuser:appgroup /app/node_modules ./node_modules

COPY --chown=appuser:appgroup server.mjs package.json ./
COPY --chown=appuser:appgroup middleware/ ./middleware/
COPY --chown=appuser:appgroup routes/ ./routes/
COPY --chown=appuser:appgroup public/ ./public/

COPY --chown=appuser:appgroup schema.sql columns_default.sql seed_admin.js ./

USER appuser

EXPOSE 3000

CMD ["node", "server.mjs"]