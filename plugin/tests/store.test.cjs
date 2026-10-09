const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const records = {};
const chrome = {
  storage: {
    local: {
      async get(keys) {
        return Object.fromEntries(keys.filter(key => Object.hasOwn(records, key)).map(key => [key, records[key]]));
      },
      async set(values) { Object.assign(records, values); },
      async remove(key) { delete records[key]; }
    }
  }
};
const context = vm.createContext({ chrome, URL, URLSearchParams, Date, Object });
context.globalThis = context;
vm.runInContext(fs.readFileSync(path.join(root, 'shared.js'), 'utf8'), context);
vm.runInContext(fs.readFileSync(path.join(root, 'store.js'), 'utf8'), context);
const store = context.ComicRuleStore;

(async () => {
  const chapter35 = 'https://example.com/manga/golden/chapter-35/';
  const chapter36 = 'https://example.com/manga/golden/chapter-36/';
  const home = 'https://example.com/';
  const cover = 'https://example.com/manga/golden/';

  const allow = await store.write(chapter35, 'allow');
  assert.equal(allow.scope, 'section');
  assert.deepEqual(Object.keys(records), [allow.key]);
  assert.equal(records[allow.key].value, 'allow');
  assert.equal(typeof records[allow.key].savedAt, 'number');
  assert.equal((await store.read(chapter36)).value, 'allow');
  assert.equal(await store.read(home), null);

  const coverBlock = await store.write(cover, 'block');
  assert.equal(coverBlock.scope, 'route');
  assert.equal((await store.read(cover)).value, 'block');
  assert.equal((await store.read(chapter35)).value, 'allow');

  const hostBlock = await store.write('https://example.com/blog/post-1', 'block');
  assert.equal(hostBlock.scope, 'host');
  assert.equal((await store.read(chapter35)).value, 'block');
  assert.equal(store.touches(chapter35, { [hostBlock.key]: { newValue: records[hostBlock.key] } }, 'local'), true);
  await store.remove(hostBlock);
  assert.equal((await store.read(chapter35)).value, 'allow');
  await store.remove(coverBlock);
  assert.equal((await store.read(cover)).value, 'allow');
  console.log('14 storage assertions passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
