const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const docEvents = {};
const winEvents = {};
const frames = [];
let host = null;

const makeMockNode = () => {
  const node = {
    attributes: {},
    dataset: {},
    style: {},
    classList: {
      _classes: new Set(),
      add(c) { this._classes.add(c); },
      remove(c) { this._classes.delete(c); },
      toggle(c, force) { if (force !== undefined) { force ? this.add(c) : this.remove(c); } else { this._classes.has(c) ? this.remove(c) : this.add(c); } },
      contains(c) { return this._classes.has(c); }
    },
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return makeMockNode(); },
    querySelectorAll() { return [makeMockNode()]; },
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name]; },
    removeAttribute(name) { delete this.attributes[name]; },
    hasAttribute(name) { return name in this.attributes; },
    textContent: '',
    innerHTML: '',
    hidden: false
  };
  return node;
};

const buttonNode = makeMockNode();
const shadow = {
  innerHTML: '',
  querySelector(selector) { return makeMockNode(); },
  querySelectorAll(selector) { return [makeMockNode()]; },
  getElementById(id) { return id === 'ball-button' ? buttonNode : makeMockNode(); }
};
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
assert.equal(host.style.left, '306px');
assert.equal(host.style.top, '316px');
assert.equal(host.style.display, 'block');
assert.match(host.style.cssText, /position:fixed/);

firstTop = 250;
docEvents.scroll();
flush();
assert.equal(host.style.top, '266px');
firstTop = -100;
docEvents.scroll();
flush();
assert.equal(host.style.top, '48px');

lastBottom = 0;
docEvents.scroll();
flush();
assert.equal(host.style.display, 'none');
ball.update(null);
flush();
assert.equal(host.style.display, 'none');
console.log('9 floating ball assertions passed');

// 验证语种选择菜单在 Shadow DOM 中正确渲染
assert.match(shadow.innerHTML, /id="menu-lang-list"/);
assert.match(shadow.innerHTML, /data-lang="kr"/);
assert.match(shadow.innerHTML, /data-lang="ja"/);
assert.match(shadow.innerHTML, /data-lang="en"/);
assert.match(shadow.innerHTML, /data-lang="es"/);
assert.match(shadow.innerHTML, /data-lang="ru"/);
console.log('6 language menu DOM assertions passed');

// 验证语种状态读写与双向同步逻辑
{
  assert.equal(typeof ball.getOcrLang, 'function');
  assert.equal(typeof ball.setOcrLang, 'function');
  ball.setOcrLang('ja');
  assert.equal(ball.getOcrLang(), 'ja');
  ball.setOcrLang('en');
  assert.equal(ball.getOcrLang(), 'en');
  ball.setOcrLang('es');
  assert.equal(ball.getOcrLang(), 'es');
  ball.setOcrLang('kr');
  assert.equal(ball.getOcrLang(), 'kr');
  console.log('Language select logic & sync assertions passed');
}
