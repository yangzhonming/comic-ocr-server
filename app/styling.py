from typing import Tuple
import cv2
import numpy as np


def extract_colors_fast(image: np.ndarray, bbox: tuple) -> Tuple[str, str]:
    """
    超极速双采样色彩提取算法 (耗时 < 1ms)
    
    1. 气泡背景底色:
       在外围四周角落取 4 个 3x3 采样块，计算灰度方差。
       选取方差最小的角块 (代表最纯净、无笔画/插画干扰的底色)，取中位数作为真实背景色。
    
    2. 文本笔画前景色:
       将文字区域送入轻量级 2-中心 KMeans 聚类，结合 Otsu 自适应二值化反选出属于文字笔画的簇中心。
    
    返回: (bg_hex, text_hex)，如 ("#FFFFFF", "#000000")
    """
    bx1, by1, bx2, by2 = bbox
    h, w = image.shape[:2]

    # 文字核心区域
    tc_crop = image[max(0, by1):min(h, by2), max(0, bx1):min(w, bx2)]
    if tc_crop.size == 0 or tc_crop.shape[0] < 3 or tc_crop.shape[1] < 3:
        return "#FFFFFF", "#000000"

    # 背景外扩采样区域 (向外扩展 8px)
    bp = 8
    bg_x1 = max(0, bx1 - bp)
    bg_y1 = max(0, by1 - bp)
    bg_x2 = min(w, bx2 + bp)
    bg_y2 = min(h, by2 + bp)

    if bg_x2 <= bg_x1 or bg_y2 <= bg_y1:
        bg_crop = tc_crop
    else:
        bg_crop = image[bg_y1:bg_y2, bg_x1:bg_x2]

    def _kmeans_two(crop_img: np.ndarray):
        ch, cw = crop_img.shape[:2]
        if ch * cw > 1024:
            scale = np.sqrt(1024 / (ch * cw))
            crop_img = cv2.resize(
                crop_img,
                (max(1, int(cw * scale)), max(1, int(ch * scale))),
                interpolation=cv2.INTER_AREA
            )
        pixels = crop_img.reshape((-1, 3)).astype(np.float32)
        init_c = np.array([[0, 0, 0], [255, 255, 255]], dtype=np.float32)
        criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 8, 1.0)
        _, labels, centers = cv2.kmeans(
            pixels, 2, None, criteria, 1, cv2.KMEANS_USE_INITIAL_CENTERS, init_c
        )
        return labels, centers, pixels

    def _pick_text(labels: np.ndarray, centers: np.ndarray, pixels: np.ndarray) -> np.ndarray:
        gray = cv2.cvtColor(pixels.reshape((-1, 1, 3)).astype(np.uint8), cv2.COLOR_BGR2GRAY).reshape(-1)
        _, otsu = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
        flat = labels.flatten()
        c0 = np.sum((flat == 0) & (otsu == 255))
        c1 = np.sum((flat == 1) & (otsu == 255))
        return centers[0].astype(np.uint8) if c0 > c1 else centers[1].astype(np.uint8)

    def _sample_bg_corner(crop_img: np.ndarray) -> np.ndarray:
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
        best = blocks[int(np.argmin(variances))]
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
    """
    计算文本笔画在检测框中的填充率 (Fill Ratio)
    用于估计字符笔画是否加粗 (Font Weight)
    """
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


def estimate_font_weight(fill_ratio: float) -> int:
    """
    根据笔画填充率估算字重 (400 常规 vs 700 粗体)
    """
    return 700 if fill_ratio > 0.42 else 400
