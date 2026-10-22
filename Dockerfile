FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    PROFILE_DIR=/data/profile \
    STATE_DIR=/data/state \
    TZ=Asia/Shanghai

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      xvfb \
      x11vnc \
      novnc \
      websockify \
      fonts-noto-cjk \
      fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npx playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

COPY . .
RUN chmod +x /app/scripts/entrypoint.sh \
    && mkdir -p /data/profile /data/state

EXPOSE 8080 6080
ENTRYPOINT ["bash", "/app/scripts/entrypoint.sh"]
