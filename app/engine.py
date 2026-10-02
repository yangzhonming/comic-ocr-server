import os
import threading
from typing import Dict, List, Optional
import cv2
import numpy as np
from rapidocr_onnxruntime import RapidOCR

from app.schemas import BubbleItem
from app.styling import extract_colors_fast, compute_fill_ratio
from app.clustering import TextLineItem, cluster_text_lines


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

        # 2. 从未经下采样模糊的原图上高保真裁切 (+2px padding)
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
                crops.append(image[by1:by2, bx1:bx2])
                box_coords.append([bx1, by1, bx2, by2])

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

        # 5. BFS 连通图聚类合并气泡
        bubbles = cluster_text_lines(text_line_items, start_y=start_y)
        return bubbles


# 全局单例管理器
engine_manager = OcrEngineManager()
