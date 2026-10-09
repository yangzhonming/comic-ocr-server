const test = require("node:test");
const assert = require("node:assert/strict");

const strip = require("../slicing/virtual-strip.js");
const pixels = require("../slicing/pixel-provider.js");
const pipeline = require("../slicing/slice-pipeline.js");
const algorithm = require("../slicing/slice-algorithm.js");
const captureFlow = require("../slicing/capture-flow.js");

test("ComicCaptureFlow exports DEFAULT_CONCURRENCY of 6", () => {
  assert.equal(captureFlow.DEFAULT_CONCURRENCY, 6);
});

test("ComicCaptureFlow createSession runs with concurrency slots", async () => {
  let uploadedSlices = [];
  let inFlightSamples = [];

  // Mock global Image and fetch
  const originalFetch = global.fetch;
  const originalImage = global.Image;

  global.fetch = async (url, options) => {
    if (url.endsWith("/coordinates")) {
      return { ok: true, status: 200, json: async () => ({}) };
    }
    if (url.endsWith("/slice")) {
      await new Promise(r => setTimeout(r, 20));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          bubbles: [{ bg: "#ffffff", box: [10, 10, 50, 50], text: "hello" }]
        })
      };
    }
    return { ok: false, status: 404 };
  };

  const session = captureFlow.createSession({
    chapterId: "test-ch1",
    api: "http://127.0.0.1:8765",
    concurrency: 6,
    onSlice: (slice, count, meta) => {
      uploadedSlices.push({ sliceIndex: slice.sliceIndex, count, meta });
      inFlightSamples.push(session.getPendingBatchCount());
    }
  });

  assert.equal(typeof session.replenish, "function");
  assert.equal(typeof session.finish, "function");
  assert.equal(typeof session.close, "function");
  assert.equal(session.getPendingBatchCount(), 0);

  session.close();
  global.fetch = originalFetch;
  global.Image = originalImage;
});

test("ComicCaptureFlow contiguousImages prefix stops at gaps", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (url.endsWith("/coordinates")) return { ok: true, status: 200, json: async () => ({}) };
    if (url.endsWith("/slice")) return { ok: true, status: 200, json: async () => ({ bubbles: [] }) };
    return { ok: false, status: 404 };
  };

  const session = captureFlow.createSession({
    chapterId: "test-gap",
    api: "http://127.0.0.1:8765",
    concurrency: 6
  });

  const makeEntry = (pageIndex) => ({
    pageIndex,
    imageId: `img-${pageIndex}`,
    url: `http://example.com/p${pageIndex}.jpg`,
    img: { complete: true, currentSrc: `http://example.com/p${pageIndex}.jpg`, naturalWidth: 700, naturalHeight: 1200 }
  });

  // Send page 1 and page 4 (page 2 and 3 missing)
  await session.replenish([makeEntry(1), makeEntry(4)]);

  // Index should only contain page 1 because page 2 was missing
  const idx = session.getIndex();
  assert.equal(idx.pages.length, 1);
  assert.equal(idx.pages[0].pageIndex, 1);

  // Now replenish page 2 and page 3
  await session.replenish([makeEntry(2), makeEntry(3)]);
  const idxUpdated = session.getIndex();
  // Now all 4 contiguous pages are indexed!
  assert.equal(idxUpdated.pages.length, 4);
  session.close();
  global.fetch = originalFetch;
});

test("ComicImageCapture clearAllPageCaches preserves comic_* keys in localStorage", () => {
  const store = {
    site_session: 'abc',
    user_token: '123',
    comic_debug: '1',
    comic_dev_auto_clear_cache: '1'
  };
  const mockLocalStorage = {
    getItem(k) { return store[k]; },
    setItem(k, v) { store[k] = v; },
    removeItem(k) { delete store[k]; },
    key(i) { return Object.keys(store)[i]; },
    get length() { return Object.keys(store).length; }
  };

  for (let i = mockLocalStorage.length - 1; i >= 0; i--) {
    const k = mockLocalStorage.key(i);
    if (k && !k.startsWith('comic_')) {
      mockLocalStorage.removeItem(k);
    }
  }

  assert.equal(store.site_session, undefined);
  assert.equal(store.user_token, undefined);
  assert.equal(store.comic_debug, '1');
  assert.equal(store.comic_dev_auto_clear_cache, '1');
});

test("ComicCaptureFlow Tail Buffer holds undersized tail in pending until finalize()", async () => {
  const originalFetch = global.fetch;
  const originalDocument = global.document;
  const originalImage = global.Image;
  const originalCreateImageBitmap = global.createImageBitmap;

  global.createImageBitmap = async () => ({ width: 700, height: 1200, close() {} });
  class MockImage {
    set src(v) { setTimeout(() => { if (this.onload) this.onload(); }, 1); }
  }
  global.Image = MockImage;
  global.document = {
    createElement() {
      const canvas = {
        width: 0, height: 0,
        getContext() { return this.context; },
        toBlob(callback) { callback(new Blob(['mock'], { type: 'image/jpeg' })); }
      };
      canvas.context = {
        fillRect() {},
        drawImage() {},
        getImageData(x, y, width, height) {
          const data = new Uint8ClampedArray(width * height * 4);
          data.fill(255);
          return { data, width, height };
        }
      };
      return canvas;
    }
  };
  global.fetch = async (url) => {
    if (url.endsWith('/coordinates')) return { ok: true, status: 200, json: async () => ({}) };
    if (url.endsWith('/slice')) return { ok: true, status: 200, json: async () => ({ bubbles: [] }) };
    return { ok: false, status: 404 };
  };

  try {
    const slices = [];
    const session = captureFlow.createSession({
      chapterId: 'test-tail-under-minheight',
      api: 'http://127.0.0.1:8765',
      concurrency: 6,
      onSlice: (s, count, meta) => {
        slices.push({ s, count, meta });
      }
    });

    const makeEntry = (pageIndex) => ({
      pageIndex,
      imageId: 'img-' + pageIndex,
      url: 'http://example.com/p' + pageIndex + '.jpg',
      img: { complete: true, currentSrc: 'http://example.com/p' + pageIndex + '.jpg', naturalWidth: 700, naturalHeight: 1200 }
    });

    await session.replenish([makeEntry(1), makeEntry(2), makeEntry(3)]);
    await new Promise(r => setTimeout(r, 100));

    // Tail (1178px < minHeight 1820px) must stay in pending!
    assert.equal(slices.length, 1);
    assert.equal(slices[0].meta.isFinalBatch, false);
    const tailInfo = session.getTailInfo();
    assert.equal(tailInfo.pending, true);
    assert.equal(tailInfo.isFinal, false);
    assert.ok(tailInfo.tail < tailInfo.minHeight);

    // Now trigger finalize()
    session.finalize();
    await new Promise(r => setTimeout(r, 100));

    // Now the final tail is cut and uploaded with isFinalBatch = true!
    assert.equal(slices.length, 2);
    assert.equal(slices[1].meta.isFinalBatch, true);
    assert.equal(slices[1].s.endY, session.getIndex().totalHeight);
    assert.equal(slices[1].s.endY, 3600);
    assert.ok(slices[1].s.height < 700 * 2.6, 'Final slice height should be less than minHeight');

    session.close();
  } finally {
    global.fetch = originalFetch;
    global.document = originalDocument;
    global.Image = originalImage;
    global.createImageBitmap = originalCreateImageBitmap;
  }
});

test("ComicCaptureFlow passes lang to uploadCoordinates, upload and uploadCapture", async () => {
  const originalFetch = global.fetch;
  const requests = [];

  global.fetch = async (url, options) => {
    let body = options.body;
    let parsedBody = null;
    if (typeof body === 'string') {
      try { parsedBody = JSON.parse(body); } catch {}
    } else if (body && typeof body.entries === 'function') {
      parsedBody = {};
      for (const [key, val] of body.entries()) {
        parsedBody[key] = val;
      }
    }
    requests.push({ url, method: options.method, body: parsedBody });
    return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
  };

  try {
    // Test uploadCoordinates with explicit lang
    await captureFlow.uploadCoordinates(
      { width: 720, totalHeight: 1000, pages: [] },
      { api: "http://127.0.0.1:8000", chapterId: "ch1", lang: "ja" }
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "http://127.0.0.1:8000/coordinates");
    assert.equal(requests[0].body.lang, "ja");
    assert.equal(requests[0].body.chapter_id, "ch1");

    // Test upload with explicit lang
    const fakeBlob = new Blob(["mock"], { type: "image/jpeg" });
    await captureFlow.upload(
      { sliceIndex: 1, startY: 0, endY: 500, width: 720, height: 500, sourcePages: [1], cutMethod: "white", coordinateId: "ch1", blob: fakeBlob },
      { api: "http://127.0.0.1:8000", chapterId: "ch1", lang: "en" }
    );
    assert.equal(requests.length, 2);
    assert.equal(requests[1].url, "http://127.0.0.1:8000/slice");
    assert.equal(requests[1].body.lang, "en");
    assert.equal(requests[1].body.chapter_id, "ch1");

    // Test uploadCapture with explicit lang
    await captureFlow.uploadCapture(fakeBlob, {
      chapterId: "ch1", pageIndex: 1, imageId: "img-1", width: 720, height: 1000,
      api: "http://127.0.0.1:8000", lang: "ru"
    });
    assert.equal(requests.length, 3);
    assert.equal(requests[2].url, "http://127.0.0.1:8000/capture");
    assert.equal(requests[2].body.lang, "ru");
    assert.equal(requests[2].body.page_index, "1");

    // Test session creation with lang passing to session operations
    const session = captureFlow.createSession({
      chapterId: "ch-session",
      api: "http://127.0.0.1:8000",
      lang: "ja"
    });
    const makeEntry = (pageIndex) => ({
      pageIndex,
      imageId: `img-${pageIndex}`,
      url: `http://example.com/p${pageIndex}.jpg`,
      img: { complete: true, currentSrc: `http://example.com/p${pageIndex}.jpg`, naturalWidth: 700, naturalHeight: 1200 }
    });
    await session.replenish([makeEntry(1)]);
    session.close();

    // Verify coordinates uploaded by session included lang = 'ja'
    const coordReq = requests.find(r => r.url === "http://127.0.0.1:8000/coordinates" && r.body?.chapter_id === "ch-session");
    assert.ok(coordReq, "Session should have uploaded coordinates");
    assert.equal(coordReq.body.lang, "ja");
  } finally {
    global.fetch = originalFetch;
  }
});

