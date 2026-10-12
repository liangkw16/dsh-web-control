ARG NODE_IMAGE=docker.io/library/node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
FROM ${NODE_IMAGE} AS build
WORKDIR /build
RUN npm install -g pnpm@11.25.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @dsh-web-control/relay build
# Intentional legacy deploy: isolated production dependency tree; no injected workspace packages.
RUN pnpm --filter @dsh-web-control/relay deploy --legacy --prod /out
COPY release-input/web /out/public
RUN node --input-type=module -e "import {verifyUiRelease} from '/out/dist/ui-assets.js'; await verifyUiRelease('/out/public')"
RUN cd /out && node --input-type=module -e "import Database from 'better-sqlite3'; const db=new Database(':memory:'); console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,sqlite:db.prepare('select sqlite_version() v').get().v})); db.close()"
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production PORT=8787 LISTEN_HOST=0.0.0.0 STATIC_DIR=/app/public
WORKDIR /app
COPY --from=build --chown=node:node /out ./
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 CMD ["node", "dist/cli.js", "healthcheck"]
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["serve"]
