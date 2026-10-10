# Build from the repository root: docker build -f apps/dashboard/Dockerfile .
FROM node:22.23.3-alpine3.24 AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/dashboard/package.json apps/dashboard/
RUN pnpm install --frozen-lockfile --filter @urumi/dashboard...
COPY tsconfig.base.json ./
COPY apps/dashboard apps/dashboard
RUN pnpm --filter @urumi/dashboard build

FROM nginxinc/nginx-unprivileged:1.30.4-alpine3.24
COPY apps/dashboard/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/dashboard/dist /usr/share/nginx/html
EXPOSE 8080
