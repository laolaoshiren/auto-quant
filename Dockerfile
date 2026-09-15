# syntax=docker/dockerfile:1

# =============================================================================
# auto-quant 生产镜像
#
# 目标：让**非开发人员**在服务器上一条命令就能起服务，而不是克隆源码跑 npm。
#
# 两个阶段：
#   1. web-build —— 用 Vite 构建控制台静态文件
#   2. runtime   —— 只装生产依赖，运行后端
#
# 为什么运行阶段还需要 tsx：
#   `@aq/shared` 的 package.json 里 `exports` 指向 `./src/index.ts`（原始 TypeScript），
#   所以服务端**无法**编译成纯 JS 后运行 —— 它依赖 tsx 在运行时转译。
#   这也是为什么 `tsx` 被放在 `dependencies` 而不是 `devDependencies`：
#   它不是开发工具，它就是生产入口。
# =============================================================================


# -----------------------------------------------------------------------------
# 阶段 1：构建前端控制台
# -----------------------------------------------------------------------------
FROM node:22-slim AS web-build

WORKDIR /app

# 先只拷贝依赖清单。这样只要依赖没变，这一层就能命中缓存，
# 改业务代码不会导致重新下载全部依赖。
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json    ./packages/web/
RUN npm ci --no-audit --no-fund

# 再拷贝源码并构建
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/web    ./packages/web
RUN npm run build --workspace @aq/web


# -----------------------------------------------------------------------------
# 阶段 2：运行
# -----------------------------------------------------------------------------
FROM node:22-slim AS runtime

ENV NODE_ENV=production
# 统一用 UTC：日志时间、资金费结算窗口、K 线边界都按 UTC 对齐，
# 容器时区与宿主不一致会造成难以排查的偏差。
ENV TZ=UTC

WORKDIR /app

# --- 生产依赖 ---------------------------------------------------------------
# --omit=dev 跳过 vite / tailwind / typescript 这些只在构建阶段需要的东西。
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json    ./packages/web/
RUN npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force

# --- 源码 -------------------------------------------------------------------
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/server ./packages/server

# 控制台静态文件来自构建阶段。服务端按 REPO_ROOT/packages/web/dist 查找，
# 容器里 REPO_ROOT 就是 /app（env.ts 从 packages/server/src 向上三级解析）。
COPY --from=web-build /app/packages/web/dist ./packages/web/dist

# --- 非 root 运行 -----------------------------------------------------------
# 这个进程持有可以下真实订单的交易所密钥，不该用 root 跑。
# 用固定 uid/gid 1001，便于挂载卷时对属主。
RUN groupadd --gid 1001 nodejs \
 && useradd --uid 1001 --gid nodejs --create-home --shell /usr/sbin/nologin autoquant \
 && mkdir -p /app/data \
 && chown -R autoquant:nodejs /app

USER autoquant

# 数据库、AES 主密钥、JWT 密钥、日志都在这里。
# 必须挂卷，否则容器重建 = 账户凭据与全部历史丢失。
VOLUME ["/app/data"]

EXPOSE 3200

# 容器内必须绑 0.0.0.0，否则映射出去的端口连不上。
# 对外暴露与否由 compose 的端口映射决定（默认只绑宿主机 127.0.0.1）。
ENV HOST=0.0.0.0
ENV PORT=3200

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3200)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 直接调 tsx 的 CLI，不经过 npm。
# npm 会多包一层进程，signal 传递不直接，docker stop 就不能干净地触发优雅关闭。
CMD ["node", "node_modules/tsx/dist/cli.mjs", "packages/server/src/index.ts"]
