# LessonUp existing design system

本次功能沿用已有产品界面，不重设品牌。

- Tokens: `src/styles/design-system.css` and `src/styles/beautiful-ui.css`.
- 页面使用现有浅色工作台与 A4 正文，正文、辅助文字和分隔线引用现有语义 token。
- 控件复用 `src/components/ui/` 的 Button、Input、Textarea、Field 和 Select；Agent 消息复用 Beautiful UI primitives。
- 新功能采用按需打开的工作区面板及渐进表单，不增加装饰卡片网格。
- 反馈必须区分保存中、保存成功、冲突、未知结果与可重试错误。
- 沿用当前字体、圆角和间距；不新增字体、配色或动效系统。
