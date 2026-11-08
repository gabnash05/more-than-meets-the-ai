FROM node:24.11.1-bookworm-slim@sha256:48abc13a19400ca3985071e287bd405a1d99306770eb81d61202fb6b65cf0b57 AS build
WORKDIR /repo
COPY apps/web/package.json apps/web/package-lock.json ./apps/web/
COPY packages/game-contracts ./packages/game-contracts
RUN cd apps/web && npm ci
COPY apps/web ./apps/web
ENV NEXT_PUBLIC_ROOM_TRANSPORT=remote NEXT_TELEMETRY_DISABLED=1
RUN cd apps/web && npm run build

FROM nginx:1.28.0-alpine@sha256:30f1c0d78e0ad60901648be663a710bdadf19e4c10ac6782c235200619158284
COPY deploy/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /repo/apps/web/out /usr/share/nginx/html
EXPOSE 8080
