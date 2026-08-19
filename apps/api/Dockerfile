# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# ---- build: 전체(dev 포함) 의존성으로 컴파일 ----
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/package.json
# --filter=...  : 이 워크스페이스가 실제로 의존하는 패키지만 설치(web 쪽 의존성은 안 받아옴)
RUN pnpm install --frozen-lockfile --filter=@sunchak/api...

COPY apps/api ./apps/api
RUN pnpm --filter @sunchak/api exec prisma generate
RUN pnpm --filter @sunchak/api run build
# devDependencies(typescript 등)를 pnpm prune으로 제거하고 싶었지만, pnpm의
# 하드링크 스토어 구조와 Prisma의 제자리 코드 생성이 충돌해 prune 이후
# Prisma Client가 "생성 전" 상태로 리셋되는 버그를 실측으로 확인했다(2026-08-19).
# devDependencies를 이미지에 남기는 대신 정확성을 택함 — VM 디스크는 30GB로 여유 있음.

# ---- runtime: 컴파일 결과물 + 프로덕션 의존성만 ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/apps/api/prisma ./apps/api/prisma
COPY --from=build --chown=node:node /app/apps/api/package.json ./apps/api/package.json

WORKDIR /app/apps/api
USER node
EXPOSE 3001
CMD ["node", "dist/main.js"]
