# Build from the repository root: docker build -f apps/woo-mcp/Dockerfile .
FROM node:22.23.3-alpine3.24 AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/woo-mcp/package.json apps/woo-mcp/
RUN pnpm install --frozen-lockfile --filter @urumi/woo-mcp...
COPY tsconfig.base.json ./
COPY apps/woo-mcp apps/woo-mcp
RUN pnpm --filter @urumi/woo-mcp build \
 && pnpm --filter @urumi/woo-mcp deploy --prod /out

FROM node:22.23.3-alpine3.24
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/package.json ./
COPY --from=build --chown=node:node /repo/apps/woo-mcp/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
