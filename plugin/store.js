(() => {
  const { ruleKeys, preferredRule, resolveOverride, extractMangaIdentity } = globalThis.ComicPageShared || {};

  // ==========================================
  // 1. ComicRuleStore: 页面/章节黑白名单
  // ==========================================
  function keysFor(url) {
    if (!ruleKeys) return [];
    return Object.values(ruleKeys(url) || {}).filter(Boolean);
  }

  async function read(url) {
    const keys = keysFor(url);
    if (!keys.length) return null;
    const records = await (globalThis.chrome?.storage?.local?.get(keys) || Promise.resolve({}));
    return resolveOverride ? resolveOverride(records, url) : null;
  }

  async function write(url, value) {
    if (value !== 'block' && value !== 'allow') throw new Error('无效的名单类型');
    const rule = preferredRule ? preferredRule(url, value) : null;
    if (!rule) throw new Error('当前页面无法保存规则');
    await (globalThis.chrome?.storage?.local?.set({ [rule.key]: { value, savedAt: Date.now() } }) || Promise.resolve());
    return { ...rule, value };
  }

  async function remove(rule) {
    if (!rule?.key || !['block', 'allow'].includes(rule.value)) throw new Error('无效的名单规则');
    await (globalThis.chrome?.storage?.local?.remove(rule.key) || Promise.resolve());
  }

  function touches(url, changes, area) {
    return area === 'local' && keysFor(url).some(key => Object.hasOwn(changes, key));
  }

  globalThis.ComicRuleStore = Object.freeze({ read, write, remove, touches });

  // ==========================================
  // 2. ComicConfigStore: 全局持久化配置、语料库与黑名单
  // ==========================================
  const STORAGE_KEY_CONFIG = 'comic_app_global_config:v1';
  const STORAGE_KEY_ANCHORS = 'comic_site_anchors:v1';
  const STORAGE_KEY_PROFILES = 'comic_manga_profiles:v1';
  const STORAGE_KEY_BLACKLIST = 'comic_global_watermark_blacklist:v1';

  const DEFAULT_PROVIDERS = [
    {
      id: 'p_deepseek',
      name: 'DeepSeek 官方',
      url: 'https://api.deepseek.com/v1',
      key: '',
      models: ['deepseek-chat', 'deepseek-flash', 'deepseek-reasoner']
    },
    {
      id: 'p_siliconflow',
      name: '硅基流动',
      url: 'https://api.siliconflow.cn/v1',
      key: '',
      models: ['Qwen/Qwen2.5-72B-Instruct', 'deepseek-ai/DeepSeek-V3']
    }
  ];

  const DEFAULT_BLACKLIST = [
    "TempleScanEsp.Not",
    "TOONGOD.ORG",
    "READ MANHWA ONLINE FOR FREE"
  ];

  // 内存快速同步缓存（初始值）
  let inMemoryState = {
    providers: DEFAULT_PROVIDERS,
    activeProviderId: 'p_deepseek',
    activeModel: 'deepseek-flash',
    cloudApiUrl: 'https://comic-ocr.your-domain.com',
    localApiUrl: 'http://127.0.0.1:8080',
    useLocalBackend: true,
    ocrLang: 'kr',
    minFontSize: 13,
    globalOcrConfig: { mode: 'sensitive', recThresh: 0.50, boxThresh: 0.45, allowTextured: true },
    ocrComicConfigs: {},
    anchors: {},
    profiles: {},
    blacklist: [...DEFAULT_BLACKLIST],
    isLoaded: false
  };

  // 尝试从旧版 localStorage 迁移遗留配置
  function migrateFromLocalStorage() {
    if (typeof localStorage === 'undefined') return {};
    const migrated = {};
    try {
      const p = localStorage.getItem('comic_llm_providers');
      if (p) migrated.providers = JSON.parse(p);
      const ap = localStorage.getItem('comic_active_provider_id');
      if (ap) migrated.activeProviderId = ap;
      const am = localStorage.getItem('comic_active_model');
      if (am) migrated.activeModel = am;
      const cu = localStorage.getItem('comic_cloud_api_url');
      if (cu) migrated.cloudApiUrl = cu;
      const lb = localStorage.getItem('comic_dev_enable_capture');
      if (lb !== null) migrated.useLocalBackend = lb === '1';
      const lang = localStorage.getItem('comic_ocr_lang');
      if (lang) migrated.ocrLang = lang;
      const mfs = localStorage.getItem('comic_min_font_size');
      if (mfs) migrated.minFontSize = parseInt(mfs, 10);
      const draft = localStorage.getItem('comic_corpus_draft');
      if (draft && draft.trim()) {
        migrated.legacyDraft = draft.trim();
      }
      const pb = localStorage.getItem(STORAGE_KEY_PROFILES);
      if (pb) {
        try { migrated.profiles = JSON.parse(pb); } catch {}
      }
      const ab = localStorage.getItem(STORAGE_KEY_ANCHORS);
      if (ab) {
        try { migrated.anchors = JSON.parse(ab); } catch {}
      }
    } catch {}
    return migrated;
  }

  // 异步初始化加载
  async function init() {
    if (inMemoryState.isLoaded) return inMemoryState;

    let storageData = {};
    if (globalThis.chrome?.storage?.local) {
      try {
        storageData = await chrome.storage.local.get([
          STORAGE_KEY_CONFIG,
          STORAGE_KEY_ANCHORS,
          STORAGE_KEY_PROFILES,
          STORAGE_KEY_BLACKLIST
        ]);
      } catch {}
    }

    const cfg = storageData[STORAGE_KEY_CONFIG] || {};
    const anchors = storageData[STORAGE_KEY_ANCHORS] || {};
    const profiles = storageData[STORAGE_KEY_PROFILES] || {};
    const bl = storageData[STORAGE_KEY_BLACKLIST] || null;

    // 若 storage 为空，检测是否需要从 localStorage 平滑迁移
    const legacy = migrateFromLocalStorage();

    inMemoryState.providers = (cfg.providers && cfg.providers.length) ? cfg.providers : (legacy.providers || DEFAULT_PROVIDERS);
    inMemoryState.activeProviderId = cfg.activeProviderId || legacy.activeProviderId || 'p_deepseek';
    inMemoryState.activeModel = cfg.activeModel || legacy.activeModel || 'deepseek-flash';
    inMemoryState.cloudApiUrl = cfg.cloudApiUrl || legacy.cloudApiUrl || 'https://comic-ocr.your-domain.com';
    inMemoryState.localApiUrl = cfg.localApiUrl || legacy.localApiUrl || 'http://127.0.0.1:8080';
    inMemoryState.useLocalBackend = cfg.useLocalBackend ?? legacy.useLocalBackend ?? true;
    inMemoryState.ocrLang = cfg.ocrLang || legacy.ocrLang || 'kr';
    inMemoryState.minFontSize = cfg.minFontSize ?? legacy.minFontSize ?? 13;
    inMemoryState.globalOcrConfig = cfg.globalOcrConfig || { mode: 'sensitive', recThresh: 0.50, boxThresh: 0.45, allowTextured: true };
    inMemoryState.ocrComicConfigs = cfg.ocrComicConfigs || {};

    inMemoryState.anchors = (anchors && Object.keys(anchors).length > 0) ? { ...anchors } : (legacy.anchors || {});
    inMemoryState.profiles = (profiles && Object.keys(profiles).length > 0) ? { ...profiles } : (legacy.profiles || {});
    inMemoryState.blacklist = Array.isArray(bl) ? bl : [...DEFAULT_BLACKLIST];
    inMemoryState.isLoaded = true;

    // 如果发生了迁移且支持 chrome.storage，回写同步
    if (globalThis.chrome?.storage?.local && Object.keys(legacy).length > 0 && !storageData[STORAGE_KEY_CONFIG]) {
      await saveConfigState();
    }

    return inMemoryState;
  }

  async function saveConfigState() {
    if (globalThis.chrome?.storage?.local) {
      try {
        await chrome.storage.local.set({
          [STORAGE_KEY_CONFIG]: {
            providers: inMemoryState.providers,
            activeProviderId: inMemoryState.activeProviderId,
            activeModel: inMemoryState.activeModel,
            cloudApiUrl: inMemoryState.cloudApiUrl,
            localApiUrl: inMemoryState.localApiUrl,
            useLocalBackend: inMemoryState.useLocalBackend,
            ocrLang: inMemoryState.ocrLang,
            minFontSize: inMemoryState.minFontSize,
            globalOcrConfig: inMemoryState.globalOcrConfig,
            ocrComicConfigs: inMemoryState.ocrComicConfigs
          },
          [STORAGE_KEY_ANCHORS]: inMemoryState.anchors,
          [STORAGE_KEY_PROFILES]: inMemoryState.profiles,
          [STORAGE_KEY_BLACKLIST]: inMemoryState.blacklist
        });
      } catch (e) {
        console.warn('[ComicConfigStore] 写入 storage 异常:', e);
      }
    }

    // 移动端/多环境双重持久化兜底 (Dual localStorage Backup)
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_KEY_PROFILES, JSON.stringify(inMemoryState.profiles));
        localStorage.setItem(STORAGE_KEY_ANCHORS, JSON.stringify(inMemoryState.anchors));
      } catch {}
    }
  }

  // 监听多标签页或外部修改变更，保持内存同步
  if (globalThis.chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[STORAGE_KEY_CONFIG]) {
        const nv = changes[STORAGE_KEY_CONFIG].newValue || {};
        if (nv.providers) inMemoryState.providers = nv.providers;
        if (nv.activeProviderId) inMemoryState.activeProviderId = nv.activeProviderId;
        if (nv.activeModel) inMemoryState.activeModel = nv.activeModel;
        if (nv.cloudApiUrl !== undefined) inMemoryState.cloudApiUrl = nv.cloudApiUrl;
        if (nv.useLocalBackend !== undefined) inMemoryState.useLocalBackend = nv.useLocalBackend;
        if (nv.ocrLang) inMemoryState.ocrLang = nv.ocrLang;
        if (nv.minFontSize) inMemoryState.minFontSize = nv.minFontSize;
      }
      if (changes[STORAGE_KEY_ANCHORS]) {
        inMemoryState.anchors = changes[STORAGE_KEY_ANCHORS].newValue || {};
      }
      if (changes[STORAGE_KEY_PROFILES]) {
        inMemoryState.profiles = changes[STORAGE_KEY_PROFILES].newValue || {};
      }
      if (changes[STORAGE_KEY_BLACKLIST]) {
        inMemoryState.blacklist = changes[STORAGE_KEY_BLACKLIST].newValue || [...DEFAULT_BLACKLIST];
      }
    });
  }

  // 立即触发一次异步初始化
  init().catch(() => {});

  // ==========================================
  // 对外暴露的高级 API
  // ==========================================
  globalThis.ComicConfigStore = Object.freeze({
    init,

    // 同步读取当前内存状态
    getSync: () => ({ ...inMemoryState }),

    // 厂商与模型
    getProviders: () => inMemoryState.providers,
    saveProviders: async (list) => {
      inMemoryState.providers = list;
      await saveConfigState();
    },

    getActiveProviderId: () => inMemoryState.activeProviderId,
    setActiveProviderId: async (id) => {
      inMemoryState.activeProviderId = id;
      await saveConfigState();
    },

    getActiveModel: () => inMemoryState.activeModel,
    setActiveModel: async (model) => {
      inMemoryState.activeModel = model;
      await saveConfigState();
    },

    getActiveProvider: () => {
      const list = inMemoryState.providers;
      return list.find(p => p.id === inMemoryState.activeProviderId) || list[0] || null;
    },

    // 字号下限 (10px ~ 24px)
    getMinFontSize: () => inMemoryState.minFontSize || 13,
    setMinFontSize: async (size) => {
      const parsed = Math.max(10, Math.min(24, parseInt(size, 10) || 13));
      inMemoryState.minFontSize = parsed;
      try {
        localStorage.setItem('comic_min_font_size', String(parsed));
      } catch {}
      await saveConfigState();
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('comic-min-font-size-changed', { detail: { minFontSize: parsed } }));
      }
      return parsed;
    },

    // OCR 相关
    getLocalApiUrl: () => inMemoryState.localApiUrl || 'http://127.0.0.1:8080',
    setLocalApiUrl: async (url) => {
      inMemoryState.localApiUrl = (url || '').trim() || 'http://127.0.0.1:8080';
      await saveConfigState();
    },

    getCloudApiUrl: () => inMemoryState.cloudApiUrl,
    setCloudApiUrl: async (url) => {
      inMemoryState.cloudApiUrl = (url || '').trim();
      await saveConfigState();
    },

    getUseLocalBackend: () => inMemoryState.useLocalBackend,
    setUseLocalBackend: async (isLocal) => {
      inMemoryState.useLocalBackend = !!isLocal;
      await saveConfigState();
    },

    getOcrLang: () => inMemoryState.ocrLang,
    setOcrLang: async (lang) => {
      inMemoryState.ocrLang = lang;
      await saveConfigState();
    },

    getOcrSensitivity: (rawUrl) => {
      const idInfo = extractMangaIdentity ? extractMangaIdentity(rawUrl || globalThis.location?.href) : null;
      const siteKey = idInfo?.siteKey || '';
      if (siteKey && inMemoryState.ocrComicConfigs && inMemoryState.ocrComicConfigs[siteKey]) {
        return { ...inMemoryState.ocrComicConfigs[siteKey], isBound: true };
      }
      return { ...(inMemoryState.globalOcrConfig || { mode: 'sensitive', recThresh: 0.50, boxThresh: 0.45 }), isBound: false };
    },

    saveOcrSensitivity: async (rawUrl, config, rememberForComic = true) => {
      const cfg = {
        mode: config.mode || 'sensitive',
        recThresh: typeof config.recThresh === 'number' ? config.recThresh : parseFloat(config.recThresh) || 0.50,
        boxThresh: typeof config.boxThresh === 'number' ? config.boxThresh : parseFloat(config.boxThresh) || 0.45,
        allowTextured: config.allowTextured !== false
      };
      inMemoryState.globalOcrConfig = { ...cfg };
      if (rememberForComic) {
        const idInfo = extractMangaIdentity ? extractMangaIdentity(rawUrl || globalThis.location?.href) : null;
        const siteKey = idInfo?.siteKey || '';
        if (siteKey) {
          if (!inMemoryState.ocrComicConfigs) inMemoryState.ocrComicConfigs = {};
          inMemoryState.ocrComicConfigs[siteKey] = { ...cfg };
        }
      }
      await saveConfigState();
      return cfg;
    },

    // 水印黑名单 (全网通用)
    getGlobalBlacklist: () => [...inMemoryState.blacklist],
    addToGlobalBlacklist: async (ruleText) => {
      const t = (ruleText || '').trim();
      if (!t || inMemoryState.blacklist.includes(t)) return;
      inMemoryState.blacklist.push(t);
      await saveConfigState();
    },
    removeFromGlobalBlacklist: async (target) => {
      if (typeof target === 'number') {
        if (target >= 0 && target < inMemoryState.blacklist.length) {
          inMemoryState.blacklist.splice(target, 1);
          await saveConfigState();
        }
      } else {
        const t = (target || '').trim();
        const idx = inMemoryState.blacklist.indexOf(t);
        if (idx !== -1) {
          inMemoryState.blacklist.splice(idx, 1);
          await saveConfigState();
        }
      }
    },

    // 漫画档案与锚定
    getCurrentProfile: (rawUrl) => {
      const idInfo = extractMangaIdentity ? extractMangaIdentity(rawUrl || globalThis.location?.href) : null;
      const siteKey = idInfo?.siteKey || '';
      const fallbackName = idInfo?.normalizedSlug || '未命名漫画';

      // 1. 查锚定映射表
      const boundName = inMemoryState.anchors[siteKey];
      const activeName = boundName || fallbackName;
      const profile = inMemoryState.profiles[activeName] || { worldview: '', referenceTerms: [] };

      return {
        profileName: activeName,
        isBound: !!boundName,
        siteKey,
        worldview: profile.worldview || '',
        referenceTerms: Array.isArray(profile.referenceTerms) ? [...profile.referenceTerms] : []
      };
    },

    saveProfile: async (profileName, data) => {
      const name = (profileName || '').trim();
      if (!name) return;
      inMemoryState.profiles[name] = {
        worldview: (data.worldview || '').trim(),
        referenceTerms: Array.isArray(data.referenceTerms) ? [...new Set(data.referenceTerms.map(s => String(s).trim()).filter(Boolean))] : []
      };
      await saveConfigState();
    },

    bindSiteToProfile: async (siteKeyOrUrl, profileName) => {
      let sKey = (siteKeyOrUrl || '').trim();
      const pName = (profileName || '').trim();
      if (!sKey || !pName) return;
      if (sKey.includes('://') && extractMangaIdentity) {
        const idInfo = extractMangaIdentity(sKey);
        if (idInfo?.siteKey) sKey = idInfo.siteKey;
      }
      inMemoryState.anchors[sKey] = pName;
      if (!inMemoryState.profiles[pName]) {
        inMemoryState.profiles[pName] = { worldview: '', referenceTerms: [] };
      }
      await saveConfigState();
    },

    addTermToProfile: async (profileName, term) => {
      const name = (profileName || '').trim();
      const t = (term || '').trim();
      if (!name || !t) return;
      if (!inMemoryState.profiles[name]) {
        inMemoryState.profiles[name] = { worldview: '', referenceTerms: [] };
      }
      const p = inMemoryState.profiles[name];
      if (!p.referenceTerms.includes(t)) {
        p.referenceTerms.push(t);
        await saveConfigState();
      }
    },

    removeTermFromProfile: async (profileName, term) => {
      const name = (profileName || '').trim();
      const t = (term || '').trim();
      if (!name || !t || !inMemoryState.profiles[name]) return;
      const p = inMemoryState.profiles[name];
      const idx = p.referenceTerms.indexOf(t);
      if (idx !== -1) {
        p.referenceTerms.splice(idx, 1);
        await saveConfigState();
      }
    },

    getAllProfileNames: () => Object.keys(inMemoryState.profiles)
  });
})();
