# 阶段四：虚拟长图坐标与前端切片

## 使用

接收器依赖见 `../newplugin-server/requirements.txt`。双击 `start_capture_server.bat`，重新加载扩展，再刷新章节页。点击悬浮球中的“开始切片并上传”。本地目录 `captures/<chapter_id>/` 会保存 `coordinates.json`、`slices.json` 和切片 JPEG。旧 `/capture` 接口仅保留兼容，不再被插件按钮调用。Python 接收器已移到同级的 `newplugin-server` 文件夹；启动脚本从该目录运行，避免在 Chrome 扩展目录生成 `__pycache__`。

## 模块边界

- `capture.js`：沿用页面阅读区与图片顺序识别，协调运行状态、悬浮球提示；不实现图像算法。
- `slicing/capture-flow.js`：并发确认图片原始尺寸，先上传坐标索引，再生成、上传切片。最多三个图片探测、两个切片上传同时进行。
- `slicing/virtual-strip.js`：纯坐标模块。以所有源图宽度的中位数锁定工作宽度 W，按 `round(sourceHeight × W / sourceWidth)` 确定每图虚拟高度，得到唯一的连续半开区间 `[startY,endY)`。370px 和 372px 等小幅宽度差会各自按比例缩放到统一 W。
- `slicing/pixel-provider.js`：按绝对区间查询涉及的原图，只将相交部分画到局部 Canvas。分析时返回 RGBA 像素；输出时导出 JPEG 0.9。解码位图缓存目标上限为三张，空闲位图会释放。
- `slicing/slice-algorithm.js`：搜索切线，所有传入和返回的 Y 均为章节绝对坐标。
- `slicing/slice-pipeline.js`：从上一条实际切线规划下一片，先确认文字安全，再输出 `[startY,endY)` 切片；无可验证安全切线时暂停，不强制从理论线切开。

## 坐标恢复

`coordinateId` 标识本次固定的章节图片列表与尺寸。每片有 `sliceIndex`、`startY`、`endY`、`width`、`height`。若 CTD 返回的是提交切片尺寸上的框：`absoluteX = localX`，`absoluteY = startY + localY`。若 CTD 在内部缩放且返回缩放后的坐标，必须提供其坐标宽高，经 `ComicVirtualStrip.restoreBox(slice, box, {ocrWidth, ocrHeight})` 还原。`projectBox(index, absoluteBox)` 可以把跨原图边界的 OCR 框拆成各源图内的坐标，供网页覆盖层使用。插件暴露 `getCoordinateIndex()`、`restoreBox()` 和 `projectBox()`。

`coordinates.json` 保存工作宽度、整话高度以及每张源图的原始尺寸和绝对起止 Y；`slices.json` 保存每片的绝对范围与涉及的源图页号。跨图切片只绘制各图片与切片区间相交的部分，例如 `[700,1800)` 横跨 `[0,1000)` 和 `[1000,2000)` 时，画入 300px + 800px；绝对坐标不变。

## 网页坐标预览

坐标系建立后，网页原图上会显示蓝色虚线，标注每张源图的页序与绝对起点 `Y`。切片被接收器确认保存后，对应终点显示绿色实线，标注切片序号、绝对 `Y` 和切片高度。标记位于固定覆盖层中，页面滚动、窗口缩放或内部滚动容器移动时会根据原图当前矩形重新定位；显示的数值始终来自锁定的章节坐标系。悬浮面板中的“隐藏页序与切线”可统一关闭调试覆盖层。

## 当前边界

首次版本在切片前确认本次扫描到的全部图片尺寸，且要求每张已有可加载的 URL；若懒加载图尚无来源，提示滚动加载后重试。图片在运行期间换源、重排或尺寸变化时停止，重新运行会生成新的 `coordinateId`。后续可在坐标契约不变的前提下，把尺寸确认改为连续前缀流式处理。

浏览器的局部 Canvas `getImageData` 会生成 ROI 像素数组；当前实现避免完整长图 Canvas，但不保证 JPEG 解码器只解码图像的一部分。非常长的单张源图仍可能占用较多解码内存。
