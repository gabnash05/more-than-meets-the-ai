FROM node:24.11.1-bookworm-slim AS node-runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

FROM node-runtime AS build
WORKDIR /repo
COPY apps/api/package.json apps/api/package-lock.json ./apps/api/
COPY packages/game-contracts ./packages/game-contracts
RUN cd apps/api && npm ci
COPY apps/api ./apps/api
RUN cd apps/api && npm run prisma:generate && npm run build

FROM node-runtime AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001 ROOM_STORE=memory
WORKDIR /repo/apps/api
COPY --from=build --chown=node:node /repo/apps/api/package.json ./package.json
COPY --from=build --chown=node:node /repo/apps/api/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/apps/api/dist ./dist
COPY --from=build --chown=node:node /repo/apps/api/prisma ./prisma
COPY --from=build --chown=node:node /repo/apps/api/prisma.config.ts ./prisma.config.ts
USER node
EXPOSE 3001
CMD ["node", "dist/apps/api/src/main.js"]

FROM runtime AS inference
USER root
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN node node_modules/playwright/cli.js install --with-deps --only-shell chromium \
    && rm -rf /var/lib/apt/lists/*
USER node

FROM runtime AS base
