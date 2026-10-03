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

# 1. 预先安装 Python 依赖库 (使用阿里云官方镜像源秒级高速下载，无跨网抖动)
COPY requirements.txt .
RUN pip install --no-cache-dir -i https://mirrors.aliyun.com/pypi/simple/ --trusted-host mirrors.aliyun.com -r requirements.txt

# 2. 复制模型权重与应用代码
COPY models/ ./models/
COPY app/ ./app/

# 3. 权限安全适配：确保全目录只读执行权限
RUN chmod -R 755 /app

# 4. 暴露端口 (阿里云 FC 3.0 默认 9000，同时兼容 8000)
EXPOSE 9000
EXPOSE 8000

# 5. 启动服务：自适应读取 PORT (阿里云 FC 默认监听 9000 端口)
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-9000} --workers 1"]
