# 课程方案与课标 RAG 导入

这里保存课标发布清单，不把原始 PDF 或 OCR 中间产物提交到 Git。默认流程不把原始 PDF
上传到 Supabase Storage；Supabase 只保存规范化来源元数据、稳定切片、向量和引用定位。

## 当前处理步骤

1. 原始 PDF 仅保存在离线归档；如需重新解析，可临时放在 `inbox/`。
2. PaddleOCR-VL-1.6 的完整 JSON 放到 `parsed/`，文件名保持
   `<PDF文件名>_by_PaddleOCR-VL-1.6.json`。
3. 执行 `npm run curriculum:standards:normalize`，按标题层级、条款、段落和表格生成稳定切片。
4. 执行 `npm run curriculum:standards:validate`，校验所有规范化文档、页码范围、哈希和切片。
5. 确认 `.env` 中的 `BGE_M3_BASE_URL` 是获准处理课标正文的服务后，执行
   `npm run curriculum:standards:import` 生成 BGE-M3 向量并写入 Supabase 草稿版本。
6. 执行 `npm run curriculum:standards:status`；所有 17 份文档均为 `ready` 后，执行
   `npm run curriculum:standards:publish` 原子发布整个版本。

可用 `--only 数学` 或 `--only curriculum_plan` 做单文档联调。该参数只用于索引联调，不能用于
发布不完整版本。默认版本同时包含 16 份学科课标和 1 份跨学科共用课程方案。

默认 `curriculum:standards:import` 只读取 `normalized/*.chunks.json`，不会上传 PDF 或 PaddleOCR
JSON。仅遗留命令 `curriculum:standards:pdf-import` 会显式启用 PDF Storage 流程，不应在当前
方案中运行。

规范化和索引的默认路径都可通过 `--source <目录>` 覆盖。例如：

```bash
npm run curriculum:standards:validate -- --source /path/to/normalized
```

推荐保留教育部发布的原始文件名；系统使用解析产物 SHA-256 判断内容版本。同名但内容不同的
文件不能覆盖已发布版本，应使用 `--release-key <新版本>` 创建新发布。生产环境仍应在 NAS、
OSS、R2 或离线归档中保存原始 PDF 和 OCR JSON，以便审计与重新索引；这不要求使用 Supabase
Storage。
