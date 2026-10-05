from collections import Counter
from typing import List, Dict, Any, Optional, Tuple
import cv2
import numpy as np
from app.schemas import BubbleItem
from app.styling import estimate_font_weight


def classify_bubble_role(
    image: Optional[np.ndarray],
    bubble_box: List[int],
    lines_count: int,
    avg_line_h: float,
    avg_fill_ratio: float,
    bg_hex: str,
    fg_hex: str,
    text: str
) -> Tuple[str, bool]:
    """
    分层短路物理特征决策树 (Short-Circuit Physical Decision Tree):
    判断文本块属于对白(dialogue)、画外音(narration) 还是 拟声词幽灵框(sfx_ghost)
    单框计算耗时 < 0.2ms，跨语言通用，不依赖特定语种词典。
    返回: (role, is_ghost)
    """
    if image is None:
        return "dialogue", False

    h_img, w_img = image.shape[:2]
    bx, by, bw, bh = bubble_box
    pad = 6
    ox1, oy1 = max(0, bx - pad), max(0, by - pad)
    ox2, oy2 = min(w_img, bx + bw + pad), min(h_img, by + bh + pad)
    outer_crop = image[oy1:oy2, ox1:ox2]

    margin_var = 100.0
    if outer_crop.shape[0] >= 2 * pad and outer_crop.shape[1] >= 2 * pad:
        top_strip = outer_crop[0:pad, :]
        bot_strip = outer_crop[-pad:, :]
        left_strip = outer_crop[:, 0:pad]
        right_strip = outer_crop[:, -pad:]
        margin_pixels = np.concatenate([
            top_strip.reshape(-1, 3),
            bot_strip.reshape(-1, 3),
            left_strip.reshape(-1, 3),
            right_strip.reshape(-1, 3)
        ])
        gray_margin = cv2.cvtColor(margin_pixels.reshape(-1, 1, 3), cv2.COLOR_BGR2GRAY).flatten()
        margin_var = float(np.var(gray_margin))
    elif outer_crop.size > 0:
        ch, cw = outer_crop.shape[:2]
        k = max(1, min(3, ch, cw))
        corners = [
            outer_crop[0:k, 0:k],
            outer_crop[0:k, -k:],
            outer_crop[-k:, 0:k],
            outer_crop[-k:, -k:],
        ]
        vars_c = [float(np.var(cv2.cvtColor(c, cv2.COLOR_BGR2GRAY))) for c in corners if c.size > 0]
        margin_var = min(vars_c) if vars_c else 100.0

    # 移动端 390 宽度的 8.5% 标尺换算切片标准行高
    h_std = w_img * 0.085
    height_ratio = avg_line_h / max(1.0, h_std)

    # Layer 1: 【一票肯定权】气泡浸润度检测 (外扩环形留白平整 -> 必定浸泡在纯色气泡中)
    if (lines_count >= 2 and margin_var < 55.0) or (margin_var < 35.0):
        return "dialogue", False

    # Layer 2: 【一票否决权】极端尺度与空心度检测
    if height_ratio > 2.2 or height_ratio < 0.45 or avg_fill_ratio < 0.13 or avg_fill_ratio > 0.55:
        return "sfx_ghost", True

    # Layer 3: 【综合裁决层】色彩中性度与长宽比 (画外音 vs 拟声词/环境字)
    def _color_diff(hex_str: str) -> float:
        c = hex_str.lstrip('#')
        if len(c) != 6:
            return 0.0
        r, g, b = int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)
        return float(max(r, g, b) - min(r, g, b))

    fg_sat = _color_diff(fg_hex)
    aspect_ratio = bw / max(1.0, float(bh))
    clean_text = text.replace('\n', '').strip()

    # 画外音/旁白: 色彩中性(非高饱和彩字)，呈长矩形或完整长句
    if fg_sat <= 35.0 and (aspect_ratio >= 3.2 or len(clean_text) >= 6):
        return "narration", False

    # 孤立单双字叹词/杂音 (如 '헐', '쾅')
    if len(clean_text) <= 2 or margin_var > 75.0:
        return "sfx_ghost", True

    return "dialogue", False


class TextLineItem:
    """
    单行 OCR 文本识别项
    """
    def __init__(
        self,
        bbox: list,  # [x1, y1, x2, y2]
        text: str,
        score: float,
        bg_color: str,
        text_color: str,
        fill_ratio: float
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


def should_merge(a: TextLineItem, b: TextLineItem, x_overlap_ratio: float = 0.2) -> bool:
    """
    判断两个文本行是否属于同一个漫画对话气泡
    内置拟声词隔离护盾 (Anti-SFX Shield)
    """
    # 拟声词护盾：如果两行高度相差 2.2 倍以上，绝非同一段对白，严禁合并
    h_ratio = max(a.h, b.h) / max(min(a.h, b.h), 1)
    if h_ratio > 2.2:
        return False

    local_char_size = min(a.h, b.h)
    if local_char_size <= 0:
        return False

    a_bottom = a.y + a.h
    b_bottom = b.y + b.h
    center_y_a = a.y + a.h / 2.0
    center_y_b = b.y + b.h / 2.0
    h_gap = max(a.x, b.x) - min(a.x + a.w, b.x + b.w)
    v_gap = max(a.y, b.y) - min(a_bottom, b_bottom)

    # 规则 A：同行横向合并 (水平排列且中心 Y 轴非常接近)
    if abs(center_y_a - center_y_b) < local_char_size * 0.6:
        if h_gap < local_char_size * 2.0:
            return True

    # 规则 B：同气泡纵向换行合并
    x_overlap = max(0, min(a.x + a.w, b.x + b.w) - max(a.x, b.x))
    is_x_overlapped = (x_overlap > min(a.w, b.w) * x_overlap_ratio) or (x_overlap > local_char_size)

    if is_x_overlapped:
        if v_gap <= 0:
            # 存在垂直重叠，检查中心 Y 是否在合理邻近范围
            if abs(center_y_a - center_y_b) < max(a.h, b.h) * 1.3:
                return True
            return False
        # 纵向间距小于 1.3 倍字高
        if v_gap < local_char_size * 1.3:
            return True

    return False


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

        # 计算主导背景色与文字色（按文本长度加权投票）
        bg_counter = Counter()
        fg_counter = Counter()
        for item in component:
            weight = max(1, len(item.text))
            bg_counter[item.bg_color] += weight
            fg_counter[item.text_color] += weight

        bg_color = bg_counter.most_common(1)[0][0]
        fg_color = fg_counter.most_common(1)[0][0]

        # 估算平均字号与字重
        avg_line_h = sum(item.h for item in component) / len(component)
        estimated_font_size = max(12, int(round(avg_line_h * 0.85)))

        avg_fill_ratio = sum(item.fill_ratio for item in component) / len(component)
        font_weight = estimate_font_weight(avg_fill_ratio)

        avg_score = sum(item.score for item in component) / len(component)

        # 物理特征短路决策树裁决 role 与 is_ghost
        role, is_ghost = classify_bubble_role(
            image=image,
            bubble_box=box_rel,
            lines_count=len(lines),
            avg_line_h=avg_line_h,
            avg_fill_ratio=avg_fill_ratio,
            bg_hex=bg_color,
            fg_hex=fg_color,
            text=merged_text
        )

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
                is_ghost=is_ghost
            )
        )

    # 最终输出的气泡按垂直绝对坐标从上到下排列
    bubbles.sort(key=lambda b: b.box_abs[1])
    return bubbles
