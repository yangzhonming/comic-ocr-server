# 长漫阅读页识别模块交接手册

**阶段一历史交接文档，对应 `newplugin-phase1.zip`（版本 `0.1.0`）。** 当前源码已继续开发首图定位、悬浮球及图片采集（版本 `0.3.0`）；阶段二见 [PHASE2_LOCATION.md](PHASE2_LOCATION.md)，阶段三见 [PHASE3_CAPTURE.md](PHASE3_CAPTURE.md)。以下记录阶段一的名单结构与判定流程；名单存储格式保持兼容。

范围：页面识别、黑白名单、Popup、测试用原生弹窗。阶段一没有图片上传、翻译、悬浮球或后端依赖。

## 1. 文件与依赖方向

| 文件 | 运行环境 | 唯一职责 |
| --- | --- | --- |
| `manifest.json` | 扩展配置 | 声明权限、注入顺序和 Popup。 |
| `shared.js` | 网页脚本与 Popup 各自加载 | 纯 URL 解析、规则键生成、命中优先级；不读 DOM、不调用存储 API。 |
| `store.js` | 网页脚本与 Popup 各自加载 | 唯一的 `chrome.storage.local` 读写接口。 |
| `classifier.js` | 网页脚本 | 读取 DOM 和渲染几何，输出自动判定及豁免所需的图片证据；不处理名单。 |
| `content.js` | 网页脚本 | 按优先级组合名单和识别结果，监听页面变化，回复 Popup 消息，触发测试提示。 |
| `popup.html`、`popup.css`、`popup.js` | 扩展弹出页 | 呈现当前状态，让用户加入或移出规则。 |
| `tests/*.test.cjs` | Node.js | 用模拟页面和模拟存储验证关键行为。 |

依赖方向：`shared.js → store.js`；网页端为 `shared.js + store.js + classifier.js → content.js`；Popup 端为 `shared.js + store.js → popup.js`。没有后台 Service Worker。`shared.js` 和 `store.js` 在两个隔离的扩展环境中各执行一次，不共享内存；双方通过 `chrome.storage.local` 和扩展消息通信。

## 2. 存储数据结构

使用扩展自己的 `chrome.storage.local`，不使用网站的 `localStorage`。每条名单规则占一个独立键，值统一为：

```json
{
  "value": "allow",
  "savedAt": 1790568000000
}
```

- `value`：`block` 表示黑名单；`allow` 表示豁免名单。
- `savedAt`：写入时 `Date.now()` 的 Unix 毫秒时间戳，目前用于记录时间，不参与过期判断。规则不会自动过期。
- 主机按 `URL.host` 精确匹配，包含非默认端口；`www.example.com` 和 `example.com` 是两个主机。不通过字符串截取去猜测注册域名。

### 当前版本的键

| 范围 | 键格式 | 示例 | 何时新建 |
| --- | --- | --- | --- |
| 主机 | `comic-scope-override:v2:<host>` | `comic-scope-override:v2:example.com` | URL 中没有可识别漫画栏目时的域名级规则。 |
| 漫画栏目 | `comic-scope-override:v2:<host>/<section>` | `comic-scope-override:v2:example.com/manga` | URL 含 `/manga`、`/webtoon` 等栏目时；同栏目下的章节共用。 |
| 当前路径 | `comic-route-override:v2:<host>/<path>` | `comic-route-override:v2:example.com/manga/golden` | 在首页、目录或作品封面页纠正误判时；不包含查询串，避免封锁其章节。 |

栏目识别词见 `shared.js` 的 `SECTION_NAMES`。若漫画栏目之前还有语言前缀，规则保留该前缀，例如 `example.com/en/manga`。页面 URL 的 `#` 锚点不参与匹配。当前新规则只使用上表三类键；读取时仍兼容旧版完整 URL 键 `comic-page-override:v1:...` 与作品章节模板键 `comic-chapter-override:v1:...`，用户可在 Popup 中移除命中的旧规则。

**读取只针对当前 URL 计算最多五个候选键，然后一次调用 `chrome.storage.local.get(keys)`。不会遍历全量名单。** 命中顺序是：先找任意黑名单，再找豁免；同类规则按当前路径、旧版完整 URL、旧版章节模板、栏目、主机依次选择。因而主机黑名单会压过栏目豁免。

### 写入范围自动选择

- 用户在自动判定为漫画的**首页、目录或作品封面页**点“不是漫画”：写入当前路径黑名单，避免屏蔽下面真正的章节。
- 用户在漫画栏目中的章节页点“不是漫画”：写入该主机和栏目下的黑名单。
- 用户在没有漫画栏目的普通网页点“不是漫画”：写入主机黑名单。
- 用户点“是漫画”：有漫画栏目则写入主机和栏目豁免；否则写入主机豁免。豁免不是强制判定为漫画，仍要通过下面的路径和图片门槛。

旧规则保留原范围，不被静默迁移或扩大。Popup 的“移出名单”删除当前命中的那条键；若其下还存在另一条匹配规则，删除后会显现下一条规则。

## 3. 页面判定流程

```text
进入网页 / URL 改变 / 图片加载 / 名单改变
  → 读取当前 URL 对应的规则
  → 黑名单命中：blocked，停止图片扫描
  → classifier.detect()：先找可靠的连续阅读图片区
      ├─ 自动判定 yes：显示测试 alert
      └─ 自动证据不足：检查豁免规则
           ├─ 明确章节 URL + 基本大图证据：yes
           ├─ /manga/作品 等栏目子路径 + 更强连续图片证据：yes
           └─ 其余：no 或 pending，不弹窗
```

`classifier.js` 扫描最多 600 个 `<img>`，排除过小、隐藏、尚未加载的图片；依据渲染坐标聚成单列候选，检查共同 DOM 容器、宽度一致性、图片间正文、链接分散度、网格、多图片区竞争和视觉面积。章节 URL、标题、阅读容器名称、章节导航只作为附加线索，不单独放行。尚未加载的大图让结果保持 `pending`，后续图片加载再评估。

识别结果的 `kind` 有 `loading`、`pending`、`no`、`yes`、`blocked`、`error`；附有 `reason` 和 `imageCount`。`fallbackEligible` 和 `fallbackStrong` 是识别器提供给协调器的内部证据，分别用于明确章节路径和无章节号的漫画栏目子路径。**名单匹配结果不等于最终页面结果。**

动态更新由 `MutationObserver`、图片 `load`、窗口 `resize`、`popstate`、`hashchange` 触发；每秒检查一次 URL，用于无法直接观察到的单页应用路由变化。DOM 更新会合并到一次延迟评估。`chrome.storage.onChanged` 使相同范围的其他已打开标签页重新判定。

## 4. Popup 与测试提示

Popup 向当前标签页发送 `comic-page-status` 读取状态。用户点击主要按钮后，`popup.js` 经 `ComicRuleStore.write/remove` 修改名单，再发送 `comic-page-refresh`，让网页重新读取规则并返回最新状态。网页脚本和 Popup 都不自行拼装存储键。

原生 `window.alert('检测到漫画阅读页面')` 位于 `content.js` 的 `announce()`，**只用于本阶段测试**：页面可见、最终状态为 `yes`、且同一标签页当前 URL 尚未提示过时触发。未来接入悬浮球时，只需替换这里的展示行为；识别器和存储模块不应直接操作悬浮球。

## 5. 接下一个功能时的接口边界

- 页面内容和位置：只从 `classifier.js` 扩展输出，不放进名单键或持久化存储。DOM 节点不能通过 Popup 消息发送。
- 是否显示、何时显示：在 `content.js` 得到最终 `state.kind === 'yes'` 后决定。后续悬浮 UI 模块可在此接入。
- 用户纠错：只通过 `ComicRuleStore` 读写。后续功能不自行解释 `chrome.storage.local` 键。
- Popup：只呈现状态和操作；不要在 Popup 中复制图片判定算法。

当前识别范围是普通 `<img>` 长漫。CSS 背景图、Canvas、封闭 Shadow DOM、复杂 iframe 和不同网站的专有懒加载仍需后续适配；基于浏览器的真实站点验收尚未完成。

## 6. 验证与装载

在项目根目录运行：

```powershell
node newplugin/tests/classification.test.cjs
node newplugin/tests/store.test.cjs
```

然后到 `chrome://extensions` 或 `edge://extensions`，开启开发者模式并加载整个 `newplugin` 文件夹。更新扩展后刷新已经打开的网页。浏览器内部页面不可注入；Popup 会提示当前页无法读取。

`newplugin-phase1.zip` 是同目录下生成的交接压缩包；解压后应使 `manifest.json` 位于扩展文件夹根目录。测试文件和本手册也包含在包中。
