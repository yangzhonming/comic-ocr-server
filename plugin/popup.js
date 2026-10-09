// Popup 只负责呈现和用户操作。识别结果来自网页侧，持久化通过 RuleStore 完成。
const statusNode = document.getElementById('status');
const detailNode = document.getElementById('detail');
const primary = document.getElementById('primary');
const { pageKey, preferredRule } = globalThis.ComicPageShared;
const RuleStore = globalThis.ComicRuleStore;
let tabId = null;
let key = null;
let current = null;
const scopeNode = document.getElementById('scope');

function scopeLabel(scope) {
  return ({ host: '当前域名', section: '当前域名的漫画栏目', route: '当前路径',
    legacyPage: '当前完整 URL（旧规则）', legacyChapter: '同一作品章节（旧规则）' })[scope] || '当前页面';
}

function display(state) {
  current = state;
  primary.hidden = false;
  primary.disabled = false;
  const scopeText = scopeLabel(state.override?.scope);
  if (state.override?.value === 'block') {
    statusNode.textContent = '本页已关闭';
    detailNode.textContent = `黑名单作用于${scopeText}。`;
    primary.textContent = '移出黑名单';
  } else if (state.override?.value === 'allow') {
    statusNode.textContent = state.kind === 'yes' ? '本页已识别为漫画页' : '豁免规则已保存';
    detailNode.textContent = state.kind === 'yes'
      ? `豁免名单覆盖${scopeText}。${state.reason}`
      : `豁免名单覆盖${scopeText}；本页仍需符合漫画路径及图片布局条件。`;
    primary.textContent = '移出豁免名单';
  } else if (state.kind === 'yes') {
    statusNode.textContent = '已识别为漫画页';
    detailNode.textContent = state.reason;
    primary.textContent = '此页不是漫画 · 加入黑名单';
  } else {
    statusNode.textContent = state.kind === 'pending' || state.kind === 'loading' ? '正在等待页面图片' : '未识别为漫画页';
    detailNode.textContent = state.reason || '可以手动将当前 URL 加入豁免名单。';
    primary.textContent = '此页是漫画 · 加入豁免名单';
  }
  const nextValue = state.kind === 'yes' ? 'block' : 'allow';
  const inferred = preferredRule(state.url, nextValue);
  scopeNode.textContent = state.override
    ? `当前规则：${scopeText}。黑名单优先；豁免只在自动证据不足时补充判定。`
    : nextValue === 'allow'
      ? `保存范围：${scopeLabel(inferred.scope)}。首页和封面页不会仅因豁免而通过。`
      : `保存范围：${scopeLabel(inferred.scope)}。`;
}

async function getState() {
  const response = await chrome.tabs.sendMessage(tabId, { type: 'comic-page-status' });
  key = pageKey(response.url);
  if (!key) throw new Error('此页面不支持识别，请打开普通网页。');
  return { ...response, override: await RuleStore.read(response.url) };
}

async function init() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id;
    key = pageKey(tab?.url);
    if (!tabId || !key) throw new Error('此页面不支持识别，请打开普通网页。');
    display(await getState());
  } catch (error) {
    statusNode.textContent = '无法读取页面';
    detailNode.textContent = error.message.includes('Receiving end')
      ? '插件刚安装或更新后，请刷新这个网页再打开 Popup。'
      : error.message;
    primary.hidden = true;
  }
}

primary.addEventListener('click', async () => {
  if (!key || !current) return;
  primary.disabled = true;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (pageKey(tab.url) !== key) {
      await init();
      return;
    }
    if (current.override) {
      await RuleStore.remove(current.override);
    } else {
      const value = current.kind === 'yes' ? 'block' : 'allow';
      await RuleStore.write(tab.url, value);
    }
    // 主动让页面重算，Popup 显示重算后的状态；其它标签页由存储事件同步。
    const refreshed = await chrome.tabs.sendMessage(tabId, { type: 'comic-page-refresh' });
    if (pageKey(refreshed.url) !== key) await init();
    else display(refreshed);
  } catch (error) {
    detailNode.textContent = `保存失败：${error.message}`;
    primary.disabled = false;
  }
});

void init();
