FROM scratch AS npm-archive
ADD --checksum=sha256:8ad8563b81e71b90ef405b140bccf3ba9b5e7884ab210bd49ee4e2f4bc6f61f5 https://registry.npmjs.org/npm/-/npm-11.21.2.tgz /npm.tgz

FROM node:24.22.2-trixie-slim AS node-runtime
RUN --mount=type=bind,from=npm-archive,source=/npm.tgz,target=/tmp/npm.tgz \
    apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl zlib1g \
    && rm -rf /var/lib/apt/lists/* /usr/local/lib/node_modules/npm \
    && mkdir -p /usr/local/lib/node_modules/npm \
    && tar -xzf /tmp/npm.tgz --strip-components=1 -C /usr/local/lib/node_modules/npm \
    && test "$(npm --version)" = 11.21.2

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
