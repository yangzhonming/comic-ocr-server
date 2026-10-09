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
  let captureStatus = { running: false, stopping: false, previewEnabled: true, statusText: '准备就绪', count: 0, completed: 0 };
  let frame = 0;
  let resizeObserver = null;

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
    try {
      localStorage.setItem('comic_llm_providers', JSON.stringify(providers));
    } catch {}
  }

  function getActiveProviderId() {
    try {
      const id = localStorage.getItem('comic_active_provider_id');
      if (id) return id;
    } catch {}
    return getStoredProviders()[0]?.id || 'p_deepseek';
  }

  function setActiveProviderId(id) {
    try { localStorage.setItem('comic_active_provider_id', id); } catch {}
  }

  function getActiveModel() {
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
    try { localStorage.setItem('comic_active_model', model); } catch {}
    try {
      window.dispatchEvent(new CustomEvent('comic-model-changed', { detail: { model } }));
    } catch {}
  }

  function normalizeLang(lang) {
    if (!lang) return 'kr';
    const l = String(lang).toLowerCase().trim();
    if (l === 'jp' || l === 'ja' || l === 'japanese' || l === '日文' || l === '日语') return 'ja';
    if (l === 'kr' || l === 'ko' || l === 'korean' || l === '韩文' || l === '韩语') return 'kr';
    if (l === 'en' || l === 'english' || l === '英文' || l === '英语') return 'en';
    if (l === 'ru' || l === 'russian' || l === '俄文' || l === '俄语') return 'ru';
    return 'kr'; // 默认降级为韩语
  }

  function getStoredLang() {
    try {
      if (typeof localStorage !== 'undefined') {
        const val = localStorage.getItem('comic_ocr_lang');
        if (val) return normalizeLang(val);
      }
    } catch {}
    return 'kr';
  }

  function setStoredLang(lang) {
    const l = normalizeLang(lang);
    try { localStorage.setItem('comic_ocr_lang', l); } catch {}
    try {
      window.dispatchEvent(new CustomEvent('comic-lang-changed', { detail: { lang: l } }));
    } catch {}
    return l;
  }

  const LANG_FLAGS = {
    'kr': '🇰🇷',
    'ja': '🇯🇵',
    'en': '🇺🇸',
    'ru': '🇷🇺'
  };

  const LANG_SHORTS = {
    'kr': 'KR',
    'ja': 'JA',
    'en': 'EN',
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
    shadow = host.attachShadow({ mode: 'open' });

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
        /* 运行中：发光绿色光晕 */
        .manga-ui-button.working {
          box-shadow: 0 0 16px rgba(46, 213, 115, 0.75), inset 0 0 8px rgba(46, 213, 115, 0.25);
          border-color: rgba(46, 213, 115, 0.6);
        }
        /* 运行/阅读时的隐身态 (0.18 透明度，悬停/触碰恢复 1) */
        .manga-ui-button.stealth {
          opacity: 0.18;
          filter: grayscale(80%);
        }
        .manga-ui-button.stealth:hover,
        .manga-ui-button.stealth:active {
          opacity: 1;
          filter: none;
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

        /* 通用自适应设置弹框 (Modal，非抽屉) */
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
          padding: 0 16px;
        }
        .modal-tab-btn {
          padding: 10px 14px;
          background: none;
          border: none;
          border-bottom: 2px solid transparent;
          color: #94a3b8;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 6px;
          transition: all 0.15s;
        }
        .modal-tab-btn.active {
          color: #2ed573;
          border-bottom-color: #2ed573;
        }
        .modal-body {
          padding: 16px;
          overflow-y: auto;
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 14px;
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

          <!-- 选项卡导航 -->
          <div class="modal-tabs">
            <button class="modal-tab-btn active" data-tab="models">🤖 模型管理</button>
            <button class="modal-tab-btn" data-tab="corpus">📖 语料库 (预留)</button>
            <button class="modal-tab-btn" data-tab="errors">⚠️ 错误信息与诊断 <span id="modal-error-badge" style="background:rgba(239,68,68,0.2); color:#f87171; font-size:10px; padding:1px 5px; border-radius:10px; display:none;">0</span></button>
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

            <!-- Tab 2: 语料库预留 -->
            <div id="tab-pane-corpus" style="display:none; flex-direction:column; gap:10px;">
              <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); padding:10px; border-radius:10px; color:#94a3b8; font-size:11px; line-height:1.5;">
                ℹ️ <strong>语料库功能预留中</strong>：后续将支持专有名词云与世界观语气设定，翻译时将自动注入大模型 System Prompt。
              </div>
              <div>
                <label class="form-label">专有名词 / 世界观备忘录 (预留编辑框)</label>
                <textarea id="modal-corpus-draft" rows="6" class="input-text" style="resize:none; font-family:monospace;" placeholder="例如：&#10;한유진 = 韩宥真&#10;MIND SWORD = 意念天剑"></textarea>
              </div>
            </div>

            <!-- Tab 3: 错误信息与诊断 -->
            <div id="tab-pane-errors" style="display:none; flex-direction:column; gap:12px;">
              <!-- 🌟 无论有无问题，均可随时手动唤起 Dev HUD 面板 -->
              <div class="dev-launcher-card">
                <div>
                  <div style="font-weight:700; color:#38bdf8; font-size:12px; display:flex; align-items:center; gap:5px;">
                    <span>🛠️</span> 开发者诊断与测试面板
                  </div>
                  <div style="font-size:11px; color:#94a3b8; margin-top:2px;">无论是否有报错，随时开启切线、Raw框及单片重试</div>
                </div>
                <button class="btn-dev-launch" id="btn-launch-dev-hud">唤起面板</button>
              </div>

              <div style="display:flex; justify-content:space-between; align-items:center; margin-top:4px;">
                <span class="form-label" style="margin-bottom:0;">捕获到的异常清单</span>
                <button id="btn-copy-errors" style="background:#1e293b; color:#cbd5e1; border:1px solid rgba(255,255,255,0.1); border-radius:6px; padding:3px 8px; font-size:10px; cursor:pointer;">📋 一键复制全部错误</button>
              </div>

              <div id="modal-error-list" style="display:flex; flex-direction:column; gap:8px;"></div>
            </div>
          </div>

          <!-- 弹窗底栏 -->
          <div class="modal-footer">
            <span style="font-size:10px; color:#64748b; font-family:monospace;">配置存储于本地 LocalStorage</span>
            <button class="btn-confirm" id="modal-confirm-btn">完成并保存</button>
          </div>
        </div>
      </div>
    `;

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
        button.classList.add('stealth'); // 运行后自动进入 0.18 隐身态
      } else {
        button.classList.remove('working', 'stealth');
        btnIconDisplay.style.filter = 'grayscale(100%)';
      }
    }

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
      if (isRunning && menu.hasAttribute('hidden')) {
        button.classList.add('stealth');
      }
    });

    globalThis.ComicFloatingBallSyncVisual = updateVisual;
  }

  function openMenu() {
    menu.removeAttribute('hidden');
    button.classList.remove('stealth');
    renderMenuModelList();
  }

  function closeMenu() {
    menu.setAttribute('hidden', '');
    const isRunning = captureStatus.running || captureStatus.starting;
    if (isRunning) button.classList.add('stealth');
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
  function setupModalInteractions() {
    modalOverlay.addEventListener('click', (e) => {
      if (e.target === modalOverlay) closeModal();
    });
    shadow.getElementById('modal-close-btn').addEventListener('click', closeModal);
    shadow.getElementById('modal-confirm-btn').addEventListener('click', () => {
      saveModalData();
      closeModal();
    });

    // 选项卡切换
    const tabBtns = shadow.querySelectorAll('.modal-tab-btn');
    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        tabBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const tab = btn.dataset.tab;
        shadow.getElementById('tab-pane-models').style.display = tab === 'models' ? 'flex' : 'none';
        shadow.getElementById('tab-pane-corpus').style.display = tab === 'corpus' ? 'flex' : 'none';
        shadow.getElementById('tab-pane-errors').style.display = tab === 'errors' ? 'flex' : 'none';
      });
    });

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
    shadow.getElementById('btn-copy-errors').addEventListener('click', () => {
      const errors = ErrorTracker.list();
      if (errors.length === 0) return alert('当前暂无捕获到的错误信息');
      const text = JSON.stringify(errors, null, 2);
      navigator.clipboard.writeText(text).then(() => {
        alert('已复制全部错误日志 JSON 到剪贴板！');
      }).catch(() => alert(text));
    });

    // 🌟 手动唤起 Dev HUD 面板 (无论有无错误随时唤起)
    shadow.getElementById('btn-launch-dev-hud').addEventListener('click', () => {
      closeModal();
      if (globalThis.ComicDebugHUD) {
        globalThis.ComicDebugHUD.enable();
      }
    });
  }

  function openModal() {
    modalOverlay.removeAttribute('hidden');
    renderModalProviders();
    renderErrorsTab();
    updateErrorBadge();
    try {
      const draft = localStorage.getItem('comic_corpus_draft') || '';
      shadow.getElementById('modal-corpus-draft').value = draft;
    } catch {}
  }

  function closeModal() {
    modalOverlay.setAttribute('hidden', '');
    renderMenuModelList();
  }

  function saveModalData() {
    // 保存语料库草稿
    const draft = shadow.getElementById('modal-corpus-draft').value;
    try { localStorage.setItem('comic_corpus_draft', draft); } catch {}
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

  // 渲染错误信息
  function renderErrorsTab() {
    const container = shadow.getElementById('modal-error-list');
    if (!container) return;
    container.innerHTML = '';
    const errors = ErrorTracker.list();

    if (errors.length === 0) {
      container.innerHTML = `
        <div style="padding:20px; text-align:center; color:#64748b; font-size:11px; font-family:monospace;">
          ✓ 暂无捕获到的异常记录，切片与服务运行顺畅
        </div>
      `;
      return;
    }

    errors.forEach(err => {
      const item = document.createElement('div');
      item.style.cssText = 'background:rgba(239,68,68,0.08); border:1px solid rgba(239,68,68,0.25); border-radius:10px; padding:10px; display:flex; flex-direction:column; gap:4px; font-family:monospace; font-size:11px;';
      item.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <span style="color:#f87171; font-weight:bold;">● ${err.type}</span>
          <span style="color:#64748b; font-size:10px;">${err.time}</span>
        </div>
        <div style="color:#cbd5e1;">出问题切片: <span style="color:#fbbf24; font-weight:bold;">${err.sliceTag}</span></div>
        <div style="background:#090d16; padding:6px 8px; border-radius:6px; color:#94a3b8; font-size:10px; word-break:break-all;">
          ${err.detail}
        </div>
        <div style="display:flex; justify-content:flex-end; margin-top:2px;">
          <button class="btn-goto-dev" style="background:rgba(14,165,233,0.15); color:#38bdf8; border:1px solid rgba(56,189,248,0.3); border-radius:6px; padding:3px 8px; font-size:10px; font-weight:bold; cursor:pointer;">
            🔍 唤起 Dev 面板排查
          </button>
        </div>
      `;
      item.querySelector('.btn-goto-dev').addEventListener('click', () => {
        closeModal();
        if (globalThis.ComicDebugHUD) globalThis.ComicDebugHUD.enable();
      });
      container.appendChild(item);
    });
  }

  function updateErrorBadge() {
    const badge = shadow.getElementById('modal-error-badge');
    if (!badge) return;
    const errors = ErrorTracker.list();
    if (errors.length > 0) {
      badge.textContent = errors.length;
      badge.style.display = 'inline';
    } else {
      badge.style.display = 'none';
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

    const clip = clipBounds(reader.firstImage);
    const safeTop = Math.max(SAFE_TOP, clip.top + INSET);
    const safeBottom = Math.min(innerHeight - INSET, clip.bottom - INSET);
    const safeLeft = Math.max(INSET, clip.left + INSET);
    const safeRight = Math.min(innerWidth - INSET, clip.right - INSET);

    if (!isRunning) {
      if (first.top + INSET > safeBottom - SIZE || lastBottom - SIZE < safeTop ||
          first.right <= safeLeft || first.left >= safeRight) {
        setVisible(false);
        return;
      }
    }

    const endY = Math.min(lastBottom - SIZE - INSET, safeBottom - SIZE);
    const x = Math.max(safeLeft, Math.min(safeRight - SIZE, first.left + INSET));
    const targetY = Math.min(Math.max(first.top + INSET, safeTop), Math.max(safeTop, endY));
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
