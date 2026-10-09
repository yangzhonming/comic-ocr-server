(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const core = globalThis.ComicSliceAlgorithm;
  if (!core) throw new Error("slice-algorithm.js must load before slice-demo.js");

  let pictures = [], positions = [], objectUrls = [];
  let pageWidth = 720, pageHeight = 0, scheduled = 0, current = null;
  const page = $("page");

  $("files").addEventListener("change", async event => {
    for (const item of pictures) item.bitmap.close();
    revokeUrls();
    pictures = [];
    for (const file of event.target.files) {
      try { pictures.push({file, bitmap: await createImageBitmap(file)}); }
      catch (error) { console.warn("无法读取图片", file.name, error); }
    }
    buildPage();
  });
  $("build").addEventListener("click", buildPage);
  $("order").addEventListener("change", buildPage);
  $("width").addEventListener("change", buildPage);
  $("run").addEventListener("click", analyze);
  $("ruleMode").addEventListener("change", render);
  for (const id of ["center", "radius"]) {
    $(id).addEventListener("input", () => {
      updateRangeLabels();
      drawPageOverlay();
      clearTimeout(scheduled);
      scheduled = setTimeout(analyze, 180);
    });
  }

  function revokeUrls() {
    for (const url of objectUrls) URL.revokeObjectURL(url);
    objectUrls = [];
  }

  function buildPage() {
    if (!pictures.length) return;
    clearTimeout(scheduled);
    revokeUrls();
    const ordered = [...pictures];
    if ($("order").value === "name") {
      ordered.sort((a, b) => a.file.name.localeCompare(
        b.file.name, undefined, {numeric: true, sensitivity: "base"}
      ));
    }
    pageWidth = Math.max(1, Math.round(Number($("width").value) || 720));
    pageHeight = 0;
    positions = [];
    page.replaceChildren();
    page.style.width = pageWidth + "px";
    for (const item of ordered) {
      const height = Math.max(1, Math.round(
        item.bitmap.height * pageWidth / item.bitmap.width
      ));
      const url = URL.createObjectURL(item.file);
      objectUrls.push(url);
      const image = document.createElement("img");
      image.src = url;
      image.style.height = height + "px";
      image.alt = item.file.name;
      page.appendChild(image);
      positions.push({bitmap: item.bitmap, y0: pageHeight, height});
      pageHeight += height;
    }
    const plan = core.planWindow({sliceTopY: 0, width: pageWidth});
    $("center").max = Math.max(0, pageHeight - 1);
    $("center").value = Math.min(pageHeight - 1, Math.round(plan.targetY));
    $("radius").max = Math.max(1800, Math.min(5000, Math.round(pageHeight / 2)));
    $("radius").value = Math.min(Number($("radius").max), Math.round(plan.radiusPx));
    $("imageInfo").textContent = ordered.length + " 张 · " +
      pageWidth + " × " + pageHeight + " px";
    $("pageMeta").textContent = pageWidth + " × " + pageHeight + " px";
    current = null;
    updateRangeLabels();
    drawPageOverlay();
    analyze();
  }

  function searchRange() {
    const center = Math.max(0, Math.min(pageHeight - 1, Number($("center").value)));
    const radius = Math.max(1, Number($("radius").value));
    return {
      center, radius,
      start: Math.max(0, Math.floor(center - radius)),
      end: Math.min(pageHeight - 1, Math.ceil(center + radius))
    };
  }

  function updateRangeLabels() {
    if (!pageHeight) return;
    const range = searchRange();
    $("centerValue").textContent = range.center + " px";
    $("radiusValue").textContent = range.radius + " px";
  }

  function cropPixels(y0, y1) {
    const height = y1 - y0;
    const canvas = document.createElement("canvas");
    canvas.width = pageWidth;
    canvas.height = height;
    const context = canvas.getContext("2d", {willReadFrequently: true});
    context.fillStyle = "white";
    context.fillRect(0, 0, pageWidth, height);
    for (const item of positions) {
      const top = Math.max(y0, item.y0);
      const bottom = Math.min(y1, item.y0 + item.height);
      if (bottom <= top) continue;
      const sourceY = (top - item.y0) * item.bitmap.height / item.height;
      const sourceHeight = (bottom - top) * item.bitmap.height / item.height;
      context.drawImage(
        item.bitmap, 0, sourceY, item.bitmap.width, sourceHeight,
        0, top - y0, pageWidth, bottom - top
      );
    }
    return context.getImageData(0, 0, pageWidth, height);
  }

  function legacyTextGroups(parts, width) {
    const ordered = [...parts].sort((a, b) => a.x0 - b.x0 || a.centerY - b.centerY);
    const groups = [];
    for (const part of ordered) {
      let best = null, measure = Infinity;
      for (const group of groups) {
        if (group.polarity !== part.polarity) continue;
        const gap = Math.max(0, part.x0 - group.x1, group.x0 - part.x1);
        const vertical = Math.abs(part.centerY - group.centerY);
        if (vertical > Math.max(0.035 * width, 0.75 * Math.max(part.height, group.meanHeight)) ||
            gap > Math.max(0.065 * width, 1.6 * Math.max(part.height, group.meanHeight))) continue;
        const score = gap + vertical * 1.4;
        if (score < measure) { best = group; measure = score; }
      }
      if (best) {
        best.x0 = Math.min(best.x0, part.x0); best.x1 = Math.max(best.x1, part.x1);
        best.y0 = Math.min(best.y0, part.y0); best.y1 = Math.max(best.y1, part.y1);
        best.centerY = (best.centerY * best.count + part.centerY) / (best.count + 1);
        best.meanHeight = (best.meanHeight * best.count + part.height) / (best.count + 1);
        best.count++;
      } else {
        groups.push({
          x0: part.x0, x1: part.x1, y0: part.y0, y1: part.y1,
          centerY: part.centerY, meanHeight: part.height,
          count: 1, polarity: part.polarity
        });
      }
    }
    return groups.filter(group =>
      group.count >= 3 && group.x1 - group.x0 >= 0.035 * width &&
      group.x1 - group.x0 <= 0.7 * width &&
      group.y1 - group.y0 <= 0.18 * width
    );
  }

  function analyze() {
    if (!pageHeight) return;
    const range = searchRange();
    const fontSize = core.textScale(pageWidth);
    const guard = core.defaultGuard(pageWidth);
    const padding = Math.ceil(guard + fontSize);
    const offsetY = Math.max(0, range.start - padding);
    const roiEnd = Math.min(pageHeight, range.end + padding + 1);
    const pixels = cropPixels(offsetY, roiEnd);
    const start = performance.now();
    let result;
    try {
      result = core.analyze({
        data: pixels.data,
        width: pixels.width,
        height: pixels.height,
        offsetY,
        searchStartY: range.start,
        searchEndY: range.end,
        targetY: range.center,
        pageStartY: 0,
        pageEndY: pageHeight,
        guardPx: guard,
        debug: true
      });
    } catch (error) {
      $("status").textContent = "分析失败：" + error.message;
      console.error(error);
      return;
    }
    const elapsedMs = performance.now() - start;
    if (result.status === "NEED_CONTEXT") {
      $("status").textContent = "搜索带上下文尚未加载完整。";
      return;
    }
    const oldGroups = legacyTextGroups(result.debug.components, pageWidth);
    const legacy = core.selectCut({
      candidates: result.candidates,
      cost: result.debug.projectionCost,
      offsetY: result.offsetY,
      searchStartY: result.searchStartY,
      searchEndY: result.searchEndY,
      targetY: result.targetY,
      guardPx: result.guardPx,
      highZones: oldGroups.map(group => ({
        ...group,
        y0: group.y0 + result.offsetY,
        y1: group.y1 + result.offsetY
      })),
      width: pageWidth
    });
    current = {range, result, oldGroups, legacy, elapsedMs};
    render();
  }

  function displayResult() {
    if (!current) return null;
    return $("ruleMode").value === "legacy" ?
      {choice: current.legacy, high: current.oldGroups, low: [], name: "旧版"} :
      {choice: current.result, high: current.result.textBlocks,
       low: current.result.textLines.filter(line => line.confidence === "low"),
       name: "新版"};
  }

  function addBand(top, bottom, className) {
    const element = document.createElement("div");
    element.className = className;
    element.style.top = top + "px";
    element.style.height = Math.max(1, bottom - top) + "px";
    page.appendChild(element);
  }

  function addLine(y, className) {
    const element = document.createElement("div");
    element.className = "line-mark " + className;
    element.style.top = y + "px";
    page.appendChild(element);
  }

  function drawPageOverlay() {
    if (!pageHeight) return;
    page.querySelectorAll(".band,.blocked-band,.line-mark").forEach(item => item.remove());
    const range = searchRange();
    addBand(range.start, range.end + 1, "band");
    const display = displayResult();
    if (display && current.range.start === range.start &&
        current.range.end === range.end && current.range.center === range.center) {
      for (const interval of display.choice.forbiddenIntervals) {
        addBand(interval.start, interval.end + 1, "blocked-band");
      }
      for (const candidate of display.choice.candidates) {
        addLine(candidate.y, candidate.valid ? "" : "rejected");
      }
      if (display.choice.selected) {
        const uncertain = display.choice.selected.lowDistance <= current.result.guardPx;
        addLine(display.choice.selected.y, "winner" + (uncertain ? " uncertain" : ""));
      }
    }
    addLine(range.center, "center");
  }

  function paintBinary(mask, width, height) {
    const canvas = $("binary");
    canvas.width = width; canvas.height = height;
    const image = new ImageData(width, height);
    for (let i = 0, j = 0; i < mask.length; i++, j += 4) {
      const value = mask[i] ? 0 : 255;
      image.data[j] = image.data[j + 1] = image.data[j + 2] = value;
      image.data[j + 3] = 255;
    }
    canvas.getContext("2d").putImageData(image, 0, 0);
  }

  function drawComponents(display) {
    const {result} = current, debug = result.debug;
    const canvas = $("components");
    canvas.width = result.width; canvas.height = result.height;
    const context = canvas.getContext("2d");
    context.putImageData(new ImageData(debug.componentPreview, result.width, result.height), 0, 0);
    for (const interval of display.choice.forbiddenIntervals) {
      context.fillStyle = "rgba(169,118,241,.12)";
      context.fillRect(
        0, interval.start - result.offsetY, result.width,
        interval.end - interval.start + 1
      );
    }
    for (const group of display.low) {
      context.setLineDash([5, 4]);
      context.lineWidth = 1;
      context.strokeStyle = "#8794a9";
      context.strokeRect(group.x0, group.y0, group.x1 - group.x0 + 1, group.y1 - group.y0 + 1);
    }
    context.setLineDash([]);
    for (const group of display.high) {
      context.lineWidth = Math.max(1.5, result.width / 500);
      context.strokeStyle = "#a976f1";
      context.strokeRect(group.x0, group.y0, group.x1 - group.x0 + 1, group.y1 - group.y0 + 1);
      if (group.height) {
        context.fillStyle = "#6335a0";
        context.font = "bold 11px sans-serif";
        context.fillText("框高" + Math.round(group.height) + " / F" +
          Math.round(result.fontSize), group.x0, Math.max(11, group.y0 - 2));
      }
    }
    for (const candidate of display.choice.candidates) {
      context.strokeStyle = candidate.valid ? "#ffbd3d" : "#ffbd3d88";
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(0, candidate.localY + .5);
      context.lineTo(result.width, candidate.localY + .5);
      context.stroke();
    }
    if (display.choice.selected) {
      context.strokeStyle = display.choice.selected.lowDistance <= result.guardPx ?
        "#ff9b45" : "#30bb63";
      context.lineWidth = 4;
      context.beginPath();
      context.moveTo(0, display.choice.selected.localY + .5);
      context.lineTo(result.width, display.choice.selected.localY + .5);
      context.stroke();
    }
  }

  function drawProjection(display) {
    const {result} = current;
    const values = result.debug.projectionCost;
    const canvas = $("graph"), scale = devicePixelRatio || 1;
    const width = canvas.clientWidth, height = canvas.clientHeight;
    canvas.width = width * scale; canvas.height = height * scale;
    const context = canvas.getContext("2d");
    context.scale(scale, scale);
    const pad = 25, graphWidth = width - 2 * pad, graphHeight = height - 40;
    let maximum = .03;
    for (const value of values) maximum = Math.max(maximum, value);
    context.strokeStyle = "#30405a";
    context.beginPath();
    context.moveTo(pad, 12);
    context.lineTo(pad, height - 26);
    context.lineTo(width - pad, height - 26);
    context.stroke();
    context.beginPath();
    for (let i = 0; i < values.length; i++) {
      const x = pad + graphWidth * i / Math.max(1, values.length - 1);
      const y = height - 26 - graphHeight * values[i] / maximum;
      if (!i) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.strokeStyle = "#54d9e1";
    context.lineWidth = 1.5;
    context.stroke();
    for (const candidate of display.choice.candidates) {
      const x = pad + graphWidth * candidate.localY / Math.max(1, values.length - 1);
      const y = height - 26 - graphHeight * values[candidate.localY] / maximum;
      context.fillStyle = candidate.valid ? "#ffbd3d" : "#ffbd3d80";
      context.beginPath(); context.arc(x, y, 3.5, 0, Math.PI * 2); context.fill();
    }
    if (display.choice.selected) {
      const index = display.choice.selected.localY;
      const x = pad + graphWidth * index / Math.max(1, values.length - 1);
      const y = height - 26 - graphHeight * values[index] / maximum;
      context.fillStyle = "#82f28b";
      context.beginPath(); context.arc(x, y, 6, 0, Math.PI * 2); context.fill();
    }
    context.fillStyle = "#aabcce"; context.font = "11px sans-serif";
    context.fillText("y=" + result.offsetY, pad, height - 7);
    context.fillText("y=" + (result.offsetY + result.height), width - 105, height - 7);
    context.fillText("投影风险（低谷更空）", pad + 4, 24);
  }

  function render() {
    if (!current) return;
    const display = displayResult(), {result, legacy, elapsedMs} = current;
    drawPageOverlay();
    paintBinary(result.debug.binaryMask, result.width, result.height);
    drawComponents(display);
    drawProjection(display);
    $("binaryMeta").textContent = "T=" + result.threshold + " · y " +
      result.offsetY + "–" + (result.offsetY + result.height);
    const highCount = result.textLines.filter(line => line.confidence === "high").length;
    const lowCount = result.textLines.length - highCount;
    $("componentMeta").textContent = "F≈" + result.fontSize.toFixed(0) +
      "px · 新高/低 " + highCount + "/" + lowCount +
      " · 旧框 " + current.oldGroups.length;
    const newHit = result.selected ? result.selected.y + "px" : "无安全线";
    const oldHit = legacy.selected ? legacy.selected.y + "px" : "无安全线";
    const chosen = display.choice;
    const method = chosen.status === "VALLEY" ? "投影低谷" :
      chosen.status === "SAFE_INTERVAL" ? "安全区间补选" : "无安全线";
    const uncertain = chosen.selected && chosen.selected.lowDistance <= result.guardPx;
    $("status").innerHTML = "搜索 " + result.searchStartY + "–" + result.searchEndY +
      "px · 保护距离 <b>" + result.guardPx.toFixed(0) + "px</b><br>" +
      "新版命中 <b>" + newHit + "</b> · 旧版命中 <b>" + oldHit + "</b><br>" +
      "当前：" + method + (uncertain ? " · <b>低可信区附近，待复核</b>" : "") +
      " · 算法用时 " + elapsedMs.toFixed(0) + "ms";
    const list = $("candidates");
    list.replaceChildren();
    for (const candidate of [...chosen.candidates].sort((a, b) => a.y - b.y)) {
      const line = document.createElement("div");
      line.className = "item" + (candidate.valid ? "" : " bad");
      const distance = Number.isFinite(candidate.distance) ?
        Math.round(candidate.distance) + "px" : "无高可信框";
      const marker = chosen.selected && chosen.selected.y === candidate.y ? "✓ " : "";
      const left = document.createElement("span");
      left.textContent = marker + candidate.y + "px";
      const right = document.createElement("span");
      right.textContent = (candidate.valid ? "可用" : "排除") + " · " + distance;
      line.append(left, right);
      list.appendChild(line);
    }
    if (chosen.selected && chosen.status === "SAFE_INTERVAL") {
      const line = document.createElement("div");
      line.className = "item";
      line.textContent = "补选安全线：" + chosen.selected.y + "px";
      list.appendChild(line);
    }
    if (!chosen.candidates.length && !chosen.selected) list.textContent = "当前范围没有安全切线";
  }

  window.addEventListener("resize", () => { if (current) drawProjection(displayResult()); });
})();
