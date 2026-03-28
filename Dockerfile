# Stage 1: Build TypeScript
FROM oven/bun:1 AS builder

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

COPY tsconfig.json ./
COPY src/ src/
RUN bun run build

# Stage 2: Runtime
FROM oven/bun:1-slim

ARG TARGETARCH

WORKDIR /app

# Install curl for health checks
RUN apt-get update && apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock* ./
RUN bun install --production --frozen-lockfile || bun install --production

# Copy compiled output
COPY --from=builder /app/dist/ dist/

# Copy client assets (served directly, not compiled)
COPY src/client/ src/client/

# Copy vendor directory — must be pre-populated before docker build
# In CI, this is done by the VSIX extraction step
COPY vendor/ vendor/

# Replace binary with correct platform version and clean up
RUN BINARY_DIR="vendor/claude-code/resources/native-binary" && \
    if [ -f "$BINARY_DIR/claude-${TARGETARCH}" ]; then \
      mv "$BINARY_DIR/claude-${TARGETARCH}" "$BINARY_DIR/claude"; \
    fi && \
    rm -f "$BINARY_DIR/claude-amd64" "$BINARY_DIR/claude-arm64" 2>/dev/null; \
    chmod +x "$BINARY_DIR/claude" 2>/dev/null || true

# Non-root user for security
RUN groupadd -r claude && useradd -r -g claude -m claude && \
    chown -R claude:claude /app
USER claude
ENV HOME=/home/claude

# Create .claude directory for session storage
RUN mkdir -p /home/claude/.claude/projects

ENV NODE_ENV=production
EXPOSE 7860

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:7860/ || exit 1

CMD ["bun", "dist/server/index.js"]
