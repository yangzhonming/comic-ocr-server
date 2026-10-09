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

  globalThis.ComicPageShared = { pageKey, chapterKey, isReaderRoute, isSectionContentRoute, ruleKeys, preferredRule, resolveOverride };
})();
