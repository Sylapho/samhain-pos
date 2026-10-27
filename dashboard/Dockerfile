FROM node:24.22.1-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY server/package.json server/pnpm-lock.yaml ./server/
RUN pnpm --dir server install --frozen-lockfile
COPY tsconfig.app.json ./
COPY dashboard ./dashboard
COPY server/tsconfig.json ./server/
COPY server/src ./server/src
RUN pnpm dashboard:build && pnpm --dir server build

FROM base AS dependencies
WORKDIR /app/server
COPY server/package.json server/pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM node:24.22.1-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV DASHBOARD_PORT=4310
WORKDIR /app/server
COPY --from=dependencies --chown=node:node /app/server/node_modules ./node_modules
COPY --from=dependencies --chown=node:node /app/server/package.json ./package.json
COPY --from=build --chown=node:node /app/server/dist ./dist
COPY --from=build --chown=node:node /app/dashboard/dist /app/dashboard/dist
USER node
EXPOSE 4310
STOPSIGNAL SIGTERM
CMD ["node", "--max-old-space-size=384", "dist/dashboard/index.js"]
