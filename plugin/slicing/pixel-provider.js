(function (root, factory) {
  "use strict";
  const api = factory(root.ComicVirtualStrip);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ComicSlicePixels = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (strip) {
  "use strict";

  function loadBitmap(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.onload = async () => {
        try {
          const bitmap = await createImageBitmap(image);
          resolve(bitmap);
        } catch (error) { reject(error); }
        finally { image.onload = image.onerror = null; image.src = ""; }
      };
      image.onerror = () => reject(new Error("Image failed to load: " + url.slice(0, 120)));
      image.src = url;
    });
  }

  function canvasBlob(canvas, quality) {
    return new Promise((resolve, reject) => canvas.toBlob(
      blob => blob ? resolve(blob) : reject(new Error("Slice JPEG export failed")),
      "image/jpeg", quality
    ));
  }

  function createProvider(initialIndex, sources, {maxBitmaps = 3, bitmapLoader = loadBitmap} = {}) {
    if (!strip) throw new Error("virtual-strip.js must load before pixel-provider.js");
    let currentIndex = initialIndex;
    const cache = new Map();
    let clock = 0;
    let closed = false;

    function evict() {
      if (cache.size <= maxBitmaps) return;
      const unused = [...cache.entries()].filter(([, item]) => item.users === 0)
        .sort((a, b) => a[1].lastUse - b[1].lastUse);
      for (const [id, item] of unused) {
        if (cache.size <= maxBitmaps) break;
        cache.delete(id);
        item.promise.then(bitmap => bitmap.close()).catch(() => {});
      }
    }

    function disposePast(endY) {
      if (!Number.isFinite(endY)) return;
      for (const [id, item] of cache) {
        if (item.users === 0 && item.page && item.page.endY <= endY) {
          cache.delete(id);
          item.promise.then(bitmap => {
            if (bitmap && typeof bitmap.close === 'function') bitmap.close();
          }).catch(() => {});
        }
      }
    }

    async function acquire(page) {
      if (closed) throw new Error("Pixel provider is closed");
      let item = cache.get(page.imageId);
      if (!item) {
        const url = sources.get(page.imageId);
        if (!url) throw new Error("Missing source URL for page " + page.pageIndex);
        item = {users: 0, lastUse: ++clock, page,
          promise: Promise.resolve().then(() => bitmapLoader(url))};
        cache.set(page.imageId, item);
      }
      item.users++;
      item.lastUse = ++clock;
      try {
        const bitmap = await item.promise;
        if (bitmap.width !== page.sourceWidth || bitmap.height !== page.sourceHeight) {
          throw new Error("Source dimensions changed for page " + page.pageIndex);
        }
        return bitmap;
      } catch (error) {
        item.users--;
        cache.delete(page.imageId);
        throw error;
      }
    }

    async function paint(startY, endY) {
      const spans = strip.overlaps(currentIndex, startY, endY);
      const canvas = document.createElement("canvas");
      canvas.width = currentIndex.width;
      canvas.height = endY - startY;
      const ctx = canvas.getContext("2d", {willReadFrequently: true});
      if (!ctx) throw new Error("Canvas 2D is unavailable");
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      // Source images for a cross-page ROI can decode in parallel. Painting keeps
      // their destination order, so the absolute coordinate mapping stays stable.
      const loaded = await Promise.allSettled(spans.map(span => acquire(span.page)));
      try {
        const failed = loaded.find(item => item.status === "rejected");
        if (failed) throw failed.reason;
        for (let i = 0; i < spans.length; i++) {
          const span = spans[i];
          const bitmap = loaded[i].value;
          ctx.drawImage(bitmap,
            0, span.sourceY, span.page.sourceWidth, span.sourceHeight,
            0, span.destY, currentIndex.width, span.toY - span.fromY);
        }
        return canvas;
      } finally {
        for (let i = 0; i < spans.length; i++) {
          if (loaded[i].status !== "fulfilled") continue;
          const item = cache.get(spans[i].page.imageId);
          if (item) { item.users--; item.lastUse = ++clock; }
        }
        evict();
      }
    }

    return {
      updateIndex(nextIndex) {
        currentIndex = nextIndex;
      },
      getIndex() {
        return currentIndex;
      },
      async getPixels(startY, endY) {
        const canvas = await paint(startY, endY);
        try {
          const image = canvas.getContext("2d", {willReadFrequently: true})
            .getImageData(0, 0, canvas.width, canvas.height);
          return {data: image.data, width: image.width, height: image.height, offsetY: startY};
        } finally { canvas.width = canvas.height = 0; }
      },
      async makeSlice(startY, endY, quality = 0.9) {
        const canvas = await paint(startY, endY);
        try {
          const blob = await canvasBlob(canvas, quality);
          disposePast(endY);
          return blob;
        } finally { canvas.width = canvas.height = 0; }
      },
      disposePast,
      getCacheSize() { return cache.size; },
      close() {
        closed = true;
        for (const item of cache.values()) item.promise.then(bitmap => bitmap.close()).catch(() => {});
        cache.clear();
      }
    };
  }

  return {createProvider};
});
