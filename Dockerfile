FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    PROFILE_DIR=/data/profile \
    STATE_DIR=/data/state \
    TZ=Asia/Shanghai \
    CHROME_PATH=/usr/bin/google-chrome-stable

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      xvfb \
      x11vnc \
      novnc \
      websockify \
      fonts-noto-cjk \
      fonts-liberation \
      wget \
    && wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && apt-get install -y /tmp/chrome.deb \
    && rm -rf /tmp/chrome.deb /var/lib/apt/lists/*

RUN if ! id chrome >/dev/null 2>&1; then useradd --create-home --shell /bin/false chrome; fi \
    && printf 'CHROME_UID=%s\nCHROME_GID=%s\nCHROME_HOME=%s\n' \
         "$(id -u chrome)" "$(id -g chrome)" "$(getent passwd chrome | cut -d: -f6)" \
         > /etc/fenxi-chrome.env

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
