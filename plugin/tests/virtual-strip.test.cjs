const test = require("node:test");
const assert = require("node:assert/strict");
require("../slicing/slice-algorithm.js");
const strip = require("../slicing/virtual-strip.js");
const pipeline = require("../slicing/slice-pipeline.js");
const pixels = require("../slicing/pixel-provider.js");

test("370px and 372px pages share one 371px absolute coordinate system", () => {
  const index = strip.buildIndex([
    {pageIndex: 1, imageId: "first", sourceWidth: 370, sourceHeight: 1000},
    {pageIndex: 2, imageId: "second", sourceWidth: 372, sourceHeight: 1000}
  ], {coordinateId: "chapter-a"});
  assert.equal(index.width, 371);
  assert.equal(index.pages[0].endY, index.pages[1].startY);
  assert.equal(index.totalHeight, 2000);
  const spans = strip.overlaps(index, 700, 1800);
  assert.equal(spans.length, 2);
  assert.equal(spans[0].destY, 0);
  assert.equal(spans[1].destY, index.pages[0].endY - 700);
  assert.equal(spans[0].toY - spans[0].fromY + spans[1].toY - spans[1].fromY, 1100);
  assert.equal(spans[0].sourceHeight + spans[0].sourceY, 1000);
  assert.equal(spans[1].sourceY, 0);
});

test("OCR coordinates return to absolute chapter coordinates", () => {
  const box = strip.restoreBox(
    {coordinateId: "chapter-a", startY: 3000, endY: 4000, width: 720},
    {x0: 10, y0: 200, x1: 20, y1: 300}
  );
  assert.deepEqual(box, {x0: 10, x1: 20, y0: 3200, y1: 3300});
  const resized = strip.restoreBox(
    {startY: 3000, endY: 4000, width: 720},
    {x0: 5, y0: 100, x1: 10, y1: 150},
    {ocrWidth: 360, ocrHeight: 500}
  );
  assert.deepEqual(resized, box);
});

test("OCR box crossing an image seam maps to both source images", () => {
  const index = strip.buildIndex([
    {pageIndex: 1, imageId: "a", sourceWidth: 370, sourceHeight: 1000},
    {pageIndex: 2, imageId: "b", sourceWidth: 372, sourceHeight: 1000}
  ], {coordinateId: "chapter-seam"});
  const seam = index.pages[0].endY;
  const parts = strip.projectBox(index, {x0: 0, x1: index.width,
    y0: seam - 10, y1: seam + 20});
  assert.equal(parts.length, 2);
  assert.equal(parts[0].sourceBox.y1, 1000);
  assert.equal(parts[1].sourceBox.y0, 0);
  assert.equal(parts[0].sourceBox.x1, 370);
  assert.equal(parts[1].sourceBox.x1, 372);
});

test("cross-page slice paints both source regions into one local canvas", async () => {
  const index = strip.buildIndex([
    {pageIndex: 1, imageId: "a", sourceWidth: 370, sourceHeight: 1000},
    {pageIndex: 2, imageId: "b", sourceWidth: 372, sourceHeight: 1000}
  ], {coordinateId: "chapter-cross"});
  const canvases = [];
  const oldDocument = global.document;
  global.document = {
    createElement() {
      const canvas = {width: 0, height: 0, calls: [],
        getContext() { return this.context; },
        toBlob(callback) { callback({size: this.width * this.height}); }};
      canvas.context = {
        fillRect() {},
        drawImage(...args) { canvas.calls.push(args); },
        getImageData(x, y, width, height) {
          return {data: new Uint8ClampedArray(width * height * 4), width, height};
        }
      };
      canvases.push(canvas);
      return canvas;
    }
  };
  try {
    const provider = pixels.createProvider(index, new Map([["a", "a"], ["b", "b"]]), {
      bitmapLoader: async url => ({width: url === "a" ? 370 : 372,
        height: 1000, close() {}})
    });
    const roi = await provider.getPixels(700, 1800);
    assert.equal(roi.offsetY, 700);
    assert.equal(roi.height, 1100);
    assert.equal(canvases[0].calls.length, 2);
    assert.equal(canvases[0].calls[0][6], 0);
    assert.equal(canvases[0].calls[1][6], index.pages[0].endY - 700);
    assert.equal(canvases[0].calls[0][8] + canvases[0].calls[1][8], 1100);
    const blob = await provider.makeSlice(700, 1800);
    assert.equal(blob.size, index.width * 1100);
    assert.equal(canvases[1].height, 0); // The temporary canvas was released.
    assert.equal(canvases[1].calls.length, 2);
    provider.close();
  } finally { global.document = oldDocument; }
});

test("slice pipeline covers chapter exactly and advances from real cuts", async () => {
  const index = strip.buildIndex([
    {pageIndex: 1, imageId: "p1", sourceWidth: 100, sourceHeight: 500},
    {pageIndex: 2, imageId: "p2", sourceWidth: 100, sourceHeight: 500}
  ], {coordinateId: "chapter-b"});
  const pixelRequests = [];
  const provider = {
    async getPixels(startY, endY) {
      pixelRequests.push([startY, endY]);
      const data = new Uint8ClampedArray(100 * (endY - startY) * 4);
      data.fill(255);
      return {data, width: 100, height: endY - startY, offsetY: startY};
    },
    async makeSlice(startY, endY) { return {size: endY - startY}; }
  };
  const slices = [];
  for await (const slice of pipeline.generate(index, provider)) slices.push(slice);
  assert.ok(slices.length >= 3);
  assert.equal(slices[0].startY, 0);
  assert.equal(slices.at(-1).endY, index.totalHeight);
  for (let i = 1; i < slices.length; i++) {
    assert.equal(slices[i].startY, slices[i - 1].endY);
    assert.ok(slices[i].endY > slices[i].startY);
  }
  assert.ok(slices.some(slice => slice.sourcePages.length === 2));
  assert.ok(pixelRequests.length >= 1);
});
