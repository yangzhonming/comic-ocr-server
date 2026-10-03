# -------------------------------------------------------------
# 阿里云 FC 3.0 / Serverless 极简高性能纯 CPU 容器
# 纯 ONNX Runtime、零系统杂质、原生秒级冷启动
# -------------------------------------------------------------
FROM python:3.11-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8000 \
    HOME=/tmp

WORKDIR /app

# 1. 配置阿里云官方 Debian 镜像源并安装基础依赖 (libglib2.0)
RUN sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || true && \
    apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# 2. 预先安装 Python 依赖库 (使用阿里云官方镜像源秒级高速下载)
# 采用 --no-deps 安装 rapidocr-onnxruntime，彻底杜绝带 GUI 的 opencv-python 被误拉取
COPY requirements.txt .
RUN pip install --no-cache-dir -i https://mirrors.aliyun.com/pypi/simple/ --trusted-host mirrors.aliyun.com -r requirements.txt && \
    pip install --no-cache-dir --no-deps -i https://mirrors.aliyun.com/pypi/simple/ --trusted-host mirrors.aliyun.com "rapidocr-onnxruntime>=1.3.14"

# 3. 复制模型权重与应用代码
COPY models/ ./models/
COPY app/ ./app/

# 4. 权限安全适配与构建期完整自检验证
RUN chmod -R 755 /app && \
    python -c "import cv2; from rapidocr_onnxruntime import RapidOCR; from app.main import app; print('=== BUILD VERIFIED 100%: ALL MODULES LOADED SUCCESSFULLY ===')"

# 5. 暴露端口 (阿里云 FC 3.0 默认 9000，同时兼容 8000)
EXPOSE 9000
EXPOSE 8000

# 6. 启动服务：自适应读取 PORT (默认监听 8000 端口)
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1"]
