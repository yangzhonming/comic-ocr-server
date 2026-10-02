# -------------------------------------------------------------
# Hugging Face Spaces / Cloud Run 极简高性能纯 CPU 容器
# 体积压缩、无 PyTorch、纯 ONNX Runtime、零成本冷启动优化
# -------------------------------------------------------------
FROM python:3.11-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=7860

WORKDIR /app

# 安装最基础的轻量系统依赖 (libglib2.0 与 curl)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# 先复制依赖文件并安装，利用 Docker 缓存层
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 复制模型权重与代码
COPY models/ ./models/
COPY app/ ./app/

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:${PORT}/health || exit 1

EXPOSE 7860

# 启动命令：读取动态注入的 $PORT 环境变量 (默认 7860)
CMD exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --workers 1
