FROM node:24.22.2-trixie-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends zlib1g \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --no-audit --no-fund --cache /tmp/npm-cache npm@11.21.2 \
    && rm -rf /tmp/npm-cache
WORKDIR /repo
COPY apps/web/package.json apps/web/package-lock.json ./apps/web/
COPY packages/game-contracts ./packages/game-contracts
RUN cd apps/web && npm ci
COPY apps/web ./apps/web
ENV NEXT_PUBLIC_ROOM_TRANSPORT=remote NEXT_TELEMETRY_DISABLED=1
RUN cd apps/web && npm run build

FROM nginx:1.30.6-alpine
COPY deploy/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /repo/apps/web/out /usr/share/nginx/html
EXPOSE 8080
