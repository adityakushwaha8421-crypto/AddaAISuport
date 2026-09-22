# Playwright's image ships Chromium + its system dependencies (needed for ADMIN_MODE=playwright).
FROM mcr.microsoft.com/playwright:v1.63.0-noble AS base
WORKDIR /app
ENV NODE_ENV=production

FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM base
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY config ./config
# secrets/ (Telegram session, admin browser state) must be a mounted volume, never baked in.
RUN mkdir -p /app/secrets && chown -R pwuser:pwuser /app
USER pwuser
ENV FFMPEG_PATH=/usr/bin/ffmpeg HTTP_PORT=9464 HTTP_HOST=0.0.0.0
EXPOSE 9464
CMD ["node", "dist/index.js"]
