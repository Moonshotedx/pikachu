# syntax=docker/dockerfile:1

# ---------------------
# Build / runtime stage
# ---------------------
FROM oven/bun:1.2 as app

WORKDIR /app

# Install deps first (for cache efficiency)
COPY package.json bun.lockb* ./
RUN bun install --production --no-progress

# Copy source
COPY . .

# Install timezone data and set default to Asia/Kolkata (IST)
RUN apt-get update \
    && apt-get install -y --no-install-recommends tzdata \
    && rm -rf /var/lib/apt/lists/*

ENV TZ=Asia/Kolkata

# Expose default port
EXPOSE 3000

# Run the server
CMD ["bun", "run", "server.ts"] 