(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ComicSliceAlgorithm = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

  const LANG_RATIOS = {
    kr: 0.089,
    korean: 0.089,
    韩文: 0.089,
    韩语: 0.089,
    en: 0.065,
    english: 0.065,
    英文: 0.065,
    英语: 0.065,
    ru: 0.068,
    russian: 0.068,
    俄文: 0.068,
    俄语: 0.068,
    ja: 0.090,
    jp: 0.090,
    japanese: 0.090,
    日文: 0.090,
    日语: 0.090
  };
  const DEFAULT_RATIO = 0.089;

  function getLangRatio(lang) {
    let key = lang;
    if ((key === undefined || key === null || key === "") && typeof localStorage !== "undefined") {
      try {
        key = localStorage.getItem("comic_ocr_lang");
      } catch (_) {
        key = null;
      }
    }
    if (typeof key === "number" && Number.isFinite(key) && key > 0) {
      return key;
    }
    if (typeof key === "string") {
      key = key.trim().toLowerCase();
      if (Object.prototype.hasOwnProperty.call(LANG_RATIOS, key)) {
        return LANG_RATIOS[key];
      }
    }
    return DEFAULT_RATIO;
  }

  const textScale = (width, lang) => getLangRatio(lang) * width;
  const defaultGuard = width => 0.09 * width;

  function planWindow({sliceTopY, width, targetRatio = 3.46, radiusRatio = 0.86,
                       guardRatio = 0.09, minSliceHeight, maxSliceHeight, lang}) {
    if (!Number.isFinite(sliceTopY) || !Number.isFinite(width) || width <= 0 ||
        !Number.isFinite(targetRatio) || targetRatio <= 0 ||
        !Number.isFinite(radiusRatio) || radiusRatio <= 0 ||
        !Number.isFinite(guardRatio) || guardRatio < 0 ||
        (minSliceHeight !== undefined && (!Number.isFinite(minSliceHeight) || minSliceHeight < 0)) ||
        (maxSliceHeight !== undefined && (!Number.isFinite(maxSliceHeight) || maxSliceHeight <= 0))) {
      throw new TypeError("Invalid slice window parameters");
    }
    const targetY = sliceTopY + targetRatio * width;
    const radiusPx = radiusRatio * width;
    const guardPx = guardRatio * width;
    const searchStartY = Math.max(
      sliceTopY + (minSliceHeight ?? 0), targetY - radiusPx
    );
    const searchEndY = Math.min(
      sliceTopY + (maxSliceHeight ?? Infinity), targetY + radiusPx
    );
    if (searchStartY > searchEndY) {
      throw new RangeError("Slice height limits exclude the entire search window");
    }
    const contextPadding = guardPx + textScale(width, lang);
    return {
      targetY, radiusPx, guardPx, searchStartY, searchEndY,
      requiredStartY: searchStartY - contextPadding,
      requiredEndY: searchEndY + contextPadding
    };
  }

  function grayscale(rgba, width, height) {
    const gray = new Uint8Array(width * height);
    for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
      gray[i] = Math.round(0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2]);
    }
    return gray;
  }

  function otsuThreshold(gray) {
    const histogram = new Uint32Array(256);
    for (const value of gray) histogram[value]++;
    let total = 0;
    for (let i = 0; i < 256; i++) total += i * histogram[i];
    let leftCount = 0, leftSum = 0, best = -1, threshold = 128;
    for (let i = 0; i < 256; i++) {
      leftCount += histogram[i];
      if (!leftCount) continue;
      const rightCount = gray.length - leftCount;
      if (!rightCount) break;
      leftSum += i * histogram[i];
      const difference = leftSum / leftCount - (total - leftSum) / rightCount;
      const separation = leftCount * rightCount * difference * difference;
      if (separation > best) { best = separation; threshold = i; }
    }
    return threshold;
  }

  function makeBinary(gray, threshold) {
    const mask = new Uint8Array(gray.length);
    for (let i = 0; i < gray.length; i++) mask[i] = gray[i] <= threshold ? 1 : 0;
    return mask;
  }

  function components(mask, width, height, gray, debug) {
    const seen = new Uint8Array(mask.length);
    const queue = new Int32Array(mask.length);
    const accepted = [];
    const preview = debug ? new Uint8ClampedArray(mask.length * 4) : null;
    if (preview) {
      for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
        const base = Math.round(gray[i] * 0.35 + 160);
        preview[p] = preview[p + 1] = preview[p + 2] = base;
        preview[p + 3] = 255;
      }
    }
    const maxHeight = Math.round(0.145 * width);
    const maxWidth = Math.round(0.17 * width);
    const maxArea = Math.round(0.02 * width * width);
    for (let start = 0; start < mask.length; start++) {
      if (seen[start]) continue;
      const polarity = mask[start];
      let head = 0, tail = 1;
      queue[0] = start; seen[start] = 1;
      let x0 = start % width, x1 = x0, y0 = (start / width) | 0, y1 = y0;
      while (head < tail) {
        const index = queue[head++];
        const x = index % width, y = (index / width) | 0;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const xx = x + dx;
            if (xx < 0 || xx >= width) continue;
            const next = yy * width + xx;
            if (!seen[next] && mask[next] === polarity) {
              seen[next] = 1;
              queue[tail++] = next;
            }
          }
        }
      }
      const boxWidth = x1 - x0 + 1, boxHeight = y1 - y0 + 1;
      const fill = tail / (boxWidth * boxHeight);
      if (tail < 3 || boxWidth < 2 || boxHeight < 2 ||
          boxWidth > maxWidth || boxHeight > maxHeight ||
          tail > maxArea || fill < 0.025 || fill > 0.94) continue;
      accepted.push({
        x0, x1, y0, y1, width: boxWidth, height: boxHeight,
        area: tail, fill, polarity, centerY: (y0 + y1) / 2
      });
      if (preview) {
        const color = polarity ? [39, 135, 212] : [228, 155, 69];
        for (let i = 0; i < tail; i++) {
          const p = queue[i] * 4;
          preview[p] = color[0]; preview[p + 1] = color[1]; preview[p + 2] = color[2];
        }
      }
    }
    return {items: accepted, preview};
  }

  function localBackground(group, gray, mask, width, height, fontSize) {
    const padding = Math.max(2, Math.round(0.15 * fontSize));
    const step = Math.max(1, Math.round(fontSize / 16));
    let sum = 0, squares = 0, samples = 0;
    for (let y = Math.max(0, group.y0 - padding); y <= Math.min(height - 1, group.y1 + padding); y += step) {
      for (let x = Math.max(0, group.x0 - padding); x <= Math.min(width - 1, group.x1 + padding); x += step) {
        const index = y * width + x;
        if (mask[index] === group.polarity) continue;
        const value = gray[index];
        sum += value; squares += value * value; samples++;
      }
    }
    const mean = samples ? sum / samples : 0;
    const deviation = samples ? Math.sqrt(Math.max(0, squares / samples - mean * mean)) : Infinity;
    return {mean, deviation, samples};
  }

  function groupTextLines(parts, width, height, gray, mask, lang) {
    const fontSize = (typeof lang === "number" && lang > 1) ? lang : textScale(width, lang);
    const atoms = parts.filter(part =>
      part.height >= Math.max(2, 0.04 * fontSize) &&
      part.width >= Math.max(2, 0.03 * fontSize) &&
      part.height <= 1.40 * fontSize &&
      part.width <= 1.40 * fontSize &&
      part.area <= 1.15 * fontSize * fontSize &&
      part.fill >= 0.04 && part.fill <= 0.88
    ).sort((a, b) => a.x0 - b.x0 || a.centerY - b.centerY);
    const groups = [], buckets = new Map();
    const bucketSize = Math.max(4, 0.32 * fontSize);
    for (const part of atoms) {
      const key = Math.floor(part.centerY / bucketSize);
      let match = null, bestScore = Infinity;
      for (let b = key - 2; b <= key + 2; b++) {
        for (const group of buckets.get(b) || []) {
          if (group.polarity !== part.polarity) continue;
          const gap = Math.max(0, part.x0 - group.x1, group.x0 - part.x1);
          const vertical = Math.abs(part.centerY - group.centerY);
          const newHeight = Math.max(group.y1, part.y1) - Math.min(group.y0, part.y0) + 1;
          if (gap > 0.75 * fontSize || vertical > 0.36 * fontSize || newHeight > 1.55 * fontSize) continue;
          const score = gap + 1.7 * vertical;
          if (score < bestScore) { bestScore = score; match = group; }
        }
      }
      const aspect = Math.max(part.width / part.height, part.height / part.width);
      const strokeLike = part.fill < 0.76 && aspect < 5.5;
      if (match) {
        match.x0 = Math.min(match.x0, part.x0);
        match.x1 = Math.max(match.x1, part.x1);
        match.y0 = Math.min(match.y0, part.y0);
        match.y1 = Math.max(match.y1, part.y1);
        match.centerY = (match.centerY * match.count + part.centerY) / (match.count + 1);
        match.count++;
        match.area += part.area;
        if (strokeLike) match.strokeCount++;
      } else {
        const group = {
          x0: part.x0, x1: part.x1, y0: part.y0, y1: part.y1,
          centerY: part.centerY, count: 1, area: part.area,
          strokeCount: strokeLike ? 1 : 0, polarity: part.polarity
        };
        groups.push(group);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(group);
      }
    }
    const lines = [];
    // 强化下限: 动态自适应 (863px 画布下为 21.5px，100px 微型测试画布下为 4px)
    const minLineH = Math.max(4, 0.28 * fontSize);
    const maxLineW = Math.max(width * 0.94, fontSize * 3.0);
    for (const group of groups) {
      const boxWidth = group.x1 - group.x0 + 1;
      const boxHeight = group.y1 - group.y0 + 1;
      if (group.count < 3 || boxWidth < Math.max(6, 0.45 * fontSize) ||
          boxWidth > maxLineW || boxHeight < minLineH ||
          boxHeight > 1.85 * fontSize) continue;
      const density = group.area / (boxWidth * boxHeight);
      const strokeFraction = group.strokeCount / group.count;
      const background = localBackground(group, gray, mask, width, height, fontSize);
      const matchingPolarity = group.polarity ? background.mean >= 140 : background.mean <= 135;
      const backgroundOK = background.samples >= 4 &&
        matchingPolarity && background.deviation <= 55;
      // 放宽粗体全大写英文密度限制 (0.47 -> 0.58)
      const shapeOK = density >= 0.018 && density <= 0.58 && strokeFraction >= 0.40;
      lines.push({
        ...group, width: boxWidth, height: boxHeight, density, strokeFraction,
        backgroundMean: background.mean, backgroundDeviation: background.deviation,
        confidence: backgroundOK && shapeOK ? "high" : "low", fontSize
      });
    }
    return lines;
  }

  function mergeTextBlocks(lines, fontSize) {
    const ordered = [...lines].sort((a, b) => a.y0 - b.y0);
    const blocks = [];
    for (const line of ordered) {
      let best = null;
      for (const block of blocks) {
        const gap = line.y0 - block.y1;
        if (gap < -0.30 * fontSize || gap > 1.15 * fontSize) continue;
        const overlap = Math.max(0, Math.min(line.x1, block.x1) - Math.max(line.x0, block.x0));
        const centerDistance = Math.abs((line.x0 + line.x1) / 2 - (block.x0 + block.x1) / 2);
        if (overlap < 0.10 * Math.min(line.width, block.x1 - block.x0 + 1) &&
            centerDistance > 1.6 * fontSize) continue;
        best = block;
        break;
      }
      if (best) {
        best.x0 = Math.min(best.x0, line.x0); best.x1 = Math.max(best.x1, line.x1);
        best.y0 = Math.min(best.y0, line.y0); best.y1 = Math.max(best.y1, line.y1);
        best.lineCount++;
      } else {
        blocks.push({
          x0: line.x0, x1: line.x1, y0: line.y0, y1: line.y1,
          lineCount: 1, confidence: "high"
        });
      }
    }
    return blocks;
  }

  function projection(mask, width, height) {
    const rows = new Float32Array(height);
    for (let y = 0; y < height; y++) {
      let count = 0;
      const start = y * width;
      for (let x = 0; x < width; x++) count += mask[start + x];
      rows[y] = count / width;
    }
    return rows;
  }

  function chromaticEdgeProjection(rgba, gray, width, height) {
    const rows = new Float32Array(height);
    for (let y = 0; y < height; y++) {
      let edges = 0;
      for (let x = 1; x < width; x++) {
        const i = y * width + x, p = i * 4, q = p - 4;
        const colorChange = Math.max(
          Math.abs(rgba[p] - rgba[q]),
          Math.abs(rgba[p + 1] - rgba[q + 1]),
          Math.abs(rgba[p + 2] - rgba[q + 2])
        );
        if (colorChange > 40 && Math.abs(gray[i] - gray[i - 1]) < 18) edges++;
      }
      rows[y] = edges / Math.max(1, width - 1);
    }
    return rows;
  }

  function projectionCost(rows, colorEdges, width) {
    const height = rows.length;
    const prefix = new Float64Array(height + 1);
    for (let i = 0; i < height; i++) prefix[i + 1] = prefix[i] + rows[i];
    const smooth = new Float32Array(height), radius = 3;
    for (let i = 0; i < height; i++) {
      const a = Math.max(0, i - radius), b = Math.min(height, i + radius + 1);
      smooth[i] = (prefix[b] - prefix[a]) / (b - a);
    }
    const cost = new Float32Array(height);
    const half = Math.max(2, Math.round(width * 0.012));
    for (let y = 0; y < height; y++) {
      let sum = 0, max = 0, count = 0;
      for (let j = Math.max(0, y - half); j <= Math.min(height - 1, y + half); j++) {
        sum += smooth[j]; max = Math.max(max, smooth[j]); count++;
      }
      cost[y] = 0.65 * sum / count + 0.35 * max + 0.08 * colorEdges[y];
    }
    return cost;
  }

  function candidateValleys(cost, offsetY, startY, endY, targetY, radius, width) {
    const a = clamp(Math.ceil(startY - offsetY), 0, cost.length - 1);
    const b = clamp(Math.floor(endY - offsetY), 0, cost.length - 1);
    if (b < a) return [];
    const sorted = Array.from(cost.subarray(a, b + 1)).sort((x, y) => x - y);
    const cutoff = Math.min(0.4, (sorted[Math.floor(0.3 * (sorted.length - 1))] || 0) + 0.015);
    const pool = [], covered = new Uint8Array(cost.length);
    for (let start = a; start <= b;) {
      if (cost[start] > cutoff) { start++; continue; }
      let end = start;
      while (end + 1 <= b && cost[end + 1] <= cutoff) end++;
      if (end - start >= 2) {
        let best = start, bestScore = Infinity;
        for (let y = start; y <= end; y++) {
          const score = cost[y] + 0.035 * Math.abs(offsetY + y - targetY) / Math.max(1, radius);
          if (score < bestScore) { best = y; bestScore = score; }
          covered[y] = 1;
        }
        pool.push({localY: best, y: offsetY + best, cost: cost[best], source: "wide-valley"});
      }
      start = end + 1;
    }
    for (let y = Math.max(a + 1, 1); y < Math.min(b, cost.length - 1); y++) {
      if (!covered[y] && cost[y] <= cost[y - 1] && cost[y] <= cost[y + 1]) {
        pool.push({localY: y, y: offsetY + y, cost: cost[y], source: "local-valley"});
      }
    }
    pool.sort((x, y) =>
      (x.cost + 0.07 * Math.abs(x.y - targetY) / Math.max(1, radius)) -
      (y.cost + 0.07 * Math.abs(y.y - targetY) / Math.max(1, radius))
    );
    const chosen = [], separation = Math.max(12, Math.round(width * 0.075));
    for (const candidate of pool) {
      if (chosen.every(item => Math.abs(item.y - candidate.y) >= separation)) {
        chosen.push(candidate);
        if (chosen.length >= 64) break;
      }
    }
    return chosen;
  }

  function mergeIntervals(intervals) {
    const ordered = [...intervals].sort((a, b) => a.start - b.start);
    const merged = [];
    for (const interval of ordered) {
      const last = merged[merged.length - 1];
      if (last && interval.start <= last.end + 1) {
        last.end = Math.max(last.end, interval.end);
      } else merged.push({...interval});
    }
    return merged;
  }

  function allowedIntervals(startY, endY, forbidden) {
    const allowed = [];
    let cursor = startY;
    for (const interval of forbidden) {
      if (interval.start > cursor) allowed.push({start: cursor, end: interval.start - 1});
      cursor = Math.max(cursor, interval.end + 1);
    }
    if (cursor <= endY) allowed.push({start: cursor, end: endY});
    return allowed;
  }

  function verticalDistance(y, zones) {
    let nearest = Infinity;
    for (const zone of zones) {
      const distance = y < zone.y0 ? zone.y0 - y : y > zone.y1 ? y - zone.y1 : 0;
      if (distance < nearest) nearest = distance;
    }
    return nearest;
  }

  function selectCut({candidates, cost, offsetY, searchStartY, searchEndY, targetY,
                      guardPx, highZones, lowZones = [], width, allowFallback = false}) {
    const first = Math.ceil(searchStartY), last = Math.floor(searchEndY);
    const margin = Math.ceil(guardPx);

    function getIntervals(zones, m) {
      const forbidden = mergeIntervals(zones.map(zone => ({
        start: Math.max(first, Math.floor(zone.y0 - m)),
        end: Math.min(last, Math.ceil(zone.y1 + m))
      })).filter(zone => zone.start <= zone.end));
      const safe = allowedIntervals(first, last, forbidden);
      return { forbidden, safe };
    }

    const { forbidden, safe } = getIntervals(highZones, margin);
    const softForbidden = mergeIntervals([...forbidden, ...lowZones.map(zone => ({
      start: Math.max(first, Math.floor(zone.y0 - margin)),
      end: Math.min(last, Math.ceil(zone.y1 + margin))
    })).filter(zone => zone.start <= zone.end)]);
    const softSafe = allowedIntervals(first, last, softForbidden);

    const evaluated = candidates.map(item => {
      const distance = verticalDistance(item.y, highZones);
      const lowDistance = verticalDistance(item.y, lowZones);
      return {
        ...item, distance, lowDistance,
        valid: safe.some(span => item.y >= span.start && item.y <= span.end),
        safeFromLow: softSafe.some(span => item.y >= span.start && item.y <= span.end)
      };
    });

    const valid = evaluated.filter(item => item.valid).sort((a, b) =>
      Math.abs(a.y - targetY) - Math.abs(b.y - targetY) || a.cost - b.cost
    );

    // ─── 第一级：完全安全切线 ───
    const confident = valid.filter(item => item.safeFromLow);
    if (confident.length) {
      const chosen = confident[0];
      return {
        status: "VALLEY",
        selected: {...chosen, method: "projection-valley", forced: false, riskTier: 0},
        candidates: evaluated, forbiddenIntervals: forbidden, safeIntervals: safe,
        softSafeIntervals: softSafe
      };
    }

    if (softSafe.length) {
      const fallback = softSafe.map(span => {
        const inset = Math.min(Math.round(width * 0.02), Math.floor((span.end - span.start) / 4));
        const y = clamp(Math.round(targetY), span.start + inset, span.end - inset);
        const index = y - offsetY;
        return {
          y, localY: index, cost: cost[index], source: "safe-interval",
          distance: verticalDistance(y, highZones),
          lowDistance: verticalDistance(y, lowZones)
        };
      }).sort((a, b) => Math.abs(a.y - targetY) - Math.abs(b.y - targetY) || a.cost - b.cost)[0];

      return {
        status: "SAFE_INTERVAL",
        selected: {...fallback, method: "safe-interval", forced: false, riskTier: 0},
        candidates: evaluated, forbiddenIntervals: forbidden, safeIntervals: safe,
        softSafeIntervals: softSafe
      };
    }

    if (!allowFallback) {
      if (safe.length) {
        const fallback = safe.map(span => {
          const inset = Math.min(Math.round(width * 0.02), Math.floor((span.end - span.start) / 4));
          const y = clamp(Math.round(targetY), span.start + inset, span.end - inset);
          const index = y - offsetY;
          return {
            y, localY: index, cost: cost[index], source: "safe-interval",
            distance: verticalDistance(y, highZones),
            lowDistance: verticalDistance(y, lowZones)
          };
        }).sort((a, b) => Math.abs(a.y - targetY) - Math.abs(b.y - targetY) || a.cost - b.cost)[0];
        return {
          status: "SAFE_INTERVAL",
          selected: {...fallback, method: "safe-interval", forced: false, riskTier: 0},
          candidates: evaluated, forbiddenIntervals: forbidden, safeIntervals: safe,
          softSafeIntervals: softSafe
        };
      }
      return {
        status: "NO_SAFE_CUT",
        selected: null,
        candidates: evaluated,
        forbiddenIntervals: forbidden,
        safeIntervals: safe,
        softSafeIntervals: softSafe
      };
    }

    // ─── 第二级：忽略低置信噪声 ───
    if (valid.length) {
      const chosen = valid[0];
      return {
        status: "FALLBACK_LOW_CONFIDENCE",
        selected: {...chosen, method: "fallback-low-confidence", forced: true, riskTier: 0},
        warning: {
          reason: "UNCERTAIN_NOISE",
          originalTargetY: targetY,
          selectedY: chosen.y,
          highZoneCount: highZones.length,
          lowZoneCount: lowZones.length
        },
        candidates: evaluated, forbiddenIntervals: forbidden, safeIntervals: safe,
        softSafeIntervals: softSafe
      };
    }

    if (safe.length) {
      const fallback = safe.map(span => {
        const inset = Math.min(Math.round(width * 0.02), Math.floor((span.end - span.start) / 4));
        const y = clamp(Math.round(targetY), span.start + inset, span.end - inset);
        const index = y - offsetY;
        return {
          y, localY: index, cost: cost[index], source: "safe-interval",
          distance: verticalDistance(y, highZones),
          lowDistance: verticalDistance(y, lowZones)
        };
      }).sort((a, b) => Math.abs(a.y - targetY) - Math.abs(b.y - targetY) || a.cost - b.cost)[0];

      return {
        status: "FALLBACK_LOW_CONFIDENCE",
        selected: {...fallback, method: "fallback-low-confidence", forced: true, riskTier: 0},
        warning: {
          reason: "UNCERTAIN_NOISE",
          originalTargetY: targetY,
          selectedY: fallback.y,
          highZoneCount: highZones.length,
          lowZoneCount: lowZones.length
        },
        candidates: evaluated, forbiddenIntervals: forbidden, safeIntervals: safe,
        softSafeIntervals: softSafe
      };
    }

    // ─── 第三级：逐步缩小安全距离 (0.045W -> 0W) ───
    const relaxedMargins = [Math.round(margin * 0.5), 0];
    for (const rMargin of relaxedMargins) {
      const { forbidden: rForbidden, safe: rSafe } = getIntervals(highZones, rMargin);
      if (rSafe.length) {
        const fallback = rSafe.map(span => {
          const inset = Math.min(Math.round(width * 0.02), Math.floor((span.end - span.start) / 4));
          const y = clamp(Math.round(targetY), span.start + inset, span.end - inset);
          const index = y - offsetY;
          return {
            y, localY: index, cost: cost[index], source: "relaxed-guard",
            distance: verticalDistance(y, highZones),
            lowDistance: verticalDistance(y, lowZones)
          };
        }).sort((a, b) => Math.abs(a.y - targetY) - Math.abs(b.y - targetY) || a.cost - b.cost)[0];

        return {
          status: "FALLBACK_RELAXED_GUARD",
          selected: {...fallback, method: "fallback-relaxed-guard", forced: true, riskTier: 1},
          warning: {
            reason: "GUARD_RELAXED",
            originalTargetY: targetY,
            selectedY: fallback.y,
            usedMargin: rMargin,
            originalMargin: margin,
            highZoneCount: highZones.length,
            lowZoneCount: lowZones.length
          },
          candidates: evaluated, forbiddenIntervals: rForbidden, safeIntervals: rSafe,
          softSafeIntervals: []
        };
      }
    }

    // ─── 第四级：逐行字典序最小风险 ───
    let bestRow = null;
    let bestScore = null;

    for (let y = first; y <= last; y++) {
      const localIdx = y - offsetY;
      if (localIdx < 0 || localIdx >= cost.length) continue;

      let rTier = 0;
      const distToHigh = verticalDistance(y, highZones);
      if (distToHigh === 0) {
        rTier = 2;
      } else if (distToHigh < margin) {
        rTier = 1;
      } else {
        rTier = 0;
      }

      const rowCost = cost[localIdx];
      const distTarget = Math.abs(y - targetY);

      if (!bestRow) {
        bestRow = {
          y, localY: localIdx, cost: rowCost, source: "min-risk",
          distance: distToHigh, lowDistance: verticalDistance(y, lowZones)
        };
        bestScore = [rTier, rowCost, distTarget];
      } else {
        const isBetter =
          rTier < bestScore[0] ||
          (rTier === bestScore[0] && rowCost < bestScore[1]) ||
          (rTier === bestScore[0] && rowCost === bestScore[1] && distTarget < bestScore[2]);

        if (isBetter) {
          bestRow = {
            y, localY: localIdx, cost: rowCost, source: "min-risk",
            distance: distToHigh, lowDistance: verticalDistance(y, lowZones)
          };
          bestScore = [rTier, rowCost, distTarget];
        }
      }
    }

    return {
      status: "FALLBACK_MIN_RISK",
      selected: {
        ...bestRow,
        method: "fallback-min-risk",
        forced: true,
        riskTier: bestScore ? bestScore[0] : 2
      },
      warning: {
        reason: "NO_SAFE_CUT",
        originalTargetY: targetY,
        selectedY: bestRow ? bestRow.y : targetY,
        riskTier: bestScore ? bestScore[0] : 2,
        highZoneCount: highZones.length,
        lowZoneCount: lowZones.length
      },
      candidates: evaluated, forbiddenIntervals: forbidden, safeIntervals: safe,
      softSafeIntervals: []
    };
  }

  function analyze(input) {
    const {data, width, height, lang} = input;
    if (!data || !Number.isInteger(width) || !Number.isInteger(height) ||
        width < 1 || height < 1 || data.length !== width * height * 4) {
      throw new TypeError("Expected RGBA pixels and positive integer width/height");
    }
    const offsetY = Math.round(input.offsetY || 0);
    const targetY = Math.round(input.targetY);
    const searchStartY = Math.max(offsetY, Math.ceil(input.searchStartY));
    const searchEndY = Math.min(offsetY + height - 1, Math.floor(input.searchEndY));
    if (!Number.isFinite(targetY) || !Number.isFinite(searchStartY) ||
        !Number.isFinite(searchEndY) || searchStartY > searchEndY) {
      throw new RangeError("Search range is outside the supplied pixels");
    }
    const fontSize = textScale(width, lang), guardPx = Number.isFinite(input.guardPx) ?
      input.guardPx : defaultGuard(width);
    const expectedPadding = guardPx + fontSize;
    const beforeNeeded = input.pageStartY === undefined ? null :
      Math.max(input.pageStartY, input.searchStartY - expectedPadding);
    const afterNeeded = input.pageEndY === undefined ? null :
      Math.min(input.pageEndY, input.searchEndY + expectedPadding);
    if ((beforeNeeded !== null && offsetY > beforeNeeded + 1) ||
        (afterNeeded !== null && offsetY + height < afterNeeded - 1)) {
      return {status: "NEED_CONTEXT", selected: null, expectedPadding};
    }

    const gray = grayscale(data, width, height);
    const threshold = otsuThreshold(gray);
    const mask = makeBinary(gray, threshold);
    const parts = components(mask, width, height, gray, !!input.debug);
    const textLines = groupTextLines(parts.items, width, height, gray, mask, lang);
    const highLines = textLines.filter(line => line.confidence === "high");
    const lowLines = textLines.filter(line => line.confidence === "low");
    const textBlocks = mergeTextBlocks(highLines, fontSize);
    const absolute = zone => ({...zone, y0: zone.y0 + offsetY, y1: zone.y1 + offsetY});
    const highZones = textBlocks.map(absolute);
    const lowZones = lowLines.map(absolute);
    const rows = projection(mask, width, height);
    const colorEdges = chromaticEdgeProjection(data, gray, width, height);
    const cost = projectionCost(rows, colorEdges, width);
    const candidates = candidateValleys(
      cost, offsetY, searchStartY, searchEndY, targetY,
      (searchEndY - searchStartY) / 2, width
    );
    const selection = selectCut({
      candidates, cost, offsetY, searchStartY, searchEndY, targetY, guardPx,
      highZones, lowZones, width,
      allowFallback: input.allowFallback ?? true
    });
    const uncertain = selection.selected &&
      (selection.selected.forced || selection.selected.lowDistance <= guardPx);
    return {
      ...selection, targetY, searchStartY, searchEndY, offsetY, width, height,
      fontSize, guardPx, threshold, uncertain: !!uncertain,
      safeToUse: !!selection.selected && !selection.selected.forced,
      textLines, textBlocks, highZones, lowZones,
      componentCount: parts.items.length,
      lang: lang || (typeof localStorage !== "undefined" ? localStorage.getItem("comic_ocr_lang") : null) || "kr",
      debug: input.debug ? {
        gray, binaryMask: mask, componentPreview: parts.preview,
        components: parts.items, projection: rows,
        chromaticEdgeProjection: colorEdges, projectionCost: cost
      } : undefined
    };
  }

  return {
    analyze, selectCut, planWindow, textScale, defaultGuard,
    mergeIntervals, allowedIntervals, getLangRatio, LANG_RATIOS,
    groupTextLines
  };
});
