# 长漫前端切线算法

- slice-algorithm.js：纯像素计算。可由普通 script、浏览器 Worker 的 importScripts 或 Node require 加载；不读取 DOM、Canvas、图片 URL，也不发送请求。
- slice-worker.js：Worker 消息适配层。插件接入时可用；需按插件实际执行环境配置脚本 URL 与资源权限。
- slice-demo.js：仅负责演示页的上传、按文件名排序、局部图片拼接、绘图和旧版规则对比。
- virtual-strip.js：纯坐标模块，将按页排序的源图映射为统一宽度的绝对 Y 区间，并恢复 OCR 框位置。
- pixel-provider.js：按绝对区间绘制局部 Canvas，向算法提供 ROI 像素或导出最终切片。
- slice-pipeline.js：从上一条实际切线推进，生成覆盖整话且不重叠的切片。
- capture-flow.js：插件的尺寸确认、坐标索引上传和切片上传流程。

## 输入坐标

调用方先确定本次切片顶部与页面宽度 W，用 `planWindow` 以 3.46W 估算目标切线，默认在目标点上下各 0.86W 搜索。可传 `minSliceHeight` 和 `maxSliceHeight` 约束后端允许的切片高度。调用方需要取得 `requiredStartY` 至 `requiredEndY` 范围内的原图像素，并按实际整话边界裁剪。输入 data 为这个局部区域的 RGBA 像素，offsetY 是区域在整话拼接图中的绝对纵坐标。

~~~js
const window = ComicSliceAlgorithm.planWindow({
  sliceTopY,
  width,
  minSliceHeight,
  maxSliceHeight
});
// 先按 window.requiredStartY / requiredEndY 提取局部像素，再分析。
const result = ComicSliceAlgorithm.analyze({
  data: imageData.data,
  width: imageData.width,
  height: imageData.height,
  offsetY: roiStartY,
  searchStartY: window.searchStartY,
  searchEndY: window.searchEndY,
  targetY: window.targetY,
  pageStartY: 0,
  pageEndY: chapterHeight,
  guardPx: window.guardPx,
  debug: false
});
~~~

`pageStartY` / `pageEndY` 用于检测上下文是否不足；不能确认整话结尾时，调用方需要等待足够的后续图片像素。每次选中切线后，以该线作为下一片的 `sliceTopY` 重新规划窗口。

## 输出与决策

- status: VALLEY：投影候选通过文字保护区检查。
- status: SAFE_INTERVAL：投影候选都不合适，从剩余安全区间直接补选。
- status: NO_SAFE_CUT：搜索范围被高可信文字保护区覆盖，selected 为 null。
- status: NEED_CONTEXT：局部像素不足以检查搜索带边缘。
- safeToUse：选中线也避开了低可信文字行时为 true。如果 uncertain 为 true，应继续复核或扩大搜索，不能直接当作已验证安全。
- debug: true 会额外返回二值掩码、连通域预览、逐行投影及候选代价，供演示页面绘制。

当前文字区由宽度推算的字高、连通域排列、笔画填充率与局部背景亮度共同判断；多行相邻的高可信文字会合成保护块。彩色但灰度相近的边缘只参与候选代价，尚不能保证检出彩色文字。实际效果需要用多种漫画风格和移动设备样本校准。
