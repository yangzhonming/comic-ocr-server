const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const docEvents = {};
const winEvents = {};
const frames = [];
let host = null;
const button = { attributes: {}, addEventListener() {}, setAttribute(name, value) { this.attributes[name] = value; } };
const captureBtn = { attributes: {}, addEventListener() {}, setAttribute(name, value) { this.attributes[name] = value; } };
const numBtn = { attributes: {}, addEventListener() {}, setAttribute(name, value) { this.attributes[name] = value; } };
const panel = { hidden: true, style: {} };
const detail = { textContent: '' };
const shadow = { innerHTML: '', querySelector(selector) {
  if (selector === 'button') return button;
  if (selector === '.capture') return captureBtn;
  if (selector === '.numbering') return numBtn;
  if (selector === '.panel') return panel;
  return detail;
} };
const documentElement = { appendChild(node) { host = node; } };
const document = {
  documentElement,
  createElement() { return { style: {}, attachShadow() { return shadow; } }; },
  addEventListener(type, fn) { docEvents[type] = fn; }
};
const window = { addEventListener(type, fn) { winEvents[type] = fn; } };
const context = { document, window, innerWidth: 1200, innerHeight: 800,
  requestAnimationFrame(fn) { frames.push(fn); return frames.length; },
  getComputedStyle() { return { overflowY: 'visible', overflow: 'visible' }; }
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'floating-ball.js'), 'utf8'), context);
const ball = context.ComicFloatingBall;
const flush = () => { while (frames.length) frames.shift()(); };

let firstTop = 300;
let lastBottom = 2000;
const root = {
  isConnected: true,
  parentElement: documentElement,
  getBoundingClientRect() { return { top: firstTop, bottom: lastBottom, left: 290, right: 910 }; },
  querySelectorAll() { return []; }
};
const firstImage = {
  isConnected: true, parentElement: root,
  getBoundingClientRect() { return { top: firstTop, bottom: firstTop + 700, left: 290, right: 910 }; }
};
const lastImage = { getBoundingClientRect() { return { bottom: lastBottom }; } };
const reader = { root, firstImage, lastImage, imageNodes: [firstImage, lastImage] };

ball.update(null);
assert.equal(host, null);
ball.update(reader);
flush();
assert.equal(host.style.left, '298px');
assert.equal(host.style.top, '308px');
assert.equal(host.style.display, 'block');
assert.match(host.style.cssText, /position:fixed/);

firstTop = 250;
docEvents.scroll();
flush();
assert.equal(host.style.top, '258px');
firstTop = -100;
docEvents.scroll();
flush();
assert.equal(host.style.top, '16px');

lastBottom = 0;
docEvents.scroll();
flush();
assert.equal(host.style.display, 'none');
ball.update(null);
flush();
assert.equal(host.style.display, 'none');
console.log('9 floating ball assertions passed');

// 验证语种选择下拉框在 Shadow DOM 中正确渲染
assert.match(shadow.innerHTML, /id="select-float-lang"/);
assert.match(shadow.innerHTML, /value="kr"/);
assert.match(shadow.innerHTML, /value="ja"/);
assert.match(shadow.innerHTML, /value="en"/);
assert.match(shadow.innerHTML, /value="ru"/);
console.log('5 language select DOM assertions passed');

// 验证语种状态读写与双向同步逻辑
{
  const testStore = { comic_ocr_lang: 'ja' };
  const mockLocalStorage = {
    getItem(k) { return testStore[k]; },
    setItem(k, v) { testStore[k] = String(v); }
  };
  let dispatchedEvents = [];
  const testWinEvents = {};
  const mockSelect = {
    value: '',
    events: {},
    addEventListener(type, fn) { this.events[type] = fn; },
    change(val) { this.value = val; if (this.events['change']) this.events['change'](); }
  };

  const testShadow = {
    innerHTML: '',
    querySelector(selector) {
      if (selector === '#select-float-lang') return mockSelect;
      if (selector === 'button') return { addEventListener() {}, setAttribute() {} };
      if (selector === '.panel') return { hidden: true, style: {} };
      if (selector === '.capture') return { addEventListener() {}, setAttribute() {} };
      return { addEventListener() {} };
    }
  };

  const testContext = {
    document: {
      documentElement: { appendChild() {} },
      createElement() { return { style: {}, attachShadow() { return testShadow; } }; },
      addEventListener() {}
    },
    window: {
      addEventListener(type, fn) { testWinEvents[type] = fn; },
      dispatchEvent(e) { dispatchedEvents.push(e); }
    },
    localStorage: mockLocalStorage,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    innerWidth: 1200, innerHeight: 800,
    requestAnimationFrame(fn) { fn(); return 1; },
    getComputedStyle() { return { overflowY: 'visible', overflow: 'visible' }; }
  };
  testContext.globalThis = testContext;
  vm.createContext(testContext);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'floating-ball.js'), 'utf8'), testContext);

  const testBall = testContext.ComicFloatingBall;
  testBall.update(reader);

  // 1. 初始读取 localStorage 中的已保存语种 'ja'
  assert.equal(mockSelect.value, 'ja');

  // 2. 模拟用户切换为 'en'
  mockSelect.change('en');
  assert.equal(testStore.comic_ocr_lang, 'en');
  assert.equal(dispatchedEvents.length, 1);
  assert.equal(dispatchedEvents[0].type, 'comic_ocr_lang_changed');
  assert.equal(dispatchedEvents[0].detail.lang, 'en');
  assert.equal(dispatchedEvents[0].detail.source, 'floating-ball');

  // 3. 模拟外部（如 debug-hud）触发语种变更事件 'ru'
  if (testWinEvents['comic_ocr_lang_changed']) {
    testWinEvents['comic_ocr_lang_changed']({ detail: { lang: 'ru', source: 'debug-hud' } });
  }
  assert.equal(mockSelect.value, 'ru');

  // 4. 模拟外部 setOcrLang API 切换为 'kr'
  testBall.setOcrLang('kr');
  assert.equal(mockSelect.value, 'kr');

  console.log('6 language select logic & sync assertions passed');
}
