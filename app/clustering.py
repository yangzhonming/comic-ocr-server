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
) -> Tuple[str, bool]:
    """
    分层短路物理特征决策树 (Short-Circuit Physical Decision Tree):
    精准区分正规对白气泡(dialogue)、画外音(narration)与拟声词幽灵框(sfx_ghost)。
    核心判据：
    1. 四周环取色纯净度与平滑渐变保护护盾 (Border Ring Purity & Gradient Shield):
       - 纯色气泡 (Top1 >= 45%): 允许进入常规 dialogue 判定
       - 平滑渐变气泡 (Top3 >= 60% 且 颜色桶 <= 30): 判定为平滑渐变底色气泡容器，严禁误杀为拟声词！
       - 杂乱插画背景 (Top1 < 45% 且 Top3 < 60% 或 颜色桶 > 30): 100% 确认印在原画特效中，
         一票剥夺正规 dialogue 实心补丁资格，依字长与尺度精准归流至 sfx_ghost (幽灵点读) 或 narration (透明描边)。
    2. 4-角块自适应方差与背景色一致性
    3. 气泡底色物理特征 (白底黑字、黑底白字心理话、淡彩浅色气泡)
    4. 前景与背景高对比度判定
    单框计算耗时 < 0.2ms，跨语言通用。
    返回: (role, is_ghost)
    """
    if image is None:
        return "dialogue", False

    h_img, w_img = image.shape[:2]
    bx, by, bw, bh = bubble_box
    clean_text = text.replace('\n', '').strip()

    # 移动端 390 宽度的 8.5% 标尺换算切片标准行高
    h_std = w_img * 0.085
    height_ratio = avg_line_h / max(1.0, h_std)

    # 解析背景纯度与杂乱度 (兼容 dict 或 float)
    if isinstance(purity, dict):
        is_messy = purity.get("is_messy", False)
        top1_purity = purity.get("top1", 1.0)
    else:
        top1_purity = float(purity)
        is_messy = (top1_purity < 0.50)

    # === 【首要核心判据】四周环纯净度与插画杂乱护盾 ===
    # 若被判定为杂乱插画背景 (非纯色且非平滑渐变)，坚决剥夺常规对话框 (dialogue) 资格，杜绝前端大补丁
    if is_messy:
        # 短词/招式名/拟声词 (字符数 <= 15 或相对字高较大) -> 幽灵框 (默认零遮盖透明，悬停点读)
        if len(clean_text) <= 15 or height_ratio > 1.2:
            return "sfx_ghost", True
        # 复杂画面上的叙事长句 -> 画外音/旁白 (透明底 + 高反差双描边字，保全原画)
        return "narration", False

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
    contrast = abs(bg_lum - fg_lum)

    # 采样 4 个外围角落 (采用角落采样替代连续边缘条采样，彻底避免文本尾部标点符号或紧凑框边缘碰笔画导致方差失真)
    pad = 6
    ox1, oy1 = max(0, bx - pad), max(0, by - pad)
    ox2, oy2 = min(w_img, bx + bw + pad), min(h_img, by + bh + pad)
    outer_crop = image[oy1:oy2, ox1:ox2]

    ch, cw = outer_crop.shape[:2]
    k = max(2, min(6, ch // 2, cw // 2)) if (ch >= 4 and cw >= 4) else 1
    corners = [
        outer_crop[0:k, 0:k],
        outer_crop[0:k, -k:],
        outer_crop[-k:, 0:k],
        outer_crop[-k:, -k:],
    ]
    cvars = [float(np.var(cv2.cvtColor(c, cv2.COLOR_BGR2GRAY))) for c in corners if c.size > 0]
    cmeans = [float(np.mean(cv2.cvtColor(c, cv2.COLOR_BGR2GRAY))) for c in corners if c.size > 0]

    # 平整角块判定 (方差 <= 40 说明是平滑纯色)
    flat_corners = [i for i, v in enumerate(cvars) if v <= 40.0]
    # 角块灰度与采样背景色一致性 (差值 <= 45 说明与气泡底色属于同一种纯净底色)
    matching_flat_corners = [i for i in flat_corners if abs(cmeans[i] - bg_lum) <= 45.0]
    num_matching_flat = len(matching_flat_corners)

    # 气泡底色特征 (白底黑字、黑底白字心理话、浅色/淡彩气泡)
    is_light_bubble = (bg_lum >= 150.0 and bg_sat <= 45.0)
    is_dark_bubble = (bg_lum <= 95.0 and bg_sat <= 35.0)
    is_pastel_bubble = (bg_lum >= 160.0 and bg_sat <= 70.0)
    is_speech_bubble_color = (is_light_bubble or is_dark_bubble or is_pastel_bubble)

    # Layer 1: 【一票肯定权】标准对白气泡判定 (Bubble Immersion)
    # 只要符合气泡底色特征且图文有良好对比度:
    if is_speech_bubble_color and contrast >= 35.0:
        # 1. 至少 2 个角落平整纯净并与底色一致且非杂乱插画 -> 绝大多数正规气泡
        if num_matching_flat >= 2 and not is_messy:
            return "dialogue", False
        # 2. 至少 1 个角落平整且是多行或多字对白且非杂乱插画 -> 异形/椭圆紧凑对白气泡
        if num_matching_flat >= 1 and not is_messy and (lines_count >= 2 or len(clean_text) >= 4):
            return "dialogue", False
        # 3. 极高明度纯白背景 (底色 >= 220 纯白画布) 且有多字文本 -> 必定为对话气泡
        if bg_lum >= 220.0 and bg_sat <= 25.0 and not is_messy and (lines_count >= 2 or len(clean_text) >= 3):
            return "dialogue", False

    # Layer 2: 【一票否决权】拟声词/环境字检测 (SFX Ghost)
    # 1. 高饱和彩色字体 (漫画中鲜艳彩字几乎都是拟声词/环境字)
    if fg_sat >= 45.0:
        return "sfx_ghost", True

    # 2. 极端尺度 (超大招式字/音效字，或无平滑底色的过小杂字)
    if (height_ratio > 2.2 or height_ratio < 0.40) and num_matching_flat == 0:
        return "sfx_ghost", True

    # 3. 空心字/畸变笔画
    if (avg_fill_ratio < 0.12 or avg_fill_ratio > 0.58) and not is_speech_bubble_color:
        return "sfx_ghost", True

    # 4. 背景杂乱 (无任何平滑纯色角落，说明直接绘制在插画/画面上)
    if num_matching_flat == 0 and cvars and min(cvars) > 80.0:
        # 短词/拟声词直接进入幽灵框
        if len(clean_text) <= 15:
            return "sfx_ghost", True
        # 复杂画面上的中性长句 -> 画外音/旁白 (保全原画)
        return "narration", False

    # Layer 3: 【兜底裁决】
    if is_speech_bubble_color:
        return "dialogue", False

    if len(clean_text) <= 3:
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

        # 物理特征短路决策树裁决 role 与 is_ghost
        role, is_ghost = classify_bubble_role(
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
