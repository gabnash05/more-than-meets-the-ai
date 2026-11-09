FROM scratch AS npm-archive
ADD --checksum=sha256:8ad8563b81e71b90ef405b140bccf3ba9b5e7884ab210bd49ee4e2f4bc6f61f5 https://registry.npmjs.org/npm/-/npm-11.21.2.tgz /npm.tgz

FROM node:24.22.2-trixie-slim AS build
RUN --mount=type=bind,from=npm-archive,source=/npm.tgz,target=/tmp/npm.tgz \
    apt-get update && apt-get install -y --no-install-recommends zlib1g \
    && rm -rf /var/lib/apt/lists/* /usr/local/lib/node_modules/npm \
    && mkdir -p /usr/local/lib/node_modules/npm \
    && tar -xzf /tmp/npm.tgz --strip-components=1 -C /usr/local/lib/node_modules/npm \
    && test "$(npm --version)" = 11.21.2
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
