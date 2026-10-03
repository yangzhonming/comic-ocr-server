# -------------------------------------------------------------
# 阿里云 FC 3.0 / Serverless 极简高性能纯 CPU 容器
# 纯 ONNX Runtime、零系统杂质、原生秒级冷启动
# -------------------------------------------------------------
FROM python:3.11-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=9000 \
    HOME=/tmp

WORKDIR /app

# 1. 配置阿里云官方 Debian 镜像源并安装基础动态链接库 (解决 libxcb/libgl 缺失)
RUN sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || true && \
    apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    libxcb1 \
    libx11-xcb1 \
    && rm -rf /var/lib/apt/lists/*

# 2. 预先安装 Python 依赖库 (使用阿里云官方镜像源秒级高速下载)
# 强制锁定 opencv-python-headless，移除第三方包自动引入的带 GUI 的 opencv-python
COPY requirements.txt .
RUN pip install --no-cache-dir -i https://mirrors.aliyun.com/pypi/simple/ --trusted-host mirrors.aliyun.com -r requirements.txt && \
    pip uninstall -y opencv-python && \
    pip install --no-cache-dir -i https://mirrors.aliyun.com/pypi/simple/ --trusted-host mirrors.aliyun.com "opencv-python-headless>=4.9.0"

# 3. 复制模型权重与应用代码
COPY models/ ./models/
COPY app/ ./app/

# 4. 权限安全适配：确保全目录只读执行权限
RUN chmod -R 755 /app

# 5. 暴露端口 (阿里云 FC 3.0 默认 9000，同时兼容 8000)
EXPOSE 9000
EXPOSE 8000

# 6. 启动服务：自适应读取 PORT (阿里云 FC 默认监听 9000 端口)
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-9000} --workers 1"]
