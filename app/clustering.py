from collections import Counter
from typing import List, Dict, Any
from app.schemas import BubbleItem
from app.styling import estimate_font_weight


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


def cluster_text_lines(items: List[TextLineItem], start_y: int = 0) -> List[BubbleItem]:
    """
    使用 BFS 广度优先搜索构建图连通分量，将属于同一气泡的文本行聚类合并
    自动复位坐标为 box_abs (画布绝对坐标) 和 box_rel (切片相对坐标)
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
        component.sort(key=lambda item: (item.y, item.x))

        # 合并文本内容（多行保留换行符）
        merged_text = "\n".join(item.text.strip() for item in component if item.text.strip())
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

        bubbles.append(
            BubbleItem(
                box_abs=box_abs,
                box_rel=box_rel,
                text=merged_text,
                bg=bg_color,
                fg=fg_color,
                size=estimated_font_size,
                weight=font_weight,
                score=round(avg_score, 3)
            )
        )

    # 最终输出的气泡按垂直绝对坐标从上到下排列
    bubbles.sort(key=lambda b: b.box_abs[1])
    return bubbles
