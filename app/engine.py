import os
import threading
from typing import Dict, List, Optional
import cv2
import numpy as np
from rapidocr_onnxruntime import RapidOCR

from app.schemas import BubbleItem
from app.styling import extract_colors_fast, compute_fill_ratio
from app.clustering import TextLineItem, cluster_text_lines


def merge_horizontal_boxes(
    boxes: List[List[int]],
    y_overlap_ratio: float = 0.50,
    max_gap_ratio: float = 1.5,
    max_h_diff: float = 1.8
) -> List[List[int]]:
    """
    同行碎框前置水平融合算法:
    检测网络 (DBNet) 对字符间距大、笔画细 (如韩文 '우 으...') 的文字行可能会断裂为多个碎框。
    在裁切前将满足以下条件的同行碎框合并:
    1. Y 轴重合比例 >= 50%
    2. 水平间隙 <= 1.5 倍平均字高
    3. 两者字高差异 <= 1.8 倍 (杜绝把大字或背景杂线吃进来)
    融合后可一次性完整裁切送入 REC，避免字符被暴力切断、提升上下文识别率，并天然消除多余换行。
    """
    if len(boxes) <= 1:
        return boxes

    cur = [list(b) for b in boxes]
    merged = True
    while merged:
        merged = False
        n = len(cur)
        for i in range(n):
            if cur[i] is None:
                continue
            for j in range(i + 1, n):
                if cur[j] is None:
                    continue
                a, b = cur[i], cur[j]
                ha = a[3] - a[1]
                hb = b[3] - b[1]
                if ha <= 0 or hb <= 0:
                    continue

                if max(ha, hb) > min(ha, hb) * max_h_diff:
                    continue

                y_top = max(a[1], b[1])
                y_bot = min(a[3], b[3])
                overlap = max(0, y_bot - y_top)
                min_h = min(ha, hb)
                if (overlap / min_h) < y_overlap_ratio:
                    continue

                x_gap = max(0, max(a[0], b[0]) - min(a[2], b[2]))
                avg_h = (ha + hb) / 2.0
                if x_gap > avg_h * max_gap_ratio:
                    continue

                cur[i] = [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])]
                cur[j] = None
                merged = True
                break
            if merged:
                break
        cur = [b for b in cur if b is not None]

    return cur


def suppress_contained_boxes(
    boxes: List[List[int]],
    containment_thresh: float = 0.75
) -> List[List[int]]:
    """
    内部嵌套冗余碎框抑制算法:
    当 DBNet 对包含省略号 '...' 或细碎符号的整行对白同时检出大框和内部微小碎框时，
    若小框面积的大部分 (>= 75%) 都被大框包含，则剔除小框，避免产生 'ㅁ2' 等垃圾碎片。
    """
    if len(boxes) <= 1:
        return boxes

    sorted_boxes = sorted(boxes, key=lambda b: (b[2] - b[0]) * (b[3] - b[1]), reverse=True)
    kept = []
    for b in sorted_boxes:
        bx1, by1, bx2, by2 = b
        area_b = (bx2 - bx1) * (by2 - by1)
        if area_b <= 0:
            continue
        is_contained = False
        for k in kept:
            kx1, ky1, kx2, ky2 = k
            area_k = (kx2 - kx1) * (ky2 - ky1)
            ix1 = max(bx1, kx1)
            iy1 = max(by1, ky1)
            ix2 = min(bx2, kx2)
            iy2 = min(by2, ky2)
            if ix2 > ix1 and iy2 > iy1:
                inter = (ix2 - ix1) * (iy2 - iy1)
                if (inter / area_b) >= containment_thresh and area_k > area_b * 1.3:
                    is_contained = True
                    break
        if not is_contained:
            kept.append(b)
    return kept


class OcrEngineManager:
    """
    OCR 模型管理器与推理引擎 (CPU 极致优化版)
    - 共享单通道 PP-OCRv4 DET (最长边限制 1024 保持长宽比，32 倍对齐)
    - 多语种 PP-OCRv5 REC 动态路由 (韩/英/日/俄/中)
    - 内存单例持久化与启动预热
    """

    SUPPORTED_LANGUAGES = {
        "kr": ("models/korean_PP-OCRv5_rec_mobile_infer.onnx", "models/ppocrv5_korean_dict.txt"),
        "ko": ("models/korean_PP-OCRv5_rec_mobile_infer.onnx", "models/ppocrv5_korean_dict.txt"),
        "korean": ("models/korean_PP-OCRv5_rec_mobile_infer.onnx", "models/ppocrv5_korean_dict.txt"),
        "en": ("models/en_PP-OCRv5_rec_mobile_infer.onnx", "models/ppocrv5_en_dict.txt"),
        "english": ("models/en_PP-OCRv5_rec_mobile_infer.onnx", "models/ppocrv5_en_dict.txt"),
        "jp": ("models/japan_PP-OCRv4_rec_infer.onnx", "models/japan_dict.txt"),
        "ja": ("models/japan_PP-OCRv4_rec_infer.onnx", "models/japan_dict.txt"),
        "japanese": ("models/japan_PP-OCRv4_rec_infer.onnx", "models/japan_dict.txt"),
        "ru": ("models/cyrillic_PP-OCRv5_rec_mobile.onnx", "models/ppocrv5_cyrillic_dict.txt"),
        "cyrillic": ("models/cyrillic_PP-OCRv5_rec_mobile.onnx", "models/ppocrv5_cyrillic_dict.txt"),
        "russian": ("models/cyrillic_PP-OCRv5_rec_mobile.onnx", "models/ppocrv5_cyrillic_dict.txt"),
    }

    DET_MODEL_PATH = "models/ch_PP-OCRv4_det_infer.onnx"

    def __init__(self, base_dir: Optional[str] = None):
        self.base_dir = base_dir or os.getcwd()
        self._engines: Dict[str, RapidOCR] = {}
        self._lock = threading.Lock()

    def _normalize_lang(self, lang: Optional[str]) -> str:
        if not lang:
            return "kr"
        clean = lang.strip().lower()
        if clean in ("kr", "ko", "korean"):
            return "kr"
        if clean in ("en", "english"):
            return "en"
        if clean in ("jp", "ja", "japanese"):
            return "jp"
        if clean in ("ru", "cyrillic", "russian"):
            return "ru"
        if clean in ("zh", "cn", "chinese"):
            return "zh"
        return "kr"

    def get_engine(self, lang: str = "kr") -> RapidOCR:
        normalized_lang = self._normalize_lang(lang)
        if normalized_lang in self._engines:
            return self._engines[normalized_lang]

        with self._lock:
            if normalized_lang in self._engines:
                return self._engines[normalized_lang]

            det_path = os.path.join(self.base_dir, self.DET_MODEL_PATH)

            # 配置参数：1024 限制，DBNet 阈值，关闭形态学膨胀
            common_kwargs = {
                "det_model_path": det_path,
                "det_limit_side_len": 1024,
                "det_limit_type": "max",
                "det_box_thresh": 0.50,
                "det_thresh": 0.30,
                "det_unclip_ratio": 1.60,
                "det_use_dilation": False,
            }

            if normalized_lang in self.SUPPORTED_LANGUAGES:
                rec_rel, dict_rel = self.SUPPORTED_LANGUAGES[normalized_lang]
                rec_path = os.path.join(self.base_dir, rec_rel)
                dict_path = os.path.join(self.base_dir, dict_rel)
                engine = RapidOCR(
                    rec_model_path=rec_path,
                    rec_keys_path=dict_path,
                    **common_kwargs
                )
            else:
                # 默认/中文走内置模型
                engine = RapidOCR(**common_kwargs)

            self._engines[normalized_lang] = engine
            return engine

    def warmup(self, langs: Optional[List[str]] = None) -> List[str]:
        """
        服务启动预热：跑一张微型假图，消除首次推理的 ONNX 解释器和线程池初始化开销
        """
        targets = langs or ["kr"]
        dummy_img = np.full((128, 128, 3), 255, dtype=np.uint8)
        cv2.putText(dummy_img, "WARM", (10, 60), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 0), 2)

        warmed = []
        for l in targets:
            norm_l = self._normalize_lang(l)
            engine = self.get_engine(norm_l)
            boxes, _ = engine.text_det(dummy_img)
            if boxes is not None and len(boxes) > 0:
                engine.text_rec([dummy_img[10:90, 10:90]])
            warmed.append(norm_l)
        return warmed

    def process_slice(
        self,
        image: np.ndarray,
        lang: str = "kr",
        start_y: int = 0
    ) -> List[BubbleItem]:
        """
        单切片全流程处理核心管道:
        1. DET 检测 (最长边 1024 等比缩放，Passes=1)
        2. 原图高清裁切 (+2px Padding)
        3. 批量 REC 多语种识别
        4. 双采样色彩提取与笔画填充率估算
        5. BFS 连通图气泡聚类与拟声词隔离护盾
        6. 输出全局绝对坐标 (box_abs) 与局部相对坐标 (box_rel)
        """
        orig_h, orig_w = image.shape[:2]
        engine = self.get_engine(lang)

        # 1. 文本检测 (单次卷积推理)
        det_boxes, _ = engine.text_det(image)
        if det_boxes is None or len(det_boxes) == 0:
            return []

        # 提取水平对齐包围盒 [bx1, by1, bx2, by2] 并执行 DET 尺寸与噪点硬过滤
        raw_boxes = []
        for b in det_boxes:
            xs = [p[0] for p in b]
            ys = [p[1] for p in b]
            bx1 = max(0, int(round(min(xs))))
            by1 = max(0, int(round(min(ys))))
            bx2 = min(orig_w, int(round(max(xs))))
            by2 = min(orig_h, int(round(max(ys))))
            bw = bx2 - bx1
            bh = by2 - by1

            # DET 硬过滤: 滤除过小噪点斑块及极端畸变线条 (杜绝背景噪点被误识为 'o', '口', '0')
            if (bw < 12 and bh < 12) or (bw * bh < 150):
                continue
            if (bw / max(1, bh) > 15.0) or (bh / max(1, bw) > 15.0):
                continue

            raw_boxes.append([bx1, by1, bx2, by2])

        # 内部嵌套冗余碎框滤除 (避免大框内部细碎标点/噪点产生冗余框)
        dedup_boxes = suppress_contained_boxes(raw_boxes, containment_thresh=0.75)

        # 前置同行碎框水平融合
        fused_boxes = merge_horizontal_boxes(dedup_boxes, y_overlap_ratio=0.50, max_gap_ratio=1.5, max_h_diff=1.8)

        # 2. 从未经下采样模糊的原图上高保真裁切 (+2px padding)
        crops = []
        box_coords = []
        pad = 2
        for bx1, by1, bx2, by2 in fused_boxes:
            cbx1 = max(0, bx1 - pad)
            cby1 = max(0, by1 - pad)
            cbx2 = min(orig_w, bx2 + pad)
            cby2 = min(orig_h, by2 + pad)
            if (cbx2 - cbx1) >= 5 and (cby2 - cby1) >= 5:
                crops.append(image[cby1:cby2, cbx1:cbx2])
                box_coords.append([cbx1, cby1, cbx2, cby2])

        if not crops:
            return []

        # 3. 批量文本行识别
        rec_results, _ = engine.text_rec(crops)

        # 4. 双采样色彩提取与特征计算
        text_line_items: List[TextLineItem] = []
        for i, (text, score) in enumerate(rec_results):
            score = float(score)
            if score < 0.50 or not text.strip():
                continue
            bbox = box_coords[i]
            bg_hex, text_hex = extract_colors_fast(image, tuple(bbox))
            fr = compute_fill_ratio(image, tuple(bbox))
            text_line_items.append(TextLineItem(bbox, text, score, bg_hex, text_hex, fr))

        # 5. BFS 连通图聚类合并气泡并执行物理决策打标
        bubbles = cluster_text_lines(text_line_items, image=image, start_y=start_y)
        return bubbles


# 全局单例管理器
engine_manager = OcrEngineManager()
