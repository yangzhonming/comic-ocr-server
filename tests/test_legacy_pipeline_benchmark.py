import cv2
import numpy as np
import time
import json
import os
from typing import List, Dict, Any
from rapidocr_onnxruntime import RapidOCR

# ==========================================
# 1. 提炼老版黄金资产：双采样取色与字重分析
# ==========================================
def extract_colors_fast(image: np.ndarray, raw_bbox: tuple) -> tuple[str, str]:
    rx1, ry1, rx2, ry2 = raw_bbox
    h, w = image.shape[:2]

    # 文字色采样区：原始框外扩 4px
    tp = 4
    tc_x1 = max(0, rx1 - tp)
    tc_y1 = max(0, ry1 - tp)
    tc_x2 = min(w, rx2 + tp)
    tc_y2 = min(h, ry2 + tp)
    tc_crop = image[tc_y1:tc_y2, tc_x1:tc_x2]
    if tc_crop.shape[0] < 4 or tc_crop.shape[1] < 4:
        return "#FAFAFA", "#000000"

    # 背景色采样区：原始框内缩 4px
    bp = 4
    bg_x1 = rx1 + bp
    bg_y1 = ry1 + bp
    bg_x2 = rx2 - bp
    bg_y2 = ry2 - bp
    if bg_x2 <= bg_x1 or bg_y2 <= bg_y1:
        bg_crop = tc_crop
    else:
        bg_crop = image[bg_y1:bg_y2, bg_x1:bg_x2]

    def _kmeans_two(crop_img):
        ch, cw = crop_img.shape[:2]
        if ch * cw > 1024:
            scale = np.sqrt(1024 / (ch * cw))
            crop_img = cv2.resize(crop_img, (int(cw * scale), int(ch * scale)), interpolation=cv2.INTER_AREA)
        pixels = crop_img.reshape((-1, 3)).astype(np.float32)
        init_c = np.array([[0, 0, 0], [255, 255, 255]], dtype=np.float32)
        criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 8, 1.0)
        _, labels, centers = cv2.kmeans(pixels, 2, None, criteria, 1, cv2.KMEANS_USE_INITIAL_CENTERS, init_c)
        return labels, centers, pixels

    def _pick_text(labels, centers, pixels):
        gray = cv2.cvtColor(pixels.reshape((-1, 1, 3)).astype(np.uint8), cv2.COLOR_BGR2GRAY).reshape(-1)
        _, otsu = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
        flat = labels.flatten()
        c0 = np.sum((flat == 0) & (otsu == 255))
        c1 = np.sum((flat == 1) & (otsu == 255))
        return centers[0].astype(np.uint8) if c0 > c1 else centers[1].astype(np.uint8)

    def _sample_bg_corner(crop_img):
        ch, cw = crop_img.shape[:2]
        if ch < 6 or cw < 6:
            return np.median(crop_img.reshape(-1, 3), axis=0).astype(np.uint8)
        blocks = [
            crop_img[0:3, 0:3],
            crop_img[0:3, -3:],
            crop_img[-3:, 0:3],
            crop_img[-3:, -3:],
        ]
        variances = [np.var(cv2.cvtColor(b, cv2.COLOR_BGR2GRAY)) for b in blocks]
        best = blocks[np.argmin(variances)]
        return np.median(best, axis=(0, 1)).astype(np.uint8)

    try:
        labels_t, centers_t, pixels_t = _kmeans_two(tc_crop)
        text_color = _pick_text(labels_t, centers_t, pixels_t)
        bg_color = _sample_bg_corner(bg_crop)
        bg_hex = f"#{int(bg_color[2]):02x}{int(bg_color[1]):02x}{int(bg_color[0]):02x}"
        text_hex = f"#{int(text_color[2]):02x}{int(text_color[1]):02x}{int(text_color[0]):02x}"
        return bg_hex, text_hex
    except Exception:
        return "#FFFFFF", "#000000"

def compute_fill_ratio(image: np.ndarray, bbox: tuple) -> float:
    bx1, by1, bx2, by2 = bbox
    h, w = image.shape[:2]
    crop = image[max(0, by1):min(h, by2), max(0, bx1):min(w, bx2)]
    if crop.size == 0 or crop.shape[0] < 3 or crop.shape[1] < 3:
        return 0.3
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if len(crop.shape) == 3 else crop
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    edge_pixels = np.concatenate([binary[0, :], binary[-1, :], binary[:, 0], binary[:, -1]])
    is_dark_bg = np.mean(edge_pixels == 0) > 0.5
    text_pixel_count = np.count_nonzero(binary == 255 if is_dark_bg else binary == 0)
    return float(text_pixel_count) / max(binary.size, 1)

# ==========================================
# 2. 提炼老版黄金资产：图连通分量聚类算法
# ==========================================
class TextLineItem:
    def __init__(self, bbox: list, text: str, score: float, bg_color: str, text_color: str, fill_ratio: float):
        self.bbox = bbox  # [x1, y1, x2, y2]
        self.x = bbox[0]
        self.y = bbox[1]
        self.w = bbox[2] - bbox[0]
        self.h = bbox[3] - bbox[1]
        self.text = text
        self.score = score
        self.bg_color = bg_color
        self.text_color = text_color
        self.fill_ratio = fill_ratio

def should_merge(a: TextLineItem, b: TextLineItem, x_overlap_ratio: float = 0.2) -> bool:
    h_ratio = max(a.h, b.h) / max(min(a.h, b.h), 1)
    if h_ratio > 2.2:
        return False

    local_char_size = min(a.h, b.h)
    if local_char_size <= 0:
        return False

    a_bottom = a.y + a.h
    b_bottom = b.y + b.h
    center_y_a = a.y + a.h / 2
    center_y_b = b.y + b.h / 2
    h_gap = max(a.x, b.x) - min(a.x + a.w, b.x + b.w)
    v_gap = max(a.y, b.y) - min(a_bottom, b_bottom)

    # 规则 A：同行横向合并
    if abs(center_y_a - center_y_b) < local_char_size * 0.6:
        if h_gap < local_char_size * 2.0:
            return True

    # 规则 B：同气泡纵向换行合并
    x_overlap = max(0, min(a.x + a.w, b.x + b.w) - max(a.x, b.x))
    is_x_overlapped = (x_overlap > min(a.w, b.w) * x_overlap_ratio) or (x_overlap > local_char_size)

    if is_x_overlapped:
        if v_gap <= 0:
            if abs(center_y_a - center_y_b) < max(a.h, b.h) * 1.3:
                return True
            return False
        # 纵向间距小于 1.3 倍字高
        if v_gap < local_char_size * 1.3:
            return True

    return False

def cluster_text_lines(items: List[TextLineItem]) -> List[Dict[str, Any]]:
    if not items:
        return []
    n = len(items)
    adj = [[] for _ in range(n)]
    for i in range(n):
        for j in range(i + 1, n):
            if should_merge(items[i], items[j]):
                adj[i].append(j)
                adj[j].append(i)

    visited = [False] * n
    bubbles = []
    for i in range(n):
        if visited[i]:
            continue
        component = []
        queue = [i]
        visited[i] = True
        while queue:
            node = queue.pop(0)
            component.append(node)
            for neighbor in adj[node]:
                if not visited[neighbor]:
                    visited[neighbor] = True
                    queue.append(neighbor)

        cluster = [items[k] for k in component]
        cluster.sort(key=lambda it: (it.y, it.x))  # 阅读顺序从上到下

        min_x = min(it.x for it in cluster)
        min_y = min(it.y for it in cluster)
        max_x = max(it.x + it.w for it in cluster)
        max_y = max(it.y + it.h for it in cluster)

        merged_text = "\n".join(it.text for it in cluster)
        avg_score = float(np.mean([it.score for it in cluster]))
        median_h = float(np.median([it.h for it in cluster]))
        
        font_size = max(12, min(int(median_h * 0.75), 60))
        avg_fr = float(np.mean([it.fill_ratio for it in cluster]))
        font_weight = 400 if avg_fr < 0.25 else (900 if avg_fr > 0.45 else 700)
        best_item = max(cluster, key=lambda it: it.score)

        bubbles.append({
            "bubble_box": [min_x, min_y, max_x, max_y],
            "merged_text": merged_text,
            "line_count": len(cluster),
            "score": round(avg_score, 3),
            "font_size": font_size,
            "font_weight": font_weight,
            "bg_color": best_item.bg_color,
            "text_color": best_item.text_color,
            "raw_lines": [{
                "box": it.bbox,
                "text": it.text,
                "score": round(it.score, 3)
            } for it in cluster]
        })

    bubbles.sort(key=lambda b: (b["bubble_box"][1], b["bubble_box"][0]))
    return bubbles

# ==========================================
# 3. 完整流水线 Benchmark 主函数
# ==========================================
def run_pipeline_benchmark(slice_path: str, lang: str = "kr", det_limit: int = 1024, output_dir: str = "tests/output"):
    os.makedirs(output_dir, exist_ok=True)
    orig_img = cv2.imread(slice_path)
    if orig_img is None:
        raise FileNotFoundError(f"Cannot load image: {slice_path}")
    orig_h, orig_w = orig_img.shape[:2]

    rec_models = {
        "kr": ("models/korean_PP-OCRv5_rec_mobile_infer.onnx", "models/ppocrv5_korean_dict.txt"),
        "en": ("models/en_PP-OCRv5_rec_mobile_infer.onnx", "models/ppocrv5_en_dict.txt"),
    }
    rec_model_path, rec_keys_path = rec_models.get(lang, rec_models["kr"])

    t_start = time.perf_counter()
    ocr_engine = RapidOCR(
        rec_model_path=rec_model_path,
        rec_keys_path=rec_keys_path,
        det_limit_side_len=det_limit,
        det_limit_type='max',
        det_box_thresh=0.30,
        det_thresh=0.20,
        det_unclip_ratio=1.60
    )
    
    # 步骤 1：DET 全图单次卷积 (Passes = 1)
    t0 = time.perf_counter()
    det_boxes, det_elapse = ocr_engine.text_det(orig_img)
    t_det = (time.perf_counter() - t0) * 1000

    if det_boxes is None or len(det_boxes) == 0:
        return {"error": "No text detected"}

    # 步骤 2：直接从未压缩的高清原图上裁剪 (box_pad = 2px)
    crops = []
    box_coords = []
    pad = 2
    for b in det_boxes:
        xs = [p[0] for p in b]
        ys = [p[1] for p in b]
        bx1 = max(0, int(round(min(xs))) - pad)
        by1 = max(0, int(round(min(ys))) - pad)
        bx2 = min(orig_w, int(round(max(xs))) + pad)
        by2 = min(orig_h, int(round(max(ys))) + pad)
        if (bx2 - bx1) >= 5 and (by2 - by1) >= 5:
            crops.append(orig_img[by1:by2, bx1:bx2])
            box_coords.append([bx1, by1, bx2, by2])

    # 步骤 3：批量单行识字 (PP-OCRv5)
    t1 = time.perf_counter()
    rec_results, rec_elapse = ocr_engine.text_rec(crops)
    t_rec = (time.perf_counter() - t1) * 1000

    # 步骤 4：双采样取色与字重分析
    t2 = time.perf_counter()
    text_line_items = []
    for i, (text, score) in enumerate(rec_results):
        score = float(score)
        if score < 0.50 or not text.strip():
            continue
        bbox = box_coords[i]
        bg_hex, text_hex = extract_colors_fast(orig_img, tuple(bbox))
        fr = compute_fill_ratio(orig_img, tuple(bbox))
        text_line_items.append(TextLineItem(bbox, text, score, bg_hex, text_hex, fr))
    t_style = (time.perf_counter() - t2) * 1000

    # 步骤 5：图连通分量聚类（合并气泡）
    t3 = time.perf_counter()
    clustered_bubbles = cluster_text_lines(text_line_items)
    t_cluster = (time.perf_counter() - t3) * 1000
    t_total = (time.perf_counter() - t_start) * 1000

    # 步骤 6：绘制可视化标注图
    vis_img = orig_img.copy()
    for it in text_line_items:
        cv2.rectangle(vis_img, (it.x, it.y), (it.x + it.w, it.y + it.h), (0, 165, 255), 1)

    for idx, b in enumerate(clustered_bubbles):
        bx1, by1, bx2, by2 = b["bubble_box"]
        cv2.rectangle(vis_img, (bx1, by1), (bx2, by2), (0, 220, 0), 3)
        tag = f"#{idx+1} [{b['font_size']}px]"
        cv2.putText(vis_img, tag, (bx1, max(20, by1 - 8)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 220, 0), 2)

    vis_filename = os.path.basename(slice_path).replace('.jpg', '_pipeline_result.jpg')
    vis_path = os.path.join(output_dir, vis_filename)
    cv2.imwrite(vis_path, vis_img)

    result = {
        "slice_file": os.path.basename(slice_path),
        "visual_annotated_image": vis_path,
        "slice_dimensions": [orig_w, orig_h],
        "det_limit_side_len": det_limit,
        "convolution_passes": 1,
        "timing_breakdown_ms": {
            "det_inference": round(t_det, 2),
            "rec_inference": round(t_rec, 2),
            "style_and_colors": round(t_style, 2),
            "graph_clustering": round(t_cluster, 2),
            "total_latency": round(t_total, 2)
        },
        "statistics": {
            "raw_text_lines_detected": len(text_line_items),
            "clustered_bubbles_count": len(clustered_bubbles)
        },
        "clustered_bubbles": clustered_bubbles
    }
    return result

if __name__ == '__main__':
    for slice_file in ['slice_000001_Y000000000_000002581.jpg', 'slice_000003_Y000004809_000006704.jpg']:
        p = f'tests/data/manga18fx.com-muqi76dd-00nfa/{slice_file}'
        r = run_pipeline_benchmark(p, lang="kr", det_limit=1024)
        print(f"\n================ {slice_file} (DET Limit: 1024) ================")
        print(f"Passes: {r['convolution_passes']}")
        print(f"Timing: DET={r['timing_breakdown_ms']['det_inference']}ms, REC={r['timing_breakdown_ms']['rec_inference']}ms, Total={r['timing_breakdown_ms']['total_latency']}ms")
        print(f"Bubbles count: {r['statistics']['clustered_bubbles_count']}")
        for b in r['clustered_bubbles']:
            print(f"  -> Bubble {b['bubble_box']}: {repr(b['merged_text'])} (lines={b['line_count']}, score={b['score']})")
