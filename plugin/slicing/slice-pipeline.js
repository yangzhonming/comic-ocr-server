(function (root, factory) {
  "use strict";
  const api = factory(root.ComicSliceAlgorithm, root.ComicVirtualStrip);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ComicSlicePipeline = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (algorithm, strip) {
  "use strict";

  function checkCancelled(signal) {
    if (signal?.aborted) throw new DOMException("Slicing cancelled", "AbortError");
  }

  // Cut decisions are sequential because each target is measured from the last actual cut.
  // The provider may decode/prefetch source images concurrently behind this interface.
  async function* generate(index, provider, {signal, quality = 0.9, lang} = {}) {
    if (!algorithm || !strip) throw new Error("Slicing modules are missing");
    let startY = 0, number = 0;
    const maxHeight = Math.floor(4.32 * index.width);
    const minHeight = Math.ceil(2.6 * index.width);
    const minTail = Math.ceil(1.2 * index.width);
    while (startY < index.totalHeight) {
      checkCancelled(signal);
      const remaining = index.totalHeight - startY;
      let endY, analysis = null;
      if (remaining <= maxHeight) {
        endY = index.totalHeight;
      } else {
        const allowedMax = Math.min(maxHeight, remaining - minTail);
        const window = algorithm.planWindow({
          sliceTopY: startY, width: index.width,
          minSliceHeight: minHeight, maxSliceHeight: allowedMax,
          lang
        });
        const roiStartY = Math.max(0, Math.floor(window.requiredStartY));
        const roiEndY = Math.min(index.totalHeight, Math.ceil(window.requiredEndY) + 1);
        const pixels = await provider.getPixels(roiStartY, roiEndY);
        checkCancelled(signal);
        analysis = algorithm.analyze({
          ...pixels,
          targetY: window.targetY,
          searchStartY: window.searchStartY,
          searchEndY: window.searchEndY,
          guardPx: window.guardPx,
          pageStartY: 0,
          pageEndY: index.totalHeight,
          debug: false,
          lang
        });
        if (!analysis.selected) {
          const error = new Error("No verified cut after absolute Y=" + startY +
            " (" + analysis.status + ")");
          error.code = analysis.status;
          error.analysis = analysis;
          throw error;
        }
        if (analysis.selected.forced) {
          console.warn("[SlicePipeline] 触发降级切线 [Y=" + analysis.selected.y +
            ", 方法=" + analysis.selected.method +
            ", 风险等级=" + analysis.selected.riskTier + "]:", analysis.warning);
        }
        endY = analysis.selected.y;
      }
      if (!Number.isInteger(endY) || endY <= startY || endY > index.totalHeight) {
        throw new Error("Invalid absolute cut coordinate");
      }
      const blob = await provider.makeSlice(startY, endY, quality);
      checkCancelled(signal);
      const pages = strip.overlaps(index, startY, endY).map(span => span.page.pageIndex);
      yield {
        coordinateId: index.coordinateId,
        sliceIndex: ++number,
        startY,
        endY,
        width: index.width,
        height: endY - startY,
        sourcePages: pages,
        cutMethod: analysis?.selected?.method || "chapter-end",
        blob
      };
      startY = endY;
    }
  }

  return {generate};
});
