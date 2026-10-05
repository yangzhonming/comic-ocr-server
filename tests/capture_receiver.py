"""Test Capture Receiver (用于收集真实切片作为 CTD/OCR 测试素材).

功能：
1. 监听端口 8765（匹配前端 Chrome 插件默认配置）
2. 接收 /coordinates 与 /slice 请求
3. 将切片图片保存到 tests/data/{chapter_id}/
4. 记录完整的批次信息、切片清单与绝对 Y 坐标到 manifest.json
"""

from __future__ import annotations

import json
import os
import re
import threading
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

BASE_DIR = Path(__file__).resolve().parent
TEST_DATA_DIR = BASE_DIR / "data"
TEST_DATA_DIR.mkdir(parents=True, exist_ok=True)

MAX_UPLOAD_BYTES = 40 * 1024 * 1024  # 40 MiB
_lock = threading.Lock()

app = FastAPI(title="Test Comic Capture Receiver", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


def safe_name(value: str, fallback: str = "chapter") -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", str(value)).strip("._-")
    return (cleaned or fallback)[:100]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def atomic_write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(path.suffix + ".tmp")
    temp_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    temp_path.replace(path)


def load_manifest(directory: Path, chapter_id: str) -> dict:
    manifest_path = directory / "manifest.json"
    if manifest_path.exists():
        try:
            return json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {
        "chapter_id": chapter_id,
        "coordinate_id": chapter_id,
        "canvas_width": 0,
        "total_height": 0,
        "stats": {
            "total_batches_received": 0,
            "total_slices_received": 0,
            "is_completed": False,
            "last_updated_at": now_iso(),
        },
        "batches": {},
        "slices": {},
    }


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "service": "comic-test-capture-receiver",
        "save_directory": str(TEST_DATA_DIR),
    }


@app.post("/coordinates")
async def receive_coordinates(request: Request) -> dict:
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(status_code=422, detail="Invalid JSON body")

    if not isinstance(data, dict):
        raise HTTPException(status_code=422, detail="Data must be an object")

    chapter_id = safe_name(data.get("chapter_id", data.get("coordinateId", "demo")))
    chapter_dir = TEST_DATA_DIR / chapter_id

    with _lock:
        chapter_dir.mkdir(parents=True, exist_ok=True)
        # 保存原始坐标系快照
        atomic_write_json(chapter_dir / "coordinates.json", data)

        # 同步更新 manifest.json
        manifest = load_manifest(chapter_dir, chapter_id)
        manifest["canvas_width"] = data.get("width", manifest["canvas_width"])
        manifest["total_height"] = data.get("totalHeight", manifest["total_height"])
        manifest["coordinate_id"] = data.get("coordinateId", manifest["coordinate_id"])
        manifest["stats"]["last_updated_at"] = now_iso()
        atomic_write_json(chapter_dir / "manifest.json", manifest)

    print(f"📐 [坐标系就绪] 章节: {chapter_id} | 宽: {manifest['canvas_width']}px | 总高: {manifest['total_height']}px")
    return {"status": "saved", "chapter_id": chapter_id}


@app.post("/slice")
async def receive_slice(
    file: UploadFile = File(...),
    chapter_id: str = Form(...),
    coordinate_id: str = Form(...),
    slice_index: int = Form(...),
    start_y: int = Form(...),
    end_y: int = Form(...),
    width: int = Form(...),
    height: int = Form(...),
    source_pages: str = Form("[]"),
    cut_method: str = Form("standard"),
    batch_index: int = Form(1),
    is_final_batch: bool = Form(False),
) -> dict:
    if slice_index < 1 or start_y < 0 or end_y <= start_y:
        raise HTTPException(status_code=422, detail="Invalid slice coordinates")

    image_bytes = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(image_bytes) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Slice exceeds 40MiB")
    if not image_bytes.startswith(b"\xff\xd8\xff"):
        raise HTTPException(status_code=415, detail="Expected JPEG image")

    try:
        pages = json.loads(source_pages)
        if not isinstance(pages, list):
            pages = []
    except Exception:
        pages = []

    safe_cid = safe_name(chapter_id)
    chapter_dir = TEST_DATA_DIR / safe_cid
    if file.filename and ("切片" in file.filename or file.filename.startswith("slice_")):
        filename = file.filename
    else:
        filename = f"slice_{slice_index:06d}_Y{start_y:09d}_{end_y:09d}.jpg"

    with _lock:
        chapter_dir.mkdir(parents=True, exist_ok=True)
        # 1. 写入切片图片文件
        target_path = chapter_dir / filename
        temp_img_path = chapter_dir / (filename + ".tmp")
        temp_img_path.write_bytes(image_bytes)
        temp_img_path.replace(target_path)

        # 2. 读取并更新 manifest.json
        manifest = load_manifest(chapter_dir, safe_cid)
        if manifest["canvas_width"] == 0:
            manifest["canvas_width"] = width

        batch_key = str(batch_index)
        now_str = now_iso()

        # 更新批次信息
        if batch_key not in manifest["batches"]:
            manifest["batches"][batch_key] = {
                "batch_index": batch_index,
                "slice_count": 0,
                "slice_indices": [],
                "is_final_batch": is_final_batch,
                "first_received_at": now_str,
                "completed_at": now_str,
            }

        b_entry = manifest["batches"][batch_key]
        if slice_index not in b_entry["slice_indices"]:
            b_entry["slice_indices"].append(slice_index)
            b_entry["slice_indices"].sort()
            b_entry["slice_count"] = len(b_entry["slice_indices"])
        b_entry["is_final_batch"] = b_entry["is_final_batch"] or is_final_batch
        b_entry["completed_at"] = now_str

        # 更新切片明细信息
        manifest["slices"][str(slice_index)] = {
            "slice_index": slice_index,
            "batch_index": batch_index,
            "filename": filename,
            "coordinates": {
                "start_y": start_y,
                "end_y": end_y,
                "height": height,
                "width": width,
            },
            "source_pages": pages,
            "cut_method": cut_method,
            "file_size_bytes": len(image_bytes),
            "received_at": now_str,
        }

        # 更新统计
        manifest["stats"]["total_batches_received"] = len(manifest["batches"])
        manifest["stats"]["total_slices_received"] = len(manifest["slices"])
        manifest["stats"]["is_completed"] = any(b.get("is_final_batch") for b in manifest["batches"].values())
        manifest["stats"]["last_updated_at"] = now_str

        # 原子落盘
        atomic_write_json(chapter_dir / "manifest.json", manifest)

    print(
        f"💾 [切片保存] #{slice_index:02d} (批次 #{batch_index}) | "
        f"Y={start_y}~{end_y}px ({height}px) | {len(image_bytes)/1024:.1f} KB -> {filename}"
    )

    return {
        "status": "saved",
        "slice_index": slice_index,
        "batch_index": batch_index,
        "filename": filename,
        "is_final_batch": is_final_batch,
    }


if __name__ == "__main__":
    print(f"🚀 [测试切片接收器] 启动中... 监听: http://0.0.0.0:8765")
    print(f"📂 切片保存目标目录: {TEST_DATA_DIR}")
    uvicorn.run(app, host="0.0.0.0", port=8765, log_level="warning")
