# -------------------------------------------------------------
# 华为云 FunctionGraph / SWR 容器镜像云端自动构建规格
# 纯 CPU 极致优化、无 PyTorch、纯 ONNX Runtime、零成本毫秒级启动
# 华为云规范要求：
# 1. 必须监听并暴露 8000 端口 (0.0.0.0:8000)
# 2. 支持非 root 用户 (云端默认 uid 1003:gid 1003) 安全运行
# 3. 采用标准 Exec 数组格式启动服务终端
# -------------------------------------------------------------
FROM python:3.11-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8000 \
    HOME=/tmp

WORKDIR /app

# 1. 配置国内镜像源加速并安装最轻量系统依赖 (libglib2.0 与 curl)
RUN sed -i 's/deb.debian.org/mirrors.ustc.edu.cn/g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || true && \
    apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# 2. 预先安装 Python 依赖库 (配置清华源加速国内构建，利用 Docker 缓存层)
COPY requirements.txt .
RUN pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple -r requirements.txt

# 3. 复制模型权重与应用代码
COPY models/ ./models/
COPY app/ ./app/

# 4. 华为云安全权限适配：确保全目录对 uid 1003 (及任何非 root 用户) 具有完全只读执行权限
RUN chmod -R 755 /app

# 5. 健康检查探针
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

# 6. 华为云 FunctionGraph 强制要求开放 8000 端口
EXPOSE 8000

# 7. 华为云服务终端启动规范：使用 JSON 数组形式运行，确保信号捕获与标准进程托管
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
