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
    root = host.attachShadow({ mode: 'closed' });
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
          <div id="container-cloud-ocr-url" style="margin-bottom:8px;">
            <div style="font-size:10px;color:#94a3b8;margin-bottom:2px;">☁️ 云端 OCR 服务地址:</div>
            <input type="text" id="input-cloud-ocr-url" placeholder="https://<your-fc-endpoint>.cn-shenzhen.fcapp.run" style="width:100%;box-sizing:border-box;background:rgba(15,23,42,0.9);border:1px solid rgba(56,189,248,0.3);border-radius:4px;color:#f8fafc;padding:3px 6px;font-size:10px;font-family:monospace;outline:none;">
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;font-size:11px;color:#94a3b8;background:rgba(30,41,59,0.6);padding:4px 8px;border-radius:6px;">
            <span>识别语种:</span>
            <select id="select-ocr-lang" style="background:rgba(15,23,42,0.9);border:1px solid rgba(56,189,248,0.3);border-radius:4px;color:#38bdf8;padding:2px 6px;font-size:11px;font-weight:600;outline:none;">
              <option value="kr">🇰🇷 韩语 (KR)</option>
              <option value="ja">🇯🇵 日语 (JA)</option>
              <option value="en">🇺🇸 英语 (EN)</option>
              <option value="es">🇪🇸 西班牙语 (ES)</option>
              <option value="ru">🇷🇺 俄语 (RU)</option>
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
        <div class="section" id="section-pipeline-telemetry" style="border-top:1px solid rgba(148,163,184,0.2);padding-top:8px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
            <div class="section-title" style="margin:0;">🚀 极速链路遥测 (Pipeline Latency)</div>
            <span id="val-prewarm-badge" style="font-size:10px;padding:1px 5px;border-radius:4px;background:rgba(56,189,248,0.2);color:#38bdf8;">🔥 预热中...</span>
          </div>
          <div class="stat-grid" style="margin-bottom:6px;">
            <div class="stat-item"><span class="stat-label">首图就绪</span><span class="stat-val highlight" id="val-first-img-time">-- ms</span></div>
            <div class="stat-item"><span class="stat-label">首片生成</span><span class="stat-val highlight" id="val-slice0-gen-time">-- ms</span></div>
            <div class="stat-item"><span class="stat-label">⚡ 点击到首OCR</span><span class="stat-val highlight" id="val-click-ocr-time">-- ms</span></div>
            <div class="stat-item"><span class="stat-label">📦 前6片全OCR</span><span class="stat-val" id="val-top6-ocr-time">-- ms</span></div>
            <div class="stat-item"><span class="stat-label">💬 首片气泡</span><span class="stat-val highlight" id="val-slice0-bubbles">--</span></div>
            <div class="stat-item"><span class="stat-label">📚 前6片总气泡</span><span class="stat-val warn" id="val-top6-bubbles">--</span></div>
            <div class="stat-item"><span class="stat-label">✨ 首字TTFB</span><span class="stat-val highlight" id="val-llm-ttfb">-- ms</span></div>
            <div class="stat-item"><span class="stat-label">🏁 首片LLM总耗</span><span class="stat-val" id="val-llm-total">-- ms</span></div>
          </div>
        </div>
        <div class="section" id="section-telemetry" style="border-top:1px solid rgba(148,163,184,0.2);padding-top:8px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
            <div class="section-title" style="margin:0;">⚡ 耗时与全景诊断透视</div>
            <div style="display:flex;gap:4px;">
              <button id="btn-export-txt-report" class="btn-action" style="padding:1px 6px;font-size:10px;border-color:rgba(46,213,115,0.4);background:rgba(46,213,115,0.15);color:#2ed573;">💾 导出报告 (.txt)</button>
              <button id="btn-copy-txt-report" class="btn-action" style="padding:1px 6px;font-size:10px;">📋 复制报告</button>
            </div>
          </div>
          <div style="margin-bottom:6px;">
            <button id="btn-share-txt-report" class="btn-action" style="width:100%;padding:5px 0;font-size:11px;border-color:rgba(37,211,102,0.5);background:rgba(37,211,102,0.18);color:#25d366;font-weight:700;">📤 一键分享诊断报告到微信 (.txt)</button>
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
        <div class="section" id="section-container-dom" style="border-top:1px solid rgba(148,163,184,0.2);padding-top:8px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
            <div class="section-title" style="margin:0;">📦 容器 DOM 捕获与分享</div>
            <span id="label-container-info" style="font-size:10px;color:#38bdf8;">就绪待命</span>
          </div>
          <div style="display:flex;flex-direction:column;gap:5px;">
            <button id="btn-share-container-dom" class="btn-action" style="padding:5px 0;font-size:11px;border-color:rgba(37,211,102,0.5);background:rgba(37,211,102,0.18);color:#25d366;font-weight:700;">📤 分享容器到微信</button>
            <div style="display:flex;gap:4px;">
              <button id="btn-export-container-html" class="btn-action" style="flex:1;padding:3px 0;font-size:10px;border-color:rgba(56,189,248,0.4);background:rgba(14,165,233,0.15);color:#38bdf8;">💾 导出 HTML</button>
              <button id="btn-copy-container-html" class="btn-action" style="flex:1;padding:3px 0;font-size:10px;">📋 复制容器代码</button>
            </div>
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
    root.querySelector('#btn-copy-txt-report').addEventListener('click', () => {
      const txt = PacketInspector.generatePlainTextReport();
      navigator.clipboard.writeText(txt).then(() => {
        alert('已成功复制纯文本诊断报告 (.txt)！\n可直接在微信聊天框长按粘贴发送给开发者。');
      }).catch(() => {
        alert('剪贴板复制失败，请点击【导出报告】保存为文件。');
      });
    });

    root.querySelector('#btn-export-txt-report').addEventListener('click', () => {
      const txt = PacketInspector.generatePlainTextReport();
      try {
        const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `comic-diagnostic-${timestamp}.txt`;
        triggerBlobDownload(blob, filename);
      } catch (err) {
        alert('导出失败: ' + (err?.message || String(err)));
      }
    });

    root.querySelector('#btn-share-txt-report').addEventListener('click', async () => {
      const txt = PacketInspector.generatePlainTextReport();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `comic-diagnostic-${timestamp}.txt`;
      const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
      const file = new File([blob], filename, { type: 'text/plain;charset=utf-8' });

      if (typeof navigator !== 'undefined' && navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({
            title: '漫画全景翻译诊断报告',
            text: `从 ${location.hostname} 导出的切片坐标与翻译诊断报告 (.txt)`,
            files: [file]
          });
          return;
        } catch (err) {
          if (err.name === 'AbortError') return;
          console.warn('[ComicHUD] Web Share API 失败，降级为导出与复制:', err);
        }
      }

      triggerBlobDownload(blob, filename);
      try {
        await navigator.clipboard.writeText(txt);
        alert(`已生成诊断报告 [${filename}] 并已复制全文！\n文件已存入手机下载目录，同时文本已在剪贴板中，可直接在微信发送给开发者。`);
      } catch {
        alert(`已生成并下载诊断报告 [${filename}]！\n请在微信中选择该文本文件发送给开发者。`);
      }
    });

    function getCapturedContainerHtml() {
      const html = globalThis.ComicImageCapture?.getReaderHtml?.();
      if (html && html.trim().length > 0) return html;
      const fallbackEl = document.querySelector('.reading-content, #reader, .reader-container, .chapter-content, .viewer-cnt, #viewer, .comic-container');
      if (fallbackEl) return fallbackEl.outerHTML;
      return document.body ? document.body.innerHTML : '';
    }

    function triggerBlobDownload(blob, filename) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 100);
    }

    root.querySelector('#btn-share-container-dom').addEventListener('click', async () => {
      const html = getCapturedContainerHtml();
      if (!html) return alert('未找到漫画容器元素');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `comic-container-${location.hostname}-${timestamp}.html`;
      const fullDoc = `<!DOCTYPE html>\n<html>\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>Comic Container - ${location.hostname}</title>\n</head>\n<body>\n${html}\n</body>\n</html>`;
      const blob = new Blob([fullDoc], { type: 'text/html' });
      const file = new File([blob], filename, { type: 'text/html' });

      if (typeof navigator !== 'undefined' && navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({
            title: `漫画容器代码 (${location.hostname})`,
            text: `从 ${location.href} 捕获的漫画阅读器 HTML 容器结构`,
            files: [file]
          });
          return;
        } catch (err) {
          if (err.name === 'AbortError') return;
          console.warn('[ComicHUD] Web Share API 失败，降级为导出文件:', err);
        }
      }

      triggerBlobDownload(blob, filename);
      try {
        await navigator.clipboard.writeText(`已生成容器代码文件: ${filename}，已保存至下载目录，可发送给开发者。`);
        alert(`已生成并下载容器文件 [${filename}]！\n\n当前浏览器环境未直接弹出微信分享，文件已保存到本地下载文件夹，请在微信中选择发送。`);
      } catch {
        alert(`已生成并下载容器文件 [${filename}]！\n请在微信中选择发送。`);
      }
    });

    root.querySelector('#btn-export-container-html').addEventListener('click', () => {
      const html = getCapturedContainerHtml();
      if (!html) return alert('未找到漫画容器元素');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `comic-container-${location.hostname}-${timestamp}.html`;
      const fullDoc = `<!DOCTYPE html>\n<html>\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>Comic Container - ${location.hostname}</title>\n</head>\n<body>\n${html}\n</body>\n</html>`;
      const blob = new Blob([fullDoc], { type: 'text/html' });
      triggerBlobDownload(blob, filename);
    });

    root.querySelector('#btn-copy-container-html').addEventListener('click', async () => {
      const html = getCapturedContainerHtml();
      if (!html) return alert('未找到漫画容器元素');
      try {
        await navigator.clipboard.writeText(html);
        alert(`已成功复制容器 HTML 代码！(大小: ${(html.length / 1024).toFixed(1)} KB)\n可直接在微信中粘贴发送。`);
      } catch (err) {
        alert('复制到剪贴板失败: ' + (err?.message || String(err)));
      }
    });

    const captureChk = root.querySelector('#chk-enable-capture');
    const cloudUrlInput = root.querySelector('#input-cloud-ocr-url');
    const langSelect = root.querySelector('#select-ocr-lang');

    const captureVal = typeof localStorage !== 'undefined' ? localStorage?.getItem?.('comic_dev_enable_capture') : null;
    captureChk.checked = captureVal === '1' || captureVal === 'true';

    captureChk.addEventListener('change', () => {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem('comic_dev_enable_capture', captureChk.checked ? '1' : '0');
      console.log(`[ComicDebug] 本地模式: ${captureChk.checked ? '已启用 (127.0.0.1:8000)' : '已停用 (云端)'}`);
    });

    if (cloudUrlInput) {
      cloudUrlInput.value = (typeof localStorage !== 'undefined' ? localStorage.getItem('comic_cloud_api_url') : '') || '';
      cloudUrlInput.addEventListener('change', () => {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('comic_cloud_api_url', cloudUrlInput.value.trim());
          console.log(`[ComicDebug] 云端 OCR 地址已更新: ${cloudUrlInput.value.trim()}`);
        }
      });
    }

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
    const containerLabel = root.querySelector('#label-container-info');
    if (containerLabel) {
      const info = globalThis.ComicImageCapture?.getReaderInfo?.();
      if (info) {
        containerLabel.textContent = `${info.tagName.toLowerCase()} (${info.imageCount}P)`;
      } else {
        containerLabel.textContent = status.count > 0 ? `${status.count}P` : '未捕获';
      }
    }
    renderPacketTelemetry();
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
        slice: entry.slice || null,
        bubbles: entry.bubbles || [],
        ocr: entry.ocr || {
          sent_at: '',
          received_at: '',
          duration_ms: entry.ocrTimeMs || 0,
          bubbles_count: (entry.bubbles || []).length
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
    },
    generatePlainTextReport() {
      const slices = [...this.history].reverse();
      const ocrList = slices.map(s => s.ocr?.duration_ms).filter(n => typeof n === 'number' && n > 0);
      const llmList = slices.map(s => s.llm?.duration_ms).filter(n => typeof n === 'number' && n > 0);
      const avgOcr = ocrList.length ? Math.round(ocrList.reduce((a, b) => a + b, 0) / ocrList.length) : 0;
      const avgLlm = llmList.length ? Math.round(llmList.reduce((a, b) => a + b, 0) / llmList.length) : 0;
      const latestMode = slices[slices.length - 1]?.mode || '未知';
      const livePatches = globalThis.ComicImageCapture?.getLivePatches?.() || [];
      const allSliceBubbles = globalThis.ComicImageCapture?.getAllSliceBubbles?.() || [];
      const currentLang = globalThis.ComicLLMStore?.getOcrLang ? globalThis.ComicLLMStore.getOcrLang() : 'auto';

      let out = '';
      out += '================================================================================\n';
      out += '           COMIC TRANSLATE FULL DIAGNOSTIC REPORT (Dev HUD v0.8.6)\n';
      out += '================================================================================\n';
      out += `导出时间: ${new Date().toLocaleString()}\n`;
      out += `目标网址: ${typeof location !== 'undefined' ? location.href : '未知'}\n`;
      out += `运行模式: ${latestMode}\n`;
      out += `当前语种: ${currentLang}\n`;
      out += `切片总数: ${slices.length}\n`;
      out += `平均 OCR 耗时: ${avgOcr} ms\n`;
      out += `平均 LLM 耗时: ${avgLlm} ms\n`;
      out += '--------------------------------------------------------------------------------\n\n';

      // 0. 极速流水线核心遥测 (Step 1 & Step 2 数据监控)
      const telem = globalThis.ComicImageCapture?.getPipelineTelemetry?.();
      if (telem) {
        out += '================================================================================\n';
        out += '[极速流水线核心实测遥测 (Step 1 & Step 2 数据监控)]\n';
        out += '================================================================================\n';
        out += `预热状态: 探测 ${telem.prewarm?.probed || 0}/${telem.prewarm?.total || 0} 页, Bitmap池预热 ${telem.prewarm?.warmedBitmaps || 0}/6 页\n`;
        out += `首图加载耗时: ${telem.firstImageReadyMs ? (telem.firstImageReadyMs + ' ms') : '--'}\n`;
        out += `首切片生成耗时: ${telem.clickToSlice0ReadyMs ? (telem.clickToSlice0ReadyMs + ' ms') : '--'}\n`;
        out += `点击到首切片 OCR 完成: ${telem.clickToFirstOcrMs ? (telem.clickToFirstOcrMs + ' ms') : '--'} (纯OCR: ${telem.slice0OcrDurationMs ? (telem.slice0OcrDurationMs + ' ms') : '--'})\n`;
        out += `点击到前6切片 OCR 全部就绪: ${telem.slices1To5AllOcrReadyMs ? (telem.slices1To5AllOcrReadyMs + ' ms') : '--'}\n`;
        out += `首切片气泡数: ${telem.slice0Bubbles || 0} 个\n`;
        out += `前6切片累计气泡数: ${telem.first6SlicesBubbles || 0} 个\n`;
        out += `首切片大模型首字返回延迟 (TTFB): ${telem.firstLlmTtfbMs ? (telem.firstLlmTtfbMs + ' ms') : '--'}\n`;
        out += `首切片大模型完整翻译耗时: ${telem.firstLlmTotalMs ? (telem.firstLlmTotalMs + ' ms') : '--'}\n`;
        out += '--------------------------------------------------------------------------------\n\n';
      }

      // 1. 跨切线接缝重叠与双胞胎气泡碰撞扫描
      out += '================================================================================\n';
      out += '[核心异常检测 1]：跨切线接缝碰撞与重叠双胞胎气泡扫描 (排查重影)\n';
      out += '================================================================================\n';
      let cutCollisionFound = 0;
      for (let i = 0; i < allSliceBubbles.length - 1; i++) {
        const itemA = allSliceBubbles[i];
        const itemB = allSliceBubbles[i + 1];
        if (!itemA?.slice || !itemB?.slice) continue;
        const cutY = itemA.slice.endY;

        for (const bA of itemA.bubbles) {
          if (!bA?.box_abs || bA.box_abs.length < 4) continue;
          const aBottom = bA.box_abs[1] + bA.box_abs[3];
          const distToCutA = Math.abs(aBottom - cutY);

          for (const bB of itemB.bubbles) {
            if (!bB?.box_abs || bB.box_abs.length < 4) continue;
            const bTop = bB.box_abs[1];
            const distToCutB = Math.abs(bTop - cutY);

            // 若两个气泡分别贴紧切线上方和切线下方 (<= 15px)
            if (distToCutA <= 15 && distToCutB <= 15) {
              const ax1 = bA.box_abs[0], ax2 = bA.box_abs[0] + bA.box_abs[2];
              const bx1 = bB.box_abs[0], bx2 = bB.box_abs[0] + bB.box_abs[2];
              const interX = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1));
              const minW = Math.min(bA.box_abs[2], bB.box_abs[2]);
              const xRatio = minW > 0 ? (interX / minW) : 0;

              if (xRatio >= 0.5) {
                cutCollisionFound++;
                out += `⚠️ [发现切线碰撞双胞胎气泡 #${cutCollisionFound}]\n`;
                out += `   - 切片 #${itemA.sliceIndex} 底部气泡: box_abs=[${bA.box_abs.join(', ')}], 底界=${aBottom}px, 切线=${cutY}px\n`;
                out += `     原文: "${bA.text || ''}"\n`;
                out += `     译文: "${bA.translatedText || '(未翻译)'}"\n`;
                out += `   - 切片 #${itemB.sliceIndex} 顶部气泡: box_abs=[${bB.box_abs.join(', ')}], 顶界=${bTop}px, 切线=${cutY}px\n`;
                out += `     原文: "${bB.text || ''}"\n`;
                out += `     译文: "${bB.translatedText || '(未翻译)'}"\n`;
                out += `   - 水平 X 轴重合度: ${(xRatio * 100).toFixed(1)}%\n`;
                out += `   结论: 切线 Y=${cutY}px 横穿该文本框，导致两个切片分别检出半个气泡！\n\n`;
              }
            }
          }
        }
      }
      if (!cutCollisionFound) {
        out += '✅ 未发现跨切线邻近碰撞气泡。\n\n';
      }

      // 2. 大模型行号对齐与跳号/错位检查
      out += '================================================================================\n';
      out += '[核心异常检测 2]：大模型行号对齐与跳号/错位检查 (排查乱序)\n';
      out += '================================================================================\n';
      let llmIssueFound = 0;
      for (const s of slices) {
        const inputLines = (s.llm?.user_input || '').split('\n').filter(l => l.trim().startsWith('['));
        const rawRes = s.llm?.raw_response || '';
        const outputLines = rawRes.split('\n').filter(l => /^(?:\[\d+\]|\d+[\.、：:])/.test(l.trim()));

        const inCount = inputLines.length;
        const outCount = outputLines.length;
        const hasCountMismatch = (inCount > 0 && outCount > 0 && inCount !== outCount);

        const outIds = outputLines.map(l => {
          const m = l.trim().match(/^(?:\[(\d+)\]|(\d+)[\.、：:])/);
          return m ? parseInt(m[1] || m[2], 10) : -1;
        }).filter(id => id >= 0);

        const isOneIndexed = (inCount > 0 && outIds.length > 0 && outIds[0] === 1 && !outIds.includes(0));

        if (hasCountMismatch || isOneIndexed) {
          llmIssueFound++;
          out += `⚠️ [发现行号对齐异常 #${llmIssueFound} - ${s.sliceTag}]\n`;
          out += `   输入行数: ${inCount} 行, 模型输出有效行数: ${outCount} 行\n`;
          if (hasCountMismatch) {
            out += `   [行数不符] 大模型输出的行数与输入行数不一致 (漏行或合并行)！\n`;
          }
          if (isOneIndexed) {
            out += `   [首行偏离 1] 大模型疑似采用从 1 开始的序号，导致所有台词整体后移一位！\n`;
          }
          out += `   【输入片段】:\n   ${inputLines.slice(0, 3).join('\n   ')}\n`;
          out += `   【输出片段】:\n   ${outputLines.slice(0, 3).join('\n   ')}\n\n`;
        }
      }
      if (!llmIssueFound) {
        out += '✅ 大模型行号与输入行完全一一对应，未检出跳行或序号错位。\n\n';
      }

      // 3. 当前 DOM 补丁渲染重叠扫描
      out += '================================================================================\n';
      out += '[核心异常检测 3]：当前活动 DOM 物理补丁空间堆叠扫描\n';
      out += '================================================================================\n';
      out += `当前活动补丁总数: ${livePatches.length} 个\n`;
      let domCollisionCount = 0;
      for (let i = 0; i < livePatches.length; i++) {
        const pA = livePatches[i];
        const topA = parseFloat(pA.top);
        const leftA = parseFloat(pA.left);

        for (let j = i + 1; j < livePatches.length; j++) {
          const pB = livePatches[j];
          const topB = parseFloat(pB.top);
          const leftB = parseFloat(pB.left);

          if (!isNaN(topA) && !isNaN(topB) && Math.abs(topA - topB) <= 15 && Math.abs(leftA - leftB) <= 25) {
            domCollisionCount++;
            out += `⚠️ [DOM 物理重合报警 #${domCollisionCount}]\n`;
            out += `   - 补丁 1 (key="${pA.key}"): top=${pA.top}, left=${pA.left}, w=${pA.width}, text="${pA.text}"\n`;
            out += `   - 补丁 2 (key="${pB.key}"): top=${pB.top}, left=${pB.left}, w=${pB.width}, text="${pB.text}"\n`;
            out += `   警告: 两个独立补丁物理重叠，肉眼必见文字重影！\n\n`;
          }
        }
      }
      if (!domCollisionCount) {
        out += '✅ 当前活动的 DOM 补丁无物理重叠冲突。\n\n';
      }

      // 4. 详细切片日志
      out += '================================================================================\n';
      out += '[逐切片时序明细与原始报文记录]\n';
      out += '================================================================================\n';
      for (const s of slices) {
        out += `--------------------------------------------------------------------------------\n`;
        out += `${s.sliceTag} (记录于 ${s.display_time})\n`;
        const clickOcrInfo = s.ocr?.click_to_ocr_ms ? ` (首屏端到端: ${s.ocr.click_to_ocr_ms}ms)` : '';
        out += `  OCR: 耗时 ${s.ocr?.duration_ms || 0}ms${clickOcrInfo}, 检出气泡 ${s.ocr?.bubbles_count || 0} 个\n`;
        out += `  LLM: 耗时 ${s.llm?.duration_ms || 0}ms, 模型 ${s.llm?.model || '无'}\n`;
        if (s.llm?.user_input) {
          out += `  【LLM 输入】:\n${s.llm.user_input.split('\n').map(l => '    ' + l).join('\n')}\n`;
        }
        if (s.llm?.raw_response) {
          out += `  【LLM 原始响应】:\n${s.llm.raw_response.split('\n').map(l => '    ' + l).join('\n')}\n`;
        }
      }
      out += '================================================================================\n';
      out += '                           REPORT END\n';
      out += '================================================================================\n';
      return out;
    }
  };
  globalThis.ComicPacketInspector = PacketInspector;

  function renderPacketTelemetry() {
    if (!root) return;

    // 1. 更新链路与预热遥测指标 (Pipeline Telemetry)
    const telem = globalThis.ComicImageCapture?.getPipelineTelemetry?.();
    if (telem) {
      const badge = root.querySelector('#val-prewarm-badge');
      if (badge) {
        if (telem.prewarm?.probed > 0 || telem.prewarm?.warmedBitmaps > 0) {
          badge.textContent = `🔥 探测:${telem.prewarm.probed} / 预热:${telem.prewarm.warmedBitmaps}图`;
          badge.style.color = '#4ade80';
        } else {
          badge.textContent = '🔥 预热中...';
          badge.style.color = '#38bdf8';
        }
      }
      const firstImg = root.querySelector('#val-first-img-time');
      if (firstImg && telem.firstImageReadyMs) firstImg.textContent = `${telem.firstImageReadyMs} ms`;
      const slice0Gen = root.querySelector('#val-slice0-gen-time');
      if (slice0Gen && telem.clickToSlice0ReadyMs) slice0Gen.textContent = `${telem.clickToSlice0ReadyMs} ms`;
      const clickOcr = root.querySelector('#val-click-ocr-time');
      if (clickOcr && telem.clickToFirstOcrMs) clickOcr.textContent = `${telem.clickToFirstOcrMs} ms`;
      const top6Ocr = root.querySelector('#val-top6-ocr-time');
      if (top6Ocr && telem.slices1To5AllOcrReadyMs) top6Ocr.textContent = `${telem.slices1To5AllOcrReadyMs} ms`;
      const slice0Bub = root.querySelector('#val-slice0-bubbles');
      if (slice0Bub && telem.slice0Bubbles) slice0Bub.textContent = `${telem.slice0Bubbles} 个`;
      const top6Bub = root.querySelector('#val-top6-bubbles');
      if (top6Bub && telem.first6SlicesBubbles) top6Bub.textContent = `${telem.first6SlicesBubbles} 个`;
      const ttfb = root.querySelector('#val-llm-ttfb');
      if (ttfb && telem.firstLlmTtfbMs) ttfb.textContent = `${telem.firstLlmTtfbMs} ms`;
      const llmTot = root.querySelector('#val-llm-total');
      if (llmTot && telem.firstLlmTotalMs) llmTot.textContent = `${telem.firstLlmTotalMs} ms`;
    }

    // 2. 更新最新切片报文与耗时
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
    if (ocrEl) {
      const clickOcrTag = pkt.ocr?.click_to_ocr_ms ? ` (首片端到端: ${pkt.ocr.click_to_ocr_ms}ms)` : '';
      ocrEl.textContent = `${ocrMs} ms${clickOcrTag}`;
    }
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
    if (l === 'es' || l === 'spanish' || l === '西文' || l === '西语' || l === '西班牙语') return 'es';
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
    setDetectedLangDesc: (lang) => {
      if (root) {
        const el = root.querySelector('#val-ocr-lang-desc');
        if (el) {
          const LANG_LABELS = {
            'auto': '🌐 自动探测 (前5切片)',
            'es': '🇪🇸 西班牙语 (锁定)',
            'en': '🇺🇸 英语 (锁定)',
            'kr': '🇰🇷 韩语 (锁定)',
            'ja': '🇯🇵 日语 (锁定)',
            'ru': '🇷🇺 俄语 (锁定)'
          };
          el.textContent = LANG_LABELS[lang] || `🌐 ${lang} (锁定)`;
        }
      }
    },
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
