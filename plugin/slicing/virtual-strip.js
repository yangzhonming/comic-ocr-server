(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ComicVirtualStrip = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function median(values) {
    const ordered = [...values].sort((a, b) => a - b);
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2 ? ordered[middle] :
      Math.round((ordered[middle - 1] + ordered[middle]) / 2);
  }

  // All coordinates are integer pixels in one chapter-wide, normalized image.
  // Every interval is half-open: [startY, endY). No two pages own the same row.
  function buildIndex(images, {coordinateId, workingWidth} = {}) {
    if (!Array.isArray(images) || !images.length) throw new TypeError("Images are required");
    if (!coordinateId || typeof coordinateId !== "string") {
      throw new TypeError("A stable coordinateId is required");
    }
    const widths = images.map(item => item.sourceWidth);
    if (images.some((item, i) =>
      !Number.isInteger(item.pageIndex) || item.pageIndex !== i + 1 ||
      !item.imageId || !Number.isInteger(item.sourceWidth) || item.sourceWidth < 1 ||
      !Number.isInteger(item.sourceHeight) || item.sourceHeight < 1)) {
      throw new TypeError("Expected ordered, dimensioned images with contiguous page indices");
    }
    if (new Set(images.map(item => item.imageId)).size !== images.length) {
      throw new TypeError("Image IDs must be unique within a coordinate system");
    }
    const width = workingWidth ?? median(widths);
    if (!Number.isInteger(width) || width < 1) throw new TypeError("Invalid working width");
    let nextY = 0;
    const pages = images.map(item => {
      const height = Math.max(1, Math.round(item.sourceHeight * width / item.sourceWidth));
      const page = Object.freeze({
        pageIndex: item.pageIndex,
        imageId: item.imageId,
        sourceWidth: item.sourceWidth,
        sourceHeight: item.sourceHeight,
        startY: nextY,
        endY: nextY + height,
        height
      });
      nextY += height;
      if (!Number.isSafeInteger(nextY)) throw new RangeError("Chapter is too tall");
      return page;
    });
    return Object.freeze({coordinateId, width, totalHeight: nextY, pages: Object.freeze(pages)});
  }

  function overlaps(index, startY, endY) {
    if (!Number.isInteger(startY) || !Number.isInteger(endY) ||
        startY < 0 || endY > index.totalHeight || startY >= endY) {
      throw new RangeError("Invalid absolute Y interval");
    }
    const result = [];
    for (const page of index.pages) {
      if (page.endY <= startY) continue;
      if (page.startY >= endY) break;
      const fromY = Math.max(startY, page.startY);
      const toY = Math.min(endY, page.endY);
      result.push({page, fromY, toY, destY: fromY - startY,
        sourceY: (fromY - page.startY) * page.sourceHeight / page.height,
        sourceHeight: (toY - fromY) * page.sourceHeight / page.height});
    }
    return result;
  }

  // OCR boxes must be in the submitted slice's pixel coordinates.
  function restoreBox(slice, box, {ocrWidth = slice.width, ocrHeight = slice.endY - slice.startY} = {}) {
    if (!slice || !box || !Number.isFinite(slice.width) || slice.width <= 0 ||
        !Number.isFinite(slice.startY) || !Number.isFinite(slice.endY) ||
        slice.endY <= slice.startY ||
        ![box.x0, box.x1, box.y0, box.y1].every(Number.isFinite) ||
        !Number.isFinite(ocrWidth) || ocrWidth <= 0 ||
        !Number.isFinite(ocrHeight) || ocrHeight <= 0) throw new TypeError("Invalid OCR geometry");
    const sx = slice.width / ocrWidth;
    const sy = (slice.endY - slice.startY) / ocrHeight;
    return {
      x0: box.x0 * sx,
      x1: box.x1 * sx,
      y0: slice.startY + box.y0 * sy,
      y1: slice.startY + box.y1 * sy
    };
  }

  // A box can cross a source-image boundary. Return one source-local box per page.
  function projectBox(index, absoluteBox) {
    const {x0, x1, y0, y1} = absoluteBox;
    if (![x0, x1, y0, y1].every(Number.isFinite) || x0 < 0 || x1 > index.width ||
        x0 >= x1 || y0 < 0 || y1 > index.totalHeight || y0 >= y1) {
      throw new RangeError("OCR box is outside the chapter coordinate system");
    }
    return index.pages.filter(page => page.startY < y1 && page.endY > y0)
      .map(page => {
        const first = Math.max(y0, page.startY);
        const last = Math.min(y1, page.endY);
        const scaleX = page.sourceWidth / index.width;
        const scaleY = page.sourceHeight / page.height;
        return {
          pageIndex: page.pageIndex, imageId: page.imageId,
          sourceBox: {
            x0: x0 * scaleX, x1: x1 * scaleX,
            y0: (first - page.startY) * scaleY,
            y1: (last - page.startY) * scaleY
          }
        };
      });
  }

  return {buildIndex, overlaps, restoreBox, projectBox};
});
