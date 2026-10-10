# Build from the repository root: docker build -f apps/provisioner/Dockerfile .
FROM node:22.23.3-alpine3.24 AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/provisioner/package.json apps/provisioner/
RUN pnpm install --frozen-lockfile --filter @urumi/provisioner...
COPY tsconfig.base.json ./
COPY apps/provisioner apps/provisioner
RUN pnpm --filter @urumi/provisioner build \
 && pnpm --filter @urumi/provisioner deploy --prod /out

FROM node:22.23.3-alpine3.24 AS helm
ARG TARGETARCH
ARG HELM_VERSION=v4.3.0
ARG HELM_SHA256_amd64=86584a54def73570558f66f5111cc53dfed56689637ae32c1201205d494f54fb
ARG HELM_SHA256_arm64=31c5794dd55c66a51e6b7d2e2ac7a114ae8b1de41ff1d9ba51748ac973b06a08
RUN wget -q -O /tmp/helm.tgz "https://get.helm.sh/helm-${HELM_VERSION}-linux-${TARGETARCH}.tar.gz" \
 && eval "expected=\$HELM_SHA256_${TARGETARCH}" \
 && echo "${expected}  /tmp/helm.tgz" | sha256sum -c - \
 && tar -xzf /tmp/helm.tgz -C /tmp && mv /tmp/linux-${TARGETARCH}/helm /usr/local/bin/helm

FROM node:22.23.3-alpine3.24
ENV NODE_ENV=production
WORKDIR /app
COPY --from=helm /usr/local/bin/helm /usr/local/bin/helm
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/package.json ./
COPY --from=build --chown=node:node /repo/apps/provisioner/dist ./dist
COPY charts/store /charts/store
USER node
# helm writes its cache and config under HOME; /tmp is an emptyDir.
ENV HOME=/tmp
EXPOSE 8081
CMD ["node", "dist/index.js"]
