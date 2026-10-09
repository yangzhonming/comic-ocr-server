#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# 自动释放已占用的 8000 端口，避免 Address already in use 报错
(fuser -k 8000/tcp 2>/dev/null || true); sleep 1

cd "$PROJECT_ROOT"
source .venv/bin/activate

echo "========================================================"
echo "  Comic OCR Server 正在启动..."
echo "  服务端口: 8000"
echo "  接口文档: http://127.0.0.1:8000/docs"
echo "  健康检查: http://127.0.0.1:8000/health"
echo "========================================================"

exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
