# syntax=docker/dockerfile:1.7

FROM node:26.5.0-alpine3.24@sha256:e88a35be04478413b7c71c455cd9865de9b9360e1f43456be5951032d7ac1a66 AS dependencies

WORKDIR /app

RUN apk add --no-cache g++ make python3

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && cd node_modules/better-sqlite3 \
    && node /usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js rebuild --release --force_build=1 \
    && rm -rf prebuilds \
    && cd /app \
    && npm cache clean --force

FROM node:26.5.0-alpine3.24@sha256:e88a35be04478413b7c71c455cd9865de9b9360e1f43456be5951032d7ac1a66 AS runtime

ARG VECTOR_BUILD_REVISION=unknown

LABEL org.opencontainers.image.source="https://github.com/ejupi-djenis30/vector-placement-operations" \
      org.opencontainers.image.version="3.4.0" \
      org.opencontainers.image.revision="${VECTOR_BUILD_REVISION}" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    VECTOR_HOST=0.0.0.0 \
    VECTOR_PORT=4173 \
    VECTOR_DB_PATH=/var/lib/vector/vector.sqlite

WORKDIR /app

RUN rm -rf \
      /usr/local/lib/node_modules/npm \
      /usr/local/lib/node_modules/corepack \
      /opt/yarn-v1.22.22 \
    && rm -f \
      /usr/local/bin/npm \
      /usr/local/bin/npx \
      /usr/local/bin/corepack \
      /usr/local/bin/yarn \
      /usr/local/bin/yarnpkg \
      /usr/local/bin/pnpm \
      /usr/local/bin/pnpx

COPY --from=dependencies --chown=root:root /app/node_modules ./node_modules
COPY --chown=root:root package.json package-lock.json ./
COPY --chown=root:root LICENSE /usr/share/licenses/vector/LICENSE
COPY --chown=root:root migrations ./migrations
COPY --chown=root:root server ./server
COPY --chown=root:root site ./site
COPY --chown=root:root \
    scripts/backup-lib.mjs \
    scripts/backup.mjs \
    scripts/cli-args.mjs \
    scripts/compact.mjs \
    scripts/create-admin.mjs \
    scripts/doctor.mjs \
    scripts/inspect-backup.mjs \
    scripts/migrate.mjs \
    scripts/restore.mjs \
    ./scripts/

RUN chown -R root:root /app \
    && chmod -R go-w /app \
    && chmod 0444 /usr/share/licenses/vector/LICENSE \
    && mkdir -p /var/lib/vector \
    && chown node:node /var/lib/vector \
    && chmod 0700 /var/lib/vector

USER node

EXPOSE 4173
VOLUME ["/var/lib/vector"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "const p=process.env.VECTOR_PORT||'4173';fetch('http://127.0.0.1:'+p+'/api/health/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT []
CMD ["node", "server/index.mjs"]
