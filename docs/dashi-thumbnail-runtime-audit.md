# Dashi 缩略图审查（2026-09-04）

## 结论与证据边界

黑缩略图的可复现直接原因是运行时卸载误伤 DOM 克隆，不需要数据库、保存请求或 LessonUp 的 iframe 桥接参与。不能据此断言所有生成、保存、编辑问题都已解决。

对照来源：项目克隆的上游 `0.4.11`，提交 `7cb23347f91cda1a5519eafc8c040704e389535a`；本机保留的个人安装版 `0.4.5`。后者解释了旧版为何能正常工作，但没有证据确定用户此前打开的具体文件就是该安装产物。

## 根因链路

1. `template-swiss.html:createOverviewDomPreview` 克隆真实幻灯片 DOM，保留 `.slide.imported-theme-slide` 类及 `cv-near` 标记。
2. `releaseInactiveRuntimeSlides` 全局查找幻灯片，因此也遍历侧栏克隆。
3. `0.4.5` 的 `releaseRuntimeThemeSlide` 在没有 `mountedRoots` 记录时直接返回。DOM 克隆不是 React 根，所以不会被清空。
4. `0.4.11` 改为调用 `resetRuntimeRoot`；即使没有 React 根记录，也会 `replaceChildren()`。普通缩略图因而被清空，而携带 `cv-near` 的克隆被跳过。
5. 缩略图容器仍标记为已经渲染；翻页后的正常缓存路径不一定重新生成它。这解释了“先显示，稍后变黑”，以及某一页仍正常的情况。

## Web 与存储核对

- 当前 Web 路径仍是 `BrowserDashiSkill → 内容 HTML → 原版模板 + 原版主题运行时`，不是原版 Node 生成脚本的逐行执行。原版文件一致与完整运行流程一致必须区分。
- D1 保存业务记录、goal 与校验值，R2 保存包含内容/编辑状态的单个 HTML。共享编辑器和主题资源不逐份存入作品。
- 前端加载 effect 只依赖 `presentationId`。保存成功更新 ref 中的校验值，不执行 `setSrcDoc`，没有“保存成功自动重建 iframe”的路径。
- 代码测试覆盖：原生编辑状态映射、HTML 生成、对象存储写入、全新工作区读取、编辑器重新组装。标题、配色、文本、页序及最终编辑器 HTML 相同。此测试使用内存对象存储，不声称检查过线上 D1/R2 全量数据。

## 修复范围

`scripts/dashi-runtime-compat.mjs` 在构建共享主题 bundle 时，将卸载选择器改为：

```css
#deck > .slide.imported-theme-slide, #deck > .slide.bespoke-slide
```

只有这一处精确替换，覆盖 12 个主题；预期位置不唯一或消失会使构建失败，要求重新审查上游。标识为 `deck-owned-runtime-release-v1`，写入产物 inventory 与 notice。

不改原版 Skill 文件、编辑器、缩略图克隆、配色或导出器；不通过延时重绘、禁止卸载或清除全部缓存掩盖问题。

## 旧实现清理

- 删除未再实例化的 `server/presentations/native-dashi-skill.ts`，移除协调器/工具对其类型的依赖。原版 Skill 内自带的 Node 脚本仍作为完整上游包保留，不属于 LessonUp 的第二条运行链路。
- 构建默认只读取项目 Skill；删除 `DASHI_PPT_ROOT` 和个人目录自动回退，防止安装版本混入。
- 项目只保留一个 `dashi-ppt/SKILL.md`。个人全局 Skill 不属于项目运行链路，本轮未删除；之前移出的临时备份不参与构建。

## 验证

- `runtime-ownership.vitest.js`：调用上游实际函数，用真实 DOM 节点及克隆复现旧版、新版、修正版行为。无浏览器、网络或持久化参与。
- `dashi-export-assets.test.ts`：验证 12 个主题除选择器替换外逐字节一致；编辑器及 PPTX 导出器保持原样。
- `browser-dashi-skill.test.ts`：验证内容和编辑状态的保存/读取往返。
- 未进行浏览器视觉验收，本轮未部署。
