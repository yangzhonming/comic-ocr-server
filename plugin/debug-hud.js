(() => {
  // 独立开发者诊断面板 (Dev HUD)
  // 测试阶段默认开启（上线时可将 DEFAULT_DEBUG 改为 false）。
  // 支持通过控制台全局指令 window.enableComicDebug() / disableComicDebug() 随时开关。
  const DEFAULT_DEBUG = true;
  let host = null;
  let root = null;
  let isVisible = false;
  let cachedStatus = null;

  function isActive() {
    try {
      if (typeof localStorage === 'undefined') return DEFAULT_DEBUG;
      const val = localStorage.getItem('comic_debug');
      if (val === '0' || val === 'false') return false;
      if (val === '1' || val === 'true') return true;
      return DEFAULT_DEBUG;
    } catch {
      return DEFAULT_DEBUG;
    }
  }

  function ensureHUD() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'comic-dev-debug-hud';
    host.style.cssText = 'all:initial;position:fixed;top:16px;right:16px;z-index:2147483646;display:none;pointer-events:auto;';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { all: initial; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
        .hud {
          width: 270px;
          padding: 12px 14px;
          border-radius: 10px;
          background: rgba(15, 23, 42, 0.92);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          border: 1px solid rgba(56, 189, 248, 0.35);
          color: #e2e8f0;
          font-size: 11px;
          line-height: 1.5;
          box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.6), 0 0 15px rgba(56, 189, 248, 0.15);
        }
        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          border-bottom: 1px solid rgba(148, 163, 184, 0.2);
          padding-bottom: 6px;
          margin-bottom: 8px;
          font-weight: 700;
          font-size: 12px;
          color: #38bdf8;
        }
        .close-btn {
          background: none;
          border: none;
          color: #94a3b8;
          cursor: pointer;
          font-size: 14px;
          padding: 0 4px;
          line-height: 1;
        }
        .close-btn:hover { color: #f43f5e; }
        .section { margin-bottom: 8px; }
        .section-title {
          color: #94a3b8;
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 3px;
        }
        .stat-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 4px 8px;
          background: rgba(30, 41, 59, 0.6);
          padding: 6px 8px;
          border-radius: 6px;
        }
        .stat-item { display: flex; justify-content: space-between; }
        .stat-label { color: #cbd5e1; }
        .stat-val { font-weight: 700; color: #38bdf8; }
        .stat-val.highlight { color: #4ade80; }
        .stat-val.warn { color: #facc15; }
        .status-text {
          color: #f8fafc;
          word-break: break-all;
          background: rgba(30, 41, 59, 0.6);
          padding: 4px 8px;
          border-radius: 6px;
          margin-top: 2px;
        }
        .btn-action {
          width: 100%;
          padding: 6px 0;
          border-radius: 6px;
          border: 1px solid rgba(56, 189, 248, 0.4);
          background: rgba(14, 165, 233, 0.15);
          color: #38bdf8;
          font-weight: 600;
          font-size: 11px;
          cursor: pointer;
          transition: all 0.15s ease;
        }
        .btn-action:hover {
          background: rgba(14, 165, 233, 0.35);
          color: #fff;
          border-color: #38bdf8;
        }
      </style>
      <div class="hud">
        <div class="header">
          <span>🛠️ Dev HUD v0.8.6</span>
          <button class="close-btn" title="关闭面板 (Console 输入 enableComicDebug() 重新开启)">✕</button>
        </div>
        <div class="section">
          <div class="section-title">切片遥测 (Capture Telemetry)</div>
          <div class="stat-grid">
            <div class="stat-item"><span class="stat-label">总图片</span><span class="stat-val" id="val-total">0</span></div>
            <div class="stat-item"><span class="stat-label">已切片</span><span class="stat-val highlight" id="val-slices">0</span></div>
            <div class="stat-item"><span class="stat-label">⚡ 属性直取</span><span class="stat-val highlight" id="val-track1">0</span></div>
            <div class="stat-item"><span class="stat-label">👁️ 动态捕获</span><span class="stat-val warn" id="val-track2">0</span></div>
            <div class="stat-item"><span class="stat-label">📦 已完成</span><span class="stat-val highlight" id="val-batches">0</span></div>
            <div class="stat-item"><span class="stat-label">🚀 在途并发</span><span class="stat-val" id="val-pending-batch">0</span></div>
          </div>
        </div>
        <div class="section">
          <div class="section-title">流水线遥测 (Pipeline Status)</div>
          <div class="status-text" id="val-status">就绪待命</div>
        </div>
        <div class="section">
          <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:#94a3b8;cursor:pointer;margin-bottom:8px;">
            <input type="checkbox" id="chk-enable-capture" style="accent-color:#38bdf8;">
            <span style="color:#f8fafc;font-weight:600;">💻 优先使用本地 OCR (127.0.0.1:8000)</span>
          </label>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;font-size:11px;color:#94a3b8;background:rgba(30,41,59,0.6);padding:4px 8px;border-radius:6px;">
            <span>识别语种:</span>
            <select id="select-ocr-lang" style="background:rgba(15,23,42,0.9);border:1px solid rgba(56,189,248,0.4);border-radius:4px;color:#38bdf8;padding:2px 6px;font-size:11px;font-family:inherit;outline:none;cursor:pointer;">
              <option value="kr">🇰🇷 韩语 (默认)</option>
              <option value="ja">🇯🇵 日语</option>
              <option value="en">🇺🇸 英语</option>
              <option value="ru">🇷🇺 俄语</option>
            </select>
          </div>
          <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:#94a3b8;cursor:pointer;margin-bottom:8px;">
            <input type="checkbox" id="chk-local-truecase" style="accent-color:#38bdf8;">
            <span style="color:#f8fafc;font-weight:600;">🔤 英文本地转译 (大写转自然阅读体)</span>
          </label>
          <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:#94a3b8;cursor:pointer;margin-bottom:8px;">
            <input type="checkbox" id="chk-auto-clear" style="accent-color:#38bdf8;">
            <span>测试模式：刷新自动清理缓存</span>
          </label>
          <div style="display:flex;gap:6px;">
            <button class="btn-action" id="btn-toggle-overlay">辅助线</button>
            <button class="btn-action" id="btn-clear-cache" style="border-color:rgba(239,68,68,0.5);background:rgba(239,68,68,0.15);color:#f87171;">🧹 清缓存并刷新</button>
          </div>
        </div>
        <div class="section" id="section-telemetry" style="border-top:1px solid rgba(148,163,184,0.2);padding-top:8px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
            <div class="section-title" style="margin:0;">⚡ 耗时与数据包透视</div>
            <button id="btn-copy-latest-pkt" class="btn-action" style="padding:1px 6px;font-size:10px;">📋 复制报文</button>
          </div>
          <div style="display:flex;gap:6px;margin-bottom:6px;">
            <div class="stat-item" style="flex:1;"><span class="stat-label">⏱️ OCR 耗时</span><span class="stat-val highlight" id="val-ocr-time">-- ms</span></div>
            <div class="stat-item" style="flex:1;"><span class="stat-label">⚡ LLM 耗时</span><span class="stat-val highlight" id="val-llm-time">-- ms</span></div>
          </div>
          <div style="margin-bottom:6px;">
            <div style="display:flex;justify-content:space-between;font-size:10px;color:#94a3b8;margin-bottom:2px;">
              <span>📤 发送请求包 (输入)</span>
              <span id="label-req-slice" style="color:#38bdf8;">--</span>
            </div>
            <pre id="val-req-packet" style="margin:0;max-height:75px;overflow-y:auto;background:rgba(15,23,42,0.85);border:1px solid rgba(56,189,248,0.2);padding:6px;border-radius:4px;font-size:10px;color:#e2e8f0;white-space:pre-wrap;word-break:break-all;font-family:inherit;">(等待切片发送...)</pre>
          </div>
          <div>
            <div style="display:flex;justify-content:space-between;font-size:10px;color:#94a3b8;margin-bottom:2px;">
              <span>📥 返回响应包 (大模型流)</span>
              <span id="label-res-model" style="color:#2ed573;">--</span>
            </div>
            <pre id="val-res-packet" style="margin:0;max-height:75px;overflow-y:auto;background:rgba(15,23,42,0.85);border:1px solid rgba(46,213,115,0.2);padding:6px;border-radius:4px;font-size:10px;color:#a7f3d0;white-space:pre-wrap;word-break:break-all;font-family:inherit;">(等待大模型响应...)</pre>
          </div>
        </div>
      </div>
    `;
    root.querySelector('.close-btn').addEventListener('click', () => {
      disableComicDebug();
    });
    root.querySelector('#btn-toggle-overlay').addEventListener('click', () => {
      globalThis.ComicImageCapture?.togglePreview();
    });
    root.querySelector('#btn-copy-latest-pkt').addEventListener('click', () => {
      const report = PacketInspector.getFullReport();
      if (!report.slices_timeline.length) return alert('暂无切片报文记录');
      navigator.clipboard.writeText(JSON.stringify(report, null, 2)).then(() => {
        alert(`已成功复制压测报告 JSON！\n共记录 ${report.slices_timeline.length} 个切片\n模式: ${report.benchmark_summary.test_mode}\n平均 OCR 耗时: ${report.benchmark_summary.avg_ocr_duration_ms}ms\n平均 LLM 耗时: ${report.benchmark_summary.avg_llm_duration_ms}ms`);
      }).catch(() => {});
    });
    const captureChk = root.querySelector('#chk-enable-capture');
    const langSelect = root.querySelector('#select-ocr-lang');

    const captureVal = typeof localStorage !== 'undefined' ? localStorage?.getItem?.('comic_dev_enable_capture') : null;
    captureChk.checked = captureVal === '1' || captureVal === 'true';

    captureChk.addEventListener('change', () => {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem('comic_dev_enable_capture', captureChk.checked ? '1' : '0');
      console.log(`[ComicDebug] 本地模式: ${captureChk.checked ? '已启用 (127.0.0.1:8000)' : '已停用 (云端)'}`);
    });

    if (langSelect) {
      langSelect.value = getOcrLang();
      langSelect.addEventListener('change', () => {
        const val = normalizeLang(langSelect.value);
        if (typeof localStorage !== 'undefined') {
          try {
            localStorage.setItem('comic_ocr_lang', val);
          } catch {}
        }
        console.log(`[ComicDebug] 识别语种切换为: ${val}`);
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
          try {
            window.dispatchEvent(new CustomEvent('comic_ocr_lang_changed', { detail: { lang: val, source: 'debug-hud' } }));
          } catch {}
        }
      });

      const syncDebugHudLang = (lang) => {
        const target = lang ? normalizeLang(lang) : getOcrLang();
        if (langSelect.value !== target) {
          langSelect.value = target;
        }
      };

      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('comic_ocr_lang_changed', (e) => {
          if (e.detail?.source !== 'debug-hud') {
            syncDebugHudLang(e.detail?.lang);
          }
        });
        window.addEventListener('storage', (e) => {
          if (e.key === 'comic_ocr_lang') {
            syncDebugHudLang(e.newValue);
          }
        });
      }
    }

    const autoClearChk = root.querySelector('#chk-auto-clear');
    const autoClearVal = typeof localStorage !== 'undefined' ? localStorage?.getItem?.('comic_dev_auto_clear_cache') : null;
    autoClearChk.checked = autoClearVal !== '0' && autoClearVal !== 'false';
    autoClearChk.addEventListener('change', () => {
      if (typeof localStorage === 'undefined') return;
      if (autoClearChk.checked) {
        localStorage.setItem('comic_dev_auto_clear_cache', '1');
      } else {
        localStorage.setItem('comic_dev_auto_clear_cache', '0');
      }
    });

    const truecaseChk = root.querySelector('#chk-local-truecase');
    const truecaseVal = typeof localStorage !== 'undefined' ? localStorage?.getItem?.('comic_local_truecase_enabled') : null;
    truecaseChk.checked = truecaseVal === '1' || truecaseVal === 'true';
    truecaseChk.addEventListener('change', () => {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem('comic_local_truecase_enabled', truecaseChk.checked ? '1' : '0');
      console.log(`[ComicDebug] 英文本地转译模式: ${truecaseChk.checked ? '已启用 (大写转自然阅读流)' : '已停用'}`);
      if (globalThis.ComicImageOverlay?.scheduleOverlay) {
        globalThis.ComicImageOverlay.scheduleOverlay();
      }
    });
    root.querySelector('#btn-clear-cache').addEventListener('click', async () => {
      if (globalThis.ComicImageCapture?.clearCaches) {
        await globalThis.ComicImageCapture.clearCaches();
      }
      location.reload();
    });
    document.documentElement.appendChild(host);
  }

  function renderStatus(status) {
    if (!status || !root) return;
    cachedStatus = status;
    const totalEl = root.querySelector('#val-total');
    const slicesEl = root.querySelector('#val-slices');
    const track1El = root.querySelector('#val-track1');
    const track2El = root.querySelector('#val-track2');
    const batchesEl = root.querySelector('#val-batches');
    const pendingBatchEl = root.querySelector('#val-pending-batch');
    const statusEl = root.querySelector('#val-status');
    if (!totalEl) return;

    totalEl.textContent = String(status.count || 0);
    slicesEl.textContent = String(status.slicesCompleted || 0);
    track1El.textContent = String(status.stats?.attribute || 0);
    track2El.textContent = String(status.stats?.observer || 0);
    if (batchesEl) batchesEl.textContent = String(status.batchesCompleted || 0);
    if (pendingBatchEl) pendingBatchEl.textContent = String(status.pendingBatchCount || 0);
    statusEl.textContent = status.statusText || '准备就绪';
  }

  // ========================================================
  // 数据包与链路耗时检查器 (Packet & Latency Inspector)
  // ========================================================
  const PacketInspector = {
    history: [],
    record(entry) {
      const item = {
        recorded_at: new Date().toISOString(),
        display_time: new Date().toLocaleTimeString(),
        sliceTag: entry.sliceTag || '切片',
        sliceIndex: entry.sliceIndex || 0,
        mode: entry.mode || (entry.apiEndpoint?.includes('127.0.0.1') ? '本地 (Local 127.0.0.1:8000)' : '云端 (Cloud Serverless)'),
        apiEndpoint: entry.apiEndpoint || '',
        ocr: entry.ocr || {
          sent_at: '',
          received_at: '',
          duration_ms: entry.ocrTimeMs || 0,
          bubbles_count: 0
        },
        llm: entry.llm || {
          prepared_at: '',
          sent_at: '',
          first_token_at: '',
          completed_at: '',
          duration_ms: entry.llmTimeMs || 0,
          model: entry.requestData?.model || '',
          endpoint: entry.requestData?.endpoint || '',
          system_prompt: entry.requestData?.prompt || '',
          user_input: entry.requestData?.input || '',
          raw_response: entry.responseData || ''
        }
      };
      this.history.unshift(item);
      if (this.history.length > 60) this.history.pop();
      renderPacketTelemetry();
    },
    getLatest() {
      return this.history[0] || null;
    },
    getFullReport() {
      const slices = [...this.history].reverse();
      const ocrList = slices.map(s => s.ocr?.duration_ms).filter(n => typeof n === 'number' && n > 0);
      const llmList = slices.map(s => s.llm?.duration_ms).filter(n => typeof n === 'number' && n > 0);
      const avgOcr = ocrList.length ? Math.round(ocrList.reduce((a, b) => a + b, 0) / ocrList.length) : 0;
      const avgLlm = llmList.length ? Math.round(llmList.reduce((a, b) => a + b, 0) / llmList.length) : 0;
      const latestMode = slices[slices.length - 1]?.mode || '未知';

      return {
        benchmark_summary: {
          test_mode: latestMode,
          export_time: new Date().toISOString(),
          total_slices_recorded: slices.length,
          avg_ocr_duration_ms: avgOcr,
          avg_llm_duration_ms: avgLlm
        },
        slices_timeline: slices
      };
    }
  };
  globalThis.ComicPacketInspector = PacketInspector;

  function renderPacketTelemetry() {
    if (!root) return;
    const pkt = PacketInspector.getLatest();
    if (!pkt) return;
    const ocrEl = root.querySelector('#val-ocr-time');
    const llmEl = root.querySelector('#val-llm-time');
    const sliceLabel = root.querySelector('#label-req-slice');
    const modelLabel = root.querySelector('#label-res-model');
    const reqEl = root.querySelector('#val-req-packet');
    const resEl = root.querySelector('#val-res-packet');

    const ocrMs = pkt.ocr?.duration_ms ?? pkt.ocrTimeMs ?? 0;
    const llmMs = pkt.llm?.duration_ms ?? pkt.llmTimeMs ?? 0;
    if (ocrEl) ocrEl.textContent = `${ocrMs} ms`;
    if (llmEl) llmEl.textContent = `${llmMs} ms`;
    if (sliceLabel) sliceLabel.textContent = `${pkt.sliceTag} [${pkt.ocr?.duration_ms || ocrMs}ms]`;
    if (modelLabel) modelLabel.textContent = `${pkt.llm?.model || '已完成'} [${pkt.llm?.duration_ms || llmMs}ms]`;
    if (reqEl) {
      reqEl.textContent = pkt.llm?.user_input || (typeof pkt.requestData === 'string' ? pkt.requestData : JSON.stringify(pkt.requestData, null, 2));
    }
    if (resEl) {
      resEl.textContent = pkt.llm?.raw_response || (typeof pkt.responseData === 'string' ? pkt.responseData : JSON.stringify(pkt.responseData, null, 2));
    }
  }

  function normalizeLang(lang) {
    if (!lang) return 'kr';
    const l = String(lang).toLowerCase().trim();
    if (l === 'jp' || l === 'ja' || l === 'japanese' || l === '日文' || l === '日语') return 'ja';
    if (l === 'kr' || l === 'ko' || l === 'korean' || l === '韩文' || l === '韩语') return 'kr';
    if (l === 'en' || l === 'english' || l === '英文' || l === '英语') return 'en';
    if (l === 'ru' || l === 'russian' || l === '俄文' || l === '俄语') return 'ru';
    return l;
  }

  function setVisible(next) {
    isVisible = next;
    if (next) {
      ensureHUD();
      host.style.display = 'block';
      if (root) {
        const select = root.querySelector('#select-ocr-lang');
        if (select) select.value = getOcrLang();
      }
      if (cachedStatus) renderStatus(cachedStatus);
      renderPacketTelemetry();
    } else if (host) {
      host.style.display = 'none';
    }
  }

  function update(status) {
    cachedStatus = status;
    if (isVisible && root) {
      renderStatus(status);
    }
  }

  function enableComicDebug() {
    try { localStorage.setItem('comic_debug', '1'); } catch {}
    setVisible(true);
    console.log('%c[ComicDebug]%c 开发者诊断面板已激活！再次关闭可执行 disableComicDebug()', 'color:#38bdf8;font-weight:bold;', 'color:inherit;');
  }

  function disableComicDebug() {
    try { localStorage.setItem('comic_debug', '0'); } catch {}
    setVisible(false);
    console.log('%c[ComicDebug]%c 开发者诊断面板已关闭。重新开启可执行 enableComicDebug()', 'color:#94a3b8;font-weight:bold;', 'color:inherit;');
  }

  function isCaptureMode() {
    try {
      return localStorage.getItem('comic_dev_enable_capture') === '1';
    } catch {
      return false;
    }
  }

  function getCaptureEndpoint() {
    return 'http://127.0.0.1:8000';
  }

  function getOcrLang() {
    try {
      const val = localStorage.getItem('comic_ocr_lang');
      return normalizeLang(val);
    } catch {
      return 'kr';
    }
  }

  function setOcrLang(lang) {
    const val = normalizeLang(lang);
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem('comic_ocr_lang', val);
      } catch {}
    }
    if (root) {
      const select = root.querySelector('#select-ocr-lang');
      if (select && select.value !== val) select.value = val;
    }
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      try {
        window.dispatchEvent(new CustomEvent('comic_ocr_lang_changed', { detail: { lang: val, source: 'debug-hud' } }));
      } catch {}
    }
  }

  function isLocalTruecaseMode() {
    try {
      return localStorage.getItem('comic_local_truecase_enabled') === '1';
    } catch {
      return false;
    }
  }

  // 注册全局控制台指令
  globalThis.enableComicDebug = enableComicDebug;
  globalThis.disableComicDebug = disableComicDebug;
  window.enableComicDebug = enableComicDebug;
  window.disableComicDebug = disableComicDebug;

  // 导出接口供 capture 派发数据
  globalThis.ComicDebugHUD = Object.freeze({
    update,
    updatePackets: (pkt) => PacketInspector.record(pkt),
    enable: enableComicDebug,
    disable: disableComicDebug,
    isActive,
    isCaptureMode,
    getCaptureEndpoint,
    getOcrLang,
    setOcrLang,
    isLocalTruecaseMode
  });

  // 如果此前在 localStorage 中开启过，则在页面初始化时自动呈现
  if (isActive()) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => setVisible(true));
    } else {
      setVisible(true);
    }
  }
})();
