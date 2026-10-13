(() => {
  // 漫画阅读器控制核心 (移动端与桌面端双适配)
  // 包含：左上角悬浮球、老版195px经典菜单、通用自适应配置Modal弹窗、错误捕获与Dev HUD联动
  const SIZE = 48;
  const INSET = 10;
  const SAFE_TOP = 16;
  let host = null;
  let shadow = null;
  let button = null;
  let menu = null;
  let modalOverlay = null;
  let btnIconDisplay = null;
  let reader = null;
  let captureStatus = { running: false, stopping: false, previewEnabled: false, statusText: '准备就绪', count: 0, completed: 0 };
  let frame = 0;
  let resizeObserver = null;
  let hasFirstTranslation = false;

  // ========================================================
  // 1. 错误捕获追踪器 (全局可用)
  // ========================================================
  const ErrorTracker = {
    record(err) {
      const errors = this.list();
      errors.unshift({
        id: 'err_' + Date.now(),
        time: new Date().toLocaleTimeString(),
        type: err.type || '切片异常',
        sliceTag: err.sliceTag || '全局',
        detail: String(err.detail || err.message || JSON.stringify(err))
      });
      if (errors.length > 30) errors.pop();
      try {
        localStorage.setItem('comic_recent_errors', JSON.stringify(errors));
      } catch {}
      renderErrorsTab();
      updateErrorBadge();
    },
    list() {
      try {
        const val = localStorage.getItem('comic_recent_errors');
        return val ? JSON.parse(val) : [];
      } catch {
        return [];
      }
    },
    clear() {
      try { localStorage.removeItem('comic_recent_errors'); } catch {}
      renderErrorsTab();
      updateErrorBadge();
    }
  };
  globalThis.ComicErrorTracker = ErrorTracker;

  // ========================================================
  // 2. 配置与状态管理 (LLM 厂商、语种、模型)
  // ========================================================
  const DEFAULT_PROVIDERS = [
    {
      id: 'p_deepseek',
      name: 'DeepSeek 官方',
      url: 'https://api.deepseek.com/v1',
      key: '',
      models: ['deepseek-chat', 'deepseek-coder']
    },
    {
      id: 'p_siliconflow',
      name: '硅基流动',
      url: 'https://api.siliconflow.cn/v1',
      key: '',
      models: ['Qwen/Qwen2.5-72B-Instruct', 'deepseek-ai/DeepSeek-V3']
    }
  ];

  function getStoredProviders() {
    if (globalThis.ComicConfigStore) {
      return globalThis.ComicConfigStore.getProviders();
    }
    try {
      const val = localStorage.getItem('comic_llm_providers');
      if (val) {
        const list = JSON.parse(val);
        if (Array.isArray(list) && list.length > 0) return list;
      }
    } catch {}
    return DEFAULT_PROVIDERS;
  }

  function saveStoredProviders(providers) {
    if (globalThis.ComicConfigStore) {
      globalThis.ComicConfigStore.saveProviders(providers);
    }
    try {
      localStorage.setItem('comic_llm_providers', JSON.stringify(providers));
    } catch {}
  }

  function getActiveProviderId() {
    if (globalThis.ComicConfigStore) {
      return globalThis.ComicConfigStore.getActiveProviderId();
    }
    try {
      const id = localStorage.getItem('comic_active_provider_id');
      if (id) return id;
    } catch {}
    return getStoredProviders()[0]?.id || 'p_deepseek';
  }

  function setActiveProviderId(id) {
    if (globalThis.ComicConfigStore) {
      globalThis.ComicConfigStore.setActiveProviderId(id);
    }
    try { localStorage.setItem('comic_active_provider_id', id); } catch {}
  }

  function getActiveModel() {
    if (globalThis.ComicConfigStore) {
      return globalThis.ComicConfigStore.getActiveModel();
    }
    try {
      const val = localStorage.getItem('comic_active_model');
      if (val) return val;
    } catch {}
    return 'none'; // 默认：none (纯看原文学习模式)
  }

  function getActiveProvider() {
    const list = getStoredProviders();
    const id = getActiveProviderId();
    return list.find(p => p.id === id) || list[0] || null;
  }

  function setActiveModel(model) {
    if (globalThis.ComicConfigStore) {
      globalThis.ComicConfigStore.setActiveModel(model);
    }
    try { localStorage.setItem('comic_active_model', model); } catch {}
    try {
      window.dispatchEvent(new CustomEvent('comic-model-changed', { detail: { model } }));
    } catch {}
  }

  let inMemoryLang = 'kr';

  function normalizeLang(lang) {
    if (!lang) return 'kr';
    const l = String(lang).toLowerCase().trim();
    if (l === 'jp' || l === 'ja' || l === 'japanese' || l === '日文' || l === '日语') return 'ja';
    if (l === 'kr' || l === 'ko' || l === 'korean' || l === '韩文' || l === '韩语') return 'kr';
    if (l === 'en' || l === 'english' || l === '英文' || l === '英语') return 'en';
    if (l === 'es' || l === 'spanish' || l === '西文' || l === '西语' || l === '西班牙语') return 'es';
    if (l === 'ru' || l === 'russian' || l === '俄文' || l === '俄语') return 'ru';
    return 'kr'; // 默认降级为韩语
  }

  function getStoredLang() {
    if (globalThis.ComicConfigStore) {
      return normalizeLang(globalThis.ComicConfigStore.getOcrLang());
    }
    try {
      if (typeof localStorage !== 'undefined') {
        const val = localStorage.getItem('comic_ocr_lang');
        if (val) return normalizeLang(val);
      }
    } catch {}
    return inMemoryLang || 'kr';
  }

  function setStoredLang(lang) {
    const l = normalizeLang(lang);
    inMemoryLang = l;
    if (globalThis.ComicConfigStore) {
      globalThis.ComicConfigStore.setOcrLang(l);
    }
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('comic_ocr_lang', l);
      }
    } catch {}
    try {
      window.dispatchEvent(new CustomEvent('comic-lang-changed', { detail: { lang: l } }));
    } catch {}
    return l;
  }

  const LANG_FLAGS = {
    'kr': '🇰🇷',
    'ja': '🇯🇵',
    'en': '🇺🇸',
    'es': '🇪🇸',
    'ru': '🇷🇺'
  };

  const LANG_SHORTS = {
    'kr': 'KR',
    'ja': 'JA',
    'en': 'EN',
    'es': 'ES',
    'ru': 'RU'
  };

  // 暴露给其他模块的 LLM 配置接口
  globalThis.ComicLLMStore = Object.freeze({
    getProviders: getStoredProviders,
    saveProviders: saveStoredProviders,
    getActiveProviderId,
    setActiveProviderId,
    getActiveProvider,
    getActiveModel,
    setActiveModel,
    getOcrLang: getStoredLang,
    setOcrLang: setStoredLang
  });

  // ========================================================
  // 3. 构建 Shadow DOM 及核心 UI
  // ========================================================
  function ensureHost() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'comic-reader-floating-ball-v2';
    host.style.cssText = 'all:initial;position:fixed;left:0;top:0;z-index:2147483647;display:none;pointer-events:auto;';
    shadow = host.attachShadow({ mode: 'closed' });

    shadow.innerHTML = `
      <style>
        :host {
          all: initial;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          user-select: none;
        }
        * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }

        /* 悬浮球本体 (老版暗色毛玻璃) */
        .manga-ui-button {
          width: ${SIZE}px;
          height: ${SIZE}px;
          border-radius: 14px;
          background: rgba(30, 34, 40, 0.90);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          border: 1px solid rgba(255, 255, 255, 0.16);
          display: flex;
          justify-content: center;
          align-items: center;
          cursor: pointer;
          transition: all 0.25s cubic-bezier(0.25, 0.8, 0.25, 1);
          box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
          outline: none;
          position: relative;
        }
        @keyframes ball-breathe {
          0%, 100% {
            box-shadow: 0 0 8px rgba(46, 213, 115, 0.4), inset 0 0 4px rgba(46, 213, 115, 0.2);
            border-color: rgba(46, 213, 115, 0.4);
            transform: scale(1);
          }
          50% {
            box-shadow: 0 0 16px rgba(46, 213, 115, 0.8), 0 0 24px rgba(46, 213, 115, 0.3), inset 0 0 8px rgba(46, 213, 115, 0.35);
            border-color: rgba(46, 213, 115, 0.8);
            transform: scale(1.03);
          }
        }
        /* 运行中：发光绿色呼吸光晕 */
        .manga-ui-button.working {
          border-color: rgba(46, 213, 115, 0.6);
          animation: ball-breathe 2s ease-in-out infinite;
        }
        /* 运行/首译完成后的淡化隐身态 (0.24 透明度，悬停/触碰恢复 1) */
        .manga-ui-button.stealth {
          opacity: 0.24;
          animation: none;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
          border-color: rgba(255, 255, 255, 0.12);
          transition: opacity 0.8s ease, box-shadow 0.5s ease, border-color 0.5s ease, transform 0.2s ease;
        }
        .manga-ui-button.stealth:hover,
        .manga-ui-button.stealth:active {
          opacity: 1;
          box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
        }

        /* 195px 老版经典暗色菜单 */
        .manga-ui-menu {
          position: absolute;
          top: ${SIZE + 8}px;
          left: 0;
          width: 195px;
          background: rgba(26, 28, 35, 0.98);
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          border: 1px solid rgba(255, 255, 255, 0.10);
          border-radius: 14px;
          padding: 6px;
          box-shadow: 0 16px 40px rgba(0, 0, 0, 0.65);
          display: flex;
          flex-direction: column;
          gap: 2px;
          z-index: 1000;
        }
        .manga-ui-menu[hidden] { display: none !important; }

        .manga-ui-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 7px 9px;
          border-radius: 8px;
          cursor: pointer;
          color: #dcdde1;
          font-weight: 600;
          font-size: 12px;
          transition: background 0.15s;
        }
        .manga-ui-header:hover {
          background: rgba(255, 255, 255, 0.06);
        }
        .manga-ui-item {
          padding: 6px 9px;
          border-radius: 8px;
          cursor: pointer;
          color: #7f8fa6;
          font-size: 12px;
          font-weight: 500;
          display: flex;
          align-items: center;
          justify-content: space-between;
          transition: all 0.15s;
        }
        .manga-ui-item:hover {
          color: #fff;
          background: rgba(255, 255, 255, 0.05);
        }
        .manga-ui-item.active {
          color: #2ed573;
          font-weight: bold;
          background: rgba(46, 213, 115, 0.08);
        }
        .divider {
          height: 1px;
          background: rgba(255, 255, 255, 0.06);
          margin: 3px 0;
          border: none;
        }

        /* 通用自适应设置弹框 (Modal，支持移动端软键盘动态避让) */
        .settings-modal-overlay {
          position: fixed;
          inset: 0;
          background: rgba(8, 12, 18, 0.78);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          z-index: 2147483647;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 14px;
          box-sizing: border-box;
          transition: padding-top 0.2s ease, height 0.2s ease;
        }
        .settings-modal-overlay[hidden] { display: none !important; }

        .settings-modal-card {
          width: 94vw;
          max-width: 500px;
          max-height: 85vh;
          background: #1a1d23;
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 20px;
          box-shadow: 0 24px 60px rgba(0, 0, 0, 0.75);
          display: flex;
          flex-direction: column;
          overflow: hidden;
          color: #e2e8f0;
          font-size: 12px;
          transition: max-height 0.2s ease;
        }
        .modal-header {
          padding: 12px 18px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
          display: flex;
          justify-content: space-between;
          align-items: center;
          background: rgba(20, 22, 27, 0.6);
        }
        .modal-title { font-size: 13px; font-weight: 700; color: #f1f5f9; display: flex; align-items: center; gap: 6px; }
        .modal-close-btn {
          width: 28px;
          height: 28px;
          border-radius: 50%;
          border: none;
          background: rgba(255, 255, 255, 0.06);
          color: #94a3b8;
          cursor: pointer;
          font-size: 13px;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.15s;
        }
        .modal-close-btn:hover { color: #fff; background: rgba(255, 255, 255, 0.12); }

        .modal-tabs {
          display: flex;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
          background: rgba(20, 22, 27, 0.4);
          padding: 0 8px;
          overflow-x: auto;
          scrollbar-width: none;
        }
        .modal-tabs::-webkit-scrollbar { display: none; }
        .modal-tab-btn {
          flex: 1;
          justify-content: center;
          white-space: nowrap;
          padding: 10px 4px;
          background: none;
          border: none;
          border-bottom: 2px solid transparent;
          color: #94a3b8;
          font-size: 11px;
          font-weight: 600;
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 4px;
          transition: all 0.15s;
        }
        .modal-tab-btn.active {
          color: #2ed573;
          border-bottom-color: #2ed573;
        }
        .modal-body {
          padding: 14px 16px;
          overflow-y: auto;
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 14px;
          scroll-behavior: smooth;
        }
        .modal-body::-webkit-scrollbar { width: 5px; }
        .modal-body::-webkit-scrollbar-thumb { background: #334155; border-radius: 3px; }

        .modal-footer {
          padding: 12px 18px;
          border-top: 1px solid rgba(255, 255, 255, 0.08);
          background: rgba(20, 22, 27, 0.8);
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .btn-confirm {
          padding: 8px 20px;
          border-radius: 10px;
          background: #2ed573;
          color: #0b1e13;
          font-weight: 700;
          border: none;
          cursor: pointer;
          font-size: 12px;
          transition: background 0.15s;
        }
        .btn-confirm:hover { background: #26c367; }

        /* 输入控件 */
        .input-text {
          width: 100%;
          background: #14161b;
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 8px;
          color: #f1f5f9;
          font-family: inherit;
          font-size: 12px;
          padding: 7px 10px;
          outline: none;
          transition: border-color 0.15s;
        }
        .input-text:focus { border-color: #2ed573; }
        .form-label {
          display: block;
          font-size: 11px;
          font-weight: 600;
          color: #94a3b8;
          margin-bottom: 4px;
        }

        /* 厂商卡片 */
        .provider-card {
          background: #14161b;
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 12px;
          padding: 12px;
          display: flex;
          flex-direction: column;
          gap: 8px;
          transition: all 0.15s;
        }
        .provider-card.active {
          border-color: rgba(46, 213, 115, 0.6);
          background: #181d24;
          box-shadow: 0 4px 16px rgba(46, 213, 115, 0.08);
        }

        /* Dev HUD 入口大卡片 */
        .dev-launcher-card {
          background: rgba(14, 165, 233, 0.1);
          border: 1px solid rgba(56, 189, 248, 0.3);
          border-radius: 12px;
          padding: 12px;
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .btn-dev-launch {
          background: #0ea5e9;
          color: #032030;
          font-weight: 700;
          border: none;
          padding: 6px 14px;
          border-radius: 8px;
          cursor: pointer;
          font-size: 11px;
        }
        .btn-dev-launch:hover { background: #38bdf8; }

        /* 档案名联想输入 */
        .profile-input-wrapper {
          position: relative;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .autocomplete-dropdown {
          position: absolute;
          top: 100%;
          left: 0;
          right: 0;
          background: #11141b;
          border: 1px solid #334155;
          border-radius: 6px;
          box-shadow: 0 10px 24px rgba(0,0,0,0.8);
          max-height: 140px;
          overflow-y: auto;
          z-index: 1000;
          display: none;
          margin-top: 2px;
        }
        .autocomplete-dropdown.show { display: block; }
        .dropdown-opt {
          padding: 8px 10px;
          font-size: 12px;
          color: #f1f5f9;
          cursor: pointer;
          display: flex;
          justify-content: space-between;
          border-bottom: 1px solid #1a202c;
        }
        .dropdown-opt:hover { background: rgba(56, 189, 248, 0.15); color: #38bdf8; }

        /* 标签云容器 */
        .tags-pool {
          background: #14161b;
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 8px;
          padding: 8px;
          min-height: 65px;
          max-height: 110px;
          overflow-y: auto;
          display: flex;
          flex-wrap: wrap;
          align-content: flex-start;
          gap: 5px;
          box-sizing: border-box;
        }
        .tag-chip {
          background: rgba(46, 213, 115, 0.12);
          border: 1px solid rgba(46, 213, 115, 0.3);
          color: #86efac;
          font-size: 11px;
          padding: 2px 7px;
          border-radius: 4px;
          display: inline-flex;
          align-items: center;
          gap: 5px;
        }
        .tag-chip.bl {
          background: rgba(239, 68, 68, 0.12);
          border-color: rgba(239, 68, 68, 0.3);
          color: #fca5a5;
        }
        .tag-chip .del-x {
          cursor: pointer;
          color: rgba(255, 255, 255, 0.4);
          font-weight: bold;
        }
        .tag-chip .del-x:hover { color: #ff4757; }

        /* 水印黑名单折叠手风琴 */
        .blacklist-accordion {
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 8px;
          background: #101319;
          overflow: hidden;
        }
        .accordion-header {
          padding: 8px 10px;
          font-size: 11px;
          font-weight: 700;
          color: #fca5a5;
          display: flex;
          justify-content: space-between;
          align-items: center;
          cursor: pointer;
          background: rgba(239, 68, 68, 0.05);
        }
        .accordion-header:hover { background: rgba(239, 68, 68, 0.1); }
        .accordion-arrow {
          font-size: 10px;
          color: #94a3b8;
          transition: transform 0.2s;
        }
        .accordion-content {
          padding: 8px;
          display: none;
          flex-direction: column;
          gap: 6px;
          border-top: 1px solid rgba(255, 255, 255, 0.08);
        }
        .blacklist-accordion.open .accordion-content { display: flex; }
        .blacklist-accordion.open .accordion-arrow { transform: rotate(90deg); }

        /* 快速 Toast 提示胶囊 */
        .toast-pill {
          position: fixed;
          bottom: 24px;
          left: 50%;
          transform: translateX(-50%) translateY(20px);
          background: rgba(15, 23, 42, 0.95);
          border: 1px solid #38bdf8;
          color: #f8fafc;
          padding: 7px 16px;
          border-radius: 20px;
          font-size: 11px;
          font-weight: 600;
          box-shadow: 0 8px 24px rgba(0,0,0,0.6);
          pointer-events: none;
          opacity: 0;
          transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
          z-index: 2147483647;
          white-space: nowrap;
        }
        .toast-pill.show {
          opacity: 1;
          transform: translateX(-50%) translateY(0);
        }

        /* 气泡微调极简弹窗 */
        .bubble-modal-box {
          width: 90%;
          max-width: 340px;
          background: #161920;
          border: 1px solid #262e3d;
          border-radius: 14px;
          box-shadow: 0 20px 48px rgba(0, 0, 0, 0.85);
          display: flex;
          flex-direction: column;
          gap: 10px;
          padding: 12px 14px;
          transform: scale(0.95);
          transition: transform 0.15s ease;
          box-sizing: border-box;
        }
        .bubble-head {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 8px;
        }
        .trans-preview {
          font-size: 13px;
          font-weight: 700;
          color: #ffffff;
          line-height: 1.4;
          user-select: text;
          max-height: 80px;
          overflow-y: auto;
          word-break: break-word;
        }
        .word-blocks-area {
          display: flex;
          flex-wrap: wrap;
          gap: 4px;
          background: #0f1218;
          border: 1px solid #262e3d;
          border-radius: 6px;
          padding: 6px 8px;
          max-height: 125px;
          overflow-y: auto;
          overscroll-behavior: contain;
          box-sizing: border-box;
        }
        .word-blocks-area::-webkit-scrollbar {
          width: 4px;
        }
        .word-blocks-area::-webkit-scrollbar-thumb {
          background: #334155;
          border-radius: 4px;
        }
        .word-blocks-area::-webkit-scrollbar-thumb:hover {
          background: #475569;
        }
        .word-chip {
          height: 26px;
          padding: 0 6px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          background: #1c212a;
          border: 1px solid #2e3544;
          border-radius: 4px;
          font-size: 11px;
          color: #cbd5e1;
          cursor: pointer;
          white-space: nowrap;
        }
        .word-chip.selected {
          background: #38bdf8;
          border-color: #38bdf8;
          color: #ffffff;
          font-weight: bold;
        }
        .bubble-foot {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-top: 2px;
        }
        .btn-foot-bl {
          background: rgba(239, 68, 68, 0.12);
          border: 1px solid rgba(239, 68, 68, 0.4);
          color: #fca5a5;
          font-size: 11px;
          font-weight: 600;
          padding: 6px 10px;
          border-radius: 6px;
          cursor: pointer;
        }
        .btn-foot-bl:active { background: #ef4444; color: #fff; }
        .btn-foot-ok {
          background: #38bdf8;
          border: none;
          color: #fff;
          font-size: 11px;
          font-weight: 700;
          padding: 6px 16px;
          border-radius: 6px;
          cursor: pointer;
        }
        .btn-foot-ok:hover { background: #0ea5e9; }

        /* OCR 识别模式与高级设置样式 */
        .ocr-modes-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 6px;
        }
        .ocr-mode-btn {
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 8px;
          padding: 8px 6px;
          text-align: left;
          cursor: pointer;
          transition: all 0.15s ease;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .ocr-mode-btn:hover {
          border-color: rgba(46, 213, 115, 0.4);
          background: rgba(46, 213, 115, 0.05);
        }
        .ocr-mode-btn.active {
          border-color: #2ed573;
          background: rgba(46, 213, 115, 0.12);
          box-shadow: 0 0 10px rgba(46, 213, 115, 0.2);
        }
        .ocr-mode-btn.active.mode-balanced {
          border-color: #f59e0b;
          background: rgba(245, 158, 11, 0.12);
          box-shadow: 0 0 10px rgba(245, 158, 11, 0.2);
        }
        .ocr-mode-btn.active.mode-strict {
          border-color: #f43f5e;
          background: rgba(244, 63, 94, 0.12);
          box-shadow: 0 0 10px rgba(244, 63, 94, 0.2);
        }
        .ocr-slider-drawer {
          overflow: hidden;
          transition: max-height 0.25s ease;
        }
        .ocr-slider-drawer.collapsed {
          max-height: 0;
          display: none;
        }
        .ocr-slider-drawer:not(.collapsed) {
          max-height: 250px;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .slider-ctrl {
          width: 100%;
          height: 6px;
          border-radius: 4px;
          background: #334155;
          accent-color: #2ed573;
          cursor: pointer;
        }
      </style>

      <!-- 悬浮球本体 -->
      <button class="manga-ui-button" id="ball-button" title="短按：开始/停止翻译&#10;长按：呼出菜单">
        <span id="ball-flag-icon" style="font-size: 24px; line-height: 1; filter: grayscale(100%);">🇰🇷</span>
      </button>

      <!-- 195px 老版经典菜单 -->
      <div class="manga-ui-menu" id="ball-menu" hidden>
        <!-- 1. 识别源语种 (提交给后端 OCR，仅限韩/日/英/俄，无中文) -->
        <div class="manga-ui-header" style="cursor: default;">
          <div style="display:flex; align-items:center; gap:6px;">
            <span>🌍</span>
            <span>识别源语种 (OCR)</span>
          </div>
          <span id="menu-lang-tag" style="color:#2ed573; font-weight:bold; font-size:11px;">KR</span>
        </div>

        <div id="menu-lang-list" style="display:flex; flex-direction:column; gap:2px; padding: 2px 0;">
          <div class="manga-ui-item active" data-lang="kr">
            <span>🇰🇷 한국어 (韩文)</span>
            <span class="chk-mark" style="color:#2ed573; font-size:11px;">✓</span>
          </div>
          <div class="manga-ui-item" data-lang="ja">
            <span>🇯🇵 日本語 (日文)</span>
            <span class="chk-mark" style="color:#2ed573; font-size:11px; display:none;">✓</span>
          </div>
          <div class="manga-ui-item" data-lang="en">
            <span>🇺🇸 English (英文)</span>
            <span class="chk-mark" style="color:#2ed573; font-size:11px; display:none;">✓</span>
          </div>
          <div class="manga-ui-item" data-lang="es">
            <span>🇪🇸 Español (西班牙文)</span>
            <span class="chk-mark" style="color:#2ed573; font-size:11px; display:none;">✓</span>
          </div>
          <div class="manga-ui-item" data-lang="ru">
            <span>🇷🇺 Русский (俄文)</span>
            <span class="chk-mark" style="color:#2ed573; font-size:11px; display:none;">✓</span>
          </div>
        </div>

        <div class="divider"></div>

        <!-- 2. AI 翻译模型 / 模式 (包含 none 原文学习模式) -->
        <div class="manga-ui-header" style="cursor: default;">
          <div style="display:flex; align-items:center; gap:6px;">
            <span>⚡</span>
            <span>翻译模型 / 模式</span>
          </div>
          <span id="menu-platform-label" style="font-size:10px; color:#64748b; font-family:monospace; max-width:70px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">DeepSeek</span>
        </div>

        <div id="menu-model-list" style="display:flex; flex-direction:column; gap:2px; max-height:120px; overflow-y:auto;">
          <!-- 动态注入 -->
        </div>

        <div class="divider"></div>

        <!-- 3. 设置中心入口 -->
        <div class="manga-ui-header" id="btn-open-settings" style="color:#94a3b8; font-weight:600;">
          <div style="display:flex; align-items:center; gap:6px;">
            <span>⚙️</span>
            <span>设置中心</span>
          </div>
          <span style="font-size:11px; color:#64748b;">›</span>
        </div>
      </div>

      <!-- 通用自适应设置弹框 (Modal) -->
      <div class="settings-modal-overlay" id="modal-overlay" hidden>
        <div class="settings-modal-card">
          <!-- 弹窗顶栏 -->
          <div class="modal-header">
            <div class="modal-title">
              <span style="color:#2ed573;">⚙️</span>
              <span>汉化插件配置中心</span>
            </div>
            <button class="modal-close-btn" id="modal-close-btn">✕</button>
          </div>

          <!-- 选项卡导航 (精简缩写适应移动端视口) -->
          <div class="modal-tabs">
            <button class="modal-tab-btn active" data-tab="models">🤖 模型</button>
            <button class="modal-tab-btn" data-tab="ocr">⚡ OCR</button>
            <button class="modal-tab-btn" data-tab="corpus">📖 语料</button>
            <button class="modal-tab-btn" data-tab="errors">🛠️ 调试 <span id="modal-error-badge" style="background:rgba(239,68,68,0.2); color:#f87171; font-size:10px; padding:1px 5px; border-radius:10px; display:none;">0</span></button>
          </div>

          <!-- 弹窗内容区 -->
          <div class="modal-body">
            <!-- Tab 1: 模型管理 -->
            <div id="tab-pane-models" style="display:flex; flex-direction:column; gap:12px;">
              <div style="display:flex; justify-content:space-between; align-items:center;">
                <span class="form-label" style="margin-bottom:0;">已配置的模型厂商/平台</span>
                <button id="btn-add-provider" style="background:#2ed573; color:#0b1e13; font-weight:700; border:none; padding:4px 10px; border-radius:6px; font-size:11px; cursor:pointer;">+ 添加平台</button>
              </div>
              <div id="modal-providers-container" style="display:flex; flex-direction:column; gap:10px;"></div>
            </div>

            <!-- Tab: OCR 服务与灵敏度设置 -->
            <div id="tab-pane-ocr" style="display:none; flex-direction:column; gap:12px;">
              <!-- 模块 A: 识别灵敏度与召回模式 -->
              <div class="provider-card" style="border:1px solid rgba(255,255,255,0.1); background:#14171f;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                  <span class="form-label" style="margin-bottom:0; font-size:12px; font-weight:700; color:#f8fafc;">
                    🎯 识别灵敏度与对白召回
                  </span>
                  <span id="ocr-comic-anchor-tag" style="font-size:10px; color:#38bdf8; background:rgba(56,189,248,0.1); padding:2px 6px; border-radius:4px; border:1px solid rgba(56,189,248,0.25);">
                    📖 当前漫画专属记忆
                  </span>
                </div>

                <!-- 三大模式网格 -->
                <div class="ocr-modes-grid">
                  <!-- 1. 敏锐 -->
                  <div class="ocr-mode-btn" id="btn-ocr-sensitive" data-mode="sensitive">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                      <span style="font-size:11px; font-weight:700; color:#2ed573;">🟢 敏锐模式</span>
                      <span style="font-family:monospace; font-size:10px; color:#2ed573; font-weight:700;">0.50</span>
                    </div>
                    <div style="font-size:10px; color:#94a3b8; margin-top:2px;">防漏对白 / 高召回</div>
                    <div style="font-size:9px; color:#6ee7b7; margin-top:2px;">手写涂鸦/暗底字</div>
                  </div>

                  <!-- 2. 标准平衡 -->
                  <div class="ocr-mode-btn" id="btn-ocr-balanced" data-mode="balanced">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                      <span style="font-size:11px; font-weight:700; color:#fbbf24;">🟡 标准平衡</span>
                      <span style="font-family:monospace; font-size:10px; color:#fbbf24; font-weight:700;">0.70</span>
                    </div>
                    <div style="font-size:10px; color:#94a3b8; margin-top:2px;">默认推荐 / 均衡</div>
                    <div style="font-size:9px; color:#94a3b8; margin-top:2px;">常规白底黑字</div>
                  </div>

                  <!-- 3. 纯净 -->
                  <div class="ocr-mode-btn" id="btn-ocr-strict" data-mode="strict">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                      <span style="font-size:11px; font-weight:700; color:#f87171;">🔴 纯净模式</span>
                      <span style="font-family:monospace; font-size:10px; color:#f87171; font-weight:700;">0.82</span>
                    </div>
                    <div style="font-size:10px; color:#94a3b8; margin-top:2px;">抗网点 / 拒水印</div>
                    <div style="font-size:9px; color:#94a3b8; margin-top:2px;">仅留高置信气泡</div>
                  </div>
                </div>

                <!-- 模式解读说明卡片 -->
                <div id="ocr-desc-card" style="margin-top:8px; padding:8px 10px; border-radius:8px; background:rgba(46,213,115,0.08); border:1px solid rgba(46,213,115,0.25); font-size:11px; line-height:1.45; color:#cbd5e1;">
                  <strong style="color:#2ed573;">🟢 敏锐模式生效中</strong>：识别置信度底线放宽至 <span style="font-family:monospace; font-weight:700; color:#86efac;">0.50</span>，候选框门槛 <span style="font-family:monospace; font-weight:700; color:#86efac;">0.45</span>。手写字、暗底对白和拟声小字全部捕获！
                </div>

                <!-- 自定义高级微调折叠抽屉 -->
                <div style="margin-top:10px; border-top:1px solid rgba(255,255,255,0.08); padding-top:8px;">
                  <div id="btn-toggle-custom-drawer" style="display:flex; justify-content:space-between; align-items:center; cursor:pointer;">
                    <div style="display:flex; align-items:center; gap:6px; font-size:11px; font-weight:600; color:#cbd5e1;">
                      <span>⚙️ 自定义参数微调 (拖动滑块)</span>
                      <span id="ocr-custom-badge" style="display:none; font-size:9px; background:rgba(46,213,115,0.2); color:#86efac; border:1px solid rgba(46,213,115,0.3); padding:1px 5px; border-radius:4px; font-family:monospace;">自定义中</span>
                    </div>
                    <span id="ocr-custom-arrow" style="font-size:10px; color:#64748b; transition:transform 0.2s;">▼ 展开</span>
                  </div>

                  <div id="ocr-custom-drawer" class="ocr-slider-drawer collapsed" style="margin-top:8px; border-top:1px dashed rgba(255,255,255,0.08); padding-top:8px;">
                    <!-- 滑块 1: rec_score -->
                    <div>
                      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                        <span style="font-size:11px; color:#cbd5e1;">文本识别置信度底线 (rec_thresh) <strong style="color:#f43f5e; font-size:10px;">*核心</strong></span>
                        <span id="label-rec-thresh-val" style="font-family:monospace; font-size:11px; font-weight:700; color:#2ed573; background:#1e293b; padding:2px 6px; border-radius:4px; border:1px solid #334155;">0.50</span>
                      </div>
                      <input type="range" id="slider-rec-thresh" min="0.30" max="0.90" step="0.05" value="0.50" class="slider-ctrl">
                      <div style="display:flex; justify-content:space-between; font-size:9px; color:#64748b; font-family:monospace; margin-top:2px;">
                        <span>0.30 (极激进)</span>
                        <span>0.50 (敏锐)</span>
                        <span>0.70 (标准)</span>
                        <span>0.90 (极严格)</span>
                      </div>
                    </div>

                    <!-- 滑块 2: box_thresh -->
                    <div>
                      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                        <span style="font-size:11px; color:#cbd5e1;">文本框检测门槛 (box_thresh)</span>
                        <span id="label-box-thresh-val" style="font-family:monospace; font-size:11px; font-weight:700; color:#2ed573; background:#1e293b; padding:2px 6px; border-radius:4px; border:1px solid #334155;">0.45</span>
                      </div>
                      <input type="range" id="slider-box-thresh" min="0.30" max="0.80" step="0.05" value="0.45" class="slider-ctrl">
                      <div style="display:flex; justify-content:space-between; font-size:9px; color:#64748b; font-family:monospace; margin-top:2px;">
                        <span>0.30 (多框防漏)</span>
                        <span>0.55 (平衡)</span>
                        <span>0.80 (少框保真)</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <!-- 模块 B: 推理引擎与服务路由 -->
              <div class="provider-card" style="border:1px solid rgba(255,255,255,0.1); background:#14171f;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                  <span class="form-label" style="margin-bottom:0; font-size:12px; font-weight:700; color:#f8fafc;">
                    ⚡ 推理引擎与服务路由
                  </span>
                  <span style="font-size:10px; color:#94a3b8;">支持自定义端点 IP</span>
                </div>

                <div style="display:flex; flex-direction:column; gap:10px;">
                  <!-- 路由 1: 本地硬件加速 -->
                  <div id="ocr-route-card-local" style="padding:10px; border-radius:8px; background:rgba(46,213,115,0.05); border:1px solid rgba(46,213,115,0.3); display:flex; flex-direction:column; gap:6px;">
                    <label style="display:flex; justify-content:space-between; align-items:center; cursor:pointer;">
                      <div style="display:flex; align-items:center; gap:8px;">
                        <input type="radio" name="modal-ocr-mode" value="local" id="radio-mode-local" style="accent-color:#2ed573;" checked>
                        <span style="font-size:12px; font-weight:700; color:#2ed573;">📱 手机端本地硬件加速 (推荐·端侧硬件推理)</span>
                      </div>
                      <span style="font-size:10px; color:#2ed573; background:rgba(46,213,115,0.15); padding:1px 6px; border-radius:4px; font-family:monospace;">免流零延迟</span>
                    </label>

                    <div style="padding-top:4px;">
                      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                        <span style="font-size:10px; color:#94a3b8;">本地服务端点 (允许编辑 IP，支持同局域网设备)</span>
                        <button id="btn-reset-local-url" type="button" style="font-size:10px; color:#2ed573; background:none; border:none; cursor:pointer; text-decoration:underline; padding:0;">重置为 127.0.0.1</button>
                      </div>
                      <input type="text" id="modal-ocr-local-url" value="http://127.0.0.1:8080" class="input-text" style="font-family:monospace; font-size:11px; padding:6px 8px;">
                      <div style="font-size:10px; color:#64748b; margin-top:4px;">
                        ✨ 经由插件后台 Service Worker 特权管道直连，100% 免疫网页 HTTPS 混合内容拦截。
                      </div>
                    </div>
                  </div>

                  <!-- 路由 2: 云端 Serverless / 自建服务器 -->
                  <div id="ocr-route-card-cloud" style="padding:10px; border-radius:8px; background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.08); display:flex; flex-direction:column; gap:6px;">
                    <label style="display:flex; justify-content:space-between; align-items:center; cursor:pointer;">
                      <div style="display:flex; align-items:center; gap:8px;">
                        <input type="radio" name="modal-ocr-mode" value="cloud" id="radio-mode-cloud" style="accent-color:#2ed573;">
                        <span style="font-size:12px; font-weight:700; color:#cbd5e1;">☁️ 云端 Serverless / 自建 Docker 服务</span>
                      </div>
                      <span style="font-size:10px; color:#64748b; font-family:monospace;">远程备用</span>
                    </label>

                    <div style="padding-top:4px;">
                      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                        <span style="font-size:10px; color:#94a3b8;">云端 / 自建服务器 API 地址</span>
                      </div>
                      <input type="text" id="modal-ocr-cloud-url" placeholder="https://your-ocr-server.com" class="input-text" style="font-family:monospace; font-size:11px; padding:6px 8px;">
                      <div style="font-size:10px; color:#64748b; margin-top:4px;">
                        支持阿里云 ACR 预构建镜像一键部署、Serverless 函数计算等标准 HTTP OCR 服务。
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Tab 3: 语料库与世界观 (完全体实装) -->
            <div id="tab-pane-corpus" style="display:none; flex-direction:column; gap:11px;">
              <!-- 1. 档案名输入框 (带联想下拉建议) -->
              <div class="profile-input-wrapper">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                  <span class="form-label" style="margin-bottom:0;">📁 漫画档案名称 <span style="font-size:10px; color:#38bdf8;" id="modal-anchor-status">● 自动匹配</span></span>
                  <span style="font-size:10px; color:#64748b;">输入关键词联想已有档案</span>
                </div>
                <input type="text" class="input-text" id="modal-profile-name" placeholder="输入已有或全新档案名..." autocomplete="off">
                <div class="autocomplete-dropdown" id="modal-profile-dropdown"></div>
              </div>

              <!-- 2. 世界观与语气设定 -->
              <div>
                <div style="display:flex; justify-content:space-between; align-items:center;">
                  <span class="form-label" style="margin-bottom:0;">📖 作品世界观与语气设定</span>
                  <span style="font-size:10px; color:#64748b;">注入 System Prompt</span>
                </div>
                <textarea id="modal-worldview-input" rows="3" class="input-text" style="resize:none; font-size:11px; margin-top:4px;" placeholder="例如：现代校园恋爱轻喜剧，对白亲切口语化，男主略带调侃..."></textarea>
              </div>

              <!-- 3. 专有名词白名单标签云 (宽裕舒展) -->
              <div>
                <div style="display:flex; justify-content:space-between; align-items:center;">
                  <span class="form-label" style="margin-bottom:0;">🏷️ 专有名词白名单 (当前档案专属)</span>
                  <span style="font-size:10px; color:#2ed573;" id="modal-corpus-count-txt">0个词条</span>
                </div>
                <div class="tags-pool" id="modal-corpus-tags-pool"></div>
                <div style="display:flex; gap:6px; margin-top:4px;">
                  <input type="text" class="input-text" id="modal-new-term-input" placeholder="输入专有名词(如 基泰, 尤娜)" style="flex:1;">
                  <button id="modal-btn-add-term" style="background:#1f2533; border:1px solid rgba(255,255,255,0.15); color:#f1f5f9; padding:0 12px; border-radius:6px; font-size:11px; cursor:pointer; white-space:nowrap;">+ 添加</button>
                </div>
              </div>

              <!-- 4. 水印黑名单折叠栏 (默认折叠) -->
              <div class="blacklist-accordion" id="modal-blacklist-accordion">
                <div class="accordion-header" id="modal-accordion-toggle-btn">
                  <span>🚫 水印与广告过滤黑名单 (<span id="modal-blacklist-count-txt">0</span>条全局规则)</span>
                  <span class="accordion-arrow" id="modal-accordion-arrow">▶</span>
                </div>
                <div class="accordion-content" id="modal-accordion-content">
                  <div class="tags-pool" id="modal-blacklist-tags-pool" style="min-height:48px; max-height:80px;"></div>
                  <div style="display:flex; gap:6px; margin-top:4px;">
                    <input type="text" class="input-text" id="modal-new-blacklist-input" placeholder="输入水印特征词" style="flex:1;">
                    <button id="modal-btn-add-blacklist" style="background:#1f2533; border:1px solid rgba(255,255,255,0.15); color:#fca5a5; padding:0 12px; border-radius:6px; font-size:11px; cursor:pointer; white-space:nowrap;">+ 拉黑</button>
                  </div>
                </div>
              </div>
            </div>

            <!-- Tab 4: 🛠️ 调试与优化 -->
            <div id="tab-pane-errors" style="display:none; flex-direction:column; gap:12px;">
              <!-- 卡片 1: 快捷调试与诊断开关 -->
              <div class="section-card" style="background:#1e293b; border:1px solid rgba(148,163,184,0.15); border-radius:8px; padding:12px; display:flex; flex-direction:column; gap:8px;">
                <div style="font-size:11px; font-weight:700; color:#38bdf8; display:flex; align-items:center; justify-content:space-between;">
                  <span>🎮 快捷调试开关</span>
                  <span style="font-size:9px; color:#94a3b8;">即时生效</span>
                </div>
                <div style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
                  <div style="display:flex; flex-direction:column;">
                    <span style="font-size:12px; font-weight:600; color:#f8fafc;">切片辅助线与切线</span>
                    <span style="font-size:10px; color:#94a3b8; margin-top:1px;">在漫画图层上实时绘制落刀切线与坐标分布</span>
                  </div>
                  <button id="btn-toggle-preview" class="btn-toggle" style="padding:4px 10px; border-radius:6px; font-size:11px; font-weight:600; cursor:pointer; border:1px solid rgba(148, 163, 184, 0.2); background:#334155; color:#94a3b8; transition:all 0.15s;">⚪ 已关闭</button>
                </div>
                <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:4px;">
                  <div style="display:flex; flex-direction:column;">
                    <span style="font-size:12px; font-weight:600; color:#f8fafc;">开启 Dev 测试看版</span>
                    <span style="font-size:10px; color:#94a3b8; margin-top:1px;">单次会话浮窗，默认不开启，刷新或切换页面自动关闭</span>
                  </div>
                  <button id="btn-launch-dev-hud" style="background:rgba(14,165,233,0.2); border:1px solid #38bdf8; color:#38bdf8; padding:5px 12px; border-radius:6px; font-size:11px; font-weight:700; cursor:pointer; transition:all 0.15s;">🚀 唤起看板</button>
                </div>
              </div>

              <!-- 卡片 1.5: 🔤 气泡文字最小字号下限调节 (实时联动全量补丁) -->
              <div class="section-card" style="background:#1e293b; border:1px solid rgba(148,163,184,0.15); border-radius:8px; padding:12px; display:flex; flex-direction:column; gap:8px;">
                <div style="font-size:11px; font-weight:700; color:#38bdf8; display:flex; align-items:center; justify-content:space-between;">
                  <span>🔤 气泡文字最小字号下限</span>
                  <span id="label-min-font-size-val" style="font-size:11px; font-weight:700; color:#38bdf8; background:rgba(56,189,248,0.15); padding:2px 8px; border-radius:6px;">13 px</span>
                </div>
                <div style="font-size:10px; color:#94a3b8; line-height:1.4;">
                  保护阅读视力底限。调节即刻联动生效，页面上已有的所有补丁中凡小于此大小的字号，会自动实时撑开同步放大。
                </div>
                <div style="display:flex; align-items:center; gap:8px; margin-top:2px;">
                  <button id="btn-dec-min-font" style="width:28px; height:28px; border-radius:6px; background:#334155; border:1px solid rgba(255,255,255,0.1); color:#fff; font-size:14px; font-weight:bold; cursor:pointer; display:flex; align-items:center; justify-content:center;">-</button>
                  <input type="range" id="slider-min-font-size" min="10" max="22" step="1" value="13" style="flex:1; accent-color:#38bdf8; cursor:pointer; height:6px;">
                  <button id="btn-inc-min-font" style="width:28px; height:28px; border-radius:6px; background:#334155; border:1px solid rgba(255,255,255,0.1); color:#fff; font-size:14px; font-weight:bold; cursor:pointer; display:flex; align-items:center; justify-content:center;">+</button>
                </div>
              </div>

              <!-- 卡片 2: 核心推理规格与切片落刀参数 (深度调优·固化锁定) -->
              <div class="section-card" style="background:#1e293b; border:1px solid rgba(148,163,184,0.15); border-radius:8px; padding:12px; display:flex; flex-direction:column; gap:8px;">
                <div style="font-size:11px; font-weight:700; color:#38bdf8; display:flex; align-items:center; justify-content:space-between;">
                  <span>⚡ 核心推理规格与切片参数</span>
                  <span style="font-size:9px; color:#22c55e; background:rgba(34,197,94,0.15); padding:1px 5px; border-radius:4px;">🔒 深度标定·已固化锁定</span>
                </div>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; background:#0f172a; padding:8px; border-radius:6px; font-family:monospace; font-size:11px;">
                  <div style="display:flex; justify-content:space-between; color:#94a3b8;">
                    <span>识别精度</span><span style="color:#38bdf8; font-weight:bold;">1024 px</span>
                  </div>
                  <div style="display:flex; justify-content:space-between; color:#94a3b8;">
                    <span>在途并发</span><span style="color:#4ade80; font-weight:bold;">6 槽位</span>
                  </div>
                  <div style="display:flex; justify-content:space-between; color:#94a3b8;">
                    <span>DET 门限</span><span style="color:#f8fafc; font-weight:bold;">0.30</span>
                  </div>
                  <div style="display:flex; justify-content:space-between; color:#94a3b8;">
                    <span>DET 框置信</span><span style="color:#f8fafc; font-weight:bold;">0.50</span>
                  </div>
                  <div style="display:flex; justify-content:space-between; color:#94a3b8;">
                    <span>REC 过滤</span><span style="color:#f8fafc; font-weight:bold;">0.70</span>
                  </div>
                  <div style="display:flex; justify-content:space-between; color:#94a3b8;">
                    <span>切片压缩比</span><span style="color:#fbbf24; font-weight:bold;">3.46</span>
                  </div>
                </div>
                <div style="font-size:10px; color:#64748b; line-height:1.4;">
                  ℹ️ 标定说明：1024px 检测分辨率、6 槽位在途并发以及切片压缩系数已在服务端完成高精标定锁定，无需手动修改，确保最强吞吐与零漏检。
                </div>
              </div>

              <!-- 卡片 3: 运行异常与错误码 (只保留下载报告一个选项) -->
              <div id="modal-error-section" class="section-card" style="background:#1e293b; border:1px solid rgba(148,163,184,0.15); border-radius:8px; padding:12px; display:flex; flex-direction:column; gap:8px;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                  <div style="display:flex; align-items:center; gap:6px;">
                    <span style="font-size:11px; font-weight:700; color:#f87171;">⚠️ 运行异常与错误码</span>
                    <span id="setting-error-count-badge" style="font-size:9px; color:#94a3b8;">(暂无拦截异常)</span>
                  </div>
                  <button id="btn-download-dev-report" style="background:rgba(14,165,233,0.15); color:#38bdf8; border:1px solid rgba(56,189,248,0.4); border-radius:6px; padding:4px 10px; font-size:11px; font-weight:700; cursor:pointer; transition:all 0.15s;">📥 下载报告 (.txt)</button>
                </div>
                <div id="modal-error-status-box" style="background:#0f172a; border-radius:6px; padding:8px 10px; font-size:11px; font-family:monospace; color:#cbd5e1; line-height:1.5;">
                  <!-- 紧凑单卡片显示，不拉长页面 -->
                </div>
              </div>
            </div>
          </div>

          <!-- 弹窗底栏 -->
          <div class="modal-footer">
            <span style="font-size:10px; color:#64748b; font-family:monospace;">配置存储于 chrome.storage.local</span>
            <button class="btn-confirm" id="modal-confirm-btn">完成并保存</button>
          </div>
        </div>
      </div>

      <!-- 气泡微调极简弹窗 (双击气泡唤起) -->
      <div class="settings-modal-overlay" id="bubble-modal-overlay" hidden>
        <div class="bubble-modal-box" id="bubble-modal-box">
          <div class="bubble-head">
            <div class="trans-preview" id="bubble-trans-preview">...</div>
            <button class="modal-close-btn" id="btn-bubble-close" style="font-size:12px; width:24px; height:24px;">✕</button>
          </div>
          <div class="word-blocks-area" id="bubble-word-blocks-area"></div>
          <input type="text" class="input-text" id="input-bubble-correction" placeholder="点选分词进行修正...">
          <div class="bubble-foot">
            <button class="btn-foot-bl" id="btn-bubble-blacklist">🚫 加入黑名单</button>
            <button class="btn-foot-ok" id="btn-bubble-done">✔ 完成</button>
          </div>
        </div>
      </div>

      <!-- 快速 Toast 提示胶囊 -->
      <div class="toast-pill" id="comic-toast-pill"></div>
    `;

    if (typeof shadow.getElementById !== 'function') {
      shadow.getElementById = (id) => (shadow.querySelector ? shadow.querySelector('#' + id) : null) || { style: {}, addEventListener() {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, getAttribute() {} };
    }
    if (typeof shadow.querySelectorAll !== 'function') {
      shadow.querySelectorAll = () => [];
    }

    button = shadow.getElementById('ball-button');
    btnIconDisplay = shadow.getElementById('ball-flag-icon');
    menu = shadow.getElementById('ball-menu');
    modalOverlay = shadow.getElementById('modal-overlay');

    // 绑定核心交互事件
    setupBallInteractions();
    setupMenuInteractions();
    setupModalInteractions();

    document.documentElement.appendChild(host);

    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', scheduleLayout, { passive: true });
    if ('ResizeObserver' in window) resizeObserver = new ResizeObserver(scheduleLayout);
  }

  // ========================================================
  // 4. 悬浮球手势与菜单状态机
  // ========================================================
  function setupBallInteractions() {
    let pressTimer = null;
    let isLongPress = false;

    function updateVisual() {
      const lang = getStoredLang();
      btnIconDisplay.textContent = LANG_FLAGS[lang] || '🇰🇷';
      const isRunning = captureStatus.running || captureStatus.starting;

      if (isRunning) {
        button.classList.add('working');
        btnIconDisplay.style.filter = 'drop-shadow(0 2px 4px rgba(0,0,0,0.5))';
        if (hasFirstTranslation) {
          button.classList.add('stealth');
        } else {
          button.classList.remove('stealth');
        }
      } else {
        hasFirstTranslation = false;
        button.classList.remove('working', 'stealth');
        btnIconDisplay.style.filter = 'grayscale(100%)';
      }
    }

    globalThis.ComicFloatingBallOnFirstTranslation = () => {
      hasFirstTranslation = true;
      const isRunning = captureStatus.running || captureStatus.starting;
      if (isRunning && menu.hasAttribute('hidden')) {
        button.classList.add('stealth');
      }
    };

    button.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      isLongPress = false;
      pressTimer = setTimeout(() => {
        isLongPress = true;
        // 长按 0.5 秒：静默呼出 / 关闭菜单
        if (menu.hasAttribute('hidden')) {
          openMenu();
        } else {
          closeMenu();
        }
      }, 500);
    });

    button.addEventListener('pointerup', () => {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
      // 短按：如果菜单开着，短按关闭；如果菜单没开，短按直接启停翻译！(老版本灵魂)
      if (!isLongPress) {
        if (!menu.hasAttribute('hidden')) {
          closeMenu();
        } else {
          closeMenu();
          globalThis.ComicImageCapture?.toggle();
        }
      }
    });

    button.addEventListener('pointercancel', () => {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    });

    // 悬停/触碰时临时恢复全不透明
    button.addEventListener('mouseenter', () => button.classList.remove('stealth'));
    button.addEventListener('mouseleave', () => {
      const isRunning = captureStatus.running || captureStatus.starting;
      if (isRunning && hasFirstTranslation && menu.hasAttribute('hidden')) {
        button.classList.add('stealth');
      }
    });

    globalThis.ComicFloatingBallSyncVisual = updateVisual;
  }

  function openMenu() {
    menu.removeAttribute('hidden');
    button.classList.remove('stealth');
    renderMenuModelList();
    updateErrorBadge();
  }

  function closeMenu() {
    menu.setAttribute('hidden', '');
    const isRunning = captureStatus.running || captureStatus.starting;
    if (isRunning && hasFirstTranslation) button.classList.add('stealth');
  }

  // ========================================================
  // 5. 菜单交互 (点击外部秒收回、语种切换、模型选择)
  // ========================================================
  function setupMenuInteractions() {
    // 阻止菜单内部点击冒泡
    menu.addEventListener('pointerdown', (e) => e.stopPropagation());
    menu.addEventListener('click', (e) => e.stopPropagation());

    // 点击外部：使用 pointerdown 并在捕获阶段拦截，保证桌面和移动端一触即收回！
    document.addEventListener('pointerdown', (e) => {
      if (host && !host.contains(e.target)) {
        closeMenu();
      }
    }, true);

    // 语种选择 (仅韩/日/英/俄，无中文)
    const langItems = shadow.querySelectorAll('#menu-lang-list .manga-ui-item');
    langItems.forEach(item => {
      item.addEventListener('click', () => {
        const lang = item.dataset.lang;
        setStoredLang(lang);
        syncLangUI(lang);
      });
    });

    // 打开设置弹框
    shadow.getElementById('btn-open-settings').addEventListener('click', () => {
      closeMenu();
      openModal();
    });
  }

  function syncLangUI(lang) {
    const l = normalizeLang(lang);
    shadow.querySelectorAll('#menu-lang-list .manga-ui-item').forEach(item => {
      const match = item.dataset.lang === l;
      item.classList.toggle('active', match);
      const chk = item.querySelector('.chk-mark');
      if (chk) chk.style.display = match ? 'inline' : 'none';
    });
    const tag = shadow.getElementById('menu-lang-tag');
    if (tag) tag.textContent = LANG_SHORTS[l] || 'KR';
    btnIconDisplay.textContent = LANG_FLAGS[l] || '🇰🇷';
  }

  function renderMenuModelList() {
    const providerId = getActiveProviderId();
    const providers = getStoredProviders();
    const activeProvider = providers.find(p => p.id === providerId) || providers[0];
    const currentModel = getActiveModel();

    const label = shadow.getElementById('menu-platform-label');
    if (label && activeProvider) label.textContent = activeProvider.name;

    const container = shadow.getElementById('menu-model-list');
    if (!container) return;
    container.innerHTML = '';

    // 1. 置顶项：none (仅看原文·学习模式)
    const isNone = currentModel === 'none';
    const noneItem = document.createElement('div');
    noneItem.className = `manga-ui-item ${isNone ? 'active' : ''}`;
    noneItem.innerHTML = `
      <span style="${isNone ? 'color:#facc15; font-weight:bold;' : 'color:#fbbf24;'}">🈚 仅看原文 (学习模式)</span>
      <span class="chk-mark" style="color:#2ed573; font-size:11px; ${isNone ? '' : 'display:none;'}">✓</span>
    `;
    noneItem.addEventListener('click', () => {
      setActiveModel('none');
      renderMenuModelList();
    });
    container.appendChild(noneItem);

    // 2. 当前激活平台下配置的模型列表
    if (activeProvider && Array.isArray(activeProvider.models)) {
      activeProvider.models.forEach(modelName => {
        const isSelected = currentModel === modelName;
        const item = document.createElement('div');
        item.className = `manga-ui-item ${isSelected ? 'active' : ''}`;
        item.innerHTML = `
          <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">🤖 ${modelName}</span>
          <span class="chk-mark" style="color:#2ed573; font-size:11px; ${isSelected ? '' : 'display:none;'}">✓</span>
        `;
        item.addEventListener('click', () => {
          setActiveModel(modelName);
          renderMenuModelList();
        });
        container.appendChild(item);
      });
    }
  }

  // ========================================================
  // 6. 通用设置弹框 (Modal：模型管理、语料库、错误与Dev HUD)
  // ========================================================
  let currentProfileName = '';
  let currentTerms = [];
  let currentBlacklist = [];
  let activeBubbleData = null;
  let selectedBubbleToken = null;

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function showToast(msg) {
    const toast = shadow.getElementById('comic-toast-pill');
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
      toast.classList.remove('show');
    }, 2200);
  }
  globalThis.ComicShowToast = showToast;

  function renderCorpusTagsPool() {
    const pool = shadow.getElementById('modal-corpus-tags-pool');
    const countTxt = shadow.getElementById('modal-corpus-count-txt');
    if (countTxt) countTxt.textContent = `${currentTerms.length}个词条`;
    if (!pool) return;
    pool.innerHTML = '';
    currentTerms.forEach((term, idx) => {
      const chip = document.createElement('div');
      chip.className = 'tag-chip';
      chip.innerHTML = `<span>${escapeHtml(term)}</span><span class="del-x" title="删除">×</span>`;
      chip.querySelector('.del-x').addEventListener('click', async (e) => {
        e.stopPropagation();
        const removed = currentTerms.splice(idx, 1)[0];
        renderCorpusTagsPool();
        const pName = (shadow.getElementById('modal-profile-name')?.value || '').trim() || currentProfileName || '默认档案';
        if (globalThis.ComicConfigStore && removed) {
          await ComicConfigStore.removeTermFromProfile(pName, removed);
        }
      });
      pool.appendChild(chip);
    });
  }

  function renderBlacklistTagsPool() {
    const pool = shadow.getElementById('modal-blacklist-tags-pool');
    const countTxt = shadow.getElementById('modal-blacklist-count-txt');
    if (countTxt) countTxt.textContent = currentBlacklist.length;
    if (!pool) return;
    pool.innerHTML = '';
    currentBlacklist.forEach((rule, idx) => {
      const chip = document.createElement('div');
      chip.className = 'tag-chip bl';
      chip.innerHTML = `<span>🚫 ${escapeHtml(rule)}</span><span class="del-x" title="移除黑名单">×</span>`;
      chip.querySelector('.del-x').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (globalThis.ComicConfigStore) {
          await ComicConfigStore.removeFromGlobalBlacklist(rule);
          currentBlacklist = ComicConfigStore.getGlobalBlacklist();
        } else {
          currentBlacklist.splice(idx, 1);
        }
        renderBlacklistTagsPool();
      });
      pool.appendChild(chip);
    });
  }

  function loadCorpusTab(specifiedProfileName) {
    if (!globalThis.ComicConfigStore) return;
    const currentInfo = ComicConfigStore.getCurrentProfile(location.href);
    const targetName = (specifiedProfileName !== undefined && specifiedProfileName !== null)
      ? specifiedProfileName
      : (currentInfo.profileName || '');
    currentProfileName = targetName;

    const profileInput = shadow.getElementById('modal-profile-name');
    if (profileInput) profileInput.value = targetName;

    const statusEl = shadow.getElementById('modal-anchor-status');
    if (statusEl) {
      if (currentInfo.isBound && targetName === currentInfo.profileName) {
        statusEl.textContent = '● 绑定至此网址';
        statusEl.style.color = '#2ed573';
      } else {
        statusEl.textContent = '● 自动匹配';
        statusEl.style.color = '#38bdf8';
      }
    }

    const syncState = ComicConfigStore.getSync();
    const pData = syncState.profiles[targetName] || (targetName === currentInfo.profileName ? currentInfo : { worldview: '', referenceTerms: [] });
    const wvInput = shadow.getElementById('modal-worldview-input');
    if (wvInput) wvInput.value = pData.worldview || '';

    currentTerms = Array.isArray(pData.referenceTerms) ? [...pData.referenceTerms] : [];
    currentBlacklist = ComicConfigStore.getGlobalBlacklist() || [];

    renderCorpusTagsPool();
    renderBlacklistTagsPool();
  }

  function showProfileSuggestions(query) {
    const dropdown = shadow.getElementById('modal-profile-dropdown');
    if (!dropdown) return;
    const q = (query || '').trim().toLowerCase();
    const allNames = globalThis.ComicConfigStore?.getAllProfileNames() || [];
    const matches = allNames.filter(n => n.toLowerCase().includes(q));

    if (matches.length === 0) {
      dropdown.innerHTML = `<div style="padding:8px 10px; font-size:11px; color:#64748b; text-align:center;">暂无匹配，保存时将创建新档案</div>`;
    } else {
      const syncState = globalThis.ComicConfigStore?.getSync();
      dropdown.innerHTML = matches.map(m => {
        const termCount = syncState?.profiles?.[m]?.referenceTerms?.length || 0;
        return `
          <div class="dropdown-opt" data-name="${escapeHtml(m)}">
            <span>📁 ${escapeHtml(m)}</span>
            <span style="font-size:10px; color:#2ed573;">${termCount}词</span>
          </div>
        `;
      }).join('');

      dropdown.querySelectorAll('.dropdown-opt').forEach(opt => {
        opt.addEventListener('click', (e) => {
          e.stopPropagation();
          const chosen = opt.dataset.name;
          dropdown.classList.remove('show');
          loadCorpusTab(chosen);
          showToast(`已切换至档案【${chosen}】`);
        });
      });
    }
    dropdown.classList.add('show');
  }

  async function addNewTerm() {
    const input = shadow.getElementById('modal-new-term-input');
    const val = input?.value?.trim();
    if (!val) return;
    if (!currentTerms.includes(val)) {
      currentTerms.push(val);
      renderCorpusTagsPool();
      const pName = (shadow.getElementById('modal-profile-name')?.value || '').trim() || currentProfileName || '默认档案';
      if (globalThis.ComicConfigStore) {
        await ComicConfigStore.addTermToProfile(pName, val);
        await ComicConfigStore.bindSiteToProfile(location.href, pName);
      }
      showToast(`已添加专有名词: "${val}" (已即时保存)`);
    }
    if (input) input.value = '';
  }

  async function addNewBlacklist() {
    const input = shadow.getElementById('modal-new-blacklist-input');
    const val = input?.value?.trim();
    if (!val) return;
    if (globalThis.ComicConfigStore) {
      await ComicConfigStore.addToGlobalBlacklist(val);
      currentBlacklist = ComicConfigStore.getGlobalBlacklist();
    } else if (!currentBlacklist.includes(val)) {
      currentBlacklist.push(val);
    }
    if (input) input.value = '';
    renderBlacklistTagsPool();
    showToast(`已将 "${val}" 加入全局水印黑名单`);
  }

  // ==========================================
  // OCR 识别模式与路由端点控制逻辑
  // ==========================================
  const OCR_PRESETS = {
    sensitive: {
      mode: 'sensitive',
      recThresh: 0.50,
      boxThresh: 0.45,
      desc: '<strong style="color:#2ed573;">🟢 敏锐模式生效中</strong>：识别置信度底线放宽至 <span style="font-family:monospace; font-weight:700; color:#86efac;">0.50</span>，候选框门槛 <span style="font-family:monospace; font-weight:700; color:#86efac;">0.45</span>。手写字、暗底对白和拟声小字全部捕获！'
    },
    balanced: {
      mode: 'balanced',
      recThresh: 0.70,
      boxThresh: 0.55,
      desc: '<strong style="color:#fbbf24;">🟡 标准平衡生效中</strong>：识别置信度门槛 <span style="font-family:monospace; font-weight:700; color:#fde68a;">0.70</span>，候选框门槛 <span style="font-family:monospace; font-weight:700; color:#fde68a;">0.55</span>。推荐常规黑白/彩色漫使用，兼顾速度与准确度。'
    },
    strict: {
      mode: 'strict',
      recThresh: 0.82,
      boxThresh: 0.65,
      desc: '<strong style="color:#f87171;">🔴 纯净模式生效中</strong>：识别置信度底线提升至 <span style="font-family:monospace; font-weight:700; color:#fca5a5;">0.82</span>，候选框门槛 <span style="font-family:monospace; font-weight:700; color:#fca5a5;">0.65</span>。强力过滤网点噪点与隐形水印，仅保留高置信对白气泡。'
    }
  };

  function updateOcrRouteCards(isLocal) {
    const cardLocal = shadow.getElementById('ocr-route-card-local');
    const cardCloud = shadow.getElementById('ocr-route-card-cloud');
    if (cardLocal) {
      cardLocal.style.background = isLocal ? 'rgba(46, 213, 115, 0.05)' : 'rgba(255, 255, 255, 0.02)';
      cardLocal.style.borderColor = isLocal ? 'rgba(46, 213, 115, 0.3)' : 'rgba(255, 255, 255, 0.08)';
    }
    if (cardCloud) {
      cardCloud.style.background = isLocal ? 'rgba(255, 255, 255, 0.02)' : 'rgba(56, 189, 248, 0.08)';
      cardCloud.style.borderColor = isLocal ? 'rgba(255, 255, 255, 0.08)' : 'rgba(56, 189, 248, 0.35)';
    }
  }

  function applyOcrPreset(mode, notify = false) {
    const preset = OCR_PRESETS[mode];
    if (!preset) return;

    ['sensitive', 'balanced', 'strict'].forEach(m => {
      const btn = shadow.getElementById(`btn-ocr-${m}`);
      if (btn) {
        if (m === mode) {
          btn.classList.add('active');
          if (m === 'balanced') btn.classList.add('mode-balanced');
          if (m === 'strict') btn.classList.add('mode-strict');
        } else {
          btn.classList.remove('active', 'mode-balanced', 'mode-strict');
        }
      }
    });

    const badge = shadow.getElementById('ocr-custom-badge');
    if (badge) badge.style.display = 'none';

    const sRec = shadow.getElementById('slider-rec-thresh');
    const sBox = shadow.getElementById('slider-box-thresh');
    const lRec = shadow.getElementById('label-rec-thresh-val');
    const lBox = shadow.getElementById('label-box-thresh-val');
    if (sRec) sRec.value = preset.recThresh;
    if (sBox) sBox.value = preset.boxThresh;
    if (lRec) lRec.textContent = preset.recThresh.toFixed(2);
    if (lBox) lBox.textContent = preset.boxThresh.toFixed(2);

    const descCard = shadow.getElementById('ocr-desc-card');
    if (descCard) descCard.innerHTML = preset.desc;

    if (globalThis.ComicConfigStore?.saveOcrSensitivity) {
      void ComicConfigStore.saveOcrSensitivity(location.href, {
        mode: preset.mode,
        recThresh: preset.recThresh,
        boxThresh: preset.boxThresh
      }, true);
    }
    try {
      localStorage.setItem('comic_ocr_rec_score', String(preset.recThresh));
      localStorage.setItem('comic_ocr_det_box_thresh', String(preset.boxThresh));
    } catch {}

    if (notify) {
      const names = { sensitive: '🟢 敏锐模式 (0.50)', balanced: '🟡 标准平衡 (0.70)', strict: '🔴 纯净模式 (0.82)' };
      showToast(`🎯 OCR 已切换为【${names[mode]}】并已保存`);
    }
  }

  function applyCustomOcrSliders(notify = false) {
    const sRec = shadow.getElementById('slider-rec-thresh');
    const sBox = shadow.getElementById('slider-box-thresh');
    const lRec = shadow.getElementById('label-rec-thresh-val');
    const lBox = shadow.getElementById('label-box-thresh-val');
    if (!sRec || !sBox) return;

    const recVal = parseFloat(sRec.value) || 0.50;
    const boxVal = parseFloat(sBox.value) || 0.45;

    if (lRec) lRec.textContent = recVal.toFixed(2);
    if (lBox) lBox.textContent = boxVal.toFixed(2);

    ['sensitive', 'balanced', 'strict'].forEach(m => {
      const btn = shadow.getElementById(`btn-ocr-${m}`);
      if (btn) btn.classList.remove('active', 'mode-balanced', 'mode-strict');
    });

    const badge = shadow.getElementById('ocr-custom-badge');
    if (badge) badge.style.display = 'inline-block';

    const descCard = shadow.getElementById('ocr-desc-card');
    if (descCard) {
      descCard.innerHTML = `<strong style="color:#38bdf8;">⚙️ 自定义参数生效中</strong>：识别置信度底线 <span style="font-family:monospace; font-weight:700; color:#7dd3fc;">${recVal.toFixed(2)}</span>，候选框门槛 <span style="font-family:monospace; font-weight:700; color:#7dd3fc;">${boxVal.toFixed(2)}</span>。`;
    }

    if (globalThis.ComicConfigStore?.saveOcrSensitivity) {
      void ComicConfigStore.saveOcrSensitivity(location.href, {
        mode: 'custom',
        recThresh: recVal,
        boxThresh: boxVal
      }, true);
    }
    try {
      localStorage.setItem('comic_ocr_rec_score', String(recVal));
      localStorage.setItem('comic_ocr_det_box_thresh', String(boxVal));
    } catch {}

    if (notify) {
      showToast(`⚙️ OCR 阈值已更新：置信度 ${recVal.toFixed(2)} / 检测框 ${boxVal.toFixed(2)}`);
    }
  }

  function setupOcrTabInteractions() {
    ['sensitive', 'balanced', 'strict'].forEach(m => {
      const btn = shadow.getElementById(`btn-ocr-${m}`);
      if (btn) {
        btn.addEventListener('click', () => applyOcrPreset(m, true));
      }
    });

    const btnToggleDrawer = shadow.getElementById('btn-toggle-custom-drawer');
    const drawer = shadow.getElementById('ocr-custom-drawer');
    const arrow = shadow.getElementById('ocr-custom-arrow');
    if (btnToggleDrawer && drawer) {
      btnToggleDrawer.addEventListener('click', () => {
        const isCollapsed = drawer.classList.contains('collapsed');
        if (isCollapsed) {
          drawer.classList.remove('collapsed');
          if (arrow) arrow.textContent = '▲ 收起';
        } else {
          drawer.classList.add('collapsed');
          if (arrow) arrow.textContent = '▼ 展开';
        }
      });
    }

    const sRec = shadow.getElementById('slider-rec-thresh');
    const sBox = shadow.getElementById('slider-box-thresh');
    if (sRec) {
      sRec.addEventListener('input', () => applyCustomOcrSliders(false));
      sRec.addEventListener('change', () => applyCustomOcrSliders(true));
    }
    if (sBox) {
      sBox.addEventListener('input', () => applyCustomOcrSliders(false));
      sBox.addEventListener('change', () => applyCustomOcrSliders(true));
    }

    const radLocal = shadow.getElementById('radio-mode-local');
    const radCloud = shadow.getElementById('radio-mode-cloud');
    if (radLocal && radCloud) {
      radLocal.addEventListener('change', () => {
        updateOcrRouteCards(true);
        if (globalThis.ComicConfigStore?.setUseLocalBackend) {
          void ComicConfigStore.setUseLocalBackend(true);
        }
        showToast('📱 已切换为手机端本地硬件加速');
      });
      radCloud.addEventListener('change', () => {
        updateOcrRouteCards(false);
        if (globalThis.ComicConfigStore?.setUseLocalBackend) {
          void ComicConfigStore.setUseLocalBackend(false);
        }
        showToast('☁️ 已切换为云端 Serverless / 自建 Docker 服务');
      });
    }

    const btnResetLocal = shadow.getElementById('btn-reset-local-url');
    const inputLocalUrl = shadow.getElementById('modal-ocr-local-url');
    if (btnResetLocal && inputLocalUrl) {
      btnResetLocal.addEventListener('click', () => {
        inputLocalUrl.value = 'http://127.0.0.1:8080';
        if (globalThis.ComicConfigStore?.setLocalApiUrl) {
          void ComicConfigStore.setLocalApiUrl('http://127.0.0.1:8080');
        }
        try {
          localStorage.setItem('comic_local_api_url', 'http://127.0.0.1:8080');
        } catch {}
        showToast('🔄 本地端点已重置为 127.0.0.1:8080');
      });
    }

    if (inputLocalUrl) {
      inputLocalUrl.addEventListener('change', () => {
        const val = inputLocalUrl.value.trim() || 'http://127.0.0.1:8080';
        if (globalThis.ComicConfigStore?.setLocalApiUrl) {
          void ComicConfigStore.setLocalApiUrl(val);
        }
        try { localStorage.setItem('comic_local_api_url', val); } catch {}
      });
    }
    const inputCloudUrl = shadow.getElementById('modal-ocr-cloud-url');
    if (inputCloudUrl) {
      inputCloudUrl.addEventListener('change', () => {
        const val = inputCloudUrl.value.trim();
        if (globalThis.ComicConfigStore?.setCloudApiUrl) {
          void ComicConfigStore.setCloudApiUrl(val);
        }
        try { localStorage.setItem('comic_cloud_api_url', val); } catch {}
      });
    }
  }

  function loadOcrTabState() {
    try {
      const sens = globalThis.ComicConfigStore?.getOcrSensitivity ?
                   ComicConfigStore.getOcrSensitivity(location.href) :
                   { mode: 'sensitive', recThresh: 0.50, boxThresh: 0.45, isBound: false };

      const anchorTag = shadow.getElementById('ocr-comic-anchor-tag');
      if (anchorTag) {
        if (sens.isBound) {
          anchorTag.textContent = '📖 当前漫画专属记忆 (已生效)';
          anchorTag.style.color = '#2ed573';
        } else {
          anchorTag.textContent = '📖 当前漫画专属记忆';
          anchorTag.style.color = '#38bdf8';
        }
      }

      if (sens.mode === 'sensitive' || sens.mode === 'balanced' || sens.mode === 'strict') {
        applyOcrPreset(sens.mode, false);
      } else {
        const sRec = shadow.getElementById('slider-rec-thresh');
        const sBox = shadow.getElementById('slider-box-thresh');
        const lRec = shadow.getElementById('label-rec-thresh-val');
        const lBox = shadow.getElementById('label-box-thresh-val');
        const badge = shadow.getElementById('ocr-custom-badge');
        const descCard = shadow.getElementById('ocr-desc-card');
        const drawer = shadow.getElementById('ocr-custom-drawer');
        const arrow = shadow.getElementById('ocr-custom-arrow');

        ['sensitive', 'balanced', 'strict'].forEach(m => {
          shadow.getElementById(`btn-ocr-${m}`)?.classList.remove('active', 'mode-balanced', 'mode-strict');
        });

        const rVal = sens.recThresh ?? 0.50;
        const bVal = sens.boxThresh ?? 0.45;
        if (sRec) sRec.value = rVal;
        if (sBox) sBox.value = bVal;
        if (lRec) lRec.textContent = Number(rVal).toFixed(2);
        if (lBox) lBox.textContent = Number(bVal).toFixed(2);
        if (badge) badge.style.display = 'inline-block';
        if (drawer) drawer.classList.remove('collapsed');
        if (arrow) arrow.textContent = '▲ 收起';
        if (descCard) {
          descCard.innerHTML = `<strong style="color:#38bdf8;">⚙️ 自定义参数生效中</strong>：识别置信度底线 <span style="font-family:monospace; font-weight:700; color:#7dd3fc;">${Number(rVal).toFixed(2)}</span>，候选框门槛 <span style="font-family:monospace; font-weight:700; color:#7dd3fc;">${Number(bVal).toFixed(2)}</span>。`;
        }
      }

      const isLocal = globalThis.ComicConfigStore?.getUseLocalBackend ?
                      ComicConfigStore.getUseLocalBackend() :
                      (localStorage.getItem('comic_dev_enable_capture') !== '0');
      const localUrl = (globalThis.ComicConfigStore?.getLocalApiUrl ? ComicConfigStore.getLocalApiUrl() : null) ||
                       localStorage.getItem('comic_local_api_url') || 'http://127.0.0.1:8080';
      const cloudUrl = (globalThis.ComicConfigStore?.getCloudApiUrl ? ComicConfigStore.getCloudApiUrl() : null) ||
                       localStorage.getItem('comic_cloud_api_url') || '';

      const inputLocal = shadow.getElementById('modal-ocr-local-url');
      const inputCloud = shadow.getElementById('modal-ocr-cloud-url');
      if (inputLocal) inputLocal.value = localUrl;
      if (inputCloud) inputCloud.value = cloudUrl;

      const radLocal = shadow.getElementById('radio-mode-local');
      const radCloud = shadow.getElementById('radio-mode-cloud');
      if (radLocal) radLocal.checked = isLocal;
      if (radCloud) radCloud.checked = !isLocal;
      updateOcrRouteCards(isLocal);
    } catch (e) {
      console.warn('[FloatingBall] loadOcrTabState 异常:', e);
    }
  }

  function setupModalInteractions() {
    modalOverlay.addEventListener('click', (e) => {
      if (e.target === modalOverlay) closeModal();
    });
    shadow.getElementById('modal-close-btn').addEventListener('click', closeModal);
    shadow.getElementById('modal-confirm-btn').addEventListener('click', () => {
      saveModalData();
      closeModal();
    });

    // 绑定 OCR 服务与灵敏度事件
    setupOcrTabInteractions();

    // 选项卡切换
    const tabBtns = shadow.querySelectorAll('.modal-tab-btn');
    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        tabBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const tab = btn.dataset.tab;
        shadow.getElementById('tab-pane-models').style.display = tab === 'models' ? 'flex' : 'none';
        shadow.getElementById('tab-pane-ocr').style.display = tab === 'ocr' ? 'flex' : 'none';
        shadow.getElementById('tab-pane-corpus').style.display = tab === 'corpus' ? 'flex' : 'none';
        shadow.getElementById('tab-pane-errors').style.display = tab === 'errors' ? 'flex' : 'none';
      });
    });

    // 语料库：档案名联想下拉
    const profileInput = shadow.getElementById('modal-profile-name');
    const dropdown = shadow.getElementById('modal-profile-dropdown');
    if (profileInput) {
      profileInput.addEventListener('focus', () => showProfileSuggestions(profileInput.value));
      profileInput.addEventListener('input', (e) => showProfileSuggestions(e.target.value));
    }
    document.addEventListener('pointerdown', (e) => {
      if (dropdown && profileInput && !profileInput.contains(e.target) && !dropdown.contains(e.target)) {
        dropdown.classList.remove('show');
      }
    });

    // 语料库：添加专有名词
    const btnAddTerm = shadow.getElementById('modal-btn-add-term');
    if (btnAddTerm) btnAddTerm.addEventListener('click', addNewTerm);
    const newTermInput = shadow.getElementById('modal-new-term-input');
    if (newTermInput) {
      newTermInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          addNewTerm();
        }
      });
    }

    // 语料库：添加黑名单与手风琴折叠
    const btnAddBl = shadow.getElementById('modal-btn-add-blacklist');
    if (btnAddBl) btnAddBl.addEventListener('click', addNewBlacklist);
    const newBlInput = shadow.getElementById('modal-new-blacklist-input');
    if (newBlInput) {
      newBlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          addNewBlacklist();
        }
      });
    }
    const accBtn = shadow.getElementById('modal-accordion-toggle-btn');
    const acc = shadow.getElementById('modal-blacklist-accordion');
    if (accBtn && acc) {
      accBtn.addEventListener('click', () => {
        acc.classList.toggle('open');
      });
    }

    // 气泡微调弹窗事件绑定
    const bubbleCloseBtn = shadow.getElementById('btn-bubble-close');
    if (bubbleCloseBtn) bubbleCloseBtn.addEventListener('click', closeBubbleModal);
    const bubbleOverlay = shadow.getElementById('bubble-modal-overlay');
    if (bubbleOverlay) {
      bubbleOverlay.addEventListener('click', (e) => {
        if (e.target === bubbleOverlay) closeBubbleModal();
      });
    }

    const btnBubbleDone = shadow.getElementById('btn-bubble-done');
    if (btnBubbleDone) {
      btnBubbleDone.addEventListener('click', () => {
        if (!activeBubbleData) return closeBubbleModal();
        const newTarget = shadow.getElementById('input-bubble-correction')?.value?.trim();
        if (newTarget) {
          const curTrans = activeBubbleData.transText || '';
          const oldTerm = selectedBubbleToken;
          let newTrans = curTrans;

          if (oldTerm && curTrans.includes(oldTerm)) {
            newTrans = curTrans.split(oldTerm).join(newTarget);
          } else if (!curTrans) {
            newTrans = newTarget;
          } else if (oldTerm) {
            newTrans = curTrans + ` (${newTarget})`;
          } else {
            newTrans = newTarget;
          }

          if (globalThis.ComicConfigStore) {
            const curProfile = ComicConfigStore.getCurrentProfile(location.href);
            if (curProfile?.profileName) {
              void ComicConfigStore.addTermToProfile(curProfile.profileName, newTarget);
              void ComicConfigStore.bindSiteToProfile(location.href, curProfile.profileName);
            }
          }

          if (typeof activeBubbleData.onUpdate === 'function') {
            activeBubbleData.onUpdate(newTrans, oldTerm, newTarget);
          }
          showToast(`✔ 已将 "${oldTerm || '原译文'}" 替换为 "${newTarget}" 并存入语料库！`);
        }
        closeBubbleModal();
      });
    }

    const inputBubbleCorrection = shadow.getElementById('input-bubble-correction');
    if (inputBubbleCorrection) {
      inputBubbleCorrection.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          shadow.getElementById('btn-bubble-done')?.click();
        }
      });
    }

    const btnBubbleBl = shadow.getElementById('btn-bubble-blacklist');
    if (btnBubbleBl) {
      btnBubbleBl.addEventListener('click', () => {
        if (!activeBubbleData) return closeBubbleModal();
        const raw = (activeBubbleData.rawText || '').trim();
        if (raw && globalThis.ComicConfigStore) {
          void ComicConfigStore.addToGlobalBlacklist(raw);
        }
        if (typeof activeBubbleData.onBlacklist === 'function') {
          activeBubbleData.onBlacklist(raw);
        }
        showToast(`🚫 已将 "${raw}" 加入全网水印黑名单！`);
        closeBubbleModal();
      });
    }

    // 添加厂商
    shadow.getElementById('btn-add-provider').addEventListener('click', () => {
      const providers = getStoredProviders();
      providers.push({
        id: 'p_' + Date.now(),
        name: '自定义平台',
        url: 'https://api.openai.com/v1',
        key: '',
        models: ['gpt-4o-mini', 'claude-3-5-haiku']
      });
      saveStoredProviders(providers);
      renderModalProviders();
    });

    // 复制错误
    // 📥 下载诊断报告 (.txt) - 移动端全量下载
    const btnDownloadDevReport = shadow.getElementById('btn-download-dev-report');
    if (btnDownloadDevReport) {
      btnDownloadDevReport.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (globalThis.ComicPacketInspector?.downloadDiagnosticReport) {
          try {
            await globalThis.ComicPacketInspector.downloadDiagnosticReport();
            showToast('💾 诊断报告已自动下载！');
          } catch (err) {
            showToast('导出报告失败: ' + (err?.message || err));
          }
        } else if (globalThis.ComicDebugHUD?.downloadReport) {
          try {
            await globalThis.ComicDebugHUD.downloadReport();
            showToast('💾 诊断报告已自动下载！');
          } catch (err) {
            showToast('导出报告失败: ' + (err?.message || err));
          }
        } else {
          showToast('Dev 诊断模块尚未就绪');
        }
      });
    }

    // 辅助线与切线即时开关
    const btnTogglePreview = shadow.getElementById('btn-toggle-preview');
    if (btnTogglePreview) {
      btnTogglePreview.addEventListener('click', () => {
        let next = true;
        if (globalThis.ComicImageCapture?.togglePreview) {
          next = globalThis.ComicImageCapture.togglePreview();
        }
        if (next) {
          btnTogglePreview.textContent = '🟢 已开启';
          btnTogglePreview.style.borderColor = 'rgba(56, 189, 248, 0.4)';
          btnTogglePreview.style.background = 'rgba(56, 189, 248, 0.2)';
          btnTogglePreview.style.color = '#38bdf8';
          showToast('🟢 切片辅助线与切线已开启');
        } else {
          btnTogglePreview.textContent = '⚪ 已关闭';
          btnTogglePreview.style.borderColor = 'rgba(148, 163, 184, 0.2)';
          btnTogglePreview.style.background = '#334155';
          btnTogglePreview.style.color = '#94a3b8';
          showToast('⚪ 已关闭切片辅助线与切线');
        }
      });
    }

    // 🌟 手动唤起 Dev HUD 面板 (单次会话生效，默认不自启)
    const btnLaunchDev = shadow.getElementById('btn-launch-dev-hud');
    if (btnLaunchDev) {
      btnLaunchDev.addEventListener('click', () => {
        closeModal();
        if (globalThis.ComicDebugHUD?.openOnce) {
          globalThis.ComicDebugHUD.openOnce();
        } else if (globalThis.ComicDebugHUD?.enable) {
          globalThis.ComicDebugHUD.enable();
        }
        showToast('🚀 已在当前页面唤起 Dev 测试看板（单次生效）');
      });
    }

    // 🔤 字号下限滑动调节与实时联动更新已有补丁
    const sliderMinFont = shadow.getElementById('slider-min-font-size');
    const labelMinFontVal = shadow.getElementById('label-min-font-size-val');
    const btnDecMinFont = shadow.getElementById('btn-dec-min-font');
    const btnIncMinFont = shadow.getElementById('btn-inc-min-font');

    function applyUserMinFont(val, notifyUser = false) {
      const parsed = Math.max(10, Math.min(22, parseInt(val, 10) || 13));
      if (sliderMinFont) sliderMinFont.value = parsed;
      if (labelMinFontVal) labelMinFontVal.textContent = `${parsed} px`;
      if (globalThis.ComicConfigStore?.setMinFontSize) {
        void ComicConfigStore.setMinFontSize(parsed);
      } else {
        localStorage.setItem('comic_min_font_size', String(parsed));
      }
      if (globalThis.ComicImageCapture?.setMinFontSize) {
        globalThis.ComicImageCapture.setMinFontSize(parsed);
      }
      if (notifyUser) {
        showToast(`🔤 最小字号已设为 ${parsed}px，已联动更新页面所有补丁！`);
      }
    }

    if (sliderMinFont) {
      sliderMinFont.addEventListener('input', (e) => {
        applyUserMinFont(e.target.value, false);
      });
      sliderMinFont.addEventListener('change', (e) => {
        applyUserMinFont(e.target.value, true);
      });
    }
    if (btnDecMinFont) {
      btnDecMinFont.addEventListener('click', () => {
        const cur = parseInt(sliderMinFont?.value, 10) || 13;
        applyUserMinFont(cur - 1, true);
      });
    }
    if (btnIncMinFont) {
      btnIncMinFont.addEventListener('click', () => {
        const cur = parseInt(sliderMinFont?.value, 10) || 13;
        applyUserMinFont(cur + 1, true);
      });
    }

    // 📱 移动端软键盘动态避让与输入框自动平滑居中
    const modalCard = shadow.querySelector('.settings-modal-card');
    function adaptModalToViewport() {
      if (!modalOverlay || modalOverlay.hasAttribute('hidden')) return;
      if (window.visualViewport) {
        const vv = window.visualViewport;
        const totalHeight = window.innerHeight;
        const keyboardHeight = Math.max(0, totalHeight - vv.height);

        if (keyboardHeight > 100) {
          modalOverlay.style.alignItems = 'flex-start';
          modalOverlay.style.paddingTop = `${Math.max(6, vv.offsetTop + 6)}px`;
          modalOverlay.style.height = `${vv.height}px`;
          if (modalCard) {
            modalCard.style.maxHeight = `${Math.max(160, vv.height - 12)}px`;
          }
        } else {
          modalOverlay.style.alignItems = 'center';
          modalOverlay.style.paddingTop = '14px';
          modalOverlay.style.height = '';
          if (modalCard) {
            modalCard.style.maxHeight = '85vh';
          }
        }
      }
    }

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', () => {
        adaptModalToViewport();
        const activeEl = shadow.activeElement;
        if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
          setTimeout(() => {
            activeEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }, 150);
        }
      });
      window.visualViewport.addEventListener('scroll', adaptModalToViewport);
    }

    // 针对语料输入框等所有输入控件，获得焦点时平滑滚动至视口中心
    const focusTarget = typeof shadow.addEventListener === 'function' ? shadow : (typeof document !== 'undefined' ? document : null);
    if (focusTarget && typeof focusTarget.addEventListener === 'function') {
      focusTarget.addEventListener('focusin', (e) => {
        const target = e.target;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
          setTimeout(() => {
            target.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
          }, 250);
        }
      });
    }
  }

  function openBubbleModal(data) {
    activeBubbleData = data;
    selectedBubbleToken = null;

    const overlay = shadow.getElementById('bubble-modal-overlay');
    const previewEl = shadow.getElementById('bubble-trans-preview');
    const inputEl = shadow.getElementById('input-bubble-correction');
    const wordArea = shadow.getElementById('bubble-word-blocks-area');

    if (!overlay || !previewEl || !inputEl || !wordArea) return;

    previewEl.textContent = data.transText || data.rawText || '...';
    inputEl.value = '';
    inputEl.placeholder = '点选上方分词进行修正...';

    // 渲染分词 Chips
    wordArea.innerHTML = '';
    const raw = data.rawText || '';
    const tokens = raw.match(/\S+|\s+/g) || raw.split('');

    tokens.forEach(tok => {
      if (/^\s+$/.test(tok)) return;
      const clean = tok.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g, '');
      const chip = document.createElement('div');
      chip.className = 'word-chip';
      chip.textContent = tok;

      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        const isSel = chip.classList.contains('selected');
        wordArea.querySelectorAll('.word-chip').forEach(c => c.classList.remove('selected'));

        if (!isSel) {
          chip.classList.add('selected');
          selectedBubbleToken = clean || tok;
          inputEl.placeholder = `将 "${selectedBubbleToken}" 修正为...`;
          inputEl.focus();
        } else {
          selectedBubbleToken = null;
          inputEl.placeholder = '点选上方分词进行修正...';
        }
      });

      wordArea.appendChild(chip);
    });

    overlay.removeAttribute('hidden');
  }

  function closeBubbleModal() {
    const overlay = shadow.getElementById('bubble-modal-overlay');
    if (overlay) overlay.setAttribute('hidden', '');
    activeBubbleData = null;
    selectedBubbleToken = null;
  }

  globalThis.ComicBubbleModal = Object.freeze({
    open: openBubbleModal,
    close: closeBubbleModal
  });

  function openModal() {
    modalOverlay.removeAttribute('hidden');
    renderModalProviders();
    renderErrorsTab();
    updateErrorBadge();

    // 语料库与世界观加载
    loadCorpusTab();

    // OCR 灵敏度与服务路由状态加载
    loadOcrTabState();

    // 加载调试与优化状态
    try {
      const btnTogglePreview = shadow.getElementById('btn-toggle-preview');
      if (btnTogglePreview) {
        const isAct = globalThis.ComicImageCapture?.isPreviewActive ? globalThis.ComicImageCapture.isPreviewActive() : false;
        if (isAct) {
          btnTogglePreview.textContent = '🟢 已开启';
          btnTogglePreview.style.borderColor = 'rgba(56, 189, 248, 0.4)';
          btnTogglePreview.style.background = 'rgba(56, 189, 248, 0.2)';
          btnTogglePreview.style.color = '#38bdf8';
        } else {
          btnTogglePreview.textContent = '⚪ 已关闭';
          btnTogglePreview.style.borderColor = 'rgba(148, 163, 184, 0.2)';
          btnTogglePreview.style.background = '#334155';
          btnTogglePreview.style.color = '#94a3b8';
        }
      }
    } catch {}

    // 加载字号下限
    try {
      const curMinFont = (globalThis.ComicConfigStore?.getMinFontSize ? ComicConfigStore.getMinFontSize() : (parseInt(localStorage.getItem('comic_min_font_size'), 10) || 13));
      const sliderMinFont = shadow.getElementById('slider-min-font-size');
      const labelMinFontVal = shadow.getElementById('label-min-font-size-val');
      if (sliderMinFont && labelMinFontVal) {
        sliderMinFont.value = curMinFont;
        labelMinFontVal.textContent = `${curMinFont} px`;
      }
    } catch {}
  }

  function closeModal() {
    // 自动持久化当前填写的世界观与专有名词，杜绝未点保存导致丢词
    const pName = (shadow.getElementById('modal-profile-name')?.value || '').trim() || currentProfileName || '默认档案';
    const wvInput = shadow.getElementById('modal-worldview-input');
    if (wvInput && globalThis.ComicConfigStore) {
      const wv = wvInput.value?.trim() || '';
      void ComicConfigStore.saveProfile(pName, {
        worldview: wv,
        referenceTerms: currentTerms
      });
      void ComicConfigStore.bindSiteToProfile(location.href, pName);
    }
    modalOverlay.setAttribute('hidden', '');
    if (modalOverlay) {
      modalOverlay.style.alignItems = 'center';
      modalOverlay.style.paddingTop = '14px';
      modalOverlay.style.height = '';
    }
    const modalCard = shadow.querySelector('.settings-modal-card');
    if (modalCard) {
      modalCard.style.maxHeight = '85vh';
    }
    renderMenuModelList();
  }

  function saveModalData() {
    const profileName = (shadow.getElementById('modal-profile-name')?.value || '').trim() || currentProfileName || '默认档案';
    const worldview = shadow.getElementById('modal-worldview-input')?.value?.trim() || '';

    const localUrl = shadow.getElementById('modal-ocr-local-url')?.value?.trim() || 'http://127.0.0.1:8080';
    const cloudUrl = shadow.getElementById('modal-ocr-cloud-url')?.value?.trim() || '';
    const isLocal = Boolean(shadow.getElementById('radio-mode-local')?.checked);

    const recVal = parseFloat(shadow.getElementById('slider-rec-thresh')?.value) || 0.50;
    const boxVal = parseFloat(shadow.getElementById('slider-box-thresh')?.value) || 0.45;

    let currentMode = 'custom';
    if (shadow.getElementById('btn-ocr-sensitive')?.classList.contains('active')) currentMode = 'sensitive';
    else if (shadow.getElementById('btn-ocr-balanced')?.classList.contains('active')) currentMode = 'balanced';
    else if (shadow.getElementById('btn-ocr-strict')?.classList.contains('active')) currentMode = 'strict';

    if (globalThis.ComicConfigStore) {
      // 1. 保存漫画档案数据
      void ComicConfigStore.saveProfile(profileName, {
        worldview,
        referenceTerms: currentTerms
      });
      // 2. 绑定当前网址与该档案
      void ComicConfigStore.bindSiteToProfile(location.href, profileName);

      // 3. 保存本地与云端 OCR 地址与模式
      void ComicConfigStore.setLocalApiUrl(localUrl);
      void ComicConfigStore.setCloudApiUrl(cloudUrl);
      void ComicConfigStore.setUseLocalBackend(isLocal);

      // 4. 保存 OCR 灵敏度与阈值
      void ComicConfigStore.saveOcrSensitivity(location.href, {
        mode: currentMode,
        recThresh: recVal,
        boxThresh: boxVal
      }, true);
    }

    // 兼容遗留 localStorage
    try {
      localStorage.setItem('comic_local_api_url', localUrl);
      localStorage.setItem('comic_cloud_api_url', cloudUrl);
      localStorage.setItem('comic_dev_enable_capture', isLocal ? '1' : '0');

      localStorage.setItem('comic_ocr_det_box_thresh', String(boxVal));
      localStorage.setItem('comic_ocr_rec_score', String(recVal));
      localStorage.setItem('comic_slice_concurrency', '6');
    } catch {}

    showToast(`💾 档案【${profileName}】与参数已保存！`);
  }

  // 渲染厂商列表
  function renderModalProviders() {
    const container = shadow.getElementById('modal-providers-container');
    if (!container) return;
    container.innerHTML = '';
    const providers = getStoredProviders();
    const activeId = getActiveProviderId();

    providers.forEach(provider => {
      const isActive = provider.id === activeId;
      const card = document.createElement('div');
      card.className = `provider-card ${isActive ? 'active' : ''}`;

      card.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div style="display:flex; align-items:center; gap:6px;">
            <input type="radio" name="modal-active-provider" ${isActive ? 'checked' : ''} class="provider-radio" style="accent-color:#2ed573; cursor:pointer;">
            <input type="text" class="provider-name input-text" value="${provider.name}" style="font-weight:700; width:130px; padding:3px 6px; font-size:12px;">
          </div>
          <div style="display:flex; align-items:center; gap:6px;">
            <span style="font-size:10px; color:${isActive ? '#2ed573' : '#64748b'}; font-weight:${isActive ? 'bold' : 'normal'};">${isActive ? '● 当前激活' : '未激活'}</span>
            <button class="btn-del-provider" style="background:none; border:none; color:#64748b; cursor:pointer; font-size:12px; padding:2px 4px;">✕</button>
          </div>
        </div>
        <div>
          <span class="form-label">API Base URL</span>
          <input type="text" class="provider-url input-text" value="${provider.url}" placeholder="https://api.openai.com/v1" style="font-family:monospace; font-size:11px;">
        </div>
        <div>
          <span class="form-label">API Key</span>
          <input type="password" class="provider-key input-text" value="${provider.key}" placeholder="sk-..." style="font-family:monospace; font-size:11px;">
        </div>
        <div>
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span class="form-label">模型列表 (支持空格或逗号隔开)</span>
            <span style="font-size:10px; color:#64748b;">${provider.models.length} 个模型</span>
          </div>
          <!-- 🌟 核心需求：支持空格或逗号自由隔开输入 -->
          <input type="text" class="provider-models input-text" value="${provider.models.join(' ')}" placeholder="deepseek-chat deepseek-coder" style="font-family:monospace; font-size:11px;">
        </div>
      `;

      // 切换激活平台
      card.querySelector('.provider-radio').addEventListener('change', () => {
        setActiveProviderId(provider.id);
        if (provider.models.length > 0) setActiveModel(provider.models[0]);
        renderModalProviders();
        renderMenuModelList();
      });

      // 动态修改保存
      card.querySelector('.provider-name').addEventListener('change', (e) => {
        provider.name = e.target.value.trim();
        saveStoredProviders(providers);
        renderMenuModelList();
      });
      card.querySelector('.provider-url').addEventListener('change', (e) => {
        provider.url = e.target.value.trim();
        saveStoredProviders(providers);
      });
      card.querySelector('.provider-key').addEventListener('change', (e) => {
        provider.key = e.target.value.trim();
        saveStoredProviders(providers);
      });
      // 🌟 核心需求：模型列表支持空格或逗号分割：/[\s,]+/
      card.querySelector('.provider-models').addEventListener('change', (e) => {
        provider.models = e.target.value.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
        saveStoredProviders(providers);
        if (isActive && !provider.models.includes(getActiveModel())) {
          setActiveModel(provider.models[0] || 'none');
        }
        renderMenuModelList();
      });

      // 删除平台
      card.querySelector('.btn-del-provider').addEventListener('click', () => {
        if (providers.length <= 1) return alert('请至少保留一个模型厂商配置');
        const next = providers.filter(p => p.id !== provider.id);
        saveStoredProviders(next);
        if (getActiveProviderId() === provider.id) setActiveProviderId(next[0].id);
        renderModalProviders();
        renderMenuModelList();
      });

      container.appendChild(card);
    });
  }

  // 渲染错误信息 (紧凑卡片展示，移动端不拉长)
  function renderErrorsTab() {
    const container = shadow.getElementById('modal-error-status-box');
    if (!container) return;
    container.innerHTML = '';
    const errors = ErrorTracker.list();

    const badge = shadow.getElementById('setting-error-count-badge');
    if (badge) {
      badge.textContent = errors.length > 0 ? `(已拦截 ${errors.length} 处异常)` : '(暂无拦截异常)';
      badge.style.color = errors.length > 0 ? '#f87171' : '#94a3b8';
    }

    if (errors.length === 0) {
      container.innerHTML = `
        <div style="padding:10px; text-align:center; color:#64748b; font-size:11px; font-family:monospace; line-height:1.6;">
          ✓ 暂无拦截到的运行异常，切片与推理运行顺畅<br>
          <span style="font-size:10px; color:#94a3b8;">可随时点击右上角【下载报告】导出排查文件</span>
        </div>
      `;
      return;
    }

    const lastErr = errors[0];
    container.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
        <span style="color:#f87171; font-weight:bold;">⚠️ 已拦截 ${errors.length} 处切片/网络异常</span>
        <span style="color:#64748b; font-size:10px;">最近: ${lastErr.time || ''}</span>
      </div>
      <div style="background:rgba(239,68,68,0.1); border:1px solid rgba(239,68,68,0.25); border-radius:6px; padding:6px 8px; color:#cbd5e1; font-size:10px; word-break:break-all;">
        <span style="color:#f87171; font-weight:bold;">● ${escapeHtml(lastErr.type || '异常')}</span>
        <span style="color:#fbbf24; margin-left:6px;">[${escapeHtml(lastErr.sliceTag || '切片')}]</span>:
        <span style="color:#94a3b8; margin-left:4px;">${escapeHtml(String(lastErr.detail || '').slice(0, 120))}${String(lastErr.detail || '').length > 120 ? '...' : ''}</span>
      </div>
      <div style="margin-top:6px; display:flex; justify-content:space-between; align-items:center;">
        <span style="font-size:10px; color:#94a3b8;">排查建议：点击右上角【下载报告】直接获取完整 txt 日志</span>
        <button id="btn-compact-goto-dev" style="background:rgba(14,165,233,0.15); color:#38bdf8; border:1px solid rgba(56,189,248,0.3); border-radius:4px; padding:2px 8px; font-size:10px; cursor:pointer; font-weight:bold;">
          🔍 唤起 Dev
        </button>
      </div>
    `;

    const gotoDevBtn = container.querySelector('#btn-compact-goto-dev');
    if (gotoDevBtn) {
      gotoDevBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeModal();
        if (globalThis.ComicDebugHUD?.openOnce) {
          globalThis.ComicDebugHUD.openOnce();
        } else if (globalThis.ComicDebugHUD?.enable) {
          globalThis.ComicDebugHUD.enable();
        }
      });
    }
  }

  function updateErrorBadge() {
    const errors = ErrorTracker.list();

    const badge = shadow.getElementById('modal-error-badge');
    if (badge) {
      if (errors.length > 0) {
        badge.textContent = errors.length;
        badge.style.display = 'inline';
      } else {
        badge.style.display = 'none';
      }
    }
  }

  // ========================================================
  // 7. 视口定位与自适应布局 (保留原有成熟算法)
  // ========================================================
  function setVisible(next) {
    host.style.display = next ? 'block' : 'none';
    if (!next) closeMenu();
  }

  function clipBounds(element) {
    let top = 0;
    let bottom = innerHeight;
    let left = 0;
    let right = innerWidth;
    for (let node = element.parentElement; node && node !== document.documentElement; node = node.parentElement) {
      const style = getComputedStyle(node);
      const clipY = /(auto|scroll|hidden|clip)/.test(style.overflowY || style.overflow || '');
      const clipX = /(auto|scroll|hidden|clip)/.test(style.overflowX || style.overflow || '');
      if (!clipY && !clipX) continue;
      const rect = node.getBoundingClientRect();
      if (clipY) {
        top = Math.max(top, rect.top);
        bottom = Math.min(bottom, rect.bottom);
      }
      if (clipX) {
        left = Math.max(left, rect.left);
        right = Math.min(right, rect.right);
      }
    }
    return { top, bottom, left, right };
  }

  function layout() {
    frame = 0;
    if (!reader?.firstImage || reader.firstImage.isConnected === false || reader.root?.isConnected === false) {
      if (host) setVisible(false);
      return;
    }
    const isRunning = captureStatus.running || captureStatus.starting;
    const first = reader.firstImage.getBoundingClientRect();
    const rootRect = reader.root.getBoundingClientRect();

    let lastBottom = rootRect.bottom;
    if (reader.lastImage?.isConnected) {
      const last = reader.lastImage.getBoundingClientRect();
      lastBottom = Math.max(last.bottom, rootRect.bottom);
    }
    const allImgs = reader.root.querySelectorAll?.('img') || [];
    if (allImgs.length > 0) {
      for (let i = allImgs.length - 1; i >= Math.max(0, allImgs.length - 5); i--) {
        const b = allImgs[i].getBoundingClientRect().bottom;
        if (b > lastBottom) lastBottom = b;
      }
    }

    // 垂直 Y 轴：优先以漫画容器起点为基准，兼顾 DOM 树顺序中靠前的占位图，解决懒加载（如第 3 张图先加载）导致的跳跃或隐形
    let startY = first.top;
    if (rootRect && typeof rootRect.top === 'number') {
      startY = Math.min(startY, rootRect.top);
    }
    if (allImgs.length > 0) {
      for (let i = 0; i < Math.min(5, allImgs.length); i++) {
        const r = allImgs[i].getBoundingClientRect?.();
        if (r && typeof r.top === 'number') {
          if (r.top < startY && r.bottom > (rootRect?.top ?? -Infinity)) {
            startY = Math.min(startY, r.top);
          }
        }
      }
    }

    // 水平 X 轴：继承漫画切片实际渲染列的左边缘，防止 PC 宽屏居中排版时球飞到屏幕极左边缘
    let comicLeft = (first && typeof first.left === 'number' && (first.width > 0 || first.right > first.left)) ? first.left : null;
    if (comicLeft === null && allImgs.length > 0) {
      for (let i = 0; i < allImgs.length; i++) {
        const r = allImgs[i].getBoundingClientRect?.();
        if (r && r.width >= 100) {
          comicLeft = r.left;
          break;
        }
      }
    }
    if (comicLeft === null && rootRect && typeof rootRect.left === 'number') {
      comicLeft = rootRect.left;
    }
    if (comicLeft === null) comicLeft = 0;

    let comicRight = (first && typeof first.right === 'number' && first.right > first.left) ? first.right : null;
    if (comicRight === null && rootRect && typeof rootRect.right === 'number') {
      comicRight = rootRect.right;
    }
    if (comicRight === null) comicRight = comicLeft + 800;

    const clip = clipBounds(reader.root || reader.firstImage);
    const safeTop = Math.max(SAFE_TOP, clip.top + INSET);
    const safeBottom = Math.min(innerHeight - INSET, clip.bottom - INSET);
    const safeLeft = Math.max(INSET, clip.left + INSET);
    const safeRight = Math.min(innerWidth - INSET, clip.right - INSET);

    if (!isRunning) {
      if (startY + INSET > safeBottom - SIZE || lastBottom - SIZE < safeTop ||
          comicRight <= safeLeft || comicLeft >= safeRight) {
        setVisible(false);
        return;
      }
    }

    const endY = Math.min(lastBottom - SIZE - INSET, safeBottom - SIZE);
    const x = Math.max(safeLeft, Math.min(safeRight - SIZE, comicLeft + INSET));
    const targetY = Math.min(Math.max(startY + INSET, safeTop), Math.max(safeTop, endY));
    const y = Math.max(safeTop, targetY);

    host.style.left = `${Math.round(x)}px`;
    host.style.top = `${Math.round(y)}px`;
    setVisible(true);
  }

  function scheduleLayout() {
    if (!frame) frame = requestAnimationFrame(layout);
  }

  function onScroll() {
    scheduleLayout();
  }

  function setCaptureStatus(status) {
    captureStatus = status;
    if (globalThis.ComicFloatingBallSyncVisual) {
      globalThis.ComicFloatingBallSyncVisual();
    }
  }

  function update(nextReader) {
    if (!nextReader && !host) return;
    ensureHost();
    if (!nextReader) setVisible(false);
    const changed = reader?.firstImage !== nextReader?.firstImage ||
      reader?.lastImage !== nextReader?.lastImage || reader?.root !== nextReader?.root;
    reader = nextReader;
    if (changed) {
      resizeObserver?.disconnect();
      if (reader?.root) resizeObserver?.observe(reader.root);
      if (reader?.firstImage) resizeObserver?.observe(reader.firstImage);
      if (reader?.lastImage) resizeObserver?.observe(reader.lastImage);
    }
    syncLangUI(getStoredLang());
    globalThis.ComicImageCapture?.setStatusListener(setCaptureStatus);
    scheduleLayout();
  }

  // 导出接口保持与 content.js / capture.js 100% 兼容
  globalThis.ComicFloatingBall = Object.freeze({
    update,
    setOcrLang: (l) => { setStoredLang(l); syncLangUI(l); },
    getOcrLang: () => getStoredLang(),
    openSettings: openModal
  });
})();
