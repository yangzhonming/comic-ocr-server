# 阶段二：阅读区、首图定位与固定悬浮球

本文件记录阶段二实现（版本 `0.2.0`）；当前插件已进入阶段三 `0.3.0`，图片编号与采集见 [PHASE3_CAPTURE.md](PHASE3_CAPTURE.md)。阶段一压缩包 `newplugin-phase1.zip` 保持为历史快照。

## 模块边界

| 模块 | 新增或变化 |
| --- | --- |
| `classifier.js` | `detect()` 在判定证据外，给网页侧返回 `reader` 或 `fallbackReader`，包含阅读容器和图片节点。它不创建 UI。 |
| `content.js` | 组合黑名单、自动判定和豁免规则，挑选可信的 `reader`，调用 `ComicFloatingBall.update(reader)`；发给 Popup 的状态剔除 DOM 节点。 |
| `floating-ball.js` | 只接收定位结果，负责固定定位和可见性，不读取名单、不重新判定网页。 |
| `popup.js`、`store.js`、`shared.js` | 继续沿用阶段一接口；名单格式未改动。 |

`reader` 是网页进程内的临时对象：

```js
{
  root: Element,               // 候选漫画阅读容器
  firstImage: HTMLImageElement, // 首张漫画图，必要时是尚未加载的同列占位图
  lastImage: HTMLImageElement,  // 当前已识别序列的末张
  imageNodes: HTMLImageElement[],
  anchorSource: 'loaded' | 'placeholder'
}
```

这些 DOM 引用**不写入 `chrome.storage.local`，也不通过 `chrome.runtime` 消息发给 Popup**。名单中只保存 `value` 和 `savedAt`，详见阶段一 [HANDOFF.md](HANDOFF.md)。

## 首图定位步骤

1. 先按页面渲染尺寸筛掉图标、头像、隐藏图；按纵向位置排序。
2. 依据相邻图片的宽度、横向中心和纵向间隔形成单列候选，再检查共同 DOM 祖先、图片间文字、网格和竞争图片区。
3. 对最终候选取最小的共同内容容器，以候选第一张图片作为初始首图。
4. 若这个容器中还有更靠上的同列大图占位元素，才把锚点上移到该占位图。不会从整个网页中取第一张 `<img>`。
5. 自动判定通过使用 `reader`；豁免保底通过使用 `fallbackReader`。黑名单或无可信锚点时隐藏悬浮球。

目前以 `<img>` 为主；CSS 背景图、Canvas、封闭 Shadow DOM、跨域 iframe、虚拟列表回收及特殊网站广告仍可能需要适配。首图查找不会强制触发网页的懒加载请求。

## 悬浮球定位行为

- 在 `document.documentElement` 下创建隔离的 Shadow DOM 宿主；宿主为 `position: fixed`，不是阅读容器或图片的子节点。
- 阅读区接近视口时，初次把球放到首图左上角，横向与首图左边缘对齐。
- 每次读取首图、末图以及阅读区滚动容器的当前矩形：首图刚进入可见区域时贴其左上角；首图越过顶部安全距离（当前 16px）后停在该处；末图经过时随阅读区末端退出并隐藏。横向位置始终依据首图左边缘重算。
- 首图未进入可见区域、黑名单命中、路由切换或锚点被 DOM 移除时隐藏球，不采用页面左上角兜底。页面内部滚动容器也通过捕获阶段的 `scroll` 监听处理。
- 阶段二时悬浮球面板只显示定位状态；当前阶段已加入编号预览和本地采集。阶段一的原生 `alert` 已从当前代码移除。

## 验证

```powershell
node newplugin/tests/classification.test.cjs
node newplugin/tests/store.test.cjs
node newplugin/tests/floating-ball.test.cjs
```

分类测试覆盖已加载首图、同容器内先出现的懒加载占位首图、豁免和负例；悬浮球测试检查首图初始位置、滚动后的固定纵向坐标及离开阅读区隐藏。真实网站的浏览器视觉验收仍需进行，尤其是内层滚动容器和复杂懒加载站点。
