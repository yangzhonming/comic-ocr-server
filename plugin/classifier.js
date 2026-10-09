(() => {
  // 只负责读取页面 DOM 并输出布局证据；不访问名单存储或 Popup。
  // detect() 返回判定证据，以及仅供网页侧使用的 reader / fallbackReader。
  // reader 含 DOM 节点，不能直接通过 chrome.runtime 消息发送到 Popup。
  const MAX_IMAGES = 600;

  function median(numbers) {
    const sorted = [...numbers].sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  }

  function visibleImage(img) {
    // 懒加载占位图不算已识别图片，但会让页面保持 pending，等待后续 load/DOM 事件。
    const rect = img.getBoundingClientRect();
    const style = getComputedStyle(img);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return null;
    const minWidth = Math.max(150, Math.min(420, innerWidth * 0.28));
    if (rect.width < minWidth || rect.height < 40 || rect.width * rect.height < Math.max(16000, innerWidth * 20)) return null;
    if (!img.complete || img.naturalWidth < Math.max(160, rect.width * 0.35) || img.naturalHeight < 40) {
      return { pending: true };
    }
    return {
      node: img,
      x: rect.left,
      top: rect.top + scrollY,
      bottom: rect.bottom + scrollY,
      width: rect.width,
      height: rect.height,
      center: rect.left + rect.width / 2,
      link: img.closest('a')?.href || null
    };
  }

  function collectImages() {
    const images = [];
    let pending = 0;
    for (const img of Array.from(document.images).slice(0, MAX_IMAGES)) {
      const item = visibleImage(img);
      if (item?.pending) pending++;
      else if (item) images.push(item);
    }
    images.sort((a, b) => a.top - b.top || a.x - b.x);
    return { images, pending };
  }

  function sameColumn(previous, current) {
    // 用渲染位置聚合相邻切片；允许少量留白，不要求图片物理无缝拼接。
    const widthRatio = Math.min(previous.width, current.width) / Math.max(previous.width, current.width);
    const centerGap = Math.abs(previous.center - current.center);
    const gap = current.top - previous.bottom;
    return widthRatio >= 0.78 && centerGap <= Math.max(40, previous.width * 0.12) &&
      gap >= -40 && gap <= Math.max(320, innerHeight * 0.45, Math.min(previous.height, current.height) * 0.5);
  }

  function commonRoot(items) {
    if (!items.length) return null;
    const firstImgNode = items[0].node;
    if (!firstImgNode) return null;

    // 1. 如果已有两个及以上的漫画切片被捕获，首先计算它们的最近公共祖先 (Lowest Common Ancestor)
    let root = firstImgNode.parentElement;
    if (items.length >= 2) {
      const last = items[items.length - 1].node;
      for (let node = root; node; node = node.parentElement) {
        if (node.contains(last)) {
          root = node;
          break;
        }
      }
    }

    // 辅助函数：探查容器内有效漫画图片数量（排除评论区、头像、页头页脚等干扰项）
    const countValidImages = (container) => {
      if (!container?.querySelectorAll) return 0;
      const imgs = container.querySelectorAll('img');
      let count = 0;
      for (const img of imgs) {
        if (img.closest?.('.comment, .comments, #comments, .avatar, .reply, .replies, footer, header, nav, .footer, .header, .nav')) {
          continue;
        }
        const style = typeof getComputedStyle === 'function' ? getComputedStyle(img) : null;
        if (style && (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)) {
          continue;
        }
        const w = img.getBoundingClientRect?.().width || img.naturalWidth || img.offsetWidth || 0;
        const h = img.getBoundingClientRect?.().height || img.naturalHeight || img.offsetHeight || 0;
        if (w > 0 && h > 0 && (w < 80 || h < 40)) continue;
        count++;
      }
      return count;
    };

    // 如果当前最近公共祖先已经包含多张漫画图片（>= 2 张），且不是 body/documentElement，
    // 说明这就是包含整话切片的紧致最小容器！绝对不继续向上冒泡，彻底杜绝侵入包裹评论区的上层大容器！
    if (root && root !== document.body && root !== document.documentElement) {
      const count = countValidImages(root);
      if (count >= 2) {
        return root;
      }
    }

    // 2. 自底向上寻找，然后再从上往下判断：
    // 若当前 root 仅为单图包裹小盒子（例如首屏仅加载第 1 页，或者只有一张图片）：
    // 从第一张图片往上逐级找容器：
    // - 判断高度：漫画页面往往比容器窄，但容器高度必定比单图高（或包含间隙）
    // - 容器宽度跟单图一样或比它大
    // - 标记为疑似容器后，向下探查包含多少张图片：
    //   若仅有 1 张，说明是单图盒子，继续往上找；
    //   若包含多张图片，即锁定为离图片最近的阅读器容器并立即返回，不再继续向上冒泡！
    const imgRect = firstImgNode.getBoundingClientRect?.() || {};
    const imgWidth = items[0].width || imgRect.width || firstImgNode.naturalWidth || firstImgNode.offsetWidth || 0;
    const imgHeight = items[0].height || imgRect.height || firstImgNode.naturalHeight || firstImgNode.offsetHeight || 0;

    let curr = root ? root.parentElement : firstImgNode.parentElement;
    let fallback = root || firstImgNode.parentElement;
    let semanticCandidate = null;

    while (curr && curr !== document.body && curr !== document.documentElement) {
      const tag = curr.tagName?.toUpperCase();
      const idAndClass = `${curr.id || ''} ${curr.className || ''}`.toLowerCase();

      // 遇到导航、页眉页脚、评论区标签直接跳过
      if (tag === 'NAV' || tag === 'HEADER' || tag === 'FOOTER' || tag === 'ASIDE') {
        curr = curr.parentElement;
        continue;
      }
      if (/(?:comments?|reply|avatar|sidebar|recommend)/i.test(idAndClass)) {
        curr = curr.parentElement;
        continue;
      }

      // 记录语义化命名的阅读区容器候选
      if (/(?:reader|comic|chapter|viewer|read[-_]?content|manga|webtoon)/i.test(idAndClass)) {
        if (!semanticCandidate) semanticCandidate = curr;
      }

      const rect = curr.getBoundingClientRect?.() || {};
      const width = rect.width || curr.offsetWidth || curr.clientWidth || 0;
      const height = Math.max(rect.height || 0, curr.offsetHeight || 0, curr.scrollHeight || 0);

      const widthOk = width === 0 || width >= imgWidth * 0.82;
      const heightOk = height === 0 || height >= imgHeight * 0.98;

      if (widthOk && heightOk) {
        const imageCount = countValidImages(curr);
        if (imageCount >= 2) {
          // 找到离它最近且包含多张图片的容器，立即确认并返回！
          return curr;
        }
      }

      fallback = curr;
      curr = curr.parentElement;
    }

    return semanticCandidate || fallback;
  }

  function textBetween(a, b) {
    if (!(a.node.compareDocumentPosition(b.node) & Node.DOCUMENT_POSITION_FOLLOWING)) return 999;
    const range = document.createRange();
    range.setStartAfter(a.node);
    range.setEndBefore(b.node);
    return range.toString().replace(/\s+/g, '').length;
  }

  function hasGrid(images) {
    for (let i = 0; i < images.length; i++) {
      for (let j = i + 1; j < images.length; j++) {
        const a = images[i], b = images[j];
        if (b.top >= a.bottom) break;
        const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        if (overlapY > Math.min(a.height, b.height) * 0.4 && overlapX < Math.min(a.width, b.width) * 0.2) return true;
      }
    }
    return false;
  }

  function semanticSignals(root) {
    let path = location.pathname.toLowerCase();
    try { path = decodeURIComponent(path); } catch { /* 保留原始路径 */ }
    const heading = (document.querySelector('h1, h2')?.textContent || '').slice(0, 180);
    const rootName = `${root?.id || ''} ${String(root?.className || '')}`.toLowerCase();
    const chapterPath = /(?:chapter|episode|chap|第.{1,8}[话回章]|\bch[-_]?\d+\b)/i.test(path + ' ' + heading);
    const readerName = /(?:reader|chapter[-_ ]?(?:images|content)|webtoon|comic[-_ ]?view|manga[-_ ]?view)/i.test(rootName);
    const chapterNav = [...document.querySelectorAll('a, button')].slice(0, 250)
      .some(node => /^(?:上一[话章页]|下一[话章页]|previous\s*(?:chapter|episode)|next\s*(?:chapter|episode))$/i.test((node.textContent || '').trim()));
    const product = Boolean(document.querySelector('[itemtype*="schema.org/Product"], meta[property="og:type"][content="product"]'));
    return { score: Number(chapterPath) + Number(readerName) + Number(chapterNav), product };
  }

  function inspectGroup(items) {
    const root = commonRoot(items);
    if (!root || root === document.body || root === document.documentElement) return null;
    const multiImageContainer = (root.querySelectorAll?.('img')?.length || 0) >= 2;
    const span = items[items.length - 1].bottom - items[0].top;
    const singleLong = items.length === 1 && items[0].height >= Math.max(innerHeight * 2.2, items[0].width * 2.2);
    const continuous = items.length >= 3 && span >= innerHeight * 1.35;
    if (!singleLong && !continuous && !multiImageContainer) return null;
    const widths = items.map(item => item.width);
    const midWidth = median(widths);
    const consistent = items.filter(item => Math.abs(item.width - midWidth) / midWidth <= 0.18).length / items.length;
    const gaps = items.slice(1).map((item, index) => textBetween(items[index], item));
    const textHeavy = gaps.filter(length => length > 35).length;
    const links = new Set(items.map(item => item.link).filter(Boolean));
    const { score: semantic, product } = semanticSignals(root);
    const area = items.reduce((sum, item) => sum + item.width * item.height, 0);
    if (consistent < 0.8 || textHeavy > Math.max(1, Math.floor(gaps.length * 0.25))) return null;
    if (links.size >= Math.max(3, Math.ceil(items.length * 0.7))) return null;
    if (product && semantic === 0) return null;
    if (singleLong && semantic === 0) return null;
    return { items, area, semantic, root };
  }

  function buildReader(items, root) {
    const loadedFirst = items[0];
    const referenceWidth = median(items.map(item => item.width));
    let firstImage = loadedFirst.node;
    let firstTop = loadedFirst.top;
    // 首图可能仍是懒加载占位图。只在已确定的阅读容器内向上找同列占位图，
    // 避免把全站第一张 Logo、广告或目录封面误当作漫画首图。
    for (const img of root.querySelectorAll?.('img') || []) {
      if (img === loadedFirst.node || (img.complete && img.naturalWidth >= referenceWidth * 0.35)) continue;
      const rect = img.getBoundingClientRect();
      const style = getComputedStyle(img);
      const top = rect.top + scrollY;
      const center = rect.left + rect.width / 2;
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
      if (top >= firstTop || rect.width < referenceWidth * 0.78 || rect.height < 40) continue;
      if (Math.abs(center - loadedFirst.center) > Math.max(40, referenceWidth * 0.12)) continue;
      firstImage = img;
      firstTop = top;
    }
    return {
      root,
      firstImage,
      lastImage: items.at(-1).node,
      imageNodes: items.map(item => item.node),
      anchorSource: firstImage === loadedFirst.node ? 'loaded' : 'placeholder'
    };
  }

  function weakReaderEvidence(images, groups) {
    // 豁免保底比自动识别宽松，但仍拒绝网格、离散区域和图文混排。
    if (!images.length || hasGrid(images)) return { basic: false, substantial: false };
    const totalArea = images.reduce((sum, item) => sum + item.width * item.height, 0);
    const ranked = groups.map(items => ({ items, area: items.reduce((sum, item) => sum + item.width * item.height, 0) }))
      .sort((a, b) => b.area - a.area);
    const best = ranked[0];
    if (!best || best.area / totalArea < 0.58) return { basic: false, substantial: false };
    const root = commonRoot(best.items);
    if (!root || root === document.body || root === document.documentElement) return { basic: false, substantial: false };
    const gaps = best.items.slice(1).map((item, index) => textBetween(best.items[index], item));
    if (gaps.filter(length => length > 35).length > Math.max(1, Math.floor(gaps.length * 0.25))) return { basic: false, substantial: false };
    const links = new Set(best.items.map(item => item.link).filter(Boolean));
    if (links.size >= Math.max(3, Math.ceil(best.items.length * 0.7))) return { basic: false, substantial: false };
    const span = best.items.at(-1).bottom - best.items[0].top;
    const substantial = (best.items.length >= 2 && span >= innerHeight * 1.25 && best.area >= innerWidth * innerHeight * 0.65) ||
      (best.items.length === 1 && best.items[0].height >= Math.max(innerHeight * 2.5, best.items[0].width * 2.8));
    return { basic: true, substantial, reader: buildReader(best.items, root) };
  }

  function detect() {
    // 自动判定只输出证据，不读取 URL 名单；调用方负责黑名单优先级。
    const { images, pending } = collectImages();
    const groups = [];
    for (const image of images) {
      const group = groups.find(items => sameColumn(items[items.length - 1], image));
      if (group) group.push(image);
      else groups.push([image]);
    }
    const fallback = weakReaderEvidence(images, groups);
    const candidates = groups.map(inspectGroup).filter(Boolean).sort((a, b) => b.area - a.area);
    const best = candidates[0];
    if (!best) return { kind: pending ? 'pending' : 'no', reason: pending ? '等待大图加载' : '没有找到连续阅读区', imageCount: images.length, fallbackEligible: fallback.basic, fallbackStrong: fallback.substantial, fallbackReader: fallback.reader || null };
    const allArea = images.reduce((sum, item) => sum + item.width * item.height, 0);
    if (best.area / allArea < 0.62 || (hasGrid(images) && best.area / allArea < 0.78)) {
      return { kind: 'no', reason: '图片分散在多个区域或构成网格', imageCount: images.length, fallbackEligible: false };
    }
    if (candidates[1] && candidates[1].area > best.area * 0.6) {
      return { kind: 'no', reason: '存在多个相近的图片区', imageCount: images.length, fallbackEligible: false };
    }
    return { kind: 'yes', reason: best.semantic ? '找到连续阅读区和章节线索' : '找到占主导的连续阅读区', imageCount: best.items.length, reader: buildReader(best.items, best.root) };
  }

  globalThis.ComicPageClassifier = Object.freeze({ detect });
})();
