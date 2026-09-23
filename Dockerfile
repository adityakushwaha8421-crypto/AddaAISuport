FROM node:22-slim AS base
WORKDIR /app
ENV NODE_ENV=production

FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM base
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# secrets/ (Telegram session) and data/ (bot ON/OFF state) must be mounted volumes, never baked in.
RUN mkdir -p /app/secrets /app/data && chown -R node:node /app
USER node
ENV HTTP_PORT=9464 HTTP_HOST=0.0.0.0
EXPOSE 9464
CMD ["node", "dist/index.js"]
