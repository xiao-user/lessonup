# PaddleOCR-VL-1.6 交换格式

## 结论

JSON 是 LessonUp 的正式输入，Markdown 是人工校对副产物。不要只输出 Markdown，也不要在
PaddleOCR 阶段预先切成 RAG 小块。

## 每份 PDF 的文件

```text
parsed/
  <PDF文件名>_by_PaddleOCR-VL-1.6.json
```

当前导出是逐页结果数组，每页保留 `markdown` 和 `prunedResult`。`prunedResult.model_settings`
用于记录布局、表格、公式等开关。所有文件必须使用同一模型版本和参数；如更换模型，应创建
新的解析版本，不能与 PaddleOCR-VL-1.6 产物混用。

逐页 JSON 应保留 PP-StructureV3 原生结果，至少包括：

- 数组顺序作为 1 开始的页码（当前导出没有 `page_index`）
- `prunedResult.parsing_res_list`
- 每个区块的 `block_label`、`block_content`、`block_bbox`、`block_id` 和阅读顺序 `block_order`
- `prunedResult.layout_det_res.boxes` 中的布局置信度
- 表格的 HTML/单元格结构（存在表格时）
- 公式内容（存在公式时）

不需要另外复制完整页面图片、OCR 可视化图片或模型缓存。规范化器只提取正文、标题、表格、
公式、页码范围、区块定位和置信度，原始 PaddleOCR JSON 不会写入 Supabase。

## LessonUp 后续处理

1. 校验 PDF SHA-256、页码连续性和解析器版本。
2. 按阅读顺序还原区块，移除重复页眉页脚，保留章节标题路径。
3. 表格作为整体保留；超长表格按行拆分并重复表头。
4. 按课标章节、条款和自然段形成稳定切片，不按固定页数粗切。
5. 每个切片保存页码范围、区块范围、标题路径、内容哈希和解析置信度。
6. 生成 BGE-M3 向量，完成检索评测后原子发布整批课标。
