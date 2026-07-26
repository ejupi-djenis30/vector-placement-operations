# syntax=docker/dockerfile:1.7

FROM node:26.5.0-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb AS dependencies

WORKDIR /app

RUN apt-get update \
    && apt-get install --yes --no-install-recommends g++ make python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

FROM node:26.5.0-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb AS runtime

ARG VECTOR_BUILD_REVISION=unknown

LABEL org.opencontainers.image.source="https://github.com/ejupi-djenis30/vector-placement-operations" \
      org.opencontainers.image.version="3.0.0" \
      org.opencontainers.image.revision="${VECTOR_BUILD_REVISION}" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    VECTOR_HOST=0.0.0.0 \
    VECTOR_PORT=4173 \
    VECTOR_DB_PATH=/var/lib/vector/vector.sqlite

WORKDIR /app

COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node server ./server
COPY --chown=node:node site ./site
COPY --chown=node:node \
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

RUN mkdir -p /var/lib/vector \
    && chown node:node /var/lib/vector \
    && chmod 0700 /var/lib/vector

USER node

EXPOSE 4173
VOLUME ["/var/lib/vector"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "const p=process.env.VECTOR_PORT||'4173';fetch('http://127.0.0.1:'+p+'/api/health/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "server/index.mjs"]
