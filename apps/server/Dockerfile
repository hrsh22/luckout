# Build from the repo root: docker build -f apps/server/Dockerfile .
FROM node:24-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/api/package.json packages/api/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --prod --filter "@luckout/server..."
COPY packages/api packages/api
COPY apps/server/src apps/server/src
# Only used when DATABASE_URL is unset (PGlite); Compose always sets it.
RUN mkdir -p apps/server/.data && chown node apps/server/.data
WORKDIR /app/apps/server
ENV NODE_ENV=production
USER node
EXPOSE 8787
CMD ["node", "src/main.ts"]
