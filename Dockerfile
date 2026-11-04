# Multi-stage production build for TeleDrive Server & Web SPA
FROM node:22-alpine AS builder

WORKDIR /app

# Install build dependencies for native sqlite3 bindings
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/

RUN npm ci

COPY server/ ./server/
COPY web/ ./web/

# Build Web SPA and Server TypeScript
RUN npm run build -w web
RUN npm run build -w server

# Production runtime stage
FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0
ENV DATA_DIR=/app/data

RUN apk add --no-cache curl

# Only install production dependencies for server
COPY server/package.json ./package.json
RUN npm install --omit=dev

# Copy built server and web distributions
COPY --from=builder /app/server/dist ./dist
COPY --from=builder /app/server/src/db/migrations ./dist/db/migrations
COPY --from=builder /app/web/dist ./web-dist

# Create data directory and permissions
RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:8080/api/health || exit 1

CMD ["node", "dist/index.js"]
