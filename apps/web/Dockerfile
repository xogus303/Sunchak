# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# ---- build ----
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/package.json
RUN pnpm install --frozen-lockfile --filter=@sunchak/web...

COPY apps/web ./apps/web
# NEXT_PUBLIC_* 는 런타임이 아니라 빌드 시점에 번들에 박힌다 — 이미지 빌드할 때 값을 넘겨야 함.
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN pnpm --filter @sunchak/web run build

# ---- runtime: standalone 서버 + 정적 자산만 ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# standalone 출력은 outputFileTracingRoot 기준 경로(apps/web/...)를 그대로 보존한다.
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public

USER node
ENV PORT=3000
# 컨테이너 밖(호스트)에서 접속하려면 localhost가 아니라 모든 인터페이스에 바인딩해야 함.
ENV HOSTNAME="0.0.0.0"
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
