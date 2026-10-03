# -------------------------------------------------------------
# 华为云 FunctionGraph / 容器化 极简高性能纯 CPU 容器
# 体积压缩、无 PyTorch、纯 ONNX Runtime、零成本冷启动优化
# 华为云规范：必须暴露并监听 8000 端口
# -------------------------------------------------------------
FROM python:3.11-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8000

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
    CMD curl -f http://localhost:8000/health || exit 1

EXPOSE 8000

# 启动命令：按照华为云规范直接监听 8000 端口
CMD exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 1
