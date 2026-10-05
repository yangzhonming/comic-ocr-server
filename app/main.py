import time
from contextlib import asynccontextmanager
from typing import Optional
import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, status, Body
from fastapi.middleware.cors import CORSMiddleware

from app.engine import engine_manager
from app.schemas import HealthResponse, SliceResponse


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 启动时预热常用语种模型 (韩语)，消除首次请求的冷启动开销
    print("[ComicServer] 正在预热 ONNX Runtime 引擎...")
    warmed = engine_manager.warmup(["kr"])
    print(f"[ComicServer] 引擎预热完成，已激活语种: {warmed}")
    yield
    print("[ComicServer] 服务关闭，释放资源。")


app = FastAPI(
    title="Comic OCR Server",
    description="轻量级、无状态、面向 Serverless 极致优化的漫画 OCR 及文本样式提取微服务",
    version="1.0.0",
    lifespan=lifespan
)

# 允许浏览器插件及网页跨域请求
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/", summary="根路由")
async def root():
    return {
        "service": "comic-ocr-server",
        "version": "1.0.0",
        "status": "running"
    }


@app.get("/health", response_model=HealthResponse, summary="健康检查")
async def health():
    return HealthResponse(
        status="ok",
        version="1.0.0",
        device="cpu",
        loaded_models=list(engine_manager._engines.keys())
    )


@app.post(
    "/api/v1/slice",
    response_model=SliceResponse,
    summary="单切片流式 OCR 提取接口"
)
@app.post(
    "/slice",
    response_model=SliceResponse,
    include_in_schema=False  # 别名路由，兼容旧版本接口路径
)
async def process_slice_endpoint(
    file: UploadFile = File(..., description="切片图像二进制文件 (JPEG/PNG)"),
    slice_index: int = Form(..., description="切片序号 (0, 1, 2...)"),
    start_y: int = Form(0, description="切片在整话总画布上的起始绝对 Y 像素坐标"),
    end_y: Optional[int] = Form(None, description="切片在整话总画布上的结束绝对 Y 像素坐标 (可选)"),
    lang: str = Form("kr", description="目标识别语种 (kr, en, jp, ru, zh)")
):
    t_start = time.perf_counter()

    try:
        content = await file.read()
        if not content:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="上传的文件为空"
            )

        # 内存解码，免去磁盘 I/O
        np_arr = np.frombuffer(content, np.uint8)
        image = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
        if image is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="无法解析该图像文件，请确保格式为有效的 JPEG/PNG"
            )

        # 执行端到端识别流水线
        bubbles = engine_manager.process_slice(
            image=image,
            lang=lang,
            start_y=start_y
        )

        cost_ms = (time.perf_counter() - t_start) * 1000.0

        return SliceResponse(
            code=0,
            message="success",
            slice_index=slice_index,
            start_y=start_y,
            cost_ms=round(cost_ms, 2),
            bubbles=bubbles
        )

    except HTTPException:
        raise
    except Exception as e:
        cost_ms = (time.perf_counter() - t_start) * 1000.0
        print(f"[ComicServer] 处理切片 #{slice_index} 异常: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"OCR 处理异常: {str(e)}"
        )


@app.post("/coordinates", summary="长漫章节全局坐标系接收与同步")
async def receive_coordinates(data: Optional[dict] = Body(default=None)):
    """接收前端上报的整话长卷画布尺寸与原图分布"""
    return {"code": 0, "message": "coordinates registered"}

