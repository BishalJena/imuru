# Build from the repository root: docker build -f apps/gateway/Dockerfile .
FROM node:22.23.3-alpine3.24 AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/gateway/package.json apps/gateway/
RUN pnpm install --frozen-lockfile --filter @urumi/gateway...
COPY tsconfig.base.json ./
COPY apps/gateway apps/gateway
RUN pnpm --filter @urumi/gateway build \
 && pnpm --filter @urumi/gateway deploy --prod /out

FROM node:22.23.3-alpine3.24
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/package.json ./
COPY --from=build --chown=node:node /repo/apps/gateway/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
