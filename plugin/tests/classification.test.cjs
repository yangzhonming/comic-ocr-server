const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const folder = path.join(__dirname, '..');
const sharedCode = fs.readFileSync(path.join(folder, 'shared.js'), 'utf8');
const storeCode = fs.readFileSync(path.join(folder, 'store.js'), 'utf8');
const classifierCode = fs.readFileSync(path.join(folder, 'classifier.js'), 'utf8');
const contentCode = fs.readFileSync(path.join(folder, 'content.js'), 'utf8');

async function runCase({ url, pictures = [], gapText = '', saved = null, title = '', wrapInBoxes = false }) {
  const handlers = {};
  const siteMain = { id: 'site-main', className: 'main-wrapper', parentElement: null };
  const root = { id: 'chapter-images', className: 'reading-content', parentElement: siteMain };
  siteMain.contains = () => true;

  const images = pictures.map((picture, index) => {
    const imgObj = {
      index,
      complete: picture.complete !== false,
      naturalWidth: picture.naturalWidth ?? picture.width,
      naturalHeight: picture.naturalHeight ?? picture.height,
      getBoundingClientRect: () => ({
        left: picture.x,
        top: picture.y,
        bottom: picture.y + picture.height,
        width: picture.width,
        height: picture.height
      }),
      closest: () => null,
      compareDocumentPosition(other) { return this.index < other.index ? 4 : 0; }
    };
    if (wrapInBoxes) {
      const pageBox = {
        id: `page-box-${index}`,
        className: 'page-wrapper',
        parentElement: root,
        contains: n => n === imgObj,
        querySelectorAll: sel => sel === 'img' ? [imgObj] : [],
        getBoundingClientRect: () => ({
          left: picture.x,
          top: picture.y,
          bottom: picture.y + picture.height,
          width: picture.width,
          height: picture.height + 5
        })
      };
      imgObj.parentElement = pageBox;
    } else {
      imgObj.parentElement = root;
    }
    return imgObj;
  });

  root.contains = node => images.some(im => im === node || im.parentElement === node);
  root.querySelectorAll = selector => selector === 'img' ? images : [];
  siteMain.querySelectorAll = selector => selector === 'img' ? images : [];
  const pageUrl = new URL(url);
  const document = {
    images,
    body: {},
    documentElement: {},
    visibilityState: 'hidden',
    querySelector: selector => selector === 'h1, h2' ? { textContent: title } : null,
    querySelectorAll: () => [],
    createRange() {
      return { setStartAfter(a) { this.a = a; }, setEndBefore(b) { this.b = b; }, toString() { return gapText; } };
    },
    addEventListener() {}
  };
  const chrome = {
    storage: {
      local: { async get(keys) {
        const target = context.ComicPageShared.preferredRule(url, saved).key;
        return saved && keys.includes(target) ? { [target]: { value: saved } } : {};
      } },
      onChanged: { addListener(fn) { handlers.storage = fn; } }
    },
    runtime: { onMessage: { addListener(fn) { handlers.message = fn; } } }
  };
  const context = {
    document, chrome, location: { href: url, pathname: pageUrl.pathname },
    innerWidth: 1200, innerHeight: 800, scrollY: 0, URL, URLSearchParams,
    Node: { DOCUMENT_POSITION_FOLLOWING: 4, ELEMENT_NODE: 1 },
    HTMLImageElement: class {},
    MutationObserver: class { observe() {} },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    setTimeout, clearTimeout, setInterval: () => 0,
    alert() { throw new Error('hidden test page should not alert'); },
    addEventListener() {}
  };
  let activeReader = null;
  context.ComicFloatingBall = { update(reader) { activeReader = reader; } };
  context.ComicImageCapture = { setReader() {}, isRunning() { return false; } };
  context.window = context;
  context.top = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(sharedCode, context);
  vm.runInContext(storeCode, context);
  vm.runInContext(classifierCode, context);
  vm.runInContext(contentCode, context);
  await new Promise(resolve => setImmediate(resolve));
  const result = await new Promise(resolve => handlers.message({ type: 'comic-page-status' }, null, resolve));
  return { ...result, firstImageIndex: activeReader?.firstImage.index ?? null, readerCount: activeReader?.imageNodes.length ?? 0, rootId: activeReader?.root?.id };
}

const column = [0, 1, 2, 3].map(i => ({ x: 290, y: 200 + i * 700, width: 620, height: 700 }));

(async () => {
  const reader = await runCase({ url: 'https://example.com/webtoon/golden/chapter-35/', pictures: column });
  assert.equal(reader.kind, 'yes');
  assert.equal(reader.firstImageIndex, 0);
  assert.equal(reader.readerCount, 4);
  assert.equal(reader.rootId, 'chapter-images');

  const wrapped = await runCase({ url: 'https://example.com/webtoon/golden/chapter-35/', pictures: column, wrapInBoxes: true });
  assert.equal(wrapped.kind, 'yes');
  assert.equal(wrapped.firstImageIndex, 0);
  assert.equal(wrapped.readerCount, 4);
  assert.equal(wrapped.rootId, 'chapter-images'); // 确认锁定了真正的漫画阅读容器，绝不向上逃逸到包含评论区的外层 site-main
  assert.equal(JSON.stringify(reader).includes('parentElement'), false);
  const withPlaceholder = [{ x: 290, y: 150, width: 620, height: 300, complete: false }, ...column.map(item => ({ ...item, y: item.y + 300 }))];
  assert.equal((await runCase({ url: 'https://example.com/webtoon/golden/chapter-35/', pictures: withPlaceholder })).firstImageIndex, 0);

  // 核心断言：冷启动仅有 1 张图下载完成，但多图容器已在 DOM 时，悬浮球必须立即判定并就绪（kind: 'yes'）
  const singleLoadedInMulti = [
    { x: 290, y: 200, width: 620, height: 700, complete: true },
    { x: 290, y: 900, width: 620, height: 700, complete: false },
    { x: 290, y: 1600, width: 620, height: 700, complete: false }
  ];
  const coldStartReader = await runCase({ url: 'https://example.com/webtoon/golden/chapter-35/', pictures: singleLoadedInMulti });
  assert.equal(coldStartReader.kind, 'yes');
  assert.equal(coldStartReader.firstImageIndex, 0);
  assert.equal(coldStartReader.rootId, 'chapter-images');
  assert.equal((await runCase({ url: 'https://example.com/blog/story', pictures: column, gapText: '文章正文'.repeat(30) })).kind, 'no');
  assert.equal((await runCase({ url: 'https://example.com/comic/chapter-35', pictures: column, gapText: '文章正文'.repeat(30) })).kind, 'no');
  const grid = [0, 1, 2].flatMap(i => [
    { x: 100, y: i * 610, width: 420, height: 600 },
    { x: 650, y: i * 610, width: 420, height: 600 }
  ]);
  const gallery = await runCase({ url: 'https://example.com/gallery', pictures: grid });
  assert.equal(gallery.kind, 'no');
  assert.equal(gallery.firstImageIndex, null);
  assert.equal((await runCase({ url: 'https://example.com/', saved: 'allow' })).kind, 'no');
  assert.equal((await runCase({ url: 'https://example.com/manga/golden', pictures: column.slice(0, 1), saved: 'allow' })).kind, 'no');
  assert.equal((await runCase({ url: 'https://example.com/manga/golden', pictures: column.slice(0, 2), saved: 'allow' })).kind, 'yes');
  assert.equal((await runCase({ url: 'https://example.com/manga/golden/chapter-35', pictures: column.slice(0, 1), saved: 'allow' })).kind, 'yes');
  assert.equal((await runCase({ url: 'https://example.com/manga/golden/chapter-35', pictures: grid, saved: 'allow' })).kind, 'no');
  const blocked = await runCase({ url: 'https://example.com/chapter-3', pictures: column, saved: 'block' });
  assert.equal(blocked.kind, 'blocked');
  assert.equal(blocked.firstImageIndex, null);
  assert.equal((await runCase({ url: 'https://example.com/chapter-3', pictures: [{ x: 290, y: 200, width: 620, height: 700, complete: false }] })).kind, 'pending');
  const slices = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27].map(i => ({ x: 290, y: i * 50, width: 620, height: 50 }));
  assert.equal((await runCase({ url: 'https://example.com/read/chapter-3', pictures: slices })).kind, 'yes');
  const shared = vm.createContext({ URL, URLSearchParams });
  shared.globalThis = shared;
  vm.runInContext(sharedCode, shared);
  const rules = shared.ComicPageShared;
  assert.equal(rules.chapterKey('https://example.com/webtoon/golden/chapter-35/'), rules.chapterKey('https://example.com/webtoon/golden/chapter-36/'));
  assert.notEqual(rules.chapterKey('https://example.com/webtoon/golden/chapter-35/'), rules.chapterKey('https://example.com/webtoon/silver/chapter-35/'));
  assert.equal(rules.chapterKey('https://example.com/blog/story'), null);
  assert.equal(rules.chapterKey('https://example.com/read/chapter-35'), null);
  assert.notEqual(rules.chapterKey('https://example.com/read?comic_id=golden&chapter=35'), null);
  assert.equal(rules.preferredRule('https://example.com/manga/golden', 'block').scope, 'route');
  assert.equal(rules.preferredRule('https://example.com/manga/golden/chapter-35', 'block').scope, 'section');
  assert.equal(rules.preferredRule('https://example.com/blog/post-3', 'block').scope, 'host');
  assert.equal(rules.isSectionContentRoute('https://example.com/manga/golden'), true);
  assert.equal(rules.isSectionContentRoute('https://example.com/manga'), false);
  const chapterUrl = 'https://example.com/manga/golden/chapter-35';
  const keys = rules.ruleKeys(chapterUrl);
  assert.equal(rules.resolveOverride({ [keys.host]: { value: 'block' }, [keys.section]: { value: 'allow' } }, chapterUrl).value, 'block');
  const rootBlock = rules.preferredRule('https://example.com/', 'block');
  assert.equal(rules.resolveOverride({ [rootBlock.key]: { value: 'block' } }, chapterUrl), null);
  console.log('30 classification, anchor and scope assertions passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
