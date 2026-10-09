(function (root, factory) {
  "use strict";
  const api = factory(root.ComicVirtualStrip, root.ComicSlicePixels, root.ComicSlicePipeline, root.ComicSliceAlgorithm);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ComicCaptureFlow = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (strip, pixels, pipeline, algorithm) {
  "use strict";

  function probe(entry, signal) {
    if (signal?.aborted) return Promise.reject(new DOMException("Capture cancelled", "AbortError"));
    // Already rendered images expose their intrinsic dimensions without another request.
    if (entry.img?.complete && entry.img.currentSrc === entry.url &&
        entry.img.naturalWidth > 0 && entry.img.naturalHeight > 0) {
      return Promise.resolve({pageIndex: entry.pageIndex, imageId: entry.imageId,
        sourceWidth: entry.img.naturalWidth, sourceHeight: entry.img.naturalHeight,
        url: entry.url});
    }
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.crossOrigin = "anonymous";
      const clean = () => {
        image.onload = image.onerror = null;
        if (signal) signal.removeEventListener("abort", cancel);
      };
      const cancel = () => {
        clean(); image.src = "";
        reject(new DOMException("Capture cancelled", "AbortError"));
      };
      if (signal?.aborted) return cancel();
      if (signal) signal.addEventListener("abort", cancel, {once: true});
      image.onload = () => {
        const sourceWidth = image.naturalWidth;
        const sourceHeight = image.naturalHeight;
        clean(); image.src = "";
        if (!sourceWidth || !sourceHeight) reject(new Error("Empty image at page " + entry.pageIndex));
        else resolve({pageIndex: entry.pageIndex, imageId: entry.imageId,
          sourceWidth, sourceHeight, url: entry.url});
      };
      image.onerror = () => {
        clean(); reject(new Error("Image failed at page " + entry.pageIndex));
      };
      image.src = entry.url;
    });
  }

  // 默认并发槽位上限（顶格 6 槽位，流式直出无等待）
  const DEFAULT_CONCURRENCY = 6;

  async function upload(slice, {api, chapterId, signal, batchIndex = 1, isFinalBatch = false, lang}) {
    // 命名要求：以每一张切片的顶部（上一道切线）命名
    // 第1张切片顶部无切线，命名为“切片0”；第2张顶部为切线1，命名为“切片1”，以此类推
    const cutIndex = Math.max(0, slice.sliceIndex - 1);
    const sliceName = `切片${cutIndex}`;
    const selectedLang = lang || (globalThis.ComicDebugHUD?.getOcrLang ? globalThis.ComicDebugHUD.getOcrLang() : (typeof localStorage !== 'undefined' ? localStorage.getItem('comic_ocr_lang') : null)) || 'kr';
    const form = new FormData();
    form.append("file", slice.blob, `${sliceName}.jpg`);
    form.append("slice_name", sliceName);
    form.append("cut_index", String(cutIndex));
    form.append("chapter_id", chapterId);
    form.append("coordinate_id", slice.coordinateId);
    form.append("slice_index", String(slice.sliceIndex));
    form.append("start_y", String(slice.startY));
    form.append("end_y", String(slice.endY));
    form.append("width", String(slice.width));
    form.append("height", String(slice.height));
    form.append("source_pages", JSON.stringify(slice.sourcePages));
    form.append("cut_method", slice.cutMethod);
    form.append("batch_index", String(batchIndex));
    form.append("is_final_batch", String(Boolean(isFinalBatch)));
    form.append("lang", selectedLang);
    const ocrSentAt = new Date().toISOString();
    const ocrStartTime = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    const response = await fetch(api + "/slice", {method: "POST", body: form, signal});
    const result = await response.json().catch(() => ({}));
    const ocrReceivedAt = new Date().toISOString();
    const ocrDuration = Math.round(((typeof performance !== 'undefined') ? performance.now() : Date.now()) - ocrStartTime);
    if (result && typeof result === 'object') {
      result._ocrTimeMs = ocrDuration;
      result._ocrSentAt = ocrSentAt;
      result._ocrReceivedAt = ocrReceivedAt;
      result._api = api;
    }
    if (!response.ok) {
      const errMsg = result.detail || "Slice upload failed: HTTP " + response.status;
      if (typeof globalThis !== 'undefined' && globalThis.ComicErrorTracker && signal?.aborted !== true) {
        let errType = '切片接口异常';
        if (response.status === 413) errType = '切片图片体积超限 (413)';
        else if (response.status === 409) errType = '切片坐标冲突 (409)';
        else if (response.status >= 500) errType = 'OCR 服务端错误 (5xx)';
        globalThis.ComicErrorTracker.record({
          type: errType,
          sliceTag: `${sliceName} (第${slice.sliceIndex}片)`,
          detail: errMsg
        });
      }
      throw new Error(errMsg);
    }
    return result;
  }

  async function uploadCoordinates(index, {api, chapterId, signal, lang}) {
    try {
      const selectedLang = lang || (globalThis.ComicDebugHUD?.getOcrLang ? globalThis.ComicDebugHUD.getOcrLang() : (typeof localStorage !== 'undefined' ? localStorage.getItem('comic_ocr_lang') : null)) || 'kr';
      const response = await fetch(api + "/coordinates", {
        method: "POST", signal,
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({chapter_id: chapterId, ...index, lang: selectedLang})
      });
      if (!response.ok && response.status !== 404) {
        console.warn("[ComicCaptureFlow] 坐标索引上传状态码:", response.status);
      }
    } catch (err) {
      console.warn("[ComicCaptureFlow] 云端无状态模式，跳过本地坐标归档:", err?.message);
    }
  }

  async function uploadCapture(fileOrBlob, {chapterId, pageIndex, imageId, width, height, api, signal, lang}) {
    const selectedLang = lang || (globalThis.ComicDebugHUD?.getOcrLang ? globalThis.ComicDebugHUD.getOcrLang() : (typeof localStorage !== 'undefined' ? localStorage.getItem('comic_ocr_lang') : null)) || 'kr';
    const form = new FormData();
    const filename = `${String(pageIndex).padStart(6, '0')}.jpg`;
    form.append("file", fileOrBlob, filename);
    form.append("chapter_id", chapterId);
    form.append("page_index", String(pageIndex));
    form.append("image_id", imageId);
    form.append("width", String(width));
    form.append("height", String(height));
    form.append("lang", selectedLang);
    const response = await fetch(api + "/capture", {method: "POST", body: form, signal});
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.detail || "Capture upload failed: HTTP " + response.status);
    return result;
  }

  function createSession({ chapterId, api, signal,
                          workingWidth: customWorkingWidth = undefined,
                          concurrency = DEFAULT_CONCURRENCY,
                          totalExpectedPages: initialTotalPages = 0,
                          batchSize = undefined,
                          lang = undefined,
                          onProbe = () => {}, onCoordinate = () => {},
                          onSlice = () => {}, onBatch = () => {},
                          validateEntry = () => true }) {
    if (!strip || !pixels || !algorithm) throw new Error("Slicing modules are missing");
    const sessionLang = lang || (globalThis.ComicDebugHUD?.getOcrLang ? globalThis.ComicDebugHUD.getOcrLang() : (typeof localStorage !== 'undefined' ? localStorage.getItem('comic_ocr_lang') : null)) || 'kr';
    const concurrencyLimit = Math.max(1, Math.min(concurrency || batchSize || DEFAULT_CONCURRENCY, 6));
    const images = [];
    const sources = new Map();
    let index = null;
    let provider = null;
    let workingWidth = customWorkingWidth;
    let startY = 0;
    let sliceNumber = 0;
    let inFlight = 0;
    let totalExpectedPages = initialTotalPages;
    const slotWaiters = [];
    const uploadTasks = new Set();
    let active = true;
    let isSlicing = false;
    let wakeWaiters = [];
    let isFinal = false;

    function waitForSlot() {
      if (inFlight < concurrencyLimit) return Promise.resolve();
      return new Promise(resolve => {
        slotWaiters.push(resolve);
      });
    }

    function releaseSlot() {
      inFlight = Math.max(0, inFlight - 1);
      if (slotWaiters.length > 0) {
        const next = slotWaiters.shift();
        next();
      }
    }

    function notifyWaiters() {
      const waiters = wakeWaiters;
      wakeWaiters = [];
      for (const w of waiters) w();
    }

    function waitForMore() {
      return new Promise(resolve => {
        wakeWaiters.push(resolve);
      });
    }

    async function replenish(currentEntries, options = {}) {
      if (!active || signal?.aborted) return;
      if (options?.totalExpectedPages) {
        totalExpectedPages = options.totalExpectedPages;
      }
      const toProbe = [];
      for (const entry of currentEntries) {
        if (!images[entry.pageIndex - 1]) {
          toProbe.push(entry);
        }
      }
      if (!toProbe.length) return;

      // 如果有新图进入，且此前曾触发过 finalize，重置 isFinal 允许后续流式切片继续推进
      if (isFinal) {
        isFinal = false;
      }

      // 顶格 6 并发探测新增图片尺寸
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(6, toProbe.length) }, async () => {
        while (cursor < toProbe.length) {
          if (signal?.aborted) return;
          const entry = toProbe[cursor++];
          const probed = await probe(entry, signal);
          if (!validateEntry(entry)) throw new Error("Page order or source changed at page " + entry.pageIndex);
          images[entry.pageIndex - 1] = probed;
          sources.set(entry.imageId, entry.url);
          onProbe(entry, images.filter(Boolean).length, currentEntries.length);
        }
      }));

      if (signal?.aborted) return;

      if (!workingWidth) {
        const domW = images[0]?.img?.clientWidth || (typeof window !== "undefined" && window.innerWidth <= 500 ? window.innerWidth : 0);
        if (domW && domW >= 300 && domW <= 500) {
          workingWidth = Math.round(domW);
          console.log(`[ComicCaptureFlow] 自适应移动端视口宽度: ${workingWidth}px`);
        } else if (images[0]?.sourceWidth) {
          workingWidth = images[0].sourceWidth;
        }
      }

      // 连续完整前缀检查：长卷切片必须严格从第 1 页开始按物理页序连续推进
      // 绝对不能跳过尚未就绪的中间页（如跳过第 2、3 页去切第 4 页），避免坐标系断裂与剧情跳跃
      const contiguousImages = [];
      for (let i = 0; i < images.length; i++) {
        if (!images[i]) break; // 遇到中间断层，立刻拦截截断！
        contiguousImages.push(images[i]);
      }

      if (contiguousImages.length > 0) {
        index = strip.buildIndex(contiguousImages, { coordinateId: chapterId, workingWidth });
        await uploadCoordinates(index, { api, chapterId, signal, lang: sessionLang });
        onCoordinate(index);

        if (!provider) {
          provider = pixels.createProvider(index, sources);
        } else {
          provider.updateIndex(index);
        }
      }

      notifyWaiters();
      void triggerSliceLoop();
    }

    async function triggerSliceLoop() {
      if (isSlicing || !active || !provider || !index) return;
      isSlicing = true;
      try {
        const maxHeight = Math.floor(4.32 * index.width);
        const minHeight = Math.ceil(2.6 * index.width);
        const minTail = Math.ceil(1.2 * index.width);

        while (active && !signal?.aborted) {
          const availableHeight = index.totalHeight;
          const remaining = availableHeight - startY;

          if (remaining <= 0) {
            if (isFinal) break;
            await Promise.race([
              waitForMore(),
              new Promise((_, reject) => {
                if (signal) signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
              })
            ]).catch(() => {});
            if (!active || signal?.aborted || (isFinal && index.totalHeight === availableHeight)) break;
            continue;
          }

          // 若剩余高度不足以切出一个安全切片，且会话处于活跃状态，挂起等待后续图片补货
          if (remaining < minHeight && !isFinal) {
            await Promise.race([
              waitForMore(),
              new Promise((_, reject) => {
                if (signal) signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
              })
            ]).catch(() => {});
            if (!active || signal?.aborted) break;
            if (index.totalHeight === availableHeight && !isFinal) {
              continue;
            }
          }

          let endY, analysis = null;
          if (isFinal && remaining <= maxHeight) {
            endY = index.totalHeight;
          } else {
            const allowedMax = Math.min(maxHeight, isFinal ? remaining : Math.max(minHeight, remaining - minTail));
            const window = algorithm.planWindow({
              sliceTopY: startY, width: index.width,
              minSliceHeight: minHeight, maxSliceHeight: allowedMax,
              lang: sessionLang
            });
            const roiStartY = Math.max(0, Math.floor(window.requiredStartY));
            const roiEndY = Math.min(index.totalHeight, Math.ceil(window.requiredEndY) + 1);

            const pixelsData = await provider.getPixels(roiStartY, roiEndY);
            if (signal?.aborted) break;

            analysis = algorithm.analyze({
              ...pixelsData,
              targetY: window.targetY,
              searchStartY: window.searchStartY,
              searchEndY: window.searchEndY,
              guardPx: window.guardPx,
              pageStartY: 0,
              pageEndY: index.totalHeight,
              debug: false,
              lang: sessionLang
            });

            if (!analysis.selected) {
              if (!isFinal) {
                await Promise.race([waitForMore(), new Promise(r => setTimeout(r, 200))]);
                if (index.totalHeight > availableHeight) continue;
              }
              endY = Math.min(index.totalHeight, startY + Math.floor(3.0 * index.width));
            } else {
              endY = analysis.selected.y;
            }
          }

          if (!Number.isInteger(endY) || endY <= startY || endY > index.totalHeight) {
            break;
          }

          const blob = await provider.makeSlice(startY, endY, 0.9);
          if (signal?.aborted) break;

          const pages = strip.overlaps(index, startY, endY).map(span => span.page.pageIndex);
          const currentNumber = ++sliceNumber;
          const slice = {
            coordinateId: index.coordinateId,
            sliceIndex: currentNumber,
            startY,
            endY,
            width: index.width,
            height: endY - startY,
            sourcePages: pages,
            cutMethod: analysis?.selected?.method || (endY === index.totalHeight ? "chapter-end" : "standard"),
            blob
          };

          startY = endY;

          // 核心流式并发：申请槽位（若在飞任务达到 concurrencyLimit 则异步等待）
          await waitForSlot();
          if (!active || signal?.aborted) break;
          inFlight++;

          const isFinalSlice = isFinal && (startY >= index.totalHeight);
          const task = (async (s, num, isLast) => {
            try {
              const res = await upload(s, {
                api,
                chapterId,
                signal,
                batchIndex: num,
                isFinalBatch: isLast,
                lang: sessionLang
              });
              onSlice(s, num, {
                batchIndex: num,
                isFinalBatch: isLast,
                result: res
              });
              onBatch({
                batchIndex: num,
                slices: [s],
                isFinalBatch: isLast,
                results: [res]
              });
              return res;
            } catch (err) {
              if (err?.name !== "AbortError") {
                console.error(`[ComicCaptureFlow] 切片 #${num} 上传异常:`, err);
                if (typeof globalThis !== 'undefined' && globalThis.ComicErrorTracker) {
                  const cutIdx = Math.max(0, s.sliceIndex - 1);
                  let errType = '切片网络/处理异常';
                  const msg = err?.message || String(err);
                  if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) errType = '网络连接断开/离线';
                  globalThis.ComicErrorTracker.record({
                    type: errType,
                    sliceTag: `切片${cutIdx} (#${num})`,
                    detail: msg
                  });
                }
              }
            } finally {
              releaseSlot();
              uploadTasks.delete(task);
            }
          })(slice, currentNumber, isFinalSlice);

          uploadTasks.add(task);

          if (isFinal && startY >= index.totalHeight) {
            break;
          }
        }
      } catch (err) {
        console.error("[ComicCaptureFlow] Slicing loop error:", err);
      } finally {
        isSlicing = false;
      }
    }

    function finalize() {
      if (!active || isFinal) return;
      isFinal = true;
      notifyWaiters();
      void triggerSliceLoop();
    }

    function getTailInfo() {
      if (!index) return { committedY: 0, frontierY: 0, tail: 0, minHeight: 0, pending: false, isFinal };
      const remaining = Math.max(0, index.totalHeight - startY);
      const minHeight = Math.ceil(2.6 * index.width);
      return {
        committedY: startY,
        frontierY: index.totalHeight,
        tail: remaining,
        minHeight,
        pending: remaining > 0 && remaining < minHeight && !isFinal,
        isFinal
      };
    }

    async function finish() {
      finalize();
      // 等待所有在途流式上传任务完成
      if (uploadTasks.size > 0) {
        await Promise.allSettled(Array.from(uploadTasks));
      }
    }

    function close() {
      active = false;
      isFinal = true;
      notifyWaiters();
      for (const resolve of slotWaiters) resolve();
      slotWaiters.length = 0;
      if (provider) provider.close();
    }

    return {
      replenish,
      finalize,
      finish,
      close,
      getIndex() { return index; },
      getTailInfo,
      getSlicesCompleted() { return sliceNumber; },
      getBatchesCompleted() { return sliceNumber; },
      getPendingBatchCount() { return inFlight; },
      getInFlightCount() { return inFlight; },
      getStartY() { return startY; }
    };
  }

  async function run({entries, chapterId, api, signal,
                      concurrency = DEFAULT_CONCURRENCY,
                      batchSize = undefined,
                      totalExpectedPages = undefined,
                      lang = undefined,
                      onProbe = () => {}, onCoordinate = () => {},
                      onSlice = () => {}, onBatch = () => {},
                      validateEntry = () => true}) {
    const expected = totalExpectedPages !== undefined ? totalExpectedPages : (entries ? entries.length : 0);
    const session = createSession({
      chapterId, api, signal, concurrency: concurrency || batchSize, totalExpectedPages: expected, lang, onProbe, onCoordinate, onSlice, onBatch, validateEntry
    });
    try {
      await session.replenish(entries, { totalExpectedPages: expected });
      await session.finish();
      return {
        index: session.getIndex(),
        completed: session.getSlicesCompleted(),
        batches: session.getBatchesCompleted()
      };
    } finally {
      session.close();
    }
  }

  return { probe, upload, uploadCoordinates, uploadCapture, createSession, run, DEFAULT_CONCURRENCY, DEFAULT_BATCH_SIZE: 6, DEFAULT_FLUSH_INTERVAL_MS: 0 };
});
