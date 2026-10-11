import re
from collections import Counter
from typing import List, Dict, Any, Optional, Tuple
import cv2
import numpy as np
from app.schemas import BubbleItem
from app.styling import estimate_font_weight, extract_colors_fast


def classify_bubble_role(
    image: Optional[np.ndarray],
    bubble_box: List[int],
    lines_count: int,
    avg_line_h: float,
    avg_fill_ratio: float,
    bg_hex: str,
    fg_hex: str,
    text: str,
    purity: Any = 1.0
) -> Tuple[Optional[str], bool, str, str]:
    """
    分层物理与语义决策树 (Hierarchical Physical & Semantic Decision Tree):
    输出: (role, is_ghost, surface, render_mode)
    若返回 (None, False, surface, "drop") 则代表衣服Logo或环境杂质，调用方直接丢弃不输出！
    
    分类通道:
    1. 通道 A (纯白气泡): 亮度 >= 215, 饱和度 <= 25 -> solid_patch (实心白羽化气泡)
    2. 通道 B (平滑非白): 渐变气泡 / 窗户背景音 -> glow_patch (半透明柔和羽化光罩，绝不糊死原画)
    3. 通道 C (复杂杂乱背景):
       - 彩色高饱和 / 白色中空字 / 巨大字号 -> sfx_overlay (拟声词加深覆盖)
       - 具有对话标点 (~!?...¡¿) / 黑色字芯 -> outlined_overlay (纯透明底 + 纯白高密度描边悬浮)
       - 既非SFX、又非画外音且完全无标点 -> 衣服Logo/场景道具，直接 drop 丢弃！
    """
    if image is None:
        return "dialogue", False, "white_solid", "solid_patch"

    h_img, w_img = image.shape[:2]
    bx, by, bw, bh = bubble_box
    clean_text = text.replace('\n', ' ').strip()

    h_std = w_img * 0.085
    height_ratio = avg_line_h / max(1.0, h_std)

    # 提取纯净度与空间一致性指标
    if isinstance(purity, dict):
        top1_purity = purity.get("top1", 1.0)
        top3_purity = purity.get("top3", 1.0)
        num_colors = purity.get("num_colors", 1)
        lum_std = purity.get("lum_std", 0.0)
        is_messy = purity.get("is_messy", False)
    else:
        top1_purity = float(purity)
        top3_purity = top1_purity
        num_colors = 1
        lum_std = 0.0
        is_messy = (top1_purity < 0.50)

    def _hex_to_lum_sat(hex_str: str) -> Tuple[float, float]:
        c = hex_str.lstrip('#')
        if len(c) != 6:
            return 255.0, 0.0
        r, g, b = int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)
        lum = 0.299 * r + 0.587 * g + 0.114 * b
        sat = float(max(r, g, b) - min(r, g, b))
        return lum, sat

    bg_lum, bg_sat = _hex_to_lum_sat(bg_hex)
    fg_lum, fg_sat = _hex_to_lum_sat(fg_hex)

    # 对话情绪标点与对白特征判断
    has_dialogue_punct = bool(re.search(r'[~?¿¡!]|\.{2,}', clean_text))
    has_dialogue_words = bool(re.search(r'\b(?:de|que|un|una|los|las|el|la|es|con|en|por|para|the|and|you|that|was|for|are|with|his|they|난|이|그|저|에|는|은|가|을|를)\b', clean_text, re.IGNORECASE))
    is_dialogue_text = has_dialogue_punct or has_dialogue_words
    is_multi_line = (lines_count >= 2)

    # === 【通道 A: 纯白标准气泡】===
    # 纯度高、亮度极高、无色彩饱和度、颜色桶集中
    is_pure_white = (bg_lum >= 215.0 and bg_sat <= 25.0 and num_colors <= 28)
    if is_pure_white:
        return "dialogue", False, "white_solid", "solid_patch"

    # === 【通道 B: 平滑非白底色 (渐变气泡 / 平滑窗户/天空)】===
    # 1. 颜色高度集中 (纯色非白气泡，如浅灰/淡黄/淡青底色):
    is_solid_nonwhite = (num_colors <= 28 and top3_purity >= 0.55)
    # 2. 渐变色气泡:
    #    - 多行对白排版且具有对白自然句式特征，背景为明亮彩色气泡 (bg_sat >= 25, bg_lum >= 120，如天蓝/樱粉/薄荷渐变框)
    #    - 或带有对话情绪标点 (~!?...¡¿)，且四向亮度平滑 (lum_std <= 35 且 bg_lum >= 90)
    is_gradient_bubble = (is_multi_line and is_dialogue_text and bg_sat >= 25.0 and bg_lum >= 120.0) or \
                         (has_dialogue_punct and (num_colors <= 50 or lum_std <= 35.0) and bg_lum >= 90.0)
    if is_solid_nonwhite or is_gradient_bubble:
        return "dialogue", False, "smooth_bg", "glow_patch"

    # === 【通道 C: 复杂杂乱背景 (衣服 / 场景道具 / 悬浮画外音 / 拟声词)】===
    # 1. 拟声词三大经典视觉特征 (鲜艳彩字、白色中空字、极端巨大字号且有一定色彩)
    is_vivid_color = (fg_sat >= 35.0)
    is_hollow_font = (avg_fill_ratio < 0.18)
    is_huge_scale = (height_ratio > 2.0 and fg_sat >= 15.0)
    if is_vivid_color or is_hollow_font or is_huge_scale:
        return "sfx", True, "textured", "sfx_overlay"

    # 2. 画外音: 必须具备对话情绪标点 (~!?...¡¿) 且多字成词
    # 坚决废除无脑 len >= 7 判定，杜绝衣服 Logo (如 REAMERS, BETTER TOGETHER) 误入画外音！
    if has_dialogue_punct and len(clean_text) >= 3:
        return "ambient", False, "textured", "outlined_overlay"

    # 3. 衣服 Logo / 货架杂质最后决断:
    # 既不是拟声词，又无对话标点 -> 100% 确认是衣服印花/道具，直接 drop 丢弃！
    return None, False, "textured", "drop"


class TextLineItem:
    """
    单行 OCR 文本识别项
    """
    def __init__(
        self,
        bbox: list,  # [x1, y1, x2, y2]
        text: str,
        score: float,
        bg_color: str = "#FFFFFF",
        text_color: str = "#000000",
        fill_ratio: float = 0.3
    ):
        self.bbox = bbox
        self.x = int(bbox[0])
        self.y = int(bbox[1])
        self.w = int(bbox[2] - bbox[0])
        self.h = int(bbox[3] - bbox[1])
        self.text = text
        self.score = score
        self.bg_color = bg_color
        self.text_color = text_color
        self.fill_ratio = fill_ratio


def get_box_dims(item: Any) -> Tuple[int, int, int, int]:
    if hasattr(item, "x"):
        return item.x, item.y, item.w, item.h
    if isinstance(item, dict):
        return int(item["x"]), int(item["y"]), int(item["w"]), int(item["h"])
    raise TypeError(f"Unsupported item type: {type(item)}")


def should_merge_detailed(
    a: Any,
    b: Any,
    x_overlap_ratio: float = 0.2,
    horizontal_gap_ratio: float = 2.0,
    horizontal_center_tol: float = 0.6,
    sfx_height_ratio: float = 2.2,
    vertical_gap_ratio: float = 1.3,
    fragment_gap_ratio: float = 0.60
) -> Tuple[bool, str]:
    """
    判断两个文本行是否属于同一个漫画对话气泡 (详细返回判定理由)
    内置拟声词隔离护盾 (Anti-SFX Shield) 与非对称孤立碎片间距约束
    """
    ax, ay, aw, ah = get_box_dims(a)
    bx, by, bw, bh = get_box_dims(b)

    # 拟声词隔离护盾：如果两行高度相差过大，严禁合并
    h_ratio = max(ah, bh) / max(min(ah, bh), 1)
    if h_ratio > sfx_height_ratio:
        return False, f"sfx_shield_blocked (h_ratio={h_ratio:.2f} > {sfx_height_ratio})"

    local_char_size = min(ah, bh)
    if local_char_size <= 0:
        return False, "zero_char"

    a_bottom = ay + ah
    b_bottom = by + bh
    center_y_a = ay + ah / 2.0
    center_y_b = by + bh / 2.0
    h_gap = max(ax, bx) - min(ax + aw, bx + bw)
    v_gap = max(ay, by) - min(a_bottom, b_bottom)

    # 规则 A：同行横向合并 (水平排列且中心 Y 轴非常接近)
    if abs(center_y_a - center_y_b) < local_char_size * horizontal_center_tol:
        # 非对称碎片间距保护：若任一方为超短孤立碎片 (单字/拟声词，宽 < 1.3H)，限制其横向跨距
        is_tiny_fragment = min(aw, bw) < local_char_size * 1.3
        effective_h_gap = local_char_size * (fragment_gap_ratio if is_tiny_fragment else horizontal_gap_ratio)
        if h_gap < effective_h_gap:
            return True, "rule_a_horizontal"
        elif is_tiny_fragment:
            return False, f"rule_a_fragment_gap_rejected (h_gap={h_gap:.1f} >= {effective_h_gap:.1f})"

    # 规则 B：同气泡纵向换行合并
    x_overlap = max(0, min(ax + aw, bx + bw) - max(ax, bx))
    is_x_overlapped = (x_overlap > min(aw, bw) * x_overlap_ratio) or (x_overlap > local_char_size)

    if is_x_overlapped:
        # === 核心排版对齐检测 (Center / Left / Right Alignment Check) ===
        # 韩漫/条漫对白气泡以居中对齐为主，矩形短信/旁白框以左对齐为主。
        center_x_a = ax + aw / 2.0
        center_x_b = bx + bw / 2.0
        center_x_diff = abs(center_x_a - center_x_b)
        left_diff = abs(ax - bx)
        right_diff = abs((ax + aw) - (bx + bw))

        # 动态容差：兼顾高分辨率原图与小字号短句，宽容度合理避免误切
        center_tol = max(14.0, local_char_size * 0.48, min(aw, bw) * 0.28)
        left_tol = max(12.0, local_char_size * 0.38)
        right_tol = max(12.0, local_char_size * 0.38)

        is_center_aligned = center_x_diff <= center_tol
        is_left_aligned = left_diff <= left_tol
        is_right_aligned = right_diff <= right_tol

        # 若中心、左缘、右缘三者均不满足对齐（例如角标、旁边飘浮的小字），坚决禁止垂直合并！
        if not (is_center_aligned or is_left_aligned or is_right_aligned):
            return False, f"rule_b_alignment_rejected (center_diff={center_x_diff:.1f} > {center_tol:.1f})"

        if v_gap <= 0:
            if abs(center_y_a - center_y_b) < max(ah, bh) * vertical_gap_ratio:
                return True, "rule_b_overlap_line"
            return False, "rule_b_center_distance_too_large"
        if v_gap < local_char_size * vertical_gap_ratio:
            return True, "rule_b_vertical_line"

    return False, "disjoint"


def should_merge(a: TextLineItem, b: TextLineItem, x_overlap_ratio: float = 0.2) -> bool:
    """生产环境轻量调用入口，直接复用 should_merge_detailed"""
    can_merge, _ = should_merge_detailed(a, b, x_overlap_ratio=x_overlap_ratio)
    return can_merge


def cluster_text_lines(
    items: List[TextLineItem],
    image: Optional[np.ndarray] = None,
    start_y: int = 0
) -> List[BubbleItem]:
    """
    使用 BFS 广度优先搜索构建图连通分量，将属于同一气泡的文本行聚类合并
    自动复位坐标为 box_abs (画布绝对坐标) 和 box_rel (切片相对坐标)
    结合物理特征短路决策树裁决 role (dialogue / narration / sfx_ghost) 与 is_ghost
    """
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
    bubbles: List[BubbleItem] = []

    for i in range(n):
        if visited[i]:
            continue

        # BFS 提取连通分量
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

        component = [items[idx] for idx in component_indices]

        # 按照漫画自然阅读顺序从上到下、从左到右排序
        # 物理行分桶 (Line Bucketization): 将 Y 轴重叠度 >= 50% 的框归为同一物理行，杜绝同行碎框误插换行符
        component.sort(key=lambda item: item.y)
        lines = []
        for it in component:
            placed = False
            for line in lines:
                ref = line[0]
                y_top = max(it.y, ref.y)
                y_bot = min(it.y + it.h, ref.y + ref.h)
                overlap = max(0, y_bot - y_top)
                min_h = min(it.h, ref.h)
                if min_h > 0 and (overlap / min_h) >= 0.50:
                    line.append(it)
                    placed = True
                    break
            if not placed:
                lines.append([it])

        formatted_lines = []
        for line in lines:
            line.sort(key=lambda item: item.x)
            line_text = " ".join(item.text.strip() for item in line if item.text.strip())
            if line_text:
                formatted_lines.append(line_text)

        merged_text = "\n".join(formatted_lines)
        if not merged_text:
            continue

        # 计算气泡包围盒（切片内局部相对坐标）
        min_x = min(item.x for item in component)
        min_y = min(item.y for item in component)
        max_x = max(item.x + item.w for item in component)
        max_y = max(item.y + item.h for item in component)

        w = max_x - min_x
        h = max_y - min_y

        box_rel = [min_x, min_y, w, h]
        box_abs = [min_x, min_y + start_y, w, h]

        # 气泡大框最终精准取色与纯净度评估:
        # 若存在图像原图，直接在整个气泡大包围盒上进行环绕一周边界环众数提取 (Border Ring Mode)
        # 并返回边界环色彩纯净度 (purity)，压倒性消除局部黑边线干扰；若无图像则回退至成员投票
        if image is not None:
            bg_color, fg_color, purity = extract_colors_fast(
                image, (min_x, min_y, max_x, max_y), return_purity=True
            )
        else:
            bg_counter = Counter()
            fg_counter = Counter()
            for item in component:
                weight = max(1, len(item.text))
                bg_counter[item.bg_color] += weight
                fg_counter[item.text_color] += weight
            bg_color = bg_counter.most_common(1)[0][0]
            fg_color = fg_counter.most_common(1)[0][0]
            purity = 1.0

        # 估算平均字号与字重
        avg_line_h = sum(item.h for item in component) / len(component)
        estimated_font_size = max(12, int(round(avg_line_h * 0.85)))

        avg_fill_ratio = sum(item.fill_ratio for item in component) / len(component)
        font_weight = estimate_font_weight(avg_fill_ratio)

        avg_score = sum(item.score for item in component) / len(component)

        # 物理特征短路决策树裁决 role, is_ghost, surface, render_mode
        role, is_ghost, surface, render_mode = classify_bubble_role(
            image=image,
            bubble_box=box_rel,
            lines_count=len(lines),
            avg_line_h=avg_line_h,
            avg_fill_ratio=avg_fill_ratio,
            bg_hex=bg_color,
            fg_hex=fg_color,
            text=merged_text,
            purity=purity
        )

        # 衣服Logo / 场景杂质截杀: 若被判定为 drop，坚决丢弃不输出！
        if role is None or render_mode == "drop":
            continue

        bubbles.append(
            BubbleItem(
                box_abs=box_abs,
                box_rel=box_rel,
                text=merged_text,
                bg=bg_color,
                fg=fg_color,
                size=estimated_font_size,
                weight=font_weight,
                score=round(avg_score, 3),
                role=role,
                is_ghost=is_ghost,
                surface=surface,
                render_mode=render_mode
            )
        )

    # 最终输出的气泡按垂直绝对坐标从上到下排列
    bubbles.sort(key=lambda b: b.box_abs[1])
    return bubbles
