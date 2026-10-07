# Control plane: Telegram, tasks, secrets, links. Holds every credential the
# bots must not be able to read, so it is a separate, locked-down container.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p . && npm prune --omit=dev

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/novnc \
 && curl -fsSL https://github.com/novnc/noVNC/archive/refs/tags/v1.5.0.tar.gz \
    | tar -xz -C /opt/novnc --strip-components=1 --wildcards '*/core' '*/vendor'
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public
# Telegram's Mini App client library, served from here so the pages load no third-party script at run time
RUN curl -fsSL https://telegram.org/js/telegram-web-app.js -o public/telegram-web-app.js
COPY test ./test
ENV NODE_ENV=production
USER node
CMD ["node", "dist/index.js"]
