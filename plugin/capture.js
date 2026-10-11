(() => {
  // 漫画页序预览与切片协调器。图像/坐标/切线计算由 slicing/ 模块负责。
  const CLOUD_API = '';
  const DEFAULT_LOCAL_API = 'http://127.0.0.1:8000';
  let API = '';

  function getEffectiveApi() {
    try {
      const isLocal = typeof localStorage !== 'undefined' && (
        localStorage.getItem('comic_dev_enable_capture') === '1' ||
        localStorage.getItem('comic_dev_use_local_backend') === '1'
      );
      if (isLocal) {
        return 'http://127.0.0.1:8000';
      }
      const customCloud = typeof localStorage !== 'undefined' && localStorage.getItem('comic_cloud_api_url');
      if (customCloud && customCloud.trim()) {
        return customCloud.trim().replace(/\/+$/, '');
      }
    } catch {}
    return CLOUD_API || 'http://127.0.0.1:8000';
  }

  const MIN_WIDTH_RATIO = 0.68;
  const CENTER_TOLERANCE = 0.16;

  let reader = null;
  let entries = [];
  let lastOrder = [];
  let overlayHost = null;
  let overlayRoot = null;
  let readerResizeObserver = null;
  const badgesByImage = new Map();
  const patchesBySlice = new Map();
  const patchElements = new Map();
  const hiddenPatches = new Set();
  let previewEnabled = true;
  let running = false;
  let stopping = false;
  let starting = false;
  let frame = 0;
  let scanTimer = null;
  let abortController = null;
  let statusText = '准备就绪';
  let chapterId = '';
  let coordinateIndex = null;
  let coordinateSnapshot = null;
  let completedSlices = [];
  let lockedSources = null;
  let firstTranslationEmitted = false;
  let idCounter = 0;
  const ids = new WeakMap();
  const states = new WeakMap();
  let slicesCompleted = 0;
  let batchesCompleted = 0;
  let pendingBatchCount = 0;
  let statusListener = () => {};
  let captureStats = { attribute: 0, observer: 0 };
  let captureSession = null;
  let startClickTime = 0;
  let readerDetectedTime = 0;
  let firstImageReadyLogged = false;
  let prewarmTimer = null;
  let isPrewarming = false;
  const pipelineTelemetry = {
    firstImageReadyMs: 0,
    clickToSlice0ReadyMs: 0,
    clickToFirstOcrMs: 0,
    slice0OcrDurationMs: 0,
    slices1To5AllOcrReadyMs: 0,
    firstLlmTtfbMs: 0,
    firstLlmTotalMs: 0,
    slice0Bubbles: 0,
    first6SlicesBubbles: 0,
    totalSlicesOcrCompleted: 0,
    prewarm: {
      probed: 0,
      warmedBitmaps: 0,
      total: 0
    }
  };

  let lastHealthCheckTime = 0;
  let lastHealthCheckApi = '';
  async function ensureBackendHealthy(apiUrl) {
    if (lastHealthCheckApi === apiUrl && (Date.now() - lastHealthCheckTime) < 120000) {
      return true;
    }
    const res = await fetch(`${apiUrl}/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    lastHealthCheckTime = Date.now();
    lastHealthCheckApi = apiUrl;
    return true;
  }

  function schedulePrewarm(delay = 100) {
    clearTimeout(prewarmTimer);
    prewarmTimer = setTimeout(() => {
      void runPrewarm();
    }, delay);
  }

  async function runPrewarm() {
    if (running || starting || isPrewarming || !entries.length) return;
    isPrewarming = true;
    try {
      const targets = entries.slice(0, 10);
      pipelineTelemetry.prewarm.total = targets.length;
      let probedCount = 0;
      let warmBitmapCount = 0;

      for (let i = 0; i < targets.length; i++) {
        if (running || starting) break;
        const entry = targets[i];
        const url = getImageUrl(entry.img);
        if (!url) continue;

        if (globalThis.ComicCaptureFlow?.preprobe) {
          const probed = await globalThis.ComicCaptureFlow.preprobe({
            img: entry.img,
            pageIndex: entry.pageIndex,
            imageId: entry.imageId,
            url
          });
          if (probed && probed.sourceWidth > 0) probedCount++;
        }

        if (i < 6 && globalThis.ComicSlicePixels?.warmBitmap) {
          const b = await globalThis.ComicSlicePixels.warmBitmap(url);
          if (b && b.width > 0) warmBitmapCount++;
        }

        pipelineTelemetry.prewarm.probed = probedCount;
        pipelineTelemetry.prewarm.warmedBitmaps = warmBitmapCount;
        await new Promise(r => setTimeout(r, 16));
      }

      console.log(`[ComicCapture] 🔥【静默预热完成】尺寸探测: ${probedCount}/${targets.length} 页, Bitmap内存池预热: ${warmBitmapCount}/6 页 (点击翻译可 0ms 秒切)`);
      notify();
    } catch (err) {
      console.warn('[ComicCapture] 静默预热微小异常:', err?.message);
    } finally {
      isPrewarming = false;
    }
  }

  function imageId(img) {
    let id = ids.get(img);
    if (!id) {
      id = `img-${++idCounter}-${Math.random().toString(36).slice(2, 8)}`;
      ids.set(img, id);
    }
    return id;
  }

  function median(values) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  }

  function getLuminance(hex) {
    if (!hex || typeof hex !== 'string') return 128;
    let c = hex.replace('#', '');
    if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
    if (c.length !== 6) return 128;
    const r = parseInt(c.slice(0, 2), 16);
    const g = parseInt(c.slice(2, 4), 16);
    const b = parseInt(c.slice(4, 6), 16);
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }

  function hexToRgba(hex, alpha) {
    if (!hex) return `rgba(255, 255, 255, ${alpha})`;
    let c = hex.replace('#', '');
    if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
    if (c.length === 6) {
      const r = parseInt(c.slice(0, 2), 16);
      const g = parseInt(c.slice(2, 4), 16);
      const b = parseInt(c.slice(4, 6), 16);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
    return `rgba(255, 255, 255, ${alpha})`;
  }

  function isColorDark(hex) {
    return getLuminance(hex) < 128;
  }

  function isColorWhite(hex) {
    if (!hex || typeof hex !== 'string') return true;
    let c = hex.replace('#', '');
    if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
    if (c.length !== 6) return true;
    const r = parseInt(c.slice(0, 2), 16);
    const g = parseInt(c.slice(2, 4), 16);
    const b = parseInt(c.slice(4, 6), 16);
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const sat = Math.max(r, g, b) - Math.min(r, g, b);
    return lum >= 235 && sat <= 20;
  }

  function getPatchShadow(bgColor, isGlow) {
    const isWhite = isColorWhite(bgColor);
    if (isGlow) {
      if (isWhite) {
        return 'inset 0 0 10px 4px rgba(255, 255, 255, 0.85), 0 0 8px 2px rgba(255, 255, 255, 0.45)';
      }
      // 非白色渐变/光罩：边框与羽化均取自身背景色的柔和过渡，消除突兀白圈，色彩100%统一
      return `inset 0 0 10px 4px ${hexToRgba(bgColor, 0.90)}, 0 0 8px 2px ${hexToRgba(bgColor, 0.45)}`;
    }
    // 常规对白实色补丁 solid_patch
    if (isWhite) {
      return 'inset 0 0 8px 3px rgba(255, 255, 255, 0.95)';
    }
    if (isColorDark(bgColor)) {
      return 'inset 0 0 8px 3px rgba(0, 0, 0, 0.85)';
    }
    // 纯色非白色补丁（如浅灰、淡黄、浅蓝）：边框与羽化均采用自身纯色，高度统一无突兀白圈
    return `inset 0 0 8px 3px ${hexToRgba(bgColor, 0.90)}, 0 0 4px 1px ${hexToRgba(bgColor, 0.35)}`;
  }

  function ensureContrastColor(textColor, bgColor) {
    const bgLum = getLuminance(bgColor);
    if (!textColor) return bgLum < 128 ? '#FFFFFF' : '#000000';
    let c = textColor.replace('#', '');
    if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
    if (c.length !== 6) return bgLum < 128 ? '#FFFFFF' : '#000000';
    const r = parseInt(c.slice(0, 2), 16);
    const g = parseInt(c.slice(2, 4), 16);
    const b = parseInt(c.slice(4, 6), 16);
    const sat = Math.max(r, g, b) - Math.min(r, g, b); // 色彩饱和度/偏色度
    const txLum = 0.299 * r + 0.587 * g + 0.114 * b; // 感知亮度

    // 1. 浅色/白色常规对白气泡 (bgLum >= 160)
    if (bgLum >= 160) {
      // 只要不是明显的彩色字（例如特殊血红、亮蓝 sat > 65），
      // 或者是抗锯齿边缘取色导致的浅灰字 (txLum > 40)，一律修正为纯实黑 #000000！
      if (sat < 65 || txLum > 40) {
        return '#000000';
      }
      return textColor;
    }

    // 2. 深色/黑化对白气泡 (bgLum < 90)
    if (bgLum < 90) {
      if (sat < 65 || txLum < 200) {
        return '#FFFFFF';
      }
      return textColor;
    }

    // 3. 其余过渡色对白框，保持强对比度
    if (Math.abs(bgLum - txLum) < 95) {
      return bgLum < 128 ? '#FFFFFF' : '#000000';
    }
    return textColor;
  }

  function isDialogueBubble(hex) {
    if (!hex || typeof hex !== 'string') return true;
    let c = hex.replace('#', '');
    if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
    if (c.length !== 6) return true;
    const r = parseInt(c.slice(0, 2), 16);
    const g = parseInt(c.slice(2, 4), 16);
    const b = parseInt(c.slice(4, 6), 16);

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const colorDiff = max - min; // 偏色度 (饱和度)
    const lum = 0.299 * r + 0.587 * g + 0.114 * b; // 感知亮度

    // 1. 白底 / 乳白 / 浅灰常规气泡：亮度高 (>= 175) 且 几乎无色彩偏色 (colorDiff <= 35)
    if (lum >= 175 && colorDiff <= 35) return true;

    // 2. 纯黑 / 深灰内心戏黑化气泡：深色 (lum <= 85) 且 低饱和微偏色 (colorDiff <= 30)
    if (lum <= 85 && colorDiff <= 30) return true;

    // 其余均归为环境插画背景色 / 彩色特效拟声词，直接过滤丢弃
    return false;
  }

  function isVisibleElement(img) {
    const style = getComputedStyle(img);
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
  }

  const PLACEHOLDER_PATTERN = /(?:spacer|blank|pixel|empty|1x1|loading|default\.(?:png|gif|jpg|webp)|placeholder|grey|gray|spinner|dot\.(?:png|gif|jpg|webp)|transparent|dummy|avatar)/i;

  function isPlaceholder(url, img) {
    if (!url) return true;
    if (url.startsWith('data:image/') || url.startsWith('about:')) return true;
    if (PLACEHOLDER_PATTERN.test(url)) return true;
    if (img && img.naturalWidth > 0 && img.naturalWidth < 160 && img.naturalHeight > 0 && img.naturalHeight < 160) {
      return true;
    }
    return false;
  }

  function urlCandidate(value) {
    const valueText = String(value || '').trim();
    if (!valueText) return '';
    const candidate = valueText.includes(',') ? valueText.split(',')[0].trim().split(/\s+/)[0] : valueText;
    if (/^(?:about:blank|data:.*(?:placeholder|blank|transparent|loading))/i.test(candidate)) return '';
    if (PLACEHOLDER_PATTERN.test(candidate)) return '';
    try { return new URL(candidate, location.href).href; } catch { return ''; }
  }

  function looksLikeImageUrl(url) {
    if (!url || typeof url !== 'string') return false;
    const clean = url.trim();
    if (!clean || clean.startsWith('data:') || clean.startsWith('blob:') || clean.startsWith('about:')) return false;
    if (PLACEHOLDER_PATTERN.test(clean)) return false;
    if (/\.(jpe?g|png|webp|avif|gif)(?:[?#].*)?$/i.test(clean)) return true;
    try {
      const parsed = new URL(clean, location.href);
      const text = (parsed.hostname + parsed.pathname + parsed.search).toLowerCase();
      return text.includes('image') || text.includes('img') || text.includes('comic') ||
        text.includes('chapter') || text.includes('page') || text.includes('photo');
    } catch {
      return false;
    }
  }

  function getImageUrl(img) {
    if (!img) return '';

    // 1. 优先提取真实原图属性（data-src, data-original 等懒加载真实属性）
    const preferredAttrs = [
      img.dataset?.src, img.dataset?.original, img.dataset?.lazySrc, img.dataset?.lazy,
      img.dataset?.url, img.dataset?.actualsrc, img.dataset?.origin, img.dataset?.echo,
      img.dataset?.cfsrc, img.dataset?.lazyload, img.dataset?.image, img.dataset?.img,
      img.dataset?.pic, img.dataset?.file, img.dataset?.path, img.getAttribute?.('data-srcset')
    ];
    for (const value of preferredAttrs) {
      const candidate = urlCandidate(value);
      if (candidate && looksLikeImageUrl(candidate) && !isPlaceholder(candidate, null)) {
        return candidate;
      }
    }

    // 2. 扫描其他可能携带图片真实地址的 dataset / attributes
    if (img.attributes) {
      for (const attr of img.attributes) {
        if (attr.name.startsWith('data-') || attr.name.includes('src')) {
          const candidate = urlCandidate(attr.value);
          if (candidate && looksLikeImageUrl(candidate) && !isPlaceholder(candidate, null)) {
            return candidate;
          }
        }
      }
    }

    // 3. 兜底读取 currentSrc 与 src（严格排除占位图与极小无效图）
    for (const value of [img.currentSrc, img.src]) {
      const current = urlCandidate(value);
      if (current && looksLikeImageUrl(current) && !isPlaceholder(current, img)) {
        return current;
      }
    }

    return '';
  }

  function promoteLazyImage(img, knownUrl) {
    if (!img || !img.isConnected) return false;
    const realUrl = knownUrl || getImageUrl(img);
    if (!realUrl || realUrl.startsWith('data:')) return false;
    const current = urlCandidate(img.currentSrc || img.src);
    if (current === realUrl) return false;
    if (img.dataset.comicPromoting === '1') return false;
    img.dataset.comicPromoting = '1';
    img.src = realUrl;
    if (img.getAttribute('loading') === 'lazy') img.setAttribute('loading', 'eager');
    img.decoding = 'async';
    captureStats.attribute++;
    queueMicrotask(() => { img.dataset.comicPromoting = '0'; });
    return true;
  }

  function processImageElement(img) {
    if (!img || !img.isConnected) return;
    promoteLazyImage(img);
  }

  function promoteLazyImages(root) {
    if (!root?.querySelectorAll) return 0;
    let count = 0;
    for (const img of root.querySelectorAll('img')) {
      if (promoteLazyImage(img)) count++;
    }
    return count;
  }

  function collectOrderedImages(currentReader) {
    if (!currentReader?.root?.isConnected) return [];
    promoteLazyImages(currentReader.root);
    const known = (currentReader.imageNodes || []).filter(img => img?.isConnected);
    const allImages = Array.from(currentReader.root.querySelectorAll?.('img') || []);
    if (!known.length && !allImages.length) return [];

    const measuredRects = allImages
      .map(img => img.getBoundingClientRect())
      .filter(rect => rect.width > 50 && rect.height > 50);
    const refWidth = measuredRects.length ? median(measuredRects.map(r => r.width)) : (currentReader.root.clientWidth || innerWidth * 0.7);
    const refCenter = measuredRects.length ? median(measuredRects.map(r => r.left + r.width / 2)) : (innerWidth / 2);

    const candidates = new Set(known);
    for (const img of allImages) {
      if (candidates.has(img) || !isVisibleElement(img)) continue;
      // 严格排除评论区、头像、用户回复等非正文元素
      if (img.closest?.('.comment, .comments, #comments, .comment-box, .comment-list, .comment-item, .reply, .replies, .avatar, footer, header, nav, .footer, .header, .nav')) {
        continue;
      }
      const rect = img.getBoundingClientRect();
      const width = rect.width || img.width || Number(img.getAttribute('width')) || 0;
      const height = rect.height || img.height || Number(img.getAttribute('height')) || 0;
      const url = getImageUrl(img);

      // 已具有合理尺寸的图片按列对齐判定
      if (width >= refWidth * MIN_WIDTH_RATIO && height >= 30) {
        const center = rect.width > 0 ? rect.left + rect.width / 2 : refCenter;
        if (Math.abs(center - refCenter) <= Math.max(44, refWidth * CENTER_TOLERANCE)) {
          candidates.add(img);
          continue;
        }
      }

      // 排除头像、表情包、微型图标等尺寸已知的非漫画小图
      const naturalW = img.naturalWidth || 0;
      const naturalH = img.naturalHeight || 0;
      if ((naturalW > 0 && naturalW < 160 && naturalH > 0 && naturalH < 160) || (width > 0 && width < Math.min(160, refWidth * 0.4))) {
        continue;
      }

      // 懒加载占位图：在阅读器容器内、未隐藏且具备漫画图片地址/特征或待加载
      if (url || img.dataset?.src || img.dataset?.original || img.dataset?.lazySrc || img.dataset?.lazyload || img.dataset?.image) {
        candidates.add(img);
      }
    }

    return [...candidates]
      .filter(img => img.isConnected && isVisibleElement(img))
      .sort((a, b) => {
        const position = a.compareDocumentPosition(b);
        if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
        return 0;
      });
  }

  function getImageOffsetInRoot(img, rootNode) {
    if (!img?.isConnected || !rootNode?.isConnected) return null;
    const imgRect = img.getBoundingClientRect();
    if (overlayHost?.isConnected) {
      const overlayRect = overlayHost.getBoundingClientRect();
      return {
        left: imgRect.left - overlayRect.left,
        top: imgRect.top - overlayRect.top,
        width: imgRect.width,
        height: imgRect.height
      };
    }
    const rootRect = rootNode.getBoundingClientRect();
    const isDoc = rootNode === document.body || rootNode === document.documentElement;
    const scrollX = isDoc ? (window.scrollX || window.pageXOffset || 0) : rootNode.scrollLeft;
    const scrollY = isDoc ? (window.scrollY || window.pageYOffset || 0) : rootNode.scrollTop;
    return {
      left: imgRect.left - (isDoc ? 0 : rootRect.left) + scrollX,
      top: imgRect.top - (isDoc ? 0 : rootRect.top) + scrollY,
      width: imgRect.width,
      height: imgRect.height
    };
  }

  function ensureOverlay() {
    if (!reader?.root?.isConnected) return;
    const root = (reader.root === document.documentElement && document.body) ? document.body : reader.root;
    const isDoc = root === document.body || root === document.documentElement;
    const computed = getComputedStyle(root);
    if (!isDoc && computed.position === 'static') {
      root.style.position = 'relative';
    }

    if (!overlayHost) {
      overlayHost = document.createElement('div');
      overlayHost.id = 'comic-capture-overlay-host';
      overlayHost.style.cssText = 'all:initial;position:absolute;top:0;left:0;width:100%;height:0;pointer-events:none;z-index:2147483646;display:block;overflow:visible;';
      overlayRoot = overlayHost.attachShadow({ mode: 'closed' });
      overlayRoot.innerHTML = `<style>
        :host { all: initial; }
        .badge { position: absolute; min-width: 28px; height: 28px; padding: 0 6px; box-sizing: border-box;
          display:flex; align-items:center; justify-content:center; border:2px solid white; border-radius:999px;
          background:#e5365d; color:white; font:700 14px/1 system-ui,sans-serif;
          text-shadow:0 1px 2px #000; box-shadow:0 2px 8px #0008; z-index: 1001; }
        .badge[data-state="done"] { background:#168c58; }
        .badge[data-state="uploading"] { background:#e18b13; }
        .badge[data-state="failed"] { background:#bd183b; }
        .badge[data-state="pending"] { background:#52677a; }
        .coordinate-line { position: absolute; height: 0; border-top: 1px dashed #28a7e8;
          box-sizing: border-box; filter: drop-shadow(0 1px 1px #0009); z-index: 999; }
        .coordinate-line.slice { border-top: 3px solid #35d07f; }
        .coordinate-label { position: absolute; left: 4px; top: 2px; max-width: calc(100% - 8px);
          padding: 3px 6px; border-radius: 4px; background: #075b82e8; color: #fff;
          font: 700 11px/1.2 system-ui,sans-serif; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          box-shadow: 0 1px 4px #0008; }
        .coordinate-line.slice .coordinate-label { background: #08743ee8; }

        /* 漫画文字气泡覆盖补丁 - 绝对定位贴合漫画长卷 (全方位护眼插件与深色模式免疫) */
        .manga-patch {
          position: absolute;
          box-sizing: border-box;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          pointer-events: auto;
          z-index: 1000;
          user-select: none;
          color-scheme: light only !important;
          forced-color-adjust: none !important;
          isolation: isolate !important;
          filter: none !important;
          transition: opacity 0.15s ease, transform 0.1s ease;
        }
        .manga-patch:hover {
          outline: 1.5px solid rgba(40, 167, 232, 0.7);
          border-radius: 12px;
        }
        .manga-patch.hidden-mask .manga-patch-bg {
          opacity: 0 !important;
          background: transparent !important;
          outline: 1.5px dashed #e5365d;
          box-shadow: none !important;
        }
        .manga-patch.hidden-mask .manga-patch-text {
          opacity: 0 !important;
          visibility: hidden !important;
        }
        /* 拟声词/环境美术字: 方案1 漫画原生发光美术字，原位零遮盖呈现，彻底告别旧版黑框 */
        .manga-patch.ghost-patch {
          background: transparent !important;
          opacity: 0.95;
          box-shadow: none !important;
          transition: opacity 0.2s ease, transform 0.15s ease;
        }
        .manga-patch.ghost-patch:hover {
          opacity: 1 !important;
          outline: 1px dashed rgba(56, 189, 248, 0.6) !important;
          background: transparent !important;
          border-radius: 4px;
        }
        .manga-patch.ghost-patch .manga-patch-bg {
          display: none !important;
        }
        .manga-patch.ghost-patch .manga-patch-text {
          font-style: italic !important;
          font-weight: 800 !important;
          color: #ff3838 !important;
          text-shadow: 
            -2px -2px 0 #ffffff,
             2px -2px 0 #ffffff,
            -2px  2px 0 #ffffff,
             2px  2px 0 #ffffff,
             0   -2px 0 #ffffff,
             0    2px 0 #ffffff,
            -2px  0   0 #ffffff,
             2px  0   0 #ffffff,
             0 0 6px #ffffff,
             0 0 12px rgba(255, 255, 255, 0.95) !important;
          letter-spacing: 0.5px;
        }

        /* 场景悬浮台词/画外音: 360度纯白强力描边 + 纯白柔和晕圈，坚决剔除任何黑色阴影脏晕 */
        .manga-patch.ambient-patch {
          background: transparent !important;
          box-shadow: none !important;
        }
        .manga-patch.ambient-patch:hover {
          outline: 1px dashed rgba(56, 189, 248, 0.6) !important;
          background: transparent !important;
        }
        .manga-patch.ambient-patch .manga-patch-bg {
          display: none !important;
        }
        .manga-patch.ambient-patch .manga-patch-text {
          color: #0f172a !important;
          font-weight: 800 !important;
          text-shadow: 
            -2px -2px 0 #ffffff,
             2px -2px 0 #ffffff,
            -2px  2px 0 #ffffff,
             2px  2px 0 #ffffff,
             0   -2px 0 #ffffff,
             0    2px 0 #ffffff,
            -2px  0   0 #ffffff,
             2px  0   0 #ffffff,
             0 0 8px #ffffff,
             0 0 16px rgba(255, 255, 255, 0.95) !important;
        }

        .manga-patch.ghost-patch.hidden-mask,
        .manga-patch.ambient-patch.hidden-mask,
        .manga-patch.glow-patch.hidden-mask {
          opacity: 0 !important;
          background: transparent !important;
          outline: 1px dashed rgba(229, 54, 93, 0.4) !important;
        }

        /* 渐变气泡/平滑背景光罩: 半透明磨砂柔和羽化光罩，绝不糊死原画 */
        .manga-patch.glow-patch {
          background: transparent !important;
          box-shadow: none !important;
        }
        .manga-patch.glow-patch:hover {
          outline: 1px dashed rgba(56, 189, 248, 0.6) !important;
        }
        .manga-patch.glow-patch .manga-patch-bg {
          display: block !important;
          border-radius: 12px !important;
          backdrop-filter: blur(3px) !important;
        }
        .manga-patch.glow-patch .manga-patch-text {
          font-weight: 700 !important;
        }

        /* 画外音/旁白框: 实色高遮盖底，防止原图文字透出造成重影 */
        .manga-patch.narration-patch .manga-patch-bg {
          background: rgba(255, 255, 255, 0.95) !important;
          box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15) !important;
          border-radius: 4px !important;
        }
        .manga-patch.narration-patch .manga-patch-text {
          color: #1a1a1a !important;
          text-shadow: none !important;
        }
        .manga-patch-bg {
          position: absolute;
          inset: -2px -3px; /* 边缘微扩 2~3px，严密遮盖底图原文防止漏边 */
          border-radius: 12px;
          pointer-events: none;
          z-index: 1;
          color-scheme: light only !important;
          forced-color-adjust: none !important;
          isolation: isolate !important;
          filter: none !important;
        }
        .manga-patch-text {
          position: relative;
          z-index: 2;
          display: flex;
          align-items: center;
          justify-content: center;
          text-align: center;
          line-height: 1.25;
          word-break: keep-all;
          overflow-wrap: break-word;
          text-wrap: balance;
          white-space: pre-wrap;
          font-family: -apple-system, BlinkMacSystemFont, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
          padding: 2px 4px;
          box-sizing: border-box;
          width: 100%;
          height: 100%;
          color-scheme: light only !important;
          forced-color-adjust: none !important;
          -webkit-text-fill-color: initial !important;
          isolation: isolate !important;
          filter: none !important;
        }
      </style><div id="coordinates"></div><div id="badges"></div><div id="patches"></div>`;
      window.addEventListener('resize', scheduleOverlay, { passive: true });
    }

    if (overlayHost.parentElement !== root) {
      root.appendChild(overlayHost);
    }
  }

  function scheduleOverlay() {
    if (!frame) frame = requestAnimationFrame(renderOverlay);
  }

  function renderOverlay() {
    frame = 0;
    if (!previewEnabled || !reader?.root?.isConnected || !entries.length) {
      if (overlayHost) overlayHost.style.display = 'none';
      return;
    }
    ensureOverlay();
    if (!overlayHost || !overlayRoot) return;
    overlayHost.style.display = 'block';

    const badges = overlayRoot.querySelector('#badges');
    const coordinates = overlayRoot.querySelector('#coordinates');
    const patches = overlayRoot.querySelector('#patches');
    if (!badges || !coordinates || !patches) return;
    coordinates.replaceChildren();

    const currentImages = new Set();
    for (const entry of entries) {
      if (!entry.img.isConnected) continue;
      const offset = getImageOffsetInRoot(entry.img, reader.root);
      if (!offset || offset.width < 2 || offset.height < 2) continue;
      currentImages.add(entry.img);

      let badge = badgesByImage.get(entry.img);
      if (!badge) {
        badge = document.createElement('div');
        badge.className = 'badge';
        badgesByImage.set(entry.img, badge);
        badges.appendChild(badge);
      }
      badge.textContent = String(entry.pageIndex);
      badge.dataset.state = states.get(entry.img) || 'pending';
      badge.style.left = `${Math.max(0, offset.left + 6)}px`;
      badge.style.top = `${Math.max(0, offset.top + 6)}px`;
    }

    for (const [img, badge] of badgesByImage) {
      if (!img.isConnected || !currentImages.has(img)) {
        badge.remove();
        badgesByImage.delete(img);
      }
    }

    renderCoordinates(coordinates);
    renderPatches(patches);
  }

  function locateAbsoluteY(y) {
    if (!coordinateIndex || !coordinateSnapshot?.length || y < 0 || y > coordinateIndex.totalHeight) return null;
    let page = coordinateIndex.pages.find(item => y >= item.startY && y < item.endY);
    if (!page && y === coordinateIndex.totalHeight) page = coordinateIndex.pages.at(-1);
    const source = page && coordinateSnapshot[page.pageIndex - 1];
    if (!page || !source?.img?.isConnected || !reader?.root?.isConnected) return null;
    const offset = getImageOffsetInRoot(source.img, reader.root);
    if (!offset || offset.width < 2) return null;
    const ratio = y === page.endY ? 1 : (y - page.startY) / page.height;
    return {
      left: offset.left,
      top: offset.top + ratio * offset.height,
      width: offset.width,
      scaleX: offset.width / coordinateIndex.width,
      scaleY: offset.height / page.height
    };
  }

  function addCoordinateLine(container, y, label, type) {
    const point = locateAbsoluteY(y);
    if (!point || point.width < 2) return 0;
    const line = document.createElement('div');
    line.className = `coordinate-line ${type || ''}`;
    line.style.left = `${point.left}px`;
    line.style.top = `${point.top}px`;
    line.style.width = `${point.width}px`;
    const text = document.createElement('span');
    text.className = 'coordinate-label';
    text.textContent = label;
    line.appendChild(text);
    container.appendChild(line);
    return 1;
  }

  function renderCoordinates(container) {
    if (!coordinateIndex || !coordinateSnapshot) return 0;
    let count = 0;
    for (const page of coordinateIndex.pages) {
      count += addCoordinateLine(container, page.startY,
        `原图 ${page.pageIndex} · Y=${page.startY}px`, 'page');
    }
    for (const slice of completedSlices) {
      count += addCoordinateLine(container, slice.endY,
        `切片 ${slice.sliceIndex} · Y=${slice.endY}px · H=${slice.height}px`, 'slice');
    }
    return count;
  }

  // 内置常识专有名词/代词/缩写词典 (Truecase Default Glossary)
  const DEFAULT_TRUECASE_GLOSSARY = {
    'i': 'I', "i'm": "I'm", "i'll": "I'll", "i'd": "I'd", "i've": "I've",
    'mr': 'Mr', 'mr.': 'Mr', 'mrs': 'Mrs', 'mrs.': 'Mrs', 'ms': 'Ms', 'ms.': 'Ms', 'dr': 'Dr', 'dr.': 'Dr',
    'ok': 'OK', 'tv': 'TV', 'dna': 'DNA', 'ufo': 'UFO', 'fbi': 'FBI', 'cia': 'CIA', 'vip': 'VIP', 'ai': 'AI', 'id': 'ID',
    'monday': 'Monday', 'tuesday': 'Tuesday', 'wednesday': 'Wednesday',
    'thursday': 'Thursday', 'friday': 'Friday', 'saturday': 'Saturday', 'sunday': 'Sunday',
    'january': 'January', 'february': 'February', 'march': 'March', 'april': 'April',
    'may': 'May', 'june': 'June', 'july': 'July', 'august': 'August',
    'september': 'September', 'october': 'October', 'november': 'November', 'december': 'December'
  };

  /**
   * 漫画全大写英文转自然阅读大小写 (English Comic Truecase Engine)
   * 1. 句首大写 (依据标点 . ! ? 或换行段首)
   * 2. 专用名词库优先替换并保留正确大写 (人名/地名/专有名词)
   * 3. 固有大写词库 (代词 I/I'm, 缩写 Mr./Dr./OK/TV/DNA/FBI)
   * 4. 普通词汇转小写，极大节省行宽，大幅提升阅读体验与词汇学习效果
   */
  function toReadingCase(text, customGlossary = {}) {
    if (!text || typeof text !== 'string') return text;
    if (!/[A-Z]/.test(text)) return text;

    const glossary = { ...DEFAULT_TRUECASE_GLOSSARY, ...(customGlossary || {}) };

    let processed = text;
    // 多词短语匹配（支持跨换行）
    for (const [key, val] of Object.entries(glossary)) {
      if (key.includes(' ')) {
        const words = key.trim().split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const reg = new RegExp('\\b' + words.join('\\s+') + '\\b', 'gi');
        processed = processed.replace(reg, (match) => {
          const origSpaces = match.match(/\s+/g) || [];
          const valWords = val.trim().split(/\s+/);
          let out = '';
          for (let i = 0; i < valWords.length; i++) {
            out += valWords[i];
            if (i < origSpaces.length) out += origSpaces[i];
            else if (i < valWords.length - 1) out += ' ';
          }
          return out;
        });
      }
    }

    const lines = processed.split('\n');
    let isNewSentence = true;

    const resultLines = lines.map(line => {
      return line.replace(/[A-Za-z0-9'’\-]+|[^\sA-Za-z0-9'’\-]+/g, (token) => {
        if (/^[\.\!\?]+$/.test(token)) {
          if (token !== '...' && token !== '…') {
            isNewSentence = true;
          }
          return token;
        }
        if (/^[,\;\:\"'“”]+$/.test(token)) {
          return token;
        }

        const lower = token.toLowerCase();

        // 已被短语精准替换过（混合大小写），保留
        if (token !== token.toUpperCase() && token !== token.toLowerCase()) {
          isNewSentence = false;
          return token;
        }

        // 单词词库匹配
        if (glossary[lower]) {
          isNewSentence = false;
          return glossary[lower];
        }

        // 句首大写
        if (isNewSentence) {
          isNewSentence = false;
          return lower.charAt(0).toUpperCase() + lower.slice(1);
        }

        // 常规单词小写
        return lower;
      });
    });

    return resultLines.join('\n');
  }

  globalThis.ComicTextTransform = { toReadingCase };

  // ========================================================
  // 前端大模型直连流式翻译引擎 (方案A: 行协议逐行解析回填)
  // ========================================================
  const llmActiveControllers = new Map();

  function cleanTranslatedText(text) {
    if (!text || typeof text !== 'string') return '';
    return text
      .replace(/^(?:\[(S\d+_\d+|\d+)\]|(S\d+_\d+|\d+)[\.、：:])\s*/i, '') // 彻底剥离行号 [S1_0] 或 [0] 或 0. 避免标号污染漫画文本
      .replace(/^[*_~`]+|[*_~`]+$/g, '') // 剥离 markdown 粗体/反引号
      .replace(/^(旁白|对白|内心独白|拟声词|译文|翻译|Chinese|Translation)\s*[:：]\s*/i, '') // 剥离多余角色/翻译前缀
      .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '') // 剥离多余外层引号
      .trim();
  }

  function getBubbleDisplayText(bubble) {
    if (!bubble) return '';
    const activeModel = globalThis.ComicLLMStore?.getActiveModel ? globalThis.ComicLLMStore.getActiveModel() : 'none';
    const currentLang = globalThis.ComicLLMStore?.getOcrLang ? globalThis.ComicLLMStore.getOcrLang() : 'kr';
    const isEn = (currentLang === 'en') || /[A-Za-z]{3,}/.test(bubble.text || '');

    // 1. 若当前并非 none 模式且已有大模型翻译结果，优先展示译文
    if (activeModel !== 'none' && bubble.translatedText) {
      return bubble.translatedText;
    }

    // 2. 否则展示原文（若是英文源语种，自动规范为自然阅读体大小写）
    if (isEn && bubble.text) {
      return toReadingCase(bubble.text);
    }

    return bubble.text || '';
  }

  function computeOptimalFontSize(text, baseSize, containerW) {
    if (!text || containerW <= 0) return baseSize;
    const lines = String(text).split('\n');
    let maxLineChars = 0;
    for (const l of lines) {
      const clean = l.trim();
      let visualUnits = 0;
      for (let i = 0; i < clean.length; i++) {
        visualUnits += clean.charCodeAt(i) > 255 ? 1.0 : 0.55;
      }
      if (visualUnits > maxLineChars) maxLineChars = visualUnits;
    }
    if (maxLineChars <= 0) return baseSize;
    const availW = Math.max(20, containerW - 10);
    const maxCharSize = Math.floor(availW / maxLineChars);
    // 最低保护 12px（严格保证手机端视觉清晰度），平滑阶梯缩放
    return Math.max(12, Math.min(baseSize, maxCharSize));
  }

  function updatePatchText(sliceIndex, bubble, newText) {
    const bubbles = patchesBySlice.get(sliceIndex) || [];
    const bIdx = bubbles.indexOf(bubble);
    if (bIdx < 0) return;
    const key = `${sliceIndex}-${bIdx}`;
    const patch = patchElements.get(key);
    if (patch) {
      const textEl = patch.querySelector('.manga-patch-text');
      if (textEl) {
        if (textEl.textContent !== newText) {
          textEl.textContent = newText;
        }
        const effW = parseFloat(patch.style.width) || 0;
        const baseSize = patch._baseFontSize || parseFloat(textEl.style.fontSize) || 16;
        const optSize = computeOptimalFontSize(newText, baseSize, effW);
        textEl.style.fontSize = `${optSize}px`;
      }
      const isGhost = Boolean(bubble.is_ghost || bubble.role === 'sfx_ghost');
      const isAmbient = Boolean(bubble.role === 'ambient');
      const isNarration = Boolean(bubble.role === 'narration');
      const currentLang = globalThis.ComicLLMStore?.getOcrLang ? globalThis.ComicLLMStore.getOcrLang() : 'kr';
      const isEn = (currentLang === 'en') || /[A-Za-z]{3,}/.test(bubble.text || '');
      const origText = (isEn && bubble.text) ? toReadingCase(bubble.text) : (bubble.text || '');

      if (isGhost) {
        patch.title = `[拟声词美术字]\n译文: ${newText}\n原文: ${origText}\n(点击切换显示/透视原画)`;
      } else if (isAmbient) {
        patch.title = `[背景环境台词]\n译文: ${newText}\n原文: ${origText}\n(点击切换显示/透视原画)`;
      } else if (isNarration) {
        patch.title = `${newText}\n[画外音/旁白]\n原文: ${origText}`;
      } else {
        patch.title = `${newText}\n原文: ${origText}\n(点击切换透视对比原文)`;
      }
    }
  }

  // ========================================================
  // 前端大模型双轨调度流水线 (Dual-Track LLM Pipeline)
  // 轨一: Fast-Lane 首片特快直发 (免等待，600~800ms 首字即时上屏)
  // 轨二: Relay-Bucket 场景大包接力 (12~15 气泡 / 800ms 动态聚合)
  // ========================================================
  const llmRelayBucket = {
    items: [],
    timer: null
  };

  function resetLlmBucket() {
    if (llmRelayBucket.timer) {
      clearTimeout(llmRelayBucket.timer);
      llmRelayBucket.timer = null;
    }
    llmRelayBucket.items = [];
  }

  function dispatchBubblesToLLM(slice, bubbles, batchMeta) {
    if (!slice || !bubbles || !bubbles.length) return;
    const activeModel = globalThis.ComicLLMStore?.getActiveModel ? globalThis.ComicLLMStore.getActiveModel() : 'none';
    if (!activeModel || activeModel === 'none') return;

    const currentLang = (globalThis.ComicLLMStore?.getOcrLang ? globalThis.ComicLLMStore.getOcrLang() : null) || 'kr';

    // 格式化当前切片的可翻译气泡，赋予唯一物理 ID: [S{sliceIndex}_{bubbleIndex}]
    const translatableItems = [];
    bubbles.forEach((b, bIdx) => {
      const orig = (b.text || '').trim();
      if (orig) {
        const isJa = (currentLang === 'ja') || /[\u3040-\u30ff]/.test(orig);
        const normalized = isJa
          ? orig.replace(/\r?\n+/g, '').replace(/\s+/g, ' ').trim()
          : orig.replace(/\r?\n+/g, ' ').replace(/\s+/g, ' ').trim();
        b.normalizedText = normalized;
        translatableItems.push({
          slice,
          sliceIndex: slice.sliceIndex,
          bubble: b,
          bubbleIndex: bIdx,
          id: `S${slice.sliceIndex}_${bIdx}`,
          normalizedText: normalized
        });
      }
    });

    if (translatableItems.length === 0) return;

    // 🌟 轨一：首屏特快车道 (Fast-Lane, Slice 0 / sliceIndex === 1)
    // 豁免任何聚合等待，立即独享直发，确保首屏秒级上屏！
    if (slice.sliceIndex === 1) {
      void translateBatchItems(translatableItems, {
        isFastTrack: true,
        sliceTag: `首片特快 (#1)`,
        sliceIndex: 1
      });
      return;
    }

    // 🌟 轨二：场景大包接力车道 (Relay-Bucket, Slices 1~N)
    // 将气泡推入聚合池
    llmRelayBucket.items.push(...translatableItems);

    const isFinalBatch = Boolean(batchMeta?.isFinalBatch);
    const BUBBLE_THRESHOLD = 14; // 基于移动端实测黄金区间 12~15 气泡

    // 触发条件 1: 累计气泡达到 14 个场景上限
    // 触发条件 2: 最后一批切片 (Final Batch) 立即收尾清空
    if (llmRelayBucket.items.length >= BUBBLE_THRESHOLD || isFinalBatch) {
      flushLlmBucket(isFinalBatch ? '最终收尾大包' : '场景大包');
    } else if (!llmRelayBucket.timer) {
      // 触发条件 3: 800ms 超时保底发车，绝不长时间挂起
      llmRelayBucket.timer = setTimeout(() => {
        llmRelayBucket.timer = null;
        flushLlmBucket('超时保底大包');
      }, 800);
    }
  }

  function flushLlmBucket(reason = '大包接力') {
    if (llmRelayBucket.timer) {
      clearTimeout(llmRelayBucket.timer);
      llmRelayBucket.timer = null;
    }
    if (!llmRelayBucket.items.length) return;

    const itemsToFlush = llmRelayBucket.items.splice(0);
    const sliceIndices = [...new Set(itemsToFlush.map(it => it.sliceIndex))];
    const cutIndices = sliceIndices.map(i => Math.max(0, i - 1));
    const batchTag = `切片[${cutIndices.join(',')}]${reason} (${itemsToFlush.length}气泡)`;

    console.log(`[ComicCapture] 🚀【大模型聚合发车】${batchTag}，包含切片 #${sliceIndices.join(', #')}，共 ${itemsToFlush.length} 处对白`);
    void translateBatchItems(itemsToFlush, {
      isFastTrack: false,
      sliceTag: batchTag,
      sliceIndex: sliceIndices[0]
    });
  }

  async function translateBatchItems(items, options = {}) {
    if (!items || !items.length) return;
    const activeModel = globalThis.ComicLLMStore?.getActiveModel ? globalThis.ComicLLMStore.getActiveModel() : 'none';
    if (!activeModel || activeModel === 'none') return;

    const providers = globalThis.ComicLLMStore?.getProviders ? globalThis.ComicLLMStore.getProviders() : [];
    const activeProviderId = globalThis.ComicLLMStore?.getActiveProviderId ? globalThis.ComicLLMStore.getActiveProviderId() : '';
    const provider = providers.find(p => p.id === activeProviderId) || providers[0];

    const sliceTag = options.sliceTag || `切片大包 (${items.length}气泡)`;
    const sliceIndex = options.sliceIndex || items[0].sliceIndex;

    if (!provider || !provider.url || !provider.key) {
      if (globalThis.ComicErrorTracker) {
        globalThis.ComicErrorTracker.record({
          type: '大模型配置缺失',
          sliceTag,
          detail: `当前激活平台 [${provider?.name || '未命名'}] 未填入有效的 API Key 或 Base URL，已降级展示原文`
        });
      }
      return;
    }

    const llmPreparedAt = new Date().toISOString();
    // 构造 [ID] 原文 的协议输入，例如 [S1_0] Text
    const linesInput = items.map(it => `[${it.id}] ${it.normalizedText}`).join('\n');

    let endpoint = provider.url.trim().replace(/\/+$/, '');
    if (!endpoint.endsWith('/chat/completions')) {
      endpoint += '/chat/completions';
    }

    const ctrl = new AbortController();
    const ctrlKey = `${sliceIndex}-${Date.now()}`;
    llmActiveControllers.set(ctrlKey, ctrl);
    const llmSentAt = new Date().toISOString();
    const llmStartTime = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    let llmFirstTokenAt = null;

    const systemPrompt = '你是一位专业的漫画汉化翻译家。请将以下漫画对白逐行翻译为简体中文。\n【输出规范】\n1. 每行格式必须严格保留对应的 [ID] 标签，例如：[S1_0] 译文\n2. 严禁合并行、严禁遗漏行，[ID] 标签必须与输入完全一一对应\n3. 每条译文必须单行输出，严禁在译文内部换行\n4. 仅输出每行的 [ID] 译文，严禁输出任何问候、角色标签或额外解释\n5. 译文需自然口语化，拟声词贴切生动，契合漫画分镜语境';

    try {
      const requestPayload = {
        model: activeModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: linesInput }
        ],
        stream: true,
        temperature: 0.3,
        max_tokens: Math.max(120, items.length * 45),
        thinking: { type: 'disabled' }
      };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${provider.key.trim()}`
        },
        body: JSON.stringify(requestPayload),
        signal: ctrl.signal
      });

      if (!res.ok) {
        let errDetail = `HTTP ${res.status} ${res.statusText}`;
        try {
          const errData = await res.json();
          if (errData?.error?.message) errDetail = errData.error.message;
          else if (errData?.message) errDetail = errData.message;
        } catch {}

        let errType = '大模型请求异常';
        if (res.status === 401) errType = 'API Key 无效 (401)';
        else if (res.status === 402) errType = '账户欠费 / 额度耗尽 (402)';
        else if (res.status === 429) errType = '频次超限 / 并发限制 (429)';
        else if (res.status >= 500) errType = '大模型服务端故障 (5xx)';

        if (globalThis.ComicErrorTracker) {
          globalThis.ComicErrorTracker.record({
            type: errType,
            sliceTag,
            detail: errDetail
          });
        }
        if (globalThis.ComicPacketInspector) {
          globalThis.ComicPacketInspector.record({
            sliceTag,
            sliceIndex,
            mode: API.includes('127.0.0.1') ? '本地 (Local 127.0.0.1:8000)' : '云端 (Cloud Serverless)',
            apiEndpoint: API,
            ocr: { sent_at: '', received_at: '', duration_ms: 0, click_to_ocr_ms: 0, bubbles_count: items.length },
            llm: {
              prepared_at: llmPreparedAt, sent_at: llmSentAt, first_token_at: '', completed_at: new Date().toISOString(),
              duration_ms: Math.round(((typeof performance !== 'undefined') ? performance.now() : Date.now()) - llmStartTime),
              model: activeModel, endpoint, system_prompt: systemPrompt, user_input: linesInput,
              raw_response: `[请求失败 HTTP ${res.status}] ${errDetail}`
            }
          });
        }
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let accumulated = '';
      let fullRawResponse = '';
      let currentItem = null;
      let parsedLinesCount = 0;

      const handleParsedLine = (rawLine) => {
        const line = rawLine.trim();
        if (!line) return;

        // 兼容 [S1_0]、[0]、1. 等各种标号格式
        const match = line.match(/^(?:\[(S\d+_\d+|\d+)\]|(S\d+_\d+|\d+)[\.、：:])\s*(.+)$/i);
        if (match) {
          const tag = (match[1] || match[2]).toUpperCase();
          const rawTrans = match[3];
          const cleanTrans = cleanTranslatedText(rawTrans);

          // 1. 优先按全局联合 ID (如 S1_0) 精准匹配
          let targetItem = items.find(it => it.id.toUpperCase() === tag);

          // 2. 若大模型退化为纯数字标号 (如 [0], [1])，按序号匹配
          if (!targetItem && /^\d+$/.test(tag)) {
            const num = parseInt(tag, 10);
            if (num < items.length) targetItem = items[num];
          }

          // 3. 兜底按行解析顺序匹配
          if (!targetItem && parsedLinesCount < items.length) {
            targetItem = items[parsedLinesCount];
          }

          currentItem = targetItem;
          parsedLinesCount++;

          if (cleanTrans && targetItem) {
            targetItem.bubble.translatedText = cleanTrans;
            updatePatchText(targetItem.sliceIndex, targetItem.bubble, cleanTrans);
            if (!firstTranslationEmitted) {
              firstTranslationEmitted = true;
              if (globalThis.ComicFloatingBallOnFirstTranslation) {
                globalThis.ComicFloatingBallOnFirstTranslation();
              }
            }
          }
        } else if (currentItem && currentItem.bubble) {
          // LLM 内部换行续接处理
          const cleanCont = cleanTranslatedText(line);
          if (cleanCont) {
            currentItem.bubble.translatedText = (currentItem.bubble.translatedText ? (currentItem.bubble.translatedText + ' ') : '') + cleanCont;
            updatePatchText(currentItem.sliceIndex, currentItem.bubble, currentItem.bubble.translatedText);
            if (!firstTranslationEmitted) {
              firstTranslationEmitted = true;
              if (globalThis.ComicFloatingBallOnFirstTranslation) {
                globalThis.ComicFloatingBallOnFirstTranslation();
              }
            }
          }
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const l of lines) {
          const trimmed = l.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const parsed = JSON.parse(payload);
            const content = parsed.choices?.[0]?.delta?.content || '';
            if (content) {
              if (!llmFirstTokenAt) {
                llmFirstTokenAt = new Date().toISOString();
                if (options.isFastTrack && !pipelineTelemetry.firstLlmTtfbMs) {
                  pipelineTelemetry.firstLlmTtfbMs = Math.round(((typeof performance !== 'undefined') ? performance.now() : Date.now()) - llmStartTime);
                  console.log(`[ComicCapture] ⚡【首字TTFB】首切片大模型首字返回延迟: ${pipelineTelemetry.firstLlmTtfbMs}ms`);
                  notify();
                }
              }
              fullRawResponse += content;
              accumulated += content;
              const accLines = accumulated.split('\n');
              while (accLines.length > 1) {
                const finishedLine = accLines.shift();
                handleParsedLine(finishedLine);
              }
              accumulated = accLines[0] || '';
            }
          } catch {}
        }
      }

      if (accumulated.trim()) {
        handleParsedLine(accumulated.trim());
      }

      const llmCompletedAt = new Date().toISOString();
      const llmDuration = Math.round(((typeof performance !== 'undefined') ? performance.now() : Date.now()) - llmStartTime);
      if (options.isFastTrack && !pipelineTelemetry.firstLlmTotalMs) {
        pipelineTelemetry.firstLlmTotalMs = llmDuration;
        console.log(`[ComicCapture] ⚡【首片LLM总耗时】首切片大模型流完成耗时: ${pipelineTelemetry.firstLlmTotalMs}ms`);
        notify();
      }

      if (globalThis.ComicPacketInspector) {
        globalThis.ComicPacketInspector.record({
          sliceTag,
          sliceIndex,
          mode: API.includes('127.0.0.1') ? '本地 (Local 127.0.0.1:8000)' : '云端 (Cloud Serverless)',
          apiEndpoint: API,
          ocr: {
            sent_at: '',
            received_at: '',
            duration_ms: 0,
            click_to_ocr_ms: 0,
            bubbles_count: items.length
          },
          llm: {
            prepared_at: llmPreparedAt,
            sent_at: llmSentAt,
            first_token_at: llmFirstTokenAt || llmCompletedAt,
            completed_at: llmCompletedAt,
            duration_ms: llmDuration,
            model: activeModel,
            endpoint,
            system_prompt: systemPrompt,
            user_input: linesInput,
            raw_response: fullRawResponse.trim() || accumulated.trim()
          }
        });
      }
    } catch (err) {
      if (err?.name !== 'AbortError') {
        console.error(`[ComicCapture] ${sliceTag} 大模型调用出错:`, err);
        if (globalThis.ComicErrorTracker) {
          let errType = '大模型网络中断';
          const msg = err?.message || String(err);
          if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) errType = '网络不可达 / 跨域受阻';
          globalThis.ComicErrorTracker.record({
            type: errType,
            sliceTag,
            detail: msg
          });
        }
      }
    } finally {
      llmActiveControllers.delete(ctrlKey);
    }
  }

  // 保持向后兼容性
  function translateSliceBubbles(slice, bubbles, batchMeta) {
    dispatchBubblesToLLM(slice, bubbles, batchMeta);
  }

  function renderPatches(container) {
    if (!coordinateIndex || !coordinateSnapshot || !patchesBySlice.size) {
      if (patchElements.size) {
        for (const el of patchElements.values()) el.remove();
        patchElements.clear();
      }
      return 0;
    }

    let count = 0;
    const visibleKeys = new Set();

    // 跨切片空间几何去重：收集所有气泡候选，彻底消除相邻切片 overlap 缓冲区导致的双重渲染与文字重影
    const candidates = [];
    for (const [sliceIndex, bubbles] of patchesBySlice) {
      for (let bIdx = 0; bIdx < bubbles.length; bIdx++) {
        const bubble = bubbles[bIdx];
        if (!bubble?.box_abs || bubble.box_abs.length < 4) continue;
        candidates.push({ sliceIndex, bIdx, bubble });
      }
    }

    const uniqueCandidates = [];
    for (const cand of candidates) {
      const b = cand.bubble;
      const bX0 = b.box_abs[0];
      const bY0 = b.box_abs[1];
      const bW = b.box_abs[2];
      const bH = b.box_abs[3];
      const bArea = bW * bH;

      let isDuplicate = false;
      for (const existing of uniqueCandidates) {
        const eb = existing.bubble;
        const eX0 = eb.box_abs[0];
        const eY0 = eb.box_abs[1];
        const eW = eb.box_abs[2];
        const eH = eb.box_abs[3];
        const eArea = eW * eH;

        const ix0 = Math.max(bX0, eX0);
        const iy0 = Math.max(bY0, eY0);
        const ix1 = Math.min(bX0 + bW, eX0 + eW);
        const iy1 = Math.min(bY0 + bH, eY0 + eH);

        if (ix1 > ix0 && iy1 > iy0) {
          const interArea = (ix1 - ix0) * (iy1 - iy0);
          const iou = interArea / (bArea + eArea - interArea);
          const minCover = interArea / Math.min(bArea, eArea);

          // 空间判定：IoU >= 0.30 或 包含度 >= 0.50，判定为同区域重叠的同一物理气泡
          if (iou >= 0.30 || minCover >= 0.50) {
            isDuplicate = true;
            if (b.translatedText && !eb.translatedText) {
              eb.translatedText = b.translatedText;
            } else if (eb.translatedText && !b.translatedText) {
              b.translatedText = eb.translatedText;
            }
            break;
          }
        } else {
          // 关键修复：跨切线边界粘连去重 (Boundary Collision Deduplication)
          // 当气泡被切线横切为上下两半时，两个子气泡在垂直方向相切或仅间隔数像素 (verticalGap <= 15)，
          // 水平方向重合比例高 (xOverlapRatio >= 0.60)，且来自相邻切片 (Math.abs(cand.sliceIndex - existing.sliceIndex) <= 1)
          const xInter = Math.max(0, Math.min(bX0 + bW, eX0 + eW) - Math.max(bX0, eX0));
          const xOverlapRatio = Math.min(bW, eW) > 0 ? (xInter / Math.min(bW, eW)) : 0;
          const verticalGap = Math.max(0, Math.max(bY0, eY0) - Math.min(bY0 + bH, eY0 + eH));

          if (xOverlapRatio >= 0.60 && verticalGap <= 15 && Math.abs(cand.sliceIndex - existing.sliceIndex) <= 1) {
            isDuplicate = true;
            const mergedY0 = Math.min(bY0, eY0);
            const mergedY1 = Math.max(bY0 + bH, eY0 + eH);
            const mergedX0 = Math.min(bX0, eX0);
            const mergedX1 = Math.max(bX0 + bW, eX0 + eW);
            eb.box_abs = [mergedX0, mergedY0, mergedX1 - mergedX0, mergedY1 - mergedY0];
            if (b.translatedText && (!eb.translatedText || b.translatedText.length > eb.translatedText.length)) {
              eb.translatedText = b.translatedText;
            }
            break;
          }
        }
      }

      if (!isDuplicate) {
        uniqueCandidates.push(cand);
      }
    }

    for (const cand of uniqueCandidates) {
      const { sliceIndex, bIdx, bubble } = cand;
      const rawX0 = bubble.box_abs[0];
        const rawY0 = bubble.box_abs[1];
        const rawX1 = bubble.box_abs[0] + bubble.box_abs[2];
        const rawY1 = bubble.box_abs[1] + bubble.box_abs[3];

        // 边界安全钳位
        const x0 = Math.max(0, Math.min(coordinateIndex.width - 2, rawX0));
        const x1 = Math.max(x0 + 1, Math.min(coordinateIndex.width, rawX1));
        const y0 = Math.max(0, Math.min(coordinateIndex.totalHeight - 2, rawY0));
        const y1 = Math.max(y0 + 1, Math.min(coordinateIndex.totalHeight, rawY1));

        // 基于绝对坐标唯一定位，彻底杜绝交界处因拆分成多投影而生成重复重叠补丁
        const p0 = locateAbsoluteY(y0);
        if (!p0) continue;
        const p1 = locateAbsoluteY(y1);

        const scaleX = p0.scaleX || (p0.width / coordinateIndex.width);
        const patchLeft = p0.left + x0 * scaleX;
        const patchTop = p0.top;
        const patchW = (x1 - x0) * scaleX;
        const patchH = (p1 && p1.top > p0.top)
          ? (p1.top - p0.top)
          : ((y1 - y0) * (p0.scaleY || scaleX));

        if (patchW < 2 || patchH < 2) continue;

        const renderMode = bubble.render_mode || (bubble.is_ghost || bubble.role === 'sfx' || bubble.role === 'sfx_ghost' ? 'sfx_overlay' : (bubble.role === 'ambient' ? 'outlined_overlay' : 'solid_patch'));
        const isGhost = (renderMode === 'sfx_overlay' || bubble.is_ghost || bubble.role === 'sfx' || bubble.role === 'sfx_ghost');
        const isAmbient = (renderMode === 'outlined_overlay' || bubble.role === 'ambient');
        const isGlow = (renderMode === 'glow_patch');
        const isNarration = Boolean(bubble.role === 'narration');
        const isDialogue = (renderMode === 'solid_patch' && !isGhost && !isAmbient && !isGlow && !isNarration);
        let effLeft = patchLeft;
        let effTop = patchTop;
        let effWidth = patchW;
        let effHeight = patchH;

        if (isDialogue) {
          // 气泡内留白智能呼吸外扩 (横向左右各微扩 12%~16%，利用原图气泡原本充裕的白底空间，杜绝短句尴尬折行)
          const padX = Math.min(20, Math.max(5, Math.round(patchW * 0.14)));
          const padY = Math.min(8, Math.max(2, Math.round(patchH * 0.06)));
          effLeft = Math.max(0, patchLeft - padX);
          effWidth = patchW + padX * 2;
          effTop = Math.max(0, patchTop - padY);
          effHeight = patchH + padY * 2;
        }

        const key = `${sliceIndex}-${bIdx}`;
        visibleKeys.add(key);
        count++;

        const isHidden = hiddenPatches.has(key);

        let patch = patchElements.get(key);
        if (!patch) {
          patch = document.createElement('div');
          patch.className = 'manga-patch not-dark darkreader-ignore';
          patch.dataset.key = key;

          const bgLayer = document.createElement('div');
          bgLayer.className = 'manga-patch-bg not-dark darkreader-ignore';
          const bgColor = bubble.bg || '#FFFFFF';
          const dark = isColorDark(bgColor);
          if (renderMode === 'solid_patch' || isDialogue) {
            bgLayer.style.setProperty('background-color', bgColor, 'important');
            bgLayer.style.setProperty('box-shadow', getPatchShadow(bgColor, false), 'important');
          } else if (renderMode === 'glow_patch' || isGlow) {
            bgLayer.style.setProperty('background-color', hexToRgba(bgColor, 0.90), 'important');
            bgLayer.style.setProperty('box-shadow', getPatchShadow(bgColor, true), 'important');
          } else {
            bgLayer.style.setProperty('display', 'none', 'important');
          }
          bgLayer.style.setProperty('color-scheme', 'light only', 'important');
          bgLayer.style.setProperty('forced-color-adjust', 'none', 'important');
          bgLayer.style.setProperty('isolation', 'isolate', 'important');

          const textEl = document.createElement('div');
          textEl.className = 'manga-patch-text not-dark darkreader-ignore';
          if (isGhost) {
            textEl.style.setProperty('color', '#c0392b', 'important');
          } else if (isAmbient) {
            textEl.style.setProperty('color', '#0f172a', 'important');
          } else if (isGlow) {
            const fgColor = ensureContrastColor(bubble.fg, bgColor);
            textEl.style.setProperty('color', fgColor, 'important');
            textEl.style.setProperty('text-shadow', dark ? '0 0 4px #000000, 0 0 2px #000000' : '0 0 4px #ffffff, 0 0 2px #ffffff', 'important');
          } else {
            const fgColor = ensureContrastColor(bubble.fg, bgColor);
            textEl.style.setProperty('color', fgColor, 'important');
          }
          textEl.style.setProperty('color-scheme', 'light only', 'important');
          textEl.style.setProperty('forced-color-adjust', 'none', 'important');
          textEl.style.setProperty('-webkit-text-fill-color', 'initial', 'important');
          const displayText = getBubbleDisplayText(bubble);
          textEl.textContent = displayText;

          const currentLang = globalThis.ComicLLMStore?.getOcrLang ? globalThis.ComicLLMStore.getOcrLang() : 'kr';
          const isEn = (currentLang === 'en') || /[A-Za-z]{3,}/.test(bubble.text || '');
          const origText = (isEn && bubble.text) ? toReadingCase(bubble.text) : (bubble.text || '');

          if (isGhost) {
            patch.classList.add('ghost-patch');
            patch.title = bubble.translatedText
              ? `[拟声词音效]\n译文: ${bubble.translatedText}\n原文: ${origText}\n(点击切换显示/透视原画)`
              : `[拟声词音效]\n原文: ${origText}\n(点击切换显示/透视原画)`;
          } else if (isAmbient) {
            patch.classList.add('ambient-patch');
            patch.title = bubble.translatedText
              ? `[背景环境台词]\n译文: ${bubble.translatedText}\n原文: ${origText}\n(点击切换显示/透视原画)`
              : `[背景环境台词]\n原文: ${origText}\n(点击切换显示/透视原画)`;
          } else if (isGlow) {
            patch.classList.add('glow-patch');
            patch.title = bubble.translatedText
              ? `[渐变/平滑台词]\n译文: ${bubble.translatedText}\n原文: ${origText}`
              : `[渐变/平滑台词]\n原文: ${origText}`;
          } else if (isNarration) {
            patch.classList.add('narration-patch');
            patch.title = bubble.translatedText
              ? `${bubble.translatedText}\n[画外音/旁白]\n原文: ${origText}`
              : `${origText}\n[画外音/旁白]`;
          } else {
            patch.title = bubble.translatedText
              ? `${bubble.translatedText}\n原文: ${origText}\n(点击切换透视对比原文)`
              : `${origText}\n(点击切换透视对比原文)`;
          }

          patch.appendChild(bgLayer);
          patch.appendChild(textEl);

          patch.addEventListener('click', (e) => {
            e.stopPropagation();
            if (hiddenPatches.has(key)) {
              hiddenPatches.delete(key);
            } else {
              hiddenPatches.add(key);
            }
            scheduleOverlay();
          });

          patchElements.set(key, patch);
          container.appendChild(patch);
        }

        patch.style.left = `${effLeft}px`;
        patch.style.top = `${effTop}px`;
        patch.style.width = `${effWidth}px`;
        patch.style.height = `${effHeight}px`;

        const baseFontSize = Math.max(12, Math.min(32, Math.round((bubble.size || 16) * scaleX)));
        patch._baseFontSize = baseFontSize;
        const displayText = getBubbleDisplayText(bubble);
        const fontSize = computeOptimalFontSize(displayText, baseFontSize, effWidth);

        const textEl = patch.querySelector('.manga-patch-text');
        const bgLayer = patch.querySelector('.manga-patch-bg');
        const bgColor = bubble.bg || '#FFFFFF';

        if (bgLayer) {
          if (renderMode === 'solid_patch' || isDialogue) {
            bgLayer.style.setProperty('display', 'block', 'important');
            bgLayer.style.setProperty('background-color', bgColor, 'important');
            bgLayer.style.setProperty('box-shadow', getPatchShadow(bgColor, false), 'important');
          } else if (renderMode === 'glow_patch' || isGlow) {
            bgLayer.style.setProperty('display', 'block', 'important');
            bgLayer.style.setProperty('background-color', hexToRgba(bgColor, 0.90), 'important');
            bgLayer.style.setProperty('box-shadow', getPatchShadow(bgColor, true), 'important');
          } else {
            bgLayer.style.setProperty('display', 'none', 'important');
          }
        }

        if (textEl) {
          textEl.style.fontSize = `${fontSize}px`;
          textEl.style.fontWeight = bubble.weight || 700;
          const dark = isColorDark(bgColor);
          if (isGhost) {
            textEl.style.setProperty('color', '#c0392b', 'important');
          } else if (isAmbient) {
            textEl.style.setProperty('color', '#0f172a', 'important');
          } else if (isGlow) {
            const fgColor = ensureContrastColor(bubble.fg, bgColor);
            textEl.style.setProperty('color', fgColor, 'important');
            textEl.style.setProperty('text-shadow', dark ? '0 0 4px #000000, 0 0 2px #000000' : '0 0 4px #ffffff, 0 0 2px #ffffff', 'important');
          } else {
            const fgColor = ensureContrastColor(bubble.fg, bgColor);
            textEl.style.setProperty('color', fgColor, 'important');
          }
          if (textEl.textContent !== displayText) {
            textEl.textContent = displayText;
          }
        }

        if (isGhost) {
          patch.classList.add('ghost-patch');
          patch.classList.remove('ambient-patch', 'glow-patch', 'narration-patch');
        } else if (isAmbient) {
          patch.classList.add('ambient-patch');
          patch.classList.remove('ghost-patch', 'glow-patch', 'narration-patch');
        } else if (isGlow) {
          patch.classList.add('glow-patch');
          patch.classList.remove('ghost-patch', 'ambient-patch', 'narration-patch');
        } else if (isNarration) {
          patch.classList.add('narration-patch');
          patch.classList.remove('ghost-patch', 'ambient-patch', 'glow-patch');
        } else {
          patch.classList.remove('ghost-patch', 'ambient-patch', 'glow-patch', 'narration-patch');
        }

        if (isHidden) {
          patch.classList.add('hidden-mask');
        } else {
          patch.classList.remove('hidden-mask');
        }
      }

    for (const [k, el] of patchElements) {
      if (!visibleKeys.has(k)) {
        el.remove();
        patchElements.delete(k);
      }
    }

    return count;
  }

  function notify() {
    const completed = entries.filter(entry => states.get(entry.img) === 'done').length;
    const failed = entries.filter(entry => states.get(entry.img) === 'failed').length;
    const observerCount = entries.filter(entry => entry.img.dataset.comicMethod === 'observer').length;
    const attributeCount = entries.length - observerCount;
    const status = {
      running,
      stopping,
      starting,
      previewEnabled,
      statusText,
      count: entries.length,
      completed,
      failed,
      chapterId,
      slicesCompleted,
      batchesCompleted,
      pendingBatchCount: captureSession?.getPendingBatchCount ? captureSession.getPendingBatchCount() : 0,
      stats: {
        attribute: attributeCount,
        observer: observerCount
      }
    };
    statusListener(status);
    if (globalThis.ComicDebugHUD?.update) {
      globalThis.ComicDebugHUD.update(status);
    }
    scheduleOverlay();
  }

  function updateEntries() {
    const next = collectOrderedImages(reader);

    // 只有在未运行且坐标快照已锁定时，才检查快照是否失效
    const invalidated = !running && coordinateSnapshot &&
      (next.length !== coordinateSnapshot.length ||
        next.some((img, index) => img !== coordinateSnapshot[index].img ||
          getImageUrl(img) !== coordinateSnapshot[index].url));

    // 运行期间：只有当前正在切片的图片节点被从 DOM 彻底移除，才视为破坏中断；尾部追加图片绝不中断
    const snapshotCorrupted = running && coordinateSnapshot &&
      coordinateSnapshot.some(entry => !entry.img || !entry.img.isConnected);

    entries = next.map((img, index) => ({ img, pageIndex: index + 1, imageId: imageId(img) }));

    if (entries.length && entries[0]?.img?.complete && entries[0].img.naturalWidth > 0 && readerDetectedTime && !firstImageReadyLogged) {
      firstImageReadyLogged = true;
      const readyDur = Math.round(((typeof performance !== 'undefined') ? performance.now() : Date.now()) - readerDetectedTime);
      pipelineTelemetry.firstImageReadyMs = readyDur;
      console.log(`[ComicCapture] 🖼️【首屏加载耗时】阅读器锁定至首图就绪耗时: ${readyDur}ms (尺寸: ${entries[0].img.naturalWidth}x${entries[0].img.naturalHeight})`);
    }

    if (invalidated) {
      coordinateIndex = null;
      coordinateSnapshot = null;
      completedSlices = [];
      patchesBySlice.clear();
      for (const el of patchElements.values()) el.remove();
      patchElements.clear();
      hiddenPatches.clear();
      statusText = '页面图片发生变化，已清除旧坐标系';
    }

    if (snapshotCorrupted) {
      running = false;
      stopping = true;
      abortController?.abort();
      captureSession?.close();
      captureSession = null;
      statusText = '正在切片的漫画图片节点已失效，切片已停止';
      console.warn('[ComicCapture] 切片节点从 DOM 移除，流程中止');
    }

    // 运行期间增量补货：只要发现新图片，立即送入当前切片会话
    if (running && captureSession && entries.length) {
      markDomActivity();
      cancelEndDetector();
      const currentValid = entries
        .map(entry => ({
          img: entry.img,
          pageIndex: entry.pageIndex, // 永远携带天生的绝对物理页码！
          imageId: entry.imageId,
          url: getImageUrl(entry.img)
        }))
        .filter(entry => entry.img.isConnected && entry.url);

      console.log('[ComicCapture] 触发增量补货，当前具备地址的图片数:', currentValid.length, '总图片数:', entries.length);
      void captureSession.replenish(currentValid).then(() => {
        void checkFrontierState();
      }).catch(err => {
        console.error('[ComicCapture] 增量补货异常:', err);
      });
    }

    lastOrder = next;
    if (!running && !starting) {
      schedulePrewarm(120);
    }
    notify();
  }

  function scheduleScan(delay = 100) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(updateEntries, delay);
  }

  async function ensureAllImagesLoaded(targetReader, signal) {
    if (!targetReader?.root?.isConnected) return;
    promoteLazyImages(targetReader.root);
  }

  async function clearAllPageCaches() {
    try {
      sessionStorage.clear();
    } catch {}
    try {
      if ('caches' in window) {
        const names = await caches.keys();
        await Promise.all(names.map(name => caches.delete(name)));
      }
    } catch {}
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        // 严格保留所有以 comic_ 开头的插件自身配置与调试开关，只清除非插件的网站自身缓存
        if (key && !key.startsWith('comic_')) {
          localStorage.removeItem(key);
        }
      }
    } catch {}
    console.log('[ComicCapture] 🧹 网站缓存、SessionStorage 与 CacheStorage 已清空（插件测试模式与设置已保留）');
  }

  // ================= 终点检测器 (Multi-Signal End Detector) =================
  let endDetectorTimer = null;
  let lastCheckedDocHeight = 0;

  function isNearPageBottom() {
    try {
      const docEl = document.documentElement;
      const scrollHeight = Math.max(docEl?.scrollHeight || 0, document.body?.scrollHeight || 0);
      const scrollBottom = (window.scrollY || 0) + (window.innerHeight || 0);
      return (scrollHeight - scrollBottom) <= 80;
    } catch {
      return false;
    }
  }

  function isLastImageVisibleOrPassed() {
    if (!entries.length) return false;
    const last = entries[entries.length - 1];
    if (!last?.img?.isConnected) return false;
    try {
      const rect = last.img.getBoundingClientRect();
      // 最后一张图片的底部已进入视口或已经滚到视口上方
      return rect.bottom <= (window.innerHeight + 100);
    } catch {
      return false;
    }
  }

  async function isLastImageReady() {
    if (!entries.length) return false;
    const last = entries[entries.length - 1];
    if (!last?.img?.isConnected) return false;
    const img = last.img;
    if (!img.complete || !(img.naturalHeight > 0)) return false;
    try {
      if (typeof img.decode === 'function') {
        await img.decode();
      }
      return true;
    } catch {
      return (img.naturalHeight || 0) > 0;
    }
  }

  // ================= 前沿探测器 (Frontier Detector: CLOSED vs OPEN) =================
  let domQuietTimer = null;
  let isDomSettled = false;

  function markDomActivity() {
    isDomSettled = false;
    if (domQuietTimer) clearTimeout(domQuietTimer);
    domQuietTimer = setTimeout(() => {
      isDomSettled = true;
      if (running && captureSession) {
        checkFrontierState();
      }
    }, 300);
  }

  function getFirstScreenImageCount() {
    if (!entries.length) return 3;
    const vh = window.innerHeight || 800;
    const inFirstScreen = entries.filter(e => {
      if (!e?.img?.isConnected) return false;
      const r = e.img.getBoundingClientRect();
      return r.top < vh * 1.3;
    }).length;
    return Math.max(2, Math.min(inFirstScreen || 3, 5));
  }

  function assessFrontierState() {
    if (!entries.length || !captureSession) return 'OPEN';
    const index = captureSession.getIndex ? captureSession.getIndex() : null;
    if (!index) return 'OPEN';

    const count = entries.length;
    const probedCount = index.pages ? index.pages.length : 0;
    const firstScreenCount = getFirstScreenImageCount();
    // 经验门槛 1：图片数量大于 2 倍首屏加载数量（经验值最低 6 张）
    const minCountThreshold = Math.max(6, firstScreenCount * 2);
    const hasSufficientCount = count >= minCountThreshold;

    // 经验门槛 2：总高度达到基于首图高度计算的规模（经验值 >= minCountThreshold * H1 * 0.7）
    const firstHeight = index.pages[0]?.sourceHeight || index.width * 1.5;
    const expectedHeightThreshold = Math.max(minCountThreshold * firstHeight * 0.7, index.width * 8);
    const hasSufficientHeight = index.totalHeight >= expectedHeightThreshold;

    // 经验门槛 3：所有当前图片已探测完毕，物理连续前缀完整
    const isFullyProbed = probedCount >= count && count > 0;

    // 经验门槛 4：DOM 静默稳定（300ms 无新增节点与高度剧变）
    if (hasSufficientCount && hasSufficientHeight && isFullyProbed && isDomSettled) {
      return 'CLOSED';
    }
    return 'OPEN';
  }

  function checkFrontierState() {
    if (!running || !captureSession || stopping) return;
    const tailInfo = captureSession.getTailInfo ? captureSession.getTailInfo() : null;
    if (!tailInfo || tailInfo.isFinal) return;

    const state = assessFrontierState();
    if (state === 'CLOSED') {
      const firstScreenCount = getFirstScreenImageCount();
      const index = captureSession.getIndex();
      console.log(`[ComicCapture] 🚀 前沿探测器判定为 CLOSED（首屏预估 ${firstScreenCount} 张，已探明 ${entries.length} 张，画卷总高 ${index.totalHeight}px），启动全量预切直接收刀！`);
      statusText = `已探明完整骨架（共 ${entries.length} 页），全量预切收刀中...`;
      notify();
      captureSession.finalize();
    } else {
      // OPEN 模式：保持 Tail Buffer，继续由触底检测器在读者看完全篇时兜底
      void checkEndDetector();
    }
  }

  function cancelEndDetector() {
    if (endDetectorTimer) {
      clearTimeout(endDetectorTimer);
      endDetectorTimer = null;
    }
  }

  async function checkEndDetector() {
    if (!running || !captureSession || stopping) {
      cancelEndDetector();
      return;
    }
    const tailInfo = captureSession.getTailInfo ? captureSession.getTailInfo() : null;
    if (!tailInfo || !tailInfo.pending || tailInfo.isFinal) {
      cancelEndDetector();
      return;
    }

    const atEnd = isNearPageBottom() || isLastImageVisibleOrPassed();
    if (!atEnd) {
      cancelEndDetector();
      return;
    }

    const ready = await isLastImageReady();
    if (!ready || !running || !captureSession || stopping) {
      cancelEndDetector();
      return;
    }

    if (!endDetectorTimer) {
      const docEl = document.documentElement;
      lastCheckedDocHeight = Math.max(docEl?.scrollHeight || 0, document.body?.scrollHeight || 0);
      endDetectorTimer = setTimeout(async () => {
        endDetectorTimer = null;
        if (!running || !captureSession || stopping) return;
        const currentTail = captureSession.getTailInfo ? captureSession.getTailInfo() : null;
        if (!currentTail || !currentTail.pending || currentTail.isFinal) return;

        const currentDocHeight = Math.max(docEl?.scrollHeight || 0, document.body?.scrollHeight || 0);
        const heightStable = Math.abs(currentDocHeight - lastCheckedDocHeight) <= 15;
        const stillAtEnd = isNearPageBottom() || isLastImageVisibleOrPassed();
        const stillReady = await isLastImageReady();

        if (heightStable && stillAtEnd && stillReady) {
          console.log(`[ComicCapture] 🏁 终点检测器命中：物理触底 + DOM/高度静止，触发最终尾部收刀 (Tail: ${currentTail.tail}px, minHeight: ${currentTail.minHeight}px)`);
          statusText = `已到达章节末尾，正在切出最终尾片 (${currentTail.tail}px)...`;
          notify();
          captureSession.finalize();
        }
      }, 400);
    }
  }

  function onScrollActivity() {
    if (!running || !captureSession) return;
    void checkEndDetector();
  }

  async function start() {
    if (starting || running || stopping) return;
    startClickTime = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    pipelineTelemetry.clickToSlice0ReadyMs = 0;
    pipelineTelemetry.clickToFirstOcrMs = 0;
    pipelineTelemetry.slice0OcrDurationMs = 0;
    pipelineTelemetry.slices1To5AllOcrReadyMs = 0;
    pipelineTelemetry.firstLlmTtfbMs = 0;
    pipelineTelemetry.firstLlmTotalMs = 0;
    pipelineTelemetry.slice0Bubbles = 0;
    pipelineTelemetry.first6SlicesBubbles = 0;
    pipelineTelemetry.totalSlicesOcrCompleted = 0;

    const readerAtStart = reader;
    if (!reader?.root?.isConnected) {
      statusText = '未找到漫画阅读区';
      notify();
      return;
    }
    firstTranslationEmitted = false;
    starting = true;
    statusText = '正在扫描并预加载漫画图片...';
    notify();

    abortController = new AbortController();
    try {
      await ensureAllImagesLoaded(reader, abortController.signal);
    } catch { /* 忽略中断 */ }

    if (abortController.signal.aborted) {
      starting = false;
      abortController = null;
      statusText = '切片流程已取消';
      notify();
      return;
    }

    updateEntries();
    if (!entries.length) {
      starting = false;
      abortController = null;
      statusText = '阅读区内没有可编号的图片';
      notify();
      return;
    }
    API = getEffectiveApi();
    const isLocal = API.includes('127.0.0.1');
    const customCloud = typeof localStorage !== 'undefined' ? (localStorage.getItem('comic_cloud_api_url') || '') : '';
    if (!isLocal && !customCloud.trim() && !CLOUD_API) {
      starting = false;
      abortController = null;
      statusText = '未配置云端 OCR 接口地址，请在设置中配置';
      if (globalThis.ComicErrorTracker) {
        globalThis.ComicErrorTracker.record({
          type: '配置缺失',
          sliceTag: '前置检查',
          detail: '未检测到云端 OCR 接口地址。请点击悬浮球设置 -> OCR 服务设置，填入您的云端 API Endpoint，或在 Dev HUD 中开启本地模式。'
        });
      }
      notify();
      alert('【配置提示】未配置云端 OCR 服务地址！\n请点击悬浮球「⚙️ 设置 -> ⚡ OCR 服务设置」填入 API Endpoint，或在 Dev 面板开启本地模式。');
      return;
    }
    statusText = isLocal ? `正在连接本地 OCR 服务 (${API})...` : '正在连接云端 OCR 引擎...';
    notify();
    try {
      await ensureBackendHealthy(API);
    } catch (err) {
      starting = false;
      abortController = null;
      statusText = `无法连接 ${isLocal ? '本地 OCR' : '云端 OCR'} 服务 (${API})；请确认后台已启动 (端口: ${API.split(':').pop()})`;
      if (globalThis.ComicErrorTracker) {
        globalThis.ComicErrorTracker.record({
          type: isLocal ? '本地 OCR 离线' : '云端 OCR 无法连接',
          sliceTag: '健康检查',
          detail: `无法访问 ${API}/health: ${err?.message || '网络连接失败'}`
        });
      }
      notify();
      return;
    }
    starting = false;
    if (reader !== readerAtStart || !reader?.root?.isConnected) {
      abortController = null;
      statusText = '阅读区域已变化，请重新开始';
      notify();
      return;
    }
    updateEntries();
    if (!entries.length) {
      abortController = null;
      statusText = '阅读区图片已变化，请重新识别后开始';
      notify();
      return;
    }
    const snapshot = entries
      .map(entry => ({
        img: entry.img, pageIndex: entry.pageIndex,
        imageId: entry.imageId, url: getImageUrl(entry.img)
      }))
      .filter(entry => entry.img.isConnected && entry.url);

    if (!snapshot.length || snapshot[0].pageIndex !== 1) {
      abortController = null;
      statusText = '第 1 页图片尚未就绪；请等待首图加载后开始';
      notify();
      return;
    }
    chapterId = `${location.hostname}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    coordinateIndex = null;
    coordinateSnapshot = null;
    completedSlices = [];
    patchesBySlice.clear();
    for (const el of patchElements.values()) el.remove();
    patchElements.clear();
    hiddenPatches.clear();
    lockedSources = new Map(snapshot.map(entry => [entry.img, entry.url]));
    slicesCompleted = 0;
    batchesCompleted = 0;
    pendingBatchCount = 0;
    running = true;
    stopping = false;
    for (const entry of entries) states.set(entry.img, 'pending');
    statusText = `正在启动切片流水线（当前 ${snapshot.length} 张图片）...`;
    notify();
    const currentLang = (globalThis.ComicLLMStore?.getOcrLang ? globalThis.ComicLLMStore.getOcrLang() : null) ||
      (typeof localStorage !== 'undefined' ? localStorage.getItem('comic_ocr_lang') : null) ||
      (globalThis.ComicDebugHUD?.getOcrLang ? globalThis.ComicDebugHUD.getOcrLang() : null) || 'kr';

    captureSession = ComicCaptureFlow.createSession({
      chapterId, api: API, signal: abortController.signal,
      lang: currentLang,
      concurrency: 6,
      validateEntry: entry => {
        const current = entries[entry.pageIndex - 1];
        return current?.img === entry.img && current.imageId === entry.imageId &&
          getImageUrl(entry.img) === entry.url && entry.img.isConnected;
      },
      onProbe: (entry, done, total) => {
        states.set(entry.img, 'done');
        statusText = `已确认 ${done}/${total} 张图片尺寸`;
        notify();
      },
      onCoordinate: index => {
        coordinateIndex = index;
        coordinateSnapshot = entries.map(entry => ({
          img: entry.img, pageIndex: entry.pageIndex,
          imageId: entry.imageId, url: getImageUrl(entry.img)
        }));
        statusText = `坐标系已锁定：宽 ${index.width}px，高 ${index.totalHeight}px`;
        console.log(`[ComicCapture] 坐标系更新: 宽 ${index.width}px, 总高 ${index.totalHeight}px, 包含原图: ${index.pages.length} 页`);
        notify();
        void checkFrontierState();
      },
      onSlice: (slice, completed, batchMeta) => {
        slicesCompleted = completed;
        batchesCompleted = completed;
        pendingBatchCount = captureSession?.getPendingBatchCount ? captureSession.getPendingBatchCount() : 0;
        completedSlices = [...completedSlices.filter(item => item.sliceIndex !== slice.sliceIndex), slice]
          .sort((a, b) => a.sliceIndex - b.sliceIndex);
        const rawBubbles = batchMeta?.result?.bubbles || [];

        // 幽灵框分流：如果后端返回了 role / is_ghost，全量保留（由 renderPatches 分配实心补丁 vs 幽灵透明框）
        const bubbles = rawBubbles.filter(b => {
          if (b.role || typeof b.is_ghost === 'boolean') {
            return true;
          }
          return isDialogueBubble(b.bg); // 兼容旧版后端
        });
        if (bubbles.length > 0) {
          patchesBySlice.set(slice.sliceIndex, bubbles);
        }
        const ghostCount = bubbles.filter(b => b.is_ghost || b.role === 'sfx_ghost').length;
        const ambientCount = bubbles.filter(b => b.role === 'ambient').length;
        const dialogueCount = bubbles.length - ghostCount - ambientCount;
        statusText = `已识别 ${completed} 片 (${dialogueCount} 处对白${ambientCount > 0 ? `，${ambientCount} 处背景词` : ''}${ghostCount > 0 ? `，${ghostCount} 处拟声词` : ''})${batchMeta?.isFinalBatch ? ' [最终完成]' : ''}`;
        console.log(`[ComicCapture] 切片 #${completed} 识别完成: Y=${slice.startY}~${slice.endY}px, 对白: ${dialogueCount} 个, 背景词: ${ambientCount} 个, 拟声词: ${ghostCount} 个`);
        notify();
        void checkFrontierState();

        slice._ocrTimeMs = batchMeta?.result?._ocrTimeMs || 0;
        slice._ocrSentAt = batchMeta?.result?._ocrSentAt || '';
        slice._ocrReceivedAt = batchMeta?.result?._ocrReceivedAt || '';
        slice._api = batchMeta?.result?._api || API;
        if (completed === 1) {
          const clickToFirstOcrMs = Math.round(((typeof performance !== 'undefined') ? performance.now() : Date.now()) - startClickTime);
          slice._clickToOcrMs = clickToFirstOcrMs;
          pipelineTelemetry.clickToSlice0ReadyMs = slice._sliceCreatedAt ? Math.max(0, Math.round(slice._sliceCreatedAt - startClickTime)) : 0;
          pipelineTelemetry.clickToFirstOcrMs = clickToFirstOcrMs;
          pipelineTelemetry.slice0OcrDurationMs = slice._ocrTimeMs;
          pipelineTelemetry.slice0Bubbles = bubbles.length;
          console.log(`[ComicCapture] ⚡【首屏耗时统计】从点击按钮到首切片 OCR 完成上屏: ${clickToFirstOcrMs}ms (首切片生成: ${pipelineTelemetry.clickToSlice0ReadyMs}ms, 纯OCR网络: ${slice._ocrTimeMs}ms, 检出气泡: ${bubbles.length}个)`);
        }

        pipelineTelemetry.totalSlicesOcrCompleted = completed;
        if (slice.sliceIndex <= 6) {
          pipelineTelemetry.first6SlicesBubbles += bubbles.length;
        }
        if (completed === 6 || (batchMeta?.isFinalBatch && completed < 6)) {
          pipelineTelemetry.slices1To5AllOcrReadyMs = Math.round(((typeof performance !== 'undefined') ? performance.now() : Date.now()) - startClickTime);
          console.log(`[ComicCapture] 📊【前6切片OCR全就绪】从点击到前6片OCR就绪: ${pipelineTelemetry.slices1To5AllOcrReadyMs}ms, 累计气泡: ${pipelineTelemetry.first6SlicesBubbles}个`);
        }

        // 🌟 触发前端大模型双轨调度流式翻译 (首片特快 + 12~15 气泡大包接力)
        if (bubbles.length > 0) {
          dispatchBubblesToLLM(slice, bubbles, batchMeta);
        }
      },
      onBatch: (batchInfo) => {
        batchesCompleted = batchInfo.batchIndex;
        pendingBatchCount = captureSession?.getPendingBatchCount ? captureSession.getPendingBatchCount() : 0;
        if (batchInfo.isFinalBatch) {
          flushLlmBucket('最终收尾大包');
          statusText = `切片识别全流程完成：共 ${slicesCompleted} 片`;
          console.log(`[ComicCapture] 切片流水线全流程完成: 共 ${slicesCompleted} 片`);
        }
        notify();
      }
    });

    if (typeof window !== 'undefined') {
      window.addEventListener('scroll', onScrollActivity, { passive: true });
      window.addEventListener('scrollend', onScrollActivity, { passive: true });
    }

    void captureSession.replenish(snapshot).then(() => {
      void checkFrontierState();
    }).catch(error => {
      if (error?.name !== 'AbortError') {
        statusText = `切片暂停：${error.message}`;
        console.error('Comic slicing failed', error);
      }
    });
  }

  function stop() {
    if (!running && !starting) return;
    firstTranslationEmitted = false;
    resetLlmBucket();
    if (typeof window !== 'undefined') {
      window.removeEventListener('scroll', onScrollActivity);
      window.removeEventListener('scrollend', onScrollActivity);
    }
    cancelEndDetector();
    if (domQuietTimer) {
      clearTimeout(domQuietTimer);
      domQuietTimer = null;
    }
    isDomSettled = false;
    running = false;
    starting = false;
    stopping = true;
    abortController?.abort();
    // 终止所有在飞的大模型流式请求
    for (const ctrl of llmActiveControllers.values()) {
      try { ctrl.abort(); } catch {}
    }
    llmActiveControllers.clear();
    if (captureSession) {
      captureSession.close();
      captureSession = null;
    }
    stopping = false;
    statusText = `切片已停止，共完成 ${slicesCompleted} 片`;
    notify();
  }

  function toggle() {
    if (running || starting) stop();
    else void start();
  }

  function handleDomChange(targetNode) {
    if (!reader?.root?.isConnected || !targetNode) return;
    markDomActivity();
    if (targetNode instanceof HTMLImageElement) {
      processImageElement(targetNode);
      captureStats.observer++;
      scheduleScan(80);
    } else if (targetNode?.querySelectorAll) {
      let count = 0;
      for (const img of targetNode.querySelectorAll('img')) {
        processImageElement(img);
        captureStats.observer++;
        count++;
      }
      if (count > 0) scheduleScan(80);
    }
  }

  function setReader(nextReader) {
    const oldRoot = reader?.root;
    reader = nextReader;
    if (oldRoot !== reader?.root) {
      readerDetectedTime = (typeof performance !== 'undefined') ? performance.now() : Date.now();
      firstImageReadyLogged = false;
      captureStats = { attribute: 0, observer: 0 };
      readerResizeObserver?.disconnect();
      if (overlayHost && overlayHost.parentElement && overlayHost.parentElement !== reader?.root) {
        overlayHost.remove();
      }
      if (running && (!reader?.root || !reader.root.isConnected)) stop();
      if (reader?.root && 'ResizeObserver' in window) {
        readerResizeObserver = new ResizeObserver(() => {
          scheduleOverlay();
        });
        readerResizeObserver.observe(reader.root);
      }
    }
    if (reader?.root) {
      promoteLazyImages(reader.root);
      ensureOverlay();
    } else if (overlayHost) overlayHost.style.display = 'none';
    updateEntries();
    schedulePrewarm(80);
  }

  function togglePreview() {
    previewEnabled = !previewEnabled;
    notify();
    return previewEnabled;
  }

  document.addEventListener('load', event => {
    if (event.target instanceof HTMLImageElement && entries.some(entry => entry.img === event.target)) {
      scheduleScan(0);
    }
  }, true);

  if (typeof window !== 'undefined') {
    window.addEventListener('comic-model-changed', (e) => {
      const newModel = e?.detail?.model;
      if (newModel === 'none') {
        // 切换到仅看原文学习模式：中止在飞的大模型请求，清除译文立即恢复原文/自然大小写
        for (const ctrl of llmActiveControllers.values()) {
          try { ctrl.abort(); } catch {}
        }
        llmActiveControllers.clear();
        for (const [, bubbles] of patchesBySlice) {
          for (const b of bubbles) {
            b.translatedText = null;
          }
        }
        scheduleOverlay();
      } else {
        // 切换到大模型：对已有切片中尚未翻译的，发起补充流式翻译
        for (const [sliceIndex, bubbles] of patchesBySlice) {
          const slice = completedSlices.find(s => s.sliceIndex === sliceIndex);
          if (slice && bubbles.some(b => !b.translatedText)) {
            dispatchBubblesToLLM(slice, bubbles);
          }
        }
        flushLlmBucket('手动切模型补充大包');
      }
    });
  }

  globalThis.ComicImageCapture = Object.freeze({
    setReader,
    getReaderHtml() {
      if (!reader?.root) return '';
      return reader.root.outerHTML || '';
    },
    getReaderInfo() {
      if (!reader?.root) return null;
      return {
        tagName: reader.root.tagName,
        className: reader.root.className,
        id: reader.root.id,
        imageCount: entries.length,
        childElementCount: reader.root.childElementCount,
        clientWidth: reader.root.clientWidth,
        clientHeight: reader.root.clientHeight
      };
    },
    toggle,
    start,
    stop,
    isRunning() { return running || starting; },
    togglePreview,
    handleDomChange,
    scheduleScan,
    getCoordinateIndex() { return coordinateIndex; },
    restoreBox(slice, box, options) {
      if (!coordinateIndex || slice.coordinateId !== coordinateIndex.coordinateId) {
        throw new Error('OCR 切片坐标系与当前章节不一致');
      }
      return ComicVirtualStrip.restoreBox(slice, box, options);
    },
    projectBox(absoluteBox) {
      if (!coordinateIndex) throw new Error('当前没有有效的章节坐标系');
      return ComicVirtualStrip.projectBox(coordinateIndex, absoluteBox);
    },
    getLivePatches() {
      const list = [];
      for (const [key, el] of patchElements) {
        list.push({
          key,
          className: el.className,
          top: parseFloat(el.style.top) || 0,
          left: parseFloat(el.style.left) || 0,
          width: parseFloat(el.style.width) || 0,
          height: parseFloat(el.style.height) || 0,
          text: el.querySelector('.manga-patch-text')?.textContent || ''
        });
      }
      return list;
    },
    getAllSliceBubbles() {
      const list = [];
      const sortedSlices = [...completedSlices].sort((a, b) => a.sliceIndex - b.sliceIndex);
      for (const slice of sortedSlices) {
        const bubbles = patchesBySlice.get(slice.sliceIndex) || [];
        list.push({
          sliceIndex: slice.sliceIndex,
          slice,
          bubbles
        });
      }
      return list;
    },
    setStatusListener(listener) { statusListener = typeof listener === 'function' ? listener : () => {}; notify(); },
    clearCaches: clearAllPageCaches,
    getStats() {
      const observerCount = entries.filter(entry => entry.img.dataset.comicMethod === 'observer').length;
      return { attribute: entries.length - observerCount, observer: observerCount };
    },
    getPipelineTelemetry() {
      return {
        ...pipelineTelemetry,
        prewarm: { ...pipelineTelemetry.prewarm }
      };
    }
  });
})();
