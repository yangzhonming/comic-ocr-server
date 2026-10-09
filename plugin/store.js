(() => {
  const { ruleKeys, preferredRule, resolveOverride } = globalThis.ComicPageShared;

  // 存储记录：{ value: 'block' | 'allow', savedAt: Unix 毫秒时间戳 }。
  // 每条规则独占一个 chrome.storage.local 键，读取时最多访问当前 URL 对应的 5 个键。
  function keysFor(url) {
    return Object.values(ruleKeys(url) || {}).filter(Boolean);
  }

  async function read(url) {
    const keys = keysFor(url);
    if (!keys.length) return null;
    const records = await chrome.storage.local.get(keys);
    return resolveOverride(records, url);
  }

  async function write(url, value) {
    if (value !== 'block' && value !== 'allow') throw new Error('无效的名单类型');
    const rule = preferredRule(url, value);
    if (!rule) throw new Error('当前页面无法保存规则');
    await chrome.storage.local.set({ [rule.key]: { value, savedAt: Date.now() } });
    return { ...rule, value };
  }

  async function remove(rule) {
    if (!rule?.key || !['block', 'allow'].includes(rule.value)) throw new Error('无效的名单规则');
    await chrome.storage.local.remove(rule.key);
  }

  function touches(url, changes, area) {
    return area === 'local' && keysFor(url).some(key => Object.hasOwn(changes, key));
  }

  globalThis.ComicRuleStore = Object.freeze({ read, write, remove, touches });
})();
