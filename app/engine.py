import os
import re
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

                score_a = a[4] if len(a) > 4 else 0.85
                score_b = b[4] if len(b) > 4 else 0.85
                cur[i] = [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]), max(score_a, score_b)]
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
        bx1, by1, bx2, by2 = b[:4]
        area_b = (bx2 - bx1) * (by2 - by1)
        if area_b <= 0:
            continue
        is_contained = False
        for k in kept:
            kx1, ky1, kx2, ky2 = k[:4]
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


LANG_SCALES = {
    "kr": 0.089,
    "ko": 0.089,
    "korean": 0.089,
    "en": 0.065,
    "english": 0.065,
    "es": 0.065,
    "spanish": 0.065,
    "ru": 0.068,
    "russian": 0.068,
    "cyrillic": 0.068,
    "jp": 0.090,
    "ja": 0.090,
    "japanese": 0.090,
    "zh": 0.080,
    "chinese": 0.080,
}
DEFAULT_LANG_SCALE = 0.089


def get_lang_scale(lang: Optional[str]) -> float:
    if not lang:
        return DEFAULT_LANG_SCALE
    key = lang.strip().lower()
    return LANG_SCALES.get(key, DEFAULT_LANG_SCALE)


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
        "es": ("models/en_PP-OCRv5_rec_mobile_infer.onnx", "models/ppocrv5_en_dict.txt"),
        "spanish": ("models/en_PP-OCRv5_rec_mobile_infer.onnx", "models/ppocrv5_en_dict.txt"),
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
        if clean in ("en", "english", "es", "spanish"):
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
            # 配置参数：1024 限制，DBNet 阈值，关闭形态学膨胀，多线程与批处理极致加速
            common_kwargs = {
                "det_model_path": det_path,
                "det_limit_side_len": 1024,
                "det_limit_type": "max",
                "det_box_thresh": 0.55,
                "det_thresh": 0.30,
                "det_unclip_ratio": 1.60,
                "det_use_dilation": False,
                "rec_batch_num": 16,
                "intra_op_num_threads": int(os.environ.get("OCR_NUM_THREADS", 2)),
                "inter_op_num_threads": 1,
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
        start_y: int = 0,
        rec_thresh: float = 0.70,
        box_thresh: float = 0.55
    ) -> List[BubbleItem]:
        """
        单切片全流程处理核心管道 (极速纯净单模型版):
        1. DET 文本检测 (单次推理，提取候选框与置信度，支持动态 box_thresh)
        2. 极简几何绝对秒杀 (面积 < 60 或 短边 <= 3px: 灭除扫描微尘/细划痕，长句 100% 豁免)
        3. 嵌套碎框抑制
        4. 语种分支策略: 仅韩文 (kr/ko) 启用前置水平合并，英文 (en) 等禁用
        5. 原图高清裁切 (+2px padding) 与批量 REC 识别
        6. 后过滤双置信度决断: 动态 rec_thresh 放宽或过滤
        7. 边界环众数精准取色与自然几何聚类
        """
        orig_h, orig_w = image.shape[:2]
        engine = self.get_engine(lang)

        # 1. 文本检测 (直接获取原始框与置信度)
        det = engine.text_det
        ori_shape = (orig_h, orig_w)
        det_prep = det.get_preprocess(max(orig_h, orig_w))
        pre_img = det_prep(image)
        if pre_img is None:
            return []

        old_box_thresh = getattr(det.postprocess_op, 'box_thresh', 0.5)
        try:
            if box_thresh is not None:
                det.postprocess_op.box_thresh = float(box_thresh)
            preds = det.infer(pre_img)[0]
            dt_boxes, dt_scores = det.postprocess_op(preds, ori_shape)
        finally:
            det.postprocess_op.box_thresh = old_box_thresh

        dt_boxes = det.filter_tag_det_res(dt_boxes, ori_shape)
        if dt_boxes is None or len(dt_boxes) == 0:
            return []

        # 2. 极简尺寸绝对过滤 (不设长宽比上限，长句 100% 安全存活)
        raw_boxes = []
        for idx, b in enumerate(dt_boxes):
            xs = [p[0] for p in b]
            ys = [p[1] for p in b]
            bx1 = max(0, int(round(min(xs))))
            by1 = max(0, int(round(min(ys))))
            bx2 = min(orig_w, int(round(max(xs))))
            by2 = min(orig_h, int(round(max(ys))))
            bw = bx2 - bx1
            bh = by2 - by1

            # 仅拦截微小微粒 (面积 < 60 或 宽高均 < 8px)
            if (bw < 8 and bh < 8) or (bw * bh < 60):
                continue
            # 仅拦截绝对极细划痕 (厚度 <= 3px)
            if min(bw, bh) <= 3:
                continue

            det_s = float(dt_scores[idx]) if dt_scores is not None and idx < len(dt_scores) else 0.85
            raw_boxes.append([bx1, by1, bx2, by2, det_s])

        if not raw_boxes:
            return []

        # 3. 内部嵌套冗余碎框滤除
        dedup_boxes = suppress_contained_boxes(raw_boxes, containment_thresh=0.75)

        # 4. 语种分支策略: 仅韩文启用前置碎框横向融合；英文等西文直接禁用
        is_korean = lang and lang.strip().lower() in ["kr", "ko", "korean"]
        if is_korean:
            fused_boxes = merge_horizontal_boxes(dedup_boxes, y_overlap_ratio=0.50, max_gap_ratio=1.5, max_h_diff=1.8)
        else:
            fused_boxes = dedup_boxes

        # 5. 原图高清裁切 (+2px padding)
        crops = []
        box_coords = []
        box_det_scores = []
        pad = 2
        for box_item in fused_boxes:
            bx1, by1, bx2, by2 = box_item[:4]
            det_s = box_item[4] if len(box_item) > 4 else 0.85
            cbx1 = max(0, bx1 - pad)
            cby1 = max(0, by1 - pad)
            cbx2 = min(orig_w, bx2 + pad)
            cby2 = min(orig_h, by2 + pad)
            if (cbx2 - cbx1) >= 4 and (cby2 - cby1) >= 4:
                crops.append(image[cby1:cby2, cbx1:cbx2])
                box_coords.append([cbx1, cby1, cbx2, cby2])
                box_det_scores.append(det_s)

        if not crops:
            return []

        # 6. 批量文本行识别
        rec_results, _ = engine.text_rec(crops)

        # 水印与扫图组广告正则黑名单
        watermark_patterns = [
            re.compile(r'(?i)\b(?:https?://|www\.)\S+'),
            re.compile(r'(?i)\S+\.(?:net|com|org|es|xyz|io|me|co|top|cc|site|online)\b'),
            re.compile(r'(?i)\b(?:scan|scans|scanlation|scans?esp|templescan|leeronline)\b'),
            re.compile(r'(?i)\b(?:traducido|link en el navegador|subido por|t\.me/|discord\.gg)\b'),
            re.compile(r'(?i)\b(?:mejor calidad|escribiendo este link)\b'),
        ]

        def is_noise_or_watermark(txt: str) -> bool:
            c = txt.strip()
            # 1. 单字符孤立噪音 (如 I, 1, l, -)，韩文字符单字拟声/叹词豁免
            if len(c) <= 1 and not re.search(r'[\uac00-\ud7a3]', c):
                return True
            # 2. 水印与扫图组导流横幅 (顶级域名、汉化组关键词)
            for pat in watermark_patterns:
                if pat.search(c):
                    return True
            return False

        # 7. 后过滤逻辑: REC 置信度 >= 0.80 (带标点 0.70) + 双低双杀 + 水印杂音清洗
        text_line_items: List[TextLineItem] = []
        for i, (text, rec_score) in enumerate(rec_results):
            rec_score = float(rec_score)
            det_score = float(box_det_scores[i]) if i < len(box_det_scores) else 0.85
            clean_text = text.strip()

            if not clean_text:
                continue

            # 1. 标点保护下的动态 REC 阈值:
            has_dialogue_punct = bool(re.search(r'[~!?¿¡]|\.{2,}', clean_text))
            target_min_rec = rec_thresh if has_dialogue_punct else min(rec_thresh + 0.08, 0.82)
            if rec_score < target_min_rec:
                continue

            # 2. 双低联合截杀 (动态适配 rec_thresh 与 box_thresh，防背景网点误检)
            det_floor = max(0.40, box_thresh)
            rec_floor = max(0.45, rec_thresh - 0.05)
            if det_score < det_floor and rec_score < rec_floor:
                continue

            # 3. 强力过滤汉化组水印、扫图横幅与极短单字符噪音
            if is_noise_or_watermark(clean_text):
                continue

            bbox = box_coords[i]
            # 优化：彻底移除单行第一次 extract_colors_fast 取色！单切片节省近 50% CPU！
            fr = compute_fill_ratio(image, tuple(bbox))
            text_line_items.append(TextLineItem(bbox, clean_text, rec_score, fill_ratio=fr))

        if not text_line_items:
            return []

        # 8. BFS 连通图聚类合并气泡并执行物理决策打标
        bubbles = cluster_text_lines(text_line_items, image=image, start_y=start_y)
        return bubbles


# 全局单例管理器
engine_manager = OcrEngineManager()
