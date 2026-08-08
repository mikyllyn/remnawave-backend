FROM alpine:3.19 AS frontend
WORKDIR /opt/frontend

# The frontend ships as a release zip rather than being built here. Since the
# frontend repo is private, a token-bearing curl from inside the build is
# unreliable — private release assets are only reachable through the API asset
# endpoint, not the /releases/latest/download/ redirect. So the zip is fetched
# outside Docker and handed over in the build context instead:
#
#     ./scripts/fetch-frontend.sh [tag]
#
# CI does the same via `gh release download` — see build-and-push.yml.
COPY frontend.zip ./frontend.zip

RUN apk add --no-cache curl unzip ca-certificates \
    && unzip frontend.zip -d frontend_temp \
    && curl -L https://validator.remna.dev/wasm_exec.js -o frontend_temp/dist/assets/wasm_exec.js \
    && curl -L https://validator.remna.dev/xray.schema.json -o frontend_temp/dist/assets/xray.schema.json \
    && curl -L https://validator.remna.dev/xray.schema.cn.json -o frontend_temp/dist/assets/xray.schema.cn.json \
    && curl -L https://validator.remna.dev/main.wasm -o frontend_temp/dist/assets/main.wasm

FROM node:24.18-trixie-slim AS backend-build
WORKDIR /opt/app

COPY package*.json ./
COPY prisma ./prisma
COPY rspack.config.mjs ./
COPY prisma.config.ts ./prisma.config.ts
COPY @types ./@types

# Must land before npm ci: the postinstall hook runs patch-package, and with no
# patches/ directory present it is a silent no-op. The patches widen xray-typed
# and @remnawave/node-contract to know about the fedarisha protocol, and rspack
# does typecheck, so without them the build fails on the fedarisha branches.
COPY patches ./patches

RUN npm ci --prefer-offline --no-audit --no-fund

COPY tsconfig*.json ./
COPY src ./src
COPY libs ./libs

RUN npm run migrate:generate \
    && npm run build \
    && npm prune --omit=dev \
    && npm cache clean --force

RUN cd node_modules/@prisma/client/runtime && \
    find . -maxdepth 1 -type f ! -name 'library.js' ! -name 'package.json' -delete && \
    cd /opt/app/node_modules/.prisma/client && \
    find . -maxdepth 1 -type f \
      \( -name 'edge.*' -o -name 'index-browser.js' -o -name 'wasm.*' \
         -o -name 'query_engine_bg.*' -o -name '*-loader.mjs' \) -delete && \
    cd /opt/app && \
    rm -rf node_modules/typescript \
           node_modules/effect/dist/esm \
           node_modules/effect/dist/dts \
           node_modules/effect/src && \
    find node_modules \( -name '*.js.map' -o -name '*.mjs.map' \) -delete && \
    find node_modules \( -name '*.d.ts' -o -name '*.d.cts' -o -name '*.d.mts' \) -delete

FROM node:24.18-trixie-slim

LABEL org.opencontainers.image.title="Remnawave"
LABEL org.opencontainers.image.description="Powerful proxy management tool"
LABEL org.opencontainers.image.url="https://github.com/remnawave/backend"
LABEL org.opencontainers.image.source="https://github.com/remnawave/backend"
LABEL org.opencontainers.image.vendor="Remnawave"
LABEL org.opencontainers.image.licenses="AGPL-3.0"
LABEL org.opencontainers.image.documentation="https://docs.rw"

WORKDIR /opt/app

ARG BRANCH=main
ARG __RW_METADATA_VERSION=1.1.1
ARG __RW_METADATA_GIT_BACKEND_COMMIT=0f344f388807f5323b49024a563b3f8146d66857
ARG __RW_METADATA_GIT_FRONTEND_COMMIT=0f344f388807f5323b49024a563b3f8146d66857
ARG __RW_METADATA_GIT_BRANCH=dev
ARG __RW_METADATA_BUILD_TIME=2011-11-11T11:11:11Z
ARG __RW_METADATA_BUILD_NUMBER=0

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

ENV REMNAWAVE_BRANCH=${BRANCH}
ENV PRISMA_HIDE_UPDATE_MESSAGE=true
ENV PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1
ENV PM2_DISABLE_VERSION_CHECK=true
ENV NODE_OPTIONS="--max-old-space-size=16384"
ENV __RW_METADATA_VERSION=${__RW_METADATA_VERSION}
ENV __RW_METADATA_GIT_BACKEND_COMMIT=${__RW_METADATA_GIT_BACKEND_COMMIT}
ENV __RW_METADATA_GIT_FRONTEND_COMMIT=${__RW_METADATA_GIT_FRONTEND_COMMIT}
ENV __RW_METADATA_GIT_BRANCH=${__RW_METADATA_GIT_BRANCH}
ENV __RW_METADATA_BUILD_TIME=${__RW_METADATA_BUILD_TIME}
ENV __RW_METADATA_BUILD_NUMBER=${__RW_METADATA_BUILD_NUMBER}

COPY --from=backend-build /opt/app/dist ./dist
COPY --from=frontend /opt/frontend/frontend_temp/dist ./frontend
COPY --from=backend-build /opt/app/prisma/generated ./prisma/generated
COPY --from=backend-build /opt/app/prisma/migrations ./prisma/migrations
COPY --from=backend-build /opt/app/prisma/schema.prisma ./prisma/schema.prisma
COPY --from=backend-build /opt/app/node_modules ./node_modules

COPY configs /var/lib/remnawave/configs
COPY package*.json ./
COPY prisma.config.ts ./prisma.config.ts
COPY ecosystem.config.js ./
COPY docker-entrypoint.sh ./

RUN npm install -g pm2 \
    && chmod +x /opt/app/dist/cli.js \
    && ln -s /opt/app/dist/cli.js /usr/local/bin/cli \
    && rm -rf /usr/local/lib/node_modules/npm \
        /usr/local/lib/node_modules/corepack \
        /usr/local/bin/npm \
        /usr/local/bin/npx \
        /usr/local/bin/corepack \
        /usr/local/include/node

ENTRYPOINT [ "/bin/sh", "docker-entrypoint.sh" ]
CMD [ "pm2-runtime", "start", "ecosystem.config.js", "--env", "production" ]