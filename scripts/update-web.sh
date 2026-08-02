#!/usr/bin/env bash
# Ubuntu：拉代码 → 安装依赖 → build:web → 重启 start:web
#
# 用法：
#   chmod +x scripts/update-web.sh
#   ./scripts/update-web.sh
#
# 可选环境变量（可写进同目录上级的 .env.web，或直接 export）：
#   HOST=0.0.0.0
#   PORT=4357
#   QDRANT_URL=http://127.0.0.1:6333
#   QDRANT_STORAGE_PATH=/var/lib/qdrant/storage
#   SKIP_GIT=1          # 不执行 git pull
#   SKIP_INSTALL=1      # 不执行 npm ci/install

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PID_FILE="${PID_FILE:-$ROOT/.qdrant-web.pid}"
LOG_FILE="${LOG_FILE:-$ROOT/qdrant-web.log}"
ENV_FILE="${ENV_FILE:-$ROOT/.env.web}"

echo "==> 项目目录: $ROOT"

# 加载可选环境文件
if [[ -f "$ENV_FILE" ]]; then
  echo "==> 加载环境: $ENV_FILE"
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-4357}"
export QDRANT_URL="${QDRANT_URL:-http://127.0.0.1:6333}"

if [[ -n "${QDRANT_STORAGE_PATH:-}" ]]; then
  export QDRANT_STORAGE_PATH
fi

# 1) 更新代码
if [[ "${SKIP_GIT:-0}" != "1" ]]; then
  if [[ -d .git ]]; then
    echo "==> git pull"
    git pull --ff-only
  else
    echo "==> 未检测到 .git，跳过 git pull（可用 SKIP_GIT=1 静默跳过）"
  fi
else
  echo "==> SKIP_GIT=1，跳过 git pull"
fi

# 2) 依赖
if [[ "${SKIP_INSTALL:-0}" != "1" ]]; then
  echo "==> 安装依赖"
  if [[ -f package-lock.json ]]; then
    npm ci
  else
    npm install
  fi
else
  echo "==> SKIP_INSTALL=1，跳过 npm install"
fi

# 3) 构建网页版
echo "==> npm run build:web"
npm run build:web

# 4) 停旧进程
stop_old() {
  if [[ -f "$PID_FILE" ]]; then
    old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "${old_pid:-}" ]] && kill -0 "$old_pid" 2>/dev/null; then
      echo "==> 停止旧进程 PID=$old_pid"
      kill "$old_pid" 2>/dev/null || true
      sleep 1
      kill -9 "$old_pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
  fi
  # 兜底：按入口脚本杀掉残留
  if command -v pkill >/dev/null 2>&1; then
    pkill -f "node out/main/web.js" 2>/dev/null || true
  fi
}

stop_old

# 5) 启动
echo "==> npm run start:web  (HOST=$HOST PORT=$PORT QDRANT_URL=$QDRANT_URL)"
nohup npm run start:web >>"$LOG_FILE" 2>&1 &
echo $! >"$PID_FILE"

sleep 1
if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "==> 已启动 PID=$(cat "$PID_FILE")"
  echo "==> 日志: $LOG_FILE"
  echo "==> 健康检查: curl -sS http://127.0.0.1:${PORT}/api/health"
  curl -sS "http://127.0.0.1:${PORT}/api/health" || true
  echo
  echo "完成。"
else
  echo "!! 启动失败，请查看日志: $LOG_FILE" >&2
  tail -n 40 "$LOG_FILE" || true
  exit 1
fi
