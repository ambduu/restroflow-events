# One image per service:  docker build --build-arg SERVICE=ingest -t restroflow-ingest .
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig*.json ./
COPY packages ./packages
COPY services ./services
RUN npm ci && npx tsc -b && npm prune --omit=dev

FROM node:22-bookworm-slim
ARG SERVICE
ENV NODE_ENV=production SERVICE=${SERVICE}
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/services/${SERVICE} ./services/${SERVICE}
USER node
CMD ["sh", "-c", "node services/$SERVICE/dist/server.js"]
