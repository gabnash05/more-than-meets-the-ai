FROM node:24.11.1-bookworm-slim AS build
WORKDIR /repo
COPY apps/web/package.json apps/web/package-lock.json ./apps/web/
COPY packages/game-contracts ./packages/game-contracts
RUN cd apps/web && npm ci
COPY apps/web ./apps/web
ENV NEXT_PUBLIC_ROOM_TRANSPORT=remote NEXT_TELEMETRY_DISABLED=1
RUN cd apps/web && npm run build

FROM nginx:1.28.0-alpine
COPY deploy/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /repo/apps/web/out /usr/share/nginx/html
EXPOSE 8080
