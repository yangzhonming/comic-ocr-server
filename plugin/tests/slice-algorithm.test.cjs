const test = require("node:test");
const assert = require("node:assert/strict");
const algorithm = require("../slicing/slice-algorithm.js");

test("window planner applies width ratios and optional slice height limits", () => {
  const plan = algorithm.planWindow({
    sliceTopY: 100, width: 720, minSliceHeight: 2000, maxSliceHeight: 2800
  });
  assert.equal(plan.targetY, 2591.2);
  assert.equal(plan.searchStartY, 2100);
  assert.equal(plan.searchEndY, 2900);
  assert.equal(plan.guardPx, 64.8);
  assert.ok(plan.requiredStartY < plan.searchStartY);
  assert.ok(plan.requiredEndY > plan.searchEndY);
  assert.throws(() => algorithm.planWindow({
    sliceTopY: 0, width: 720, minSliceHeight: 4000
  }), RangeError);
});

test("projection candidate through a protected text block is rejected", () => {
  const result = algorithm.selectCut({
    candidates: [
      {y: 250, localY: 50, cost: 0.001},
      {y: 220, localY: 20, cost: 0.1}
    ],
    cost: new Float32Array(101),
    offsetY: 200,
    searchStartY: 200,
    searchEndY: 300,
    targetY: 250,
    guardPx: 10,
    highZones: [{y0: 240, y1: 260}],
    width: 100
  });
  assert.equal(result.status, "VALLEY");
  assert.equal(result.selected.y, 220);
  assert.equal(result.candidates.find(item => item.y === 250).valid, false);
});

test("safe interval fallback finds a line missed by projection minima", () => {
  const result = algorithm.selectCut({
    candidates: [{y: 250, localY: 50, cost: 0}],
    cost: new Float32Array(101),
    offsetY: 200,
    searchStartY: 200,
    searchEndY: 300,
    targetY: 250,
    guardPx: 10,
    highZones: [{y0: 240, y1: 260}],
    width: 100
  });
  assert.equal(result.status, "SAFE_INTERVAL");
  assert.ok(result.selected.y <= 229 || result.selected.y >= 271);
});

test("low-confidence text makes the selector try a different safe line", () => {
  const result = algorithm.selectCut({
    candidates: [{y: 250, localY: 50, cost: 0.001}],
    cost: new Float32Array(101), offsetY: 200,
    searchStartY: 200, searchEndY: 300, targetY: 250,
    guardPx: 10, highZones: [], lowZones: [{y0: 245, y1: 255}], width: 100
  });
  assert.equal(result.status, "SAFE_INTERVAL");
  assert.ok(result.selected.y <= 234 || result.selected.y >= 266);
  assert.ok(result.selected.lowDistance >= 10);
});

test("no safe region does not fall back to the theoretical line", () => {
  const result = algorithm.selectCut({
    candidates: [{y: 250, localY: 50, cost: 0}],
    cost: new Float32Array(101),
    offsetY: 200,
    searchStartY: 200,
    searchEndY: 300,
    targetY: 250,
    guardPx: 10,
    highZones: [{y0: 195, y1: 305}],
    width: 100
  });
  assert.equal(result.status, "NO_SAFE_CUT");
  assert.equal(result.selected, null);
  assert.deepEqual(result.safeIntervals, []);
});

test("letter scale grouping protects a synthetic text row", () => {
  const width = 100, height = 400;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = pixels[i + 1] = pixels[i + 2] = 255;
    pixels[i + 3] = 255;
  }
  function black(x, y) {
    const i = (y * width + x) * 4;
    pixels[i] = pixels[i + 1] = pixels[i + 2] = 0;
  }
  for (const x0 of [34, 42, 50]) {
    for (let y = 190; y <= 196; y++) black(x0, y);
    for (let x = x0; x <= x0 + 3; x++) black(x, 196);
  }
  const result = algorithm.analyze({
    data: pixels, width, height, offsetY: 0,
    searchStartY: 150, searchEndY: 250, targetY: 193,
    pageStartY: 0, pageEndY: 400,
    guardPx: 9, debug: true
  });
  assert.ok(result.textLines.some(line => line.confidence === "high"));
  assert.ok(result.highZones.some(zone => zone.y0 <= 193 && zone.y1 >= 193));
  assert.ok(result.selected);
  assert.ok(result.selected.y < 181 || result.selected.y > 205);
});

test("nearby dialogue lines become one protected block", () => {
  const width = 100, height = 400;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = pixels[i + 1] = pixels[i + 2] = pixels[i + 3] = 255;
  }
  for (const y0 of [190, 202]) {
    for (const x0 of [34, 42, 50]) {
      for (let y = y0; y <= y0 + 6; y++) {
        const i = (y * width + x0) * 4;
        pixels[i] = pixels[i + 1] = pixels[i + 2] = 0;
      }
      for (let x = x0; x <= x0 + 3; x++) {
        const i = ((y0 + 6) * width + x) * 4;
        pixels[i] = pixels[i + 1] = pixels[i + 2] = 0;
      }
    }
  }
  const result = algorithm.analyze({
    data: pixels, width, height, offsetY: 0,
    searchStartY: 150, searchEndY: 250, targetY: 200,
    pageStartY: 0, pageEndY: 400, guardPx: 9
  });
  assert.equal(result.textBlocks.length, 1);
  assert.ok(result.textBlocks[0].y0 <= 190);
  assert.ok(result.textBlocks[0].y1 >= 208);
  assert.notEqual(result.selected?.y, 200);
});

test("analysis waits when the search band's outside context is absent", () => {
  const width = 100, height = 110;
  const pixels = new Uint8ClampedArray(width * height * 4);
  const result = algorithm.analyze({
    data: pixels, width, height, offsetY: 90,
    searchStartY: 100, searchEndY: 190, targetY: 150,
    pageStartY: 0, pageEndY: 400
  });
  assert.equal(result.status, "NEED_CONTEXT");
  assert.equal(result.selected, null);
});

test("tier 2 degradation: accepts valley with low-confidence noise when allowFallback is true", () => {
  const result = algorithm.selectCut({
    candidates: [{y: 250, localY: 50, cost: 0.001}],
    cost: new Float32Array(101),
    offsetY: 200,
    searchStartY: 200,
    searchEndY: 300,
    targetY: 250,
    guardPx: 10,
    highZones: [],
    lowZones: [{y0: 190, y1: 310}], // covers entire range with lowZones
    width: 100,
    allowFallback: true
  });
  assert.equal(result.status, "FALLBACK_LOW_CONFIDENCE");
  assert.ok(result.selected);
  assert.equal(result.selected.forced, true);
  assert.equal(result.selected.riskTier, 0);
  assert.equal(result.selected.method, "fallback-low-confidence");
});

test("tier 3 degradation: relaxes guard distance to find cut between close text blocks", () => {
  // Gap between text blocks is 8px. Default guardPx=10 makes margin=10, covering 20px around each block.
  // So gap is completely blocked by full guard.
  // But with relaxed guard (guard=0), the 8px gap [241, 249] becomes available!
  const result = algorithm.selectCut({
    candidates: [],
    cost: new Float32Array(101),
    offsetY: 200,
    searchStartY: 200,
    searchEndY: 300,
    targetY: 245,
    guardPx: 10,
    highZones: [
      {y0: 190, y1: 240},
      {y0: 250, y1: 310}
    ],
    width: 100,
    allowFallback: true
  });
  assert.equal(result.status, "FALLBACK_RELAXED_GUARD");
  assert.ok(result.selected);
  assert.equal(result.selected.forced, true);
  assert.equal(result.selected.riskTier, 1);
  assert.ok(result.selected.y >= 241 && result.selected.y <= 249);
});

test("tier 4 degradation: full obstruction selects minimum risk line across all rows", () => {
  const cost = new Float32Array(101);
  cost.fill(0.8);
  cost[50] = 0.05; // row Y=250 has lowest energy
  const result = algorithm.selectCut({
    candidates: [],
    cost,
    offsetY: 200,
    searchStartY: 200,
    searchEndY: 300,
    targetY: 280,
    guardPx: 10,
    highZones: [{y0: 180, y1: 320}], // high-confidence text completely covers [200, 300]
    width: 100,
    allowFallback: true
  });
  assert.equal(result.status, "FALLBACK_MIN_RISK");
  assert.ok(result.selected);
  assert.equal(result.selected.forced, true);
  assert.equal(result.selected.riskTier, 2);
  assert.equal(result.selected.y, 250); // picked the minimum cost row
});

test("getLangRatio maps multi-language aliases and falls back properly", () => {
  // Korean aliases
  for (const alias of ["kr", "korean", "韩文", "韩语", "KR", " Korean "]) {
    assert.equal(algorithm.getLangRatio(alias), 0.089, `Alias ${alias} should be 0.089`);
  }
  // English aliases
  for (const alias of ["en", "english", "英文", "英语", "EN", " English "]) {
    assert.equal(algorithm.getLangRatio(alias), 0.065, `Alias ${alias} should be 0.065`);
  }
  // Russian aliases
  for (const alias of ["ru", "russian", "俄文", "俄语", "RU", " Russian "]) {
    assert.equal(algorithm.getLangRatio(alias), 0.068, `Alias ${alias} should be 0.068`);
  }
  // Japanese aliases
  for (const alias of ["ja", "jp", "japanese", "日文", "日语", "JA", " JP ", " Japanese "]) {
    assert.equal(algorithm.getLangRatio(alias), 0.090, `Alias ${alias} should be 0.090`);
  }
  // Unknown or empty falls back to kr (0.089)
  assert.equal(algorithm.getLangRatio("unknown"), 0.089);
  assert.equal(algorithm.getLangRatio(null), 0.089);
  assert.equal(algorithm.getLangRatio(""), 0.089);
  assert.equal(algorithm.getLangRatio(undefined), 0.089);
});

test("getLangRatio reads from localStorage when lang is not explicitly passed", () => {
  const originalLocalStorage = globalThis.localStorage;
  const store = {};
  globalThis.localStorage = {
    getItem: key => store[key] || null,
    setItem: (key, val) => { store[key] = String(val); },
    removeItem: key => { delete store[key]; }
  };
  try {
    store["comic_ocr_lang"] = "en";
    assert.equal(algorithm.getLangRatio(), 0.065);
    store["comic_ocr_lang"] = "ru";
    assert.equal(algorithm.getLangRatio(), 0.068);
    store["comic_ocr_lang"] = "ja";
    assert.equal(algorithm.getLangRatio(), 0.090);
    delete store["comic_ocr_lang"];
    assert.equal(algorithm.getLangRatio(), 0.089);
  } finally {
    if (originalLocalStorage) {
      globalThis.localStorage = originalLocalStorage;
    } else {
      delete globalThis.localStorage;
    }
  }
});

test("textScale supports language-aware scaling and backward compatibility", () => {
  const width = 1000;
  assert.equal(algorithm.textScale(width, "kr"), 89);
  assert.equal(algorithm.textScale(width, "en"), 65);
  assert.equal(algorithm.textScale(width, "ru"), 68);
  assert.equal(algorithm.textScale(width, "ja"), 90);
  // Default/omitted lang falls back to 89
  assert.equal(algorithm.textScale(width), 89);
});

test("planWindow applies language-adaptive context padding", () => {
  const krPlan = algorithm.planWindow({
    sliceTopY: 100, width: 1000, minSliceHeight: 2000, maxSliceHeight: 2800, lang: "kr"
  });
  const enPlan = algorithm.planWindow({
    sliceTopY: 100, width: 1000, minSliceHeight: 2000, maxSliceHeight: 2800, lang: "en"
  });
  // guardPx is 0.09 * 1000 = 90
  // kr textScale is 89, contextPadding = 90 + 89 = 179
  // en textScale is 65, contextPadding = 90 + 65 = 155
  assert.equal(krPlan.guardPx, 90);
  assert.equal(enPlan.guardPx, 90);
  assert.equal(krPlan.searchStartY - krPlan.requiredStartY, 179);
  assert.equal(enPlan.searchStartY - enPlan.requiredStartY, 155);
});

test("analyze uses input.lang to adapt fontSize and text detection", () => {
  const width = 100, height = 400;
  const pixels = new Uint8ClampedArray(width * height * 4);
  pixels.fill(255);
  const resultEn = algorithm.analyze({
    data: pixels, width, height, offsetY: 0,
    searchStartY: 150, searchEndY: 250, targetY: 193,
    pageStartY: 0, pageEndY: 400,
    guardPx: 9, lang: "en"
  });
  const resultKr = algorithm.analyze({
    data: pixels, width, height, offsetY: 0,
    searchStartY: 150, searchEndY: 250, targetY: 193,
    pageStartY: 0, pageEndY: 400,
    guardPx: 9, lang: "kr"
  });
  assert.equal(resultEn.fontSize, 6.5);
  assert.equal(resultKr.fontSize, 8.9);
  assert.equal(resultEn.lang, "en");
  assert.equal(resultKr.lang, "kr");
});


