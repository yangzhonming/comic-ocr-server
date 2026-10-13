(() => {
  // 纯 URL/规则模块：不访问 DOM、chrome.storage 或 Popup。
  // 键中的 host 是准确主机名（含非默认端口）；不猜测公共后缀或跨子域合并。
  // v1 键仍可读取，避免更新插件后丢失已保存的纠错。
  const PAGE_V1 = 'comic-page-override:v1:';
  const CHAPTER_V1 = 'comic-chapter-override:v1:';
  const SCOPE_V2 = 'comic-scope-override:v2:';
  const ROUTE_V2 = 'comic-route-override:v2:';
  const SECTION_NAMES = /^(?:manga|comic|webtoon|manhua|manhwa|read|reader|series)$/i;

  function parsedUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      url.hash = '';
      return url;
    } catch { return null; }
  }

  function partsOf(url) {
    return url.pathname.split('/').filter(Boolean).map(part => {
      try { return decodeURIComponent(part); } catch { return part; }
    });
  }

  function pageKey(rawUrl) {
    const url = parsedUrl(rawUrl);
    return url ? PAGE_V1 + url.href : null;
  }

  function chapterKey(rawUrl) {
    const url = parsedUrl(rawUrl);
    if (!url) return null;
    const parts = partsOf(url);
    let chapterIndex = -1;
    for (let i = 0; i < parts.length; i++) {
      if (/^(?:chapter|chap|ch|episode|ep)[-_ ]?\d+(?:[._-]\d+)*$/i.test(parts[i]) ||
          /^第\d+(?:[._-]\d+)*[话回章]$/.test(parts[i]) ||
          (/^\d+(?:[._-]\d+)*$/.test(parts[i]) && /^(?:chapter|chap|ch|episode|ep|read)$/i.test(parts[i - 1] || ''))) {
        chapterIndex = i;
        break;
      }
    }
    const params = new URLSearchParams(url.search);
    if (chapterIndex >= 0) parts[chapterIndex] = '{chapter}';
    else {
      for (const name of params.keys()) {
        if (/^(?:chapter|chap|ch|episode|ep)$/i.test(name) && /^\d+(?:[._-]\d+)*$/.test(params.get(name) || '')) {
          params.set(name, '{chapter}');
          break;
        }
      }
      if (![...params.values()].includes('{chapter}')) return null;
    }
    const stable = parts.slice(0, chapterIndex < 0 ? undefined : chapterIndex);
    const hasWork = stable.some(part => !SECTION_NAMES.test(part) && !/^(?:chapter|chap|ch|episode|ep)$/i.test(part)) ||
      [...params.keys()].some(name => /^(?:comic_id|manga_id|series_id|book_id|title_id)$/i.test(name) && params.get(name));
    if (!hasWork) return null;
    for (const name of [...params.keys()]) if (/^(?:utm_.+|fbclid|gclid)$/i.test(name)) params.delete(name);
    return CHAPTER_V1 + url.host.toLowerCase() + '/' + parts.join('/') + (params.size ? `?${params}` : '');
  }

  function isReaderRoute(rawUrl) {
    const url = parsedUrl(rawUrl);
    if (!url) return false;
    const parts = partsOf(url);
    if (parts.some((part, i) => /^(?:chapter|chap|ch|episode|ep)[-_ ]?\d+(?:[._-]\d+)*$/i.test(part) ||
      /^第\d+(?:[._-]\d+)*[话回章]$/.test(part) ||
      (/^\d+(?:[._-]\d+)*$/.test(part) && i > 0 && (SECTION_NAMES.test(parts[i - 1]) || /^(?:chapter|chap|ch|episode|ep)$/i.test(parts[i - 1]))))) return true;
    if ([...url.searchParams].some(([name, value]) => /^(?:chapter|chap|ch|episode|ep)$/i.test(name) && /^\d+(?:[._-]\d+)*$/.test(value))) return true;
    const sectionIndex = parts.findIndex(part => SECTION_NAMES.test(part));
    return sectionIndex >= 0 && parts.length >= sectionIndex + 3 && /^\d+(?:[._-]\d+)*$/.test(parts.at(-1));
  }

  function isSectionContentRoute(rawUrl) {
    const url = parsedUrl(rawUrl);
    if (!url) return false;
    const parts = partsOf(url);
    const sectionIndex = parts.findIndex(part => SECTION_NAMES.test(part));
    return sectionIndex >= 0 && parts.length > sectionIndex + 1;
  }

  function ruleKeys(rawUrl) {
    const url = parsedUrl(rawUrl);
    if (!url) return null;
    const parts = partsOf(url);
    const sectionIndex = parts.findIndex(part => SECTION_NAMES.test(part));
    const host = url.host.toLowerCase();
    const routePath = '/' + parts.join('/');
    return {
      host: SCOPE_V2 + host,
      section: sectionIndex < 0 ? null : SCOPE_V2 + host + '/' + parts.slice(0, sectionIndex + 1).join('/'),
      route: ROUTE_V2 + host + routePath,
      legacyPage: pageKey(rawUrl),
      legacyChapter: chapterKey(rawUrl)
    };
  }

  function preferredRule(rawUrl, value) {
    const keys = ruleKeys(rawUrl);
    if (!keys) return null;
    const path = partsOf(parsedUrl(rawUrl));
    // 首页、目录和作品封面页的误判仅关闭该路径，不屏蔽其章节。
    if (value === 'block' && (path.length === 0 || (keys.section && !isReaderRoute(rawUrl)))) {
      return { key: keys.route, scope: 'route' };
    }
    return keys.section ? { key: keys.section, scope: 'section' } : { key: keys.host, scope: 'host' };
  }

  function resolveOverride(data, rawUrl) {
    const keys = ruleKeys(rawUrl);
    if (!keys) return null;
    const checks = [
      ['route', keys.route], ['legacyPage', keys.legacyPage],
      ['legacyChapter', keys.legacyChapter], ['section', keys.section], ['host', keys.host]
    ];
    // 黑名单的任何命中都优先于豁免名单；同类型时更具体的路径优先。
    for (const value of ['block', 'allow']) {
      for (const [scope, key] of checks) {
        if (key && data[key]?.value === value) return { value, scope, key };
      }
    }
    return null;
  }

  // 提取漫画作品身份（域名、原始 Slug、归一化 Slug、网站标识键）
  function extractMangaIdentity(rawUrl) {
    const url = parsedUrl(rawUrl);
    if (!url) return null;
    const host = url.host.toLowerCase();
    const parts = partsOf(url);
    if (!parts.length) return null;

    const sectionIndex = parts.findIndex(part => SECTION_NAMES.test(part));
    let rawSlug = '';
    if (sectionIndex >= 0 && parts.length > sectionIndex + 1) {
      rawSlug = parts[sectionIndex + 1];
    } else {
      rawSlug = parts[0];
    }

    // 归一化：剥离常见后缀 (-raw, -free, -online, -manga, -webtoon, -chapter-xxx 等)
    const cleanSlug = rawSlug
      .replace(/-(?:raw|free|online|manga|webtoon|eng|color)$/i, '')
      .replace(/-(?:chapter|chap|ch|ep|episode)[-_ ]?\d+.*$/i, '')
      .trim();

    return {
      host,
      rawSlug,
      normalizedSlug: cleanSlug || rawSlug,
      siteKey: `${host}/${cleanSlug || rawSlug}`
    };
  }

  globalThis.ComicPageShared = {
    pageKey, chapterKey, isReaderRoute, isSectionContentRoute, ruleKeys, preferredRule, resolveOverride,
    extractMangaIdentity
  };

  // ==========================================
  // ComicNetBridge: 本地/云端智能双轨网络通道
  // ==========================================
  // 1. 本地 HTTP (http://127.0.0.1:8080)：经由 background.js (Service Worker) 转发，
  //    突破浏览器 HTTPS 页面的 Mixed Content 阻断。
  // 2. 云端 HTTPS (https://...)：直接前端 fetch，保证云端兼容性。
  function isLocalHttpUrl(url) {
    if (!url) return false;
    const lower = String(url).toLowerCase();
    return lower.startsWith('http://127.0.0.1') ||
           lower.startsWith('http://localhost') ||
           (lower.startsWith('http://') && !lower.startsWith('https://'));
  }

  async function fetchHealth(apiUrl) {
    const targetUrl = `${apiUrl.replace(/\/+$/, '')}/health`;
    if (isLocalHttpUrl(targetUrl) && globalThis.chrome?.runtime?.sendMessage) {
      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          action: 'OCR_FETCH',
          url: targetUrl,
          method: 'GET'
        }, response => {
          if (chrome.runtime.lastError) {
            return reject(new Error(chrome.runtime.lastError.message));
          }
          if (!response || !response.ok) {
            return reject(new Error(response?.error || `HTTP ${response?.status || 0}`));
          }
          resolve(response.data || {});
        });
      });
    }

    // 默认前端直接 fetch (云端 HTTPS)
    const res = await fetch(targetUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json().catch(() => ({}));
  }

  async function postCoordinates(apiUrl, jsonBody, signal) {
    const targetUrl = `${apiUrl.replace(/\/+$/, '')}/coordinates`;
    if (isLocalHttpUrl(targetUrl) && globalThis.chrome?.runtime?.sendMessage) {
      return new Promise((resolve, reject) => {
        let timer = null;
        let onAbort = null;
        let settled = false;

        const cleanup = () => {
          if (timer) clearTimeout(timer);
          if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        };

        if (signal?.aborted) {
          const err = new Error('Aborted');
          err.name = 'AbortError';
          return reject(err);
        }

        if (signal) {
          onAbort = () => {
            if (settled) return;
            settled = true;
            cleanup();
            const err = new Error('Aborted');
            err.name = 'AbortError';
            reject(err);
          };
          signal.addEventListener('abort', onAbort, { once: true });
        }

        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          const err = new Error('Coordinates request timed out (15s)');
          err.name = 'TimeoutError';
          reject(err);
        }, 15000);

        chrome.runtime.sendMessage({
          action: 'OCR_FETCH',
          url: targetUrl,
          method: 'POST',
          jsonBody
        }, response => {
          if (settled) return;
          settled = true;
          cleanup();
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!response || !response.ok) return reject(new Error(response?.error || `HTTP ${response?.status}`));
          resolve(response.data || {});
        });
      });
    }
    const response = await fetch(targetUrl, {
      method: "POST", signal,
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(jsonBody)
    });
    return await response.json().catch(() => ({}));
  }

  async function postSlice(apiUrl, { sliceBlob, sliceName, cutIndex, chapterId, coordinateId, sliceIndex, startY, endY, width, height, sourcePages, cutMethod, batchIndex, isFinalBatch, lang, detThresh, detBoxThresh, recScore, signal }) {
    const targetUrl = `${apiUrl.replace(/\/+$/, '')}/slice`;

    if (isLocalHttpUrl(targetUrl) && globalThis.chrome?.runtime?.sendMessage) {
      // 提取 Blob 为 Base64 字符串（彻底避免移动端 Chromium 在 sendMessage 序列化 ArrayBuffer 时丢失数据）
      const base64Data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(sliceBlob);
      });

      return new Promise((resolve, reject) => {
        let timer = null;
        let onAbort = null;
        let settled = false;

        const cleanup = () => {
          if (timer) clearTimeout(timer);
          if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        };

        if (signal?.aborted) {
          const err = new Error('Aborted');
          err.name = 'AbortError';
          return reject(err);
        }

        if (signal) {
          onAbort = () => {
            if (settled) return;
            settled = true;
            cleanup();
            const err = new Error('Aborted');
            err.name = 'AbortError';
            reject(err);
          };
          signal.addEventListener('abort', onAbort, { once: true });
        }

        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          const err = new Error('OCR slice request timed out (18s)');
          err.name = 'TimeoutError';
          reject(err);
        }, 18000);

        chrome.runtime.sendMessage({
          action: 'OCR_FETCH',
          url: targetUrl,
          method: 'POST',
          isFormData: true,
          fields: {
            slice_name: String(sliceName),
            cut_index: String(cutIndex),
            chapter_id: String(chapterId || ''),
            coordinate_id: String(coordinateId || ''),
            slice_index: String(sliceIndex),
            start_y: String(startY),
            end_y: String(endY),
            width: String(width),
            height: String(height),
            source_pages: JSON.stringify(sourcePages || []),
            cut_method: String(cutMethod || ''),
            batch_index: String(batchIndex),
            is_final_batch: String(Boolean(isFinalBatch)),
            lang: String(lang || 'kr'),
            det_thresh: String(detThresh || '0.30'),
            det_box_thresh: String(detBoxThresh || '0.50'),
            box_thresh: String(detBoxThresh || '0.50'),
            rec_score: String(recScore || '0.60'),
            rec_thresh: String(recScore || '0.60')
          },
          file: {
            name: `${sliceName}.jpg`,
            type: sliceBlob.type || 'image/jpeg',
            base64: base64Data
          }
        }, response => {
          if (settled) return;
          settled = true;
          cleanup();
          if (chrome.runtime.lastError) {
            return reject(new Error(chrome.runtime.lastError.message));
          }
          if (!response || !response.ok) {
            const err = new Error(response?.error || `HTTP ${response?.status || 0}`);
            err.status = response?.status || 0;
            err.detail = response?.data?.detail || response?.error;
            return reject(err);
          }
          resolve(response.data || {});
        });
      });
    }

    // 云端 HTTPS: 原生 FormData 前端直连
    const form = new FormData();
    form.append("file", sliceBlob, `${sliceName}.jpg`);
    form.append("slice_name", sliceName);
    form.append("cut_index", String(cutIndex));
    form.append("chapter_id", chapterId);
    form.append("coordinate_id", coordinateId);
    form.append("slice_index", String(sliceIndex));
    form.append("start_y", String(startY));
    form.append("end_y", String(endY));
    form.append("width", String(width));
    form.append("height", String(height));
    form.append("source_pages", JSON.stringify(sourcePages));
    form.append("cut_method", cutMethod);
    form.append("batch_index", String(batchIndex));
    form.append("is_final_batch", String(Boolean(isFinalBatch)));
    form.append("lang", lang);
    form.append("det_thresh", detThresh);
    form.append("det_box_thresh", detBoxThresh);
    form.append("box_thresh", detBoxThresh);
    form.append("rec_score", recScore);
    form.append("rec_thresh", recScore);

    const response = await fetch(targetUrl, { method: "POST", body: form, signal });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error(result.detail || `Slice upload failed: HTTP ${response.status}`);
      err.status = response.status;
      err.detail = result.detail;
      throw err;
    }
    return result;
  }

  globalThis.ComicNetBridge = {
    isLocalHttpUrl,
    fetchHealth,
    postCoordinates,
    postSlice
  };
})();
