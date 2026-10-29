# One image per service:  docker build --build-arg SERVICE=ingest -t restroflow-ingest .
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig*.json ./
COPY packages ./packages
COPY services ./services
COPY apps ./apps
RUN npm ci && npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ARG SERVICE
ENV NODE_ENV=production SERVICE=${SERVICE}
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/services/${SERVICE} ./services/${SERVICE}
# the analytics service also serves the dashboard (harmless for ingest)
COPY --from=build /app/apps/dashboard/dist ./apps/dashboard/dist
USER node
CMD ["sh", "-c", "node services/$SERVICE/dist/server.js"]
