"""
debug_inspect_server.py - 漫画流式切片与 OCR 算法演练后端服务
专为算法演练页面提供参数化探针接口，支持动态配置 DET / REC / 连通性参数并输出逐帧诊断数据。
运行于 tests/ 目录下，已被 .dockerignore 排除，绝不污染生产构建。
"""

import os
import sys
import time
import base64
from pathlib import Path
from typing import List, Dict, Any, Optional

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
import uvicorn

# 确保能导入 app/
ROOT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT_DIR))

from app.engine import engine_manager
from app.styling import extract_colors_fast, compute_fill_ratio, estimate_font_weight
from app.clustering import should_merge_detailed

HTML_PATH = Path(__file__).resolve().parent / "slice_playground.html"

app = FastAPI(
    title="Comic Slice & OCR Algorithm Playground Server",
    description="面向算法演练调试台的专用参数化探针服务",
    version="0.7.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
@app.get("/playground")
async def serve_playground():
    """直接提供演练页面"""
    if HTML_PATH.exists():
        return FileResponse(str(HTML_PATH))
    return JSONResponse({
        "status": "error",
        "detail": f"Playground HTML not found at {HTML_PATH}"
    }, status_code=404)


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "service": "slice-ocr-inspector",
        "version": "0.7.0",
        "playground_url": "http://127.0.0.1:9000/playground"
    }


CAPTURES_SEARCH_DIRS = [
    Path("/mnt/d/models/comic/newplugin/captures"),
    Path("/mnt/d/models/comic/captures"),
    ROOT_DIR / "captures",
]


@app.get("/api/debug/list_captures")
async def list_captures():
    """获取所有捕获目录及切片列表，按切片序号自然排序"""
    import re
    result = []
    seen_paths = set()

    for base_dir in CAPTURES_SEARCH_DIRS:
        if not base_dir.exists():
            continue
        try:
            for session_dir in sorted(base_dir.iterdir()):
                if not session_dir.is_dir():
                    continue
                session_name = session_dir.name
                if session_name in seen_paths:
                    continue
                seen_paths.add(session_name)

                # 收集图片文件
                slice_files = []
                for f in session_dir.glob("切片*.jpg"):
                    slice_files.append(f.name)
                for f in session_dir.glob("切片*.png"):
                    slice_files.append(f.name)

                def sort_key(fn):
                    m = re.search(r'\d+', fn)
                    return int(m.group()) if m else 999999

                slice_files.sort(key=sort_key)

                if slice_files:
                    result.append({
                        "session": session_name,
                        "base_dir": str(base_dir),
                        "slices": slice_files
                    })
        except Exception as e:
            print(f"[Warn] Error listing captures in {base_dir}: {e}")

    return {"status": "ok", "sessions": result}


@app.get("/api/debug/get_capture")
async def get_capture(session: str, filename: str):
    """获取指定切片图片文件流"""
    for base_dir in CAPTURES_SEARCH_DIRS:
        target_path = base_dir / session / filename
        if target_path.exists() and target_path.is_file():
            media_type = "image/jpeg" if filename.lower().endswith((".jpg", ".jpeg")) else "image/png"
            return FileResponse(str(target_path), media_type=media_type)
    raise HTTPException(status_code=404, detail="Slice not found")


def is_box_contained(box_a: list, box_b: list, threshold: float = 0.70) -> bool:
    """判断 box_a 是否有超过 threshold 的面积落在 box_b 内部，且 box_b 显著大于 box_a"""
    ax1, ay1, ax2, ay2 = box_a
    bx1, by1, bx2, by2 = box_b
    ix1 = max(ax1, bx1)
    iy1 = max(ay1, by1)
    ix2 = min(ax2, bx2)
    iy2 = min(ay2, by2)
    iw = max(0, ix2 - ix1)
    ih = max(0, iy2 - iy1)
    inter_area = iw * ih
    area_a = max(1, (ax2 - ax1) * (ay2 - ay1))
    area_b = max(1, (bx2 - bx1) * (by2 - by1))
    return (inter_area / area_a >= threshold) and (area_b >= area_a * 1.4)


def should_merge_custom(
    a: dict,
    b: dict,
    sfx_height_ratio: float = 2.2,
    vertical_gap_ratio: float = 1.3,
    horizontal_center_tol: float = 0.6,
    horizontal_gap_ratio: float = 2.0,
    fragment_gap_ratio: float = 0.60
) -> tuple:
    """
    直连生产核心聚类算法 app.clustering.should_merge_detailed
    演练台与生产环境共享 100% 相同判定标准，杜绝影子算法副本
    """
    return should_merge_detailed(
        a, b,
        x_overlap_ratio=0.2,
        horizontal_gap_ratio=horizontal_gap_ratio,
        horizontal_center_tol=horizontal_center_tol,
        sfx_height_ratio=sfx_height_ratio,
        vertical_gap_ratio=vertical_gap_ratio,
        fragment_gap_ratio=fragment_gap_ratio
    )


@app.post("/api/debug/inspect_slice")
async def inspect_slice(
    file: UploadFile = File(..., description="切片图像二进制文件"),
    det_limit_side_len: int = Form(1024, description="DET 最长边缩放限制 (例如 736, 1024, 1280)"),
    det_thresh: float = Form(0.30, description="DET 二值化概率阈值 (0.1~0.8)"),
    det_unclip_ratio: float = Form(1.60, description="DET 几何外扩膨胀比 (1.2~2.4)"),
    det_box_thresh: float = Form(0.55, description="DET 边框置信度过滤阈值 (0.2~0.8)"),
    rec_score_thresh: float = Form(0.60, description="REC 文本置信分数过滤阈值 (0.1~0.9)"),
    sfx_height_ratio: float = Form(2.2, description="拟声词护盾高度倍数 (1.5~4.5)"),
    vertical_gap_ratio: float = Form(1.3, description="同气泡最大垂直行间距倍数 (0.8~2.5)"),
    horizontal_center_tol: float = Form(0.6, description="同行中心垂直容差 (0.1~0.8)"),
    horizontal_gap_ratio: float = Form(2.0, description="同行水平间距倍数 (1.0~3.5)"),
    fragment_gap_ratio: float = Form(0.60, description="单字/孤立碎片间距约束倍数 (0.2~1.5)"),
    filter_nested_boxes: bool = Form(False, description="是否开启大框包含小框抑制过滤"),
    horizontal_merge_mode: bool = Form(True, description="同行动画合并模式：同行使用空格拼接，不同行才换行"),
    lang: str = Form("kr", description="目标识别语种 (kr, en, jp, ru, zh)")
):
    """
    全阶段参数化诊断切片接口：
    1. 动态注入 DET 与 REC 调测参数
    2. 生成二值化掩码图（Base64 PNG）
    3. 测量每阶段精确耗时 (DET / REC / Cluster) 与卷积 Pass 数
    4. 返回原始检测绿框、裁剪图识别明细、BFS 连通聚类气泡大框
    """
    t_pipeline_start = time.perf_counter()

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="上传图像为空")

    np_arr = np.frombuffer(content, np.uint8)
    image = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
    if image is None:
        raise HTTPException(status_code=400, detail="无法解码该图像，请上传有效 JPG/PNG")

    orig_h, orig_w = image.shape[:2]
    engine = engine_manager.get_engine(lang)

    # ==========================================
    # 阶段 2：参数化 DET 文本检测
    # ==========================================
    t_det_start = time.perf_counter()

    det = engine.text_det
    det.limit_side_len = int(det_limit_side_len)
    det.limit_type = 'max'
    det.postprocess_op.thresh = float(det_thresh)
    det.postprocess_op.unclip_ratio = float(det_unclip_ratio)
    det.postprocess_op.box_thresh = float(det_box_thresh)

    ori_img_shape = (orig_h, orig_w)
    det.preprocess_op = det.get_preprocess(max(orig_h, orig_w))
    prepro_img = det.preprocess_op(image)

    binary_mask_b64 = ""
    dt_boxes = None
    dt_scores = []

    if prepro_img is not None:
        preds = det.infer(prepro_img)[0]
        # preds shape: (1, 1, H, W)
        prob_map = preds[0, 0] if len(preds.shape) >= 3 else preds

        # 生成与原图匹配的高清二值化掩码图供演练台预览
        mask_raw = (prob_map >= float(det_thresh)).astype(np.uint8) * 255
        mask_resized = cv2.resize(mask_raw, (orig_w, orig_h), interpolation=cv2.INTER_NEAREST)
        _, mask_buf = cv2.imencode(".png", mask_resized)
        binary_mask_b64 = "data:image/png;base64," + base64.b64encode(mask_buf).decode("utf-8")

        dt_boxes, dt_scores = det.postprocess_op(preds, ori_img_shape)
        dt_boxes = det.filter_tag_det_res(dt_boxes, ori_img_shape)

    t_det_end = time.perf_counter()
    time_det_ms = (t_det_end - t_det_start) * 1000.0

    raw_boxes_list = []
    if dt_boxes is not None:
        for idx, (b, score) in enumerate(zip(dt_boxes, dt_scores)):
            xs = [float(p[0]) for p in b]
            ys = [float(p[1]) for p in b]
            x1 = max(0, int(round(min(xs))))
            y1 = max(0, int(round(min(ys))))
            x2 = min(orig_w, int(round(max(xs))))
            y2 = min(orig_h, int(round(max(ys))))
            w = x2 - x1
            h = y2 - y1
            if w >= 4 and h >= 4:
                raw_boxes_list.append({
                    "id": idx + 1,
                    "bbox": [x1, y1, x2, y2],
                    "w": w,
                    "h": h,
                    "aspect_ratio": round(w / max(1, h), 2),
                    "score": round(float(score), 4),
                    "is_nested": False
                })

    # 标记或过滤嵌套框
    n_boxes = len(raw_boxes_list)
    for i in range(n_boxes):
        for j in range(n_boxes):
            if i != j:
                if is_box_contained(raw_boxes_list[i]["bbox"], raw_boxes_list[j]["bbox"], threshold=0.70):
                    raw_boxes_list[i]["is_nested"] = True
                    break

    active_boxes = [b for b in raw_boxes_list if not (filter_nested_boxes and b["is_nested"])]

    # ==========================================
    # 阶段 3：原图高清裁剪与 REC 文本识别
    # ==========================================
    t_rec_start = time.perf_counter()

    pad = 2
    crops = []
    crop_boxes = []
    for item in active_boxes:
        bx1, by1, bx2, by2 = item["bbox"]
        cx1 = max(0, bx1 - pad)
        cy1 = max(0, by1 - pad)
        cx2 = min(orig_w, bx2 + pad)
        cy2 = min(orig_h, by2 + pad)
        if (cx2 - cx1) >= 4 and (cy2 - cy1) >= 4:
            crops.append(image[cy1:cy2, cx1:cx2])
            crop_boxes.append(item)

    rec_items = []
    if crops:
        rec_results, _ = engine.text_rec(crops)
        for i, (text, score) in enumerate(rec_results):
            score = float(score)
            item = crop_boxes[i]
            # 生成该行裁剪小图的 Base64 缩略图
            _, c_buf = cv2.imencode(".jpg", crops[i], [cv2.IMWRITE_JPEG_QUALITY, 85])
            thumb_b64 = "data:image/jpeg;base64," + base64.b64encode(c_buf).decode("utf-8")

            # 样式特征提取
            bg_hex, text_hex = extract_colors_fast(image, tuple(item["bbox"]))
            fill_ratio = compute_fill_ratio(image, tuple(item["bbox"]))
            font_weight = estimate_font_weight(fill_ratio)

            passed_rec = (score >= float(rec_score_thresh)) and bool(text.strip())

            rec_items.append({
                "id": item["id"],
                "bbox": item["bbox"],
                "w": item["w"],
                "h": item["h"],
                "text": text.strip(),
                "score": round(score, 4),
                "det_score": item["score"],
                "is_nested": item["is_nested"],
                "passed": passed_rec,
                "bg": bg_hex,
                "fg": text_hex,
                "fill_ratio": round(fill_ratio, 3),
                "weight": font_weight,
                "thumb_b64": thumb_b64
            })

    t_rec_end = time.perf_counter()
    time_rec_ms = (t_rec_end - t_rec_start) * 1000.0

    # ==========================================
    # 阶段 5：参数化 BFS 连通图聚类与气泡合并
    # ==========================================
    t_cluster_start = time.perf_counter()

    valid_rec_items = [r for r in rec_items if r["passed"]]
    n_valid = len(valid_rec_items)
    adj = [[] for _ in range(n_valid)]
    merge_reasons = {}

    for i in range(n_valid):
        for j in range(i + 1, n_valid):
            ai = valid_rec_items[i]
            bj = valid_rec_items[j]
            box_a = {"x": ai["bbox"][0], "y": ai["bbox"][1], "w": ai["w"], "h": ai["h"]}
            box_b = {"x": bj["bbox"][0], "y": bj["bbox"][1], "w": bj["w"], "h": bj["h"]}
            can_merge, reason = should_merge_custom(
                box_a, box_b,
                sfx_height_ratio=float(sfx_height_ratio),
                vertical_gap_ratio=float(vertical_gap_ratio),
                horizontal_center_tol=float(horizontal_center_tol),
                horizontal_gap_ratio=float(horizontal_gap_ratio),
                fragment_gap_ratio=float(fragment_gap_ratio)
            )
            if can_merge:
                adj[i].append(j)
                adj[j].append(i)
                merge_reasons[f"{ai['id']}-{bj['id']}"] = reason

    visited = [False] * n_valid
    bubbles = []
    bubble_counter = 0

    for i in range(n_valid):
        if visited[i]:
            continue

        queue = [i]
        visited[i] = True
        component_indices = []

        while queue:
            curr = queue.pop(0)
            component_indices.append(curr)
            for neighbor in adj[curr]:
                if not visited[neighbor]:
                    visited[neighbor] = True
                    queue.append(neighbor)

        component = [valid_rec_items[idx] for idx in component_indices]
        # 按阅读习惯从上到下、从左到右排序
        component.sort(key=lambda item: (item["bbox"][1], item["bbox"][0]))

        # 合并文本内容
        if horizontal_merge_mode:
            # 智能同行检测：Y轴中心差小于0.5字高，认为是同行，按空格合并；否则换行
            lines_group = []
            current_row = [component[0]]
            for k in range(1, len(component)):
                prev = current_row[-1]
                curr = component[k]
                prev_cy = prev["bbox"][1] + prev["h"] / 2.0
                curr_cy = curr["bbox"][1] + curr["h"] / 2.0
                local_h = min(prev["h"], curr["h"])
                if abs(curr_cy - prev_cy) < local_h * float(horizontal_center_tol):
                    current_row.append(curr)
                else:
                    lines_group.append(current_row)
                    current_row = [curr]
            if current_row:
                lines_group.append(current_row)

            merged_text = "\n".join(" ".join(itm["text"] for itm in row) for row in lines_group)
            line_count = len(lines_group)
        else:
            merged_text = "\n".join(itm["text"] for itm in component)
            line_count = len(component)

        min_x = min(itm["bbox"][0] for itm in component)
        min_y = min(itm["bbox"][1] for itm in component)
        max_x = max(itm["bbox"][2] for itm in component)
        max_y = max(itm["bbox"][3] for itm in component)
        bw = max_x - min_x
        bh = max_y - min_y

        avg_h = sum(itm["h"] for itm in component) / len(component)
        est_font_size = max(12, int(round(avg_h * 0.85)))
        avg_score = sum(itm["score"] for itm in component) / len(component)

        # 投票气泡背景与文字颜色
        bg_color = component[0]["bg"]
        text_color = component[0]["fg"]

        bubble_counter += 1
        bubbles.append({
            "bubble_id": bubble_counter,
            "bbox": [min_x, min_y, bw, bh],
            "text": merged_text,
            "line_count": line_count,
            "member_line_ids": [itm["id"] for itm in component],
            "font_size": est_font_size,
            "bg": bg_color,
            "fg": text_color,
            "score": round(avg_score, 4)
        })

    t_cluster_end = time.perf_counter()
    time_cluster_ms = (t_cluster_end - t_cluster_start) * 1000.0
    time_total_ms = (t_cluster_end - t_pipeline_start) * 1000.0

    return {
        "status": "ok",
        "image_info": {
            "width": orig_w,
            "height": orig_h,
            "aspect_ratio": round(orig_h / max(1, orig_w), 2)
        },
        "timings": {
            "time_det_ms": round(time_det_ms, 2),
            "time_rec_ms": round(time_rec_ms, 2),
            "time_cluster_ms": round(time_cluster_ms, 2),
            "time_total_ms": round(time_total_ms, 2),
            "det_passes": 1
        },
        "params": {
            "det_limit_side_len": det_limit_side_len,
            "det_thresh": det_thresh,
            "det_unclip_ratio": det_unclip_ratio,
            "det_box_thresh": det_box_thresh,
            "rec_score_thresh": rec_score_thresh,
            "sfx_height_ratio": sfx_height_ratio,
            "vertical_gap_ratio": vertical_gap_ratio,
            "horizontal_center_tol": horizontal_center_tol,
            "horizontal_gap_ratio": horizontal_gap_ratio,
            "fragment_gap_ratio": fragment_gap_ratio,
            "filter_nested_boxes": filter_nested_boxes,
            "horizontal_merge_mode": horizontal_merge_mode
        },
        "det_boxes": raw_boxes_list,
        "rec_items": rec_items,
        "bubbles": bubbles,
        "binary_mask_b64": binary_mask_b64
    }


if __name__ == "__main__":
    port = int(os.environ.get("DEBUG_PORT", 9000))
    print(f"🚀 [OCR 算法演练服务] 启动中... 监听: http://127.0.0.1:{port}")
    print(f"🌐 演练调试页面入口: http://127.0.0.1:{port}/playground")
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="warning")
