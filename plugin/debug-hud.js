(() => {
  // 独立开发者诊断面板 (Dev HUD)
  // 测试阶段默认开启（上线时可将 DEFAULT_DEBUG 改为 false）。
  // 支持通过控制台全局指令 window.enableComicDebug() / disableComicDebug() 随时开关。
  let host = null;
  let root = null;
  let isVisible = false;
  let cachedStatus = null;

  // 严格单次会话模式：跨页面默认永远不自启，避免遮挡阅读
  function isActive() {
    return isVisible;
  }

  function openOnce() {
    setVisible(true);
    console.log('%c[ComicDebug]%c 开发者诊断看版已在当前页面唤起（单次生效，刷新后自动关闭）！', 'color:#38bdf8;font-weight:bold;', 'color:inherit;');
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

  function getCapturedContainerHtml() {
    const html = globalThis.ComicImageCapture?.getReaderHtml?.();
    if (html && html.trim().length > 0) return html;
    const fallbackEl = document.querySelector('.reading-content, #reader, .reader-container, .chapter-content, .viewer-cnt, #viewer, .comic-container');
    if (fallbackEl) return fallbackEl.outerHTML;
    return document.body ? document.body.innerHTML : '';
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
          width: 300px;
          padding: 12px 14px;
          border-radius: 12px;
          background: rgba(15, 23, 42, 0.94);
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
          border: 1px solid rgba(56, 189, 248, 0.35);
          color: #e2e8f0;
          font-size: 11px;
          line-height: 1.5;
          box-shadow: 0 12px 30px rgba(0, 0, 0, 0.7), 0 0 16px rgba(56, 189, 248, 0.15);
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
          cursor: grab;
          user-select: none;
          -webkit-user-select: none;
          touch-action: none;
        }
        .header:active {
          cursor: grabbing;
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
          font-weight: 700;
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
          margin-top: 4px;
          font-size: 10px;
        }
        .btn-action {
          width: 100%;
          padding: 5px 0;
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
        <div class="header" title="拖动此处可移动面板位置">
          <div style="display:flex;align-items:center;gap:6px;">
            <span>🛠️ Dev HUD 诊断看版</span>
            <span style="font-size:9px;padding:1px 5px;border-radius:4px;background:rgba(245,158,11,0.2);color:#f59e0b;font-weight:normal;">可拖动 · 单次生效</span>
          </div>
          <button class="close-btn" title="关闭面板">✕</button>
        </div>

        <!-- 模块 1: 切片进度与在途并发 -->
        <div class="section">
          <div class="section-title">📦 切片进度与在途并发 (Pipeline)</div>
          <div class="stat-grid">
            <div class="stat-item"><span class="stat-label">总图片</span><span class="stat-val" id="val-total">0</span></div>
            <div class="stat-item"><span class="stat-label">已切片</span><span class="stat-val highlight" id="val-slices">0</span></div>
            <div class="stat-item"><span class="stat-label">⚡ 属性直取</span><span class="stat-val highlight" id="val-track1">0</span></div>
            <div class="stat-item"><span class="stat-label">👁️ 动态捕获</span><span class="stat-val warn" id="val-track2">0</span></div>
            <div class="stat-item"><span class="stat-label">📦 已完成</span><span class="stat-val highlight" id="val-batches">0</span></div>
            <div class="stat-item"><span class="stat-label">🚀 在途并发</span><span class="stat-val" id="val-pending-batch">0</span></div>
          </div>
          <div class="status-text" id="val-status">就绪待命</div>
        </div>

        <!-- 模块 2: 耗时与极速链路透视 -->
        <div class="section" id="section-pipeline-telemetry" style="border-top:1px solid rgba(148,163,184,0.2);padding-top:8px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
            <div class="section-title" style="margin:0;">⚡ 极速双轨耗时透视 (Latency)</div>
            <span id="val-prewarm-badge" style="font-size:10px;padding:1px 5px;border-radius:4px;background:rgba(56,189,248,0.2);color:#38bdf8;">🔥 预热中...</span>
          </div>
          <div class="stat-grid">
            <div class="stat-item"><span class="stat-label">首图就绪</span><span class="stat-val highlight" id="val-first-img-time">-- ms</span></div>
            <div class="stat-item"><span class="stat-label">首片生成</span><span class="stat-val highlight" id="val-slice0-gen-time">-- ms</span></div>
            <div class="stat-item"><span class="stat-label">⚡ 点击→首OCR</span><span class="stat-val highlight" id="val-click-ocr-time">-- ms</span></div>
            <div class="stat-item"><span class="stat-label">📦 前6片全OCR</span><span class="stat-val" id="val-top6-ocr-time">-- ms</span></div>
            <div class="stat-item"><span class="stat-label">💬 首片气泡</span><span class="stat-val highlight" id="val-slice0-bubbles">--</span></div>
            <div class="stat-item"><span class="stat-label">📚 前6片总气泡</span><span class="stat-val warn" id="val-top6-bubbles">--</span></div>
            <div class="stat-item"><span class="stat-label">✨ 首字TTFB</span><span class="stat-val highlight" id="val-llm-ttfb">-- ms</span></div>
            <div class="stat-item"><span class="stat-label">🏁 首片LLM总耗</span><span class="stat-val" id="val-llm-total">-- ms</span></div>
            <div class="stat-item"><span class="stat-label">⏱️ 最近OCR</span><span class="stat-val highlight" id="val-ocr-time">-- ms</span></div>
            <div class="stat-item"><span class="stat-label">⚡ 最近LLM</span><span class="stat-val highlight" id="val-llm-time">-- ms</span></div>
          </div>
        </div>

        <!-- 模块 3: 诊断导出 (全景打包) -->
        <div class="section" style="border-top:1px solid rgba(148,163,184,0.2);padding-top:8px;margin-bottom:0;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
            <div class="section-title" style="margin:0;">💾 诊断导出 (全景打包)</div>
            <span id="label-container-info" style="font-size:10px;color:#38bdf8;">就绪待命</span>
          </div>
          <div style="display:flex;flex-direction:column;gap:6px;">
            <button id="btn-export-txt-report" class="btn-action" style="padding:5px 0;font-size:10px;border-color:rgba(46,213,115,0.4);background:rgba(46,213,115,0.18);color:#2ed573;font-weight:700;">💾 导出全量诊断报告 (.txt)</button>
            <button id="btn-export-container-html" class="btn-action" style="padding:4px 0;font-size:10px;border-color:rgba(56,189,248,0.4);background:rgba(14,165,233,0.12);color:#38bdf8;">🌐 导出页面镜像包 (.html)</button>
          </div>
        </div>
      </div>
    `;

    // 拖动支持 (指针事件，同时兼容鼠标与触控)
    const headerEl = root.querySelector('.header');
    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let initialLeft = 0;
    let initialTop = 0;

    headerEl.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.close-btn')) return;
      isDragging = true;
      headerEl.setPointerCapture(e.pointerId);
      const rect = host.getBoundingClientRect();
      host.style.right = 'auto';
      host.style.bottom = 'auto';
      host.style.left = `${rect.left}px`;
      host.style.top = `${rect.top}px`;
      startX = e.clientX;
      startY = e.clientY;
      initialLeft = rect.left;
      initialTop = rect.top;
      e.preventDefault();
    });

    headerEl.addEventListener('pointermove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const maxL = Math.max(0, window.innerWidth - 310);
      const maxT = Math.max(0, window.innerHeight - 80);
      const newLeft = Math.max(0, Math.min(maxL, initialLeft + dx));
      const newTop = Math.max(0, Math.min(maxT, initialTop + dy));
      host.style.left = `${newLeft}px`;
      host.style.top = `${newTop}px`;
    });

    const stopDrag = (e) => {
      if (isDragging) {
        isDragging = false;
        try { headerEl.releasePointerCapture(e.pointerId); } catch {}
      }
    };
    headerEl.addEventListener('pointerup', stopDrag);
    headerEl.addEventListener('pointercancel', stopDrag);

    root.querySelector('.close-btn').addEventListener('click', () => {
      setVisible(false);
    });


    root.querySelector('#btn-export-txt-report').addEventListener('click', () => {
      PacketInspector.downloadDiagnosticReport();
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
        mode: entry.mode || (entry.apiEndpoint?.includes('127.0.0.1') ? '手机加速 (Mobile 127.0.0.1:8080)' : '云端 (Cloud Serverless)'),
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

      // 4. 运行捕获异常记录 (Errors)
      const capturedErrors = (globalThis.ComicErrorTracker?.list ? globalThis.ComicErrorTracker.list() : []);
      out += '================================================================================\n';
      out += `[运行捕获异常清单 (共 ${capturedErrors.length} 项)]\n`;
      out += '================================================================================\n';
      if (capturedErrors.length === 0) {
        out += '✅ 暂无拦截到的运行异常，切片与推理运行顺畅。\n\n';
      } else {
        for (const err of capturedErrors) {
          out += `❌ [${err.time || '--'}] 类型: ${err.type} | 切片: ${err.sliceTag}\n`;
          out += `   详情: ${err.detail}\n\n`;
        }
      }

      // 5. 详细逐切片原始报文与完整 OCR JSON 数据
      out += '================================================================================\n';
      out += '[逐切片时序明细、完整 OCR 气泡 JSON 与大模型报文记录]\n';
      out += '================================================================================\n';
      for (const s of slices) {
        out += `--------------------------------------------------------------------------------\n`;
        out += `${s.sliceTag} (记录于 ${s.display_time})\n`;
        if (s.slice) {
          out += `  切片坐标: Y=${s.slice.startY}~${s.slice.endY}px (高度: ${s.slice.height}px, 宽度: ${s.slice.width}px, 落刀: ${s.slice.cutMethod || 'standard'})\n`;
        }
        const clickOcrInfo = s.ocr?.click_to_ocr_ms ? ` (首屏端到端: ${s.ocr.click_to_ocr_ms}ms)` : '';
        out += `  OCR: 耗时 ${s.ocr?.duration_ms || 0}ms${clickOcrInfo}, 检出气泡 ${s.ocr?.bubbles_count || 0} 个\n`;
        if (s.ocr?.sent_at) out += `  OCR 时间戳: 发送 ${s.ocr.sent_at} | 接收 ${s.ocr.received_at || '--'}\n`;
        if (s.bubbles && s.bubbles.length > 0) {
          out += `  【OCR 原始气泡 JSON 数据 (${s.bubbles.length}处)】:\n`;
          out += JSON.stringify(s.bubbles, null, 2).split('\n').map(l => '    ' + l).join('\n') + '\n';
        } else {
          out += `  【OCR 原始气泡 JSON 数据】: [] (0 处气泡检出)\n`;
        }

        out += `  LLM: 耗时 ${s.llm?.duration_ms || 0}ms, 模型 ${s.llm?.model || '无'}\n`;
        if (s.llm?.sent_at) out += `  LLM 时间戳: 发送 ${s.llm.sent_at} | 完成 ${s.llm.completed_at || '--'}\n`;
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
    },
    async downloadDiagnosticReport() {
      const txt = this.generatePlainTextReport();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `comic-diagnostic-${timestamp}.txt`;
      try {
        const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
        triggerBlobDownload(blob, filename);
      } catch (err) {
        console.error('[ComicPacketInspector] 下载报告异常:', err);
      }
      return { filename, text: txt };
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

    // 2. 更新最新切片耗时
    const pkt = PacketInspector.getLatest();
    if (pkt) {
      const ocrEl = root.querySelector('#val-ocr-time');
      const llmEl = root.querySelector('#val-llm-time');
      const ocrMs = pkt.ocr?.duration_ms ?? pkt.ocrTimeMs ?? 0;
      const llmMs = pkt.llm?.duration_ms ?? pkt.llmTimeMs ?? 0;
      if (ocrEl) {
        const clickOcrTag = pkt.ocr?.click_to_ocr_ms ? ` (首片端到端: ${pkt.ocr.click_to_ocr_ms}ms)` : '';
        ocrEl.textContent = `${ocrMs} ms${clickOcrTag}`;
      }
      if (llmEl) llmEl.textContent = `${llmMs} ms`;
    }

    // 3. 更新 Dev HUD 内拦截异常卡片列表
    const errorListEl = root.querySelector('#hud-error-list');
    const errorCountEl = root.querySelector('#val-error-count');
    if (errorListEl) {
      const errors = (globalThis.ComicErrorTracker?.list ? globalThis.ComicErrorTracker.list() : []);
      if (errorCountEl) {
        errorCountEl.textContent = errors.length > 0 ? `${errors.length} 处告警` : '暂无异常';
        errorCountEl.style.color = errors.length > 0 ? '#ef4444' : '#4ade80';
      }
      if (errors.length === 0) {
        errorListEl.innerHTML = '<div style="color:#94a3b8;font-size:10px;padding:2px 0;">✅ 暂无拦截异常，运行顺畅</div>';
      } else {
        errorListEl.innerHTML = errors.slice(0, 3).map(e => `
          <div class="error-card">
            <div class="error-card-title">🔴 ${e.type || '异常'} (${e.time || '--'})</div>
            <div class="error-card-desc">${e.sliceTag || ''} · ${e.detail || ''}</div>
          </div>
        `).join('');
      }
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
    try { localStorage.removeItem('comic_debug'); } catch {}
    setVisible(true);
    console.log('%c[ComicDebug]%c 开发者诊断面板已在当前页面激活（单次生效）！再次关闭可执行 disableComicDebug()', 'color:#38bdf8;font-weight:bold;', 'color:inherit;');
  }

  function disableComicDebug() {
    try { localStorage.removeItem('comic_debug'); } catch {}
    setVisible(false);
    console.log('%c[ComicDebug]%c 开发者诊断面板已关闭。', 'color:#94a3b8;font-weight:bold;', 'color:inherit;');
  }

  function isCaptureMode() {
    try {
      return localStorage.getItem('comic_dev_enable_capture') === '1';
    } catch {
      return false;
    }
  }

  function getCaptureEndpoint() {
    return 'http://127.0.0.1:8080';
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

  // 导出接口供 capture 派发数据与外部调试
  globalThis.ComicDebugHUD = Object.freeze({
    update,
    updatePackets: (pkt) => PacketInspector.record(pkt),
    enable: enableComicDebug,
    disable: disableComicDebug,
    openOnce,
    close: () => setVisible(false),
    toggle: () => setVisible(!isVisible),
    isVisible: () => isVisible,
    downloadReport: () => PacketInspector.downloadDiagnosticReport(),
    getReportText: () => PacketInspector.generatePlainTextReport(),
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

  // 清除历史遗留可能残存的持久化标记，确保新页面绝不自启
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('comic_debug');
    }
  } catch {}
})();
