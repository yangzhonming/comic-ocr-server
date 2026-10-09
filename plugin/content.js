(() => {
  // 网页侧协调器：名单优先级、自动判定、阅读区定位、动态页面监听和 Popup 消息。
  if (window.top !== window || window.__comicPageDetectorV1) return;
  window.__comicPageDetectorV1 = true;

  const autoClearVal = typeof localStorage !== 'undefined' ? localStorage?.getItem?.('comic_dev_auto_clear_cache') : null;
  const autoClearEnabled = autoClearVal !== '0' && autoClearVal !== 'false';
  if (autoClearEnabled) {
    try {
      if (typeof sessionStorage !== 'undefined') sessionStorage.clear();
      if ('caches' in window) {
        caches.keys().then(names => Promise.all(names.map(name => caches.delete(name)))).catch(() => {});
      }
      console.log('[ComicCapture] 🧪 测试模式已启用（默认开启）：刷新时已自动清空浏览器与网站缓存');
    } catch {}
  }

  const { pageKey, isReaderRoute, isSectionContentRoute } = globalThis.ComicPageShared;
  const RuleStore = globalThis.ComicRuleStore;
  const { detect } = globalThis.ComicPageClassifier;
  const ImageCapture = globalThis.ComicImageCapture;
  const FloatingBall = globalThis.ComicFloatingBall;
  let key = null;
  let override = null;
  let state = { kind: 'pending', reason: '正在检查页面', imageCount: 0 };
  let timer = null;
  let revision = 0;
  let confirmedReader = null;

  function evaluate() {
    timer = null;
    if (!key || state.kind === 'loading') return;
    if (override?.value === 'block') {
      state = { kind: 'blocked', reason: '当前页面命中黑名单', imageCount: 0 };
      confirmedReader = null;
      ImageCapture.setReader(null);
      FloatingBall.update(null);
    } else {
      const automatic = detect();
      // DOM 节点仅留在网页进程；发往 Popup 的 state 必须可序列化。
      const { reader, fallbackReader, ...publicEvidence } = automatic;
      const fallbackApplies = override?.value === 'allow' &&
        ((isReaderRoute(location.href) && automatic.fallbackEligible) ||
         (isSectionContentRoute(location.href) && automatic.fallbackStrong));
      let selectedReader = null;
      if (automatic.kind === 'yes' && reader) {
        state = publicEvidence;
        selectedReader = reader;
        confirmedReader = reader;
      } else if (fallbackApplies && fallbackReader) {
        state = { kind: 'yes', reason: '漫画栏目路径及图片证据命中豁免规则', imageCount: automatic.imageCount };
        selectedReader = fallbackReader;
        confirmedReader = fallbackReader;
      } else if (confirmedReader?.root?.isConnected) {
        // 滚动或懒加载期间即使判定短暂处于 pending，也不丢弃已确认有效的阅读容器
        selectedReader = confirmedReader;
        state = { ...publicEvidence, kind: 'yes', reason: '已锁定漫画阅读区 (持续追踪中)' };
      } else {
        state = automatic.kind === 'yes'
          ? { kind: 'pending', reason: '阅读区首图尚无法定位', imageCount: automatic.imageCount }
          : publicEvidence;
        confirmedReader = null;
      }
      ImageCapture.setReader(selectedReader);
      FloatingBall.update(selectedReader);
    }
  }

  function schedule(delay = 250) {
    clearTimeout(timer);
    timer = setTimeout(evaluate, delay);
  }

  async function reloadOverride() {
    const currentKey = key;
    const currentRevision = ++revision;
    if (!currentKey) return;
    const savedRule = await RuleStore.read(location.href);
    if (currentRevision !== revision || currentKey !== key) return;
    override = savedRule;
    state = { kind: 'pending', reason: '正在检查页面', imageCount: 0 };
    evaluate();
  }

  async function refreshPage() {
    const nextKey = pageKey(location.href);
    if (nextKey === key && state.kind !== 'loading') return;
    key = nextKey;
    override = null;
    confirmedReader = null;
    state = { kind: 'loading', reason: '读取当前 URL 的名单设置', imageCount: 0 };
    FloatingBall.update(null);
    if (!key) return;
    const requestedKey = key;
    try {
      await reloadOverride();
    } catch {
      if (key === requestedKey) state = { kind: 'error', reason: '无法读取本地名单', imageCount: 0 };
    }
  }

  // Popup 只通过这两个消息读状态或要求重新读取名单，不直接访问识别器。
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message?.type === 'comic-page-status') {
      void refreshPage().then(() => reply({ ...state, url: location.href, override }))
        .catch(() => reply({ kind: 'error', reason: '无法读取页面状态', url: location.href, override }));
      return true;
    }
    if (message?.type !== 'comic-page-refresh') return;
    void (async () => {
      const previousKey = key;
      await refreshPage();
      if (key === previousKey) await reloadOverride();
      reply({ ...state, url: location.href, override });
    })().catch(() => reply({ kind: 'error', reason: '无法刷新当前页面状态', url: location.href, override }));
    return true;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (!key || !RuleStore.touches(location.href, changes, area)) return;
    void reloadOverride().catch(() => {
      state = { kind: 'error', reason: '无法读取本地名单', imageCount: 0 };
    });
  });

  // 单一全局监听器：统一接管全站 DOM 变动与阅读容器切片推动
  new MutationObserver(records => {
    // 阶段一：尚未锁定漫画容器（或已失效）-> 跑全量规则，探测首图与多图大盒子
    if (!confirmedReader?.root?.isConnected) {
      let hasImageMutation = false;
      for (const record of records) {
        if (record.type === 'attributes') {
          if (record.target instanceof HTMLImageElement) {
            hasImageMutation = true;
            break;
          }
        } else if (record.type === 'childList') {
          for (const node of record.addedNodes) {
            if (node instanceof HTMLImageElement || (node.querySelector && node.querySelector('img'))) {
              hasImageMutation = true;
              break;
            }
          }
          if (hasImageMutation) break;
        }
      }
      if (hasImageMutation) {
        schedule(100);
      }
      return;
    }

    // 阶段二：已锁定漫画容器 -> 走极速捷径
    // 只要判断变动的图片是否位于 confirmedReader.root 内部：
    // 若在外部（如弹窗广告、评论区、Logo、侧边栏），直接忽略！零开销跳过！
    for (const record of records) {
      if (record.type === 'childList') {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLImageElement) {
            if (confirmedReader.root.contains(node)) {
              ImageCapture.handleDomChange?.(node);
            }
          } else if (node.querySelectorAll) {
            if (confirmedReader.root.contains(node)) {
              ImageCapture.handleDomChange?.(node);
            } else if (node.contains(confirmedReader.root)) {
              for (const img of node.querySelectorAll('img')) {
                if (confirmedReader.root.contains(img)) {
                  ImageCapture.handleDomChange?.(img);
                }
              }
            }
          }
        }
      } else if (record.type === 'attributes') {
        const target = record.target;
        if (target instanceof HTMLImageElement && confirmedReader.root.contains(target)) {
          ImageCapture.handleDomChange?.(target);
        }
      }
    }
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true
  });

  document.addEventListener('load', event => {
    if (event.target instanceof HTMLImageElement) {
      if (!confirmedReader?.root?.isConnected) {
        schedule(100);
      } else if (confirmedReader.root.contains(event.target)) {
        ImageCapture.handleDomChange?.(event.target);
      }
    }
  }, true);

  window.addEventListener('resize', () => schedule(150), { passive: true });
  window.addEventListener('popstate', () => void refreshPage());
  window.addEventListener('hashchange', () => { void refreshPage(); schedule(0); });
  setInterval(() => void refreshPage(), 1000);
  void refreshPage();
})();
