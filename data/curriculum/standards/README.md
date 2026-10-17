# 课程方案与课标 RAG 导入

这里保存课标处理的本地产物，不把原始 PDF 或 OCR 中间产物提交到 Git。默认流程不上传原始 PDF；
D1 只保存规范化来源元数据、稳定切片、向量和引用定位。

## 当前处理步骤

1. 原始 PDF 仅保存在离线归档；如需重新解析，可临时放在 `inbox/`。
2. PaddleOCR-VL-1.6 的完整 JSON 放到 `parsed/`，文件名保持
   `<PDF文件名>_by_PaddleOCR-VL-1.6.json`。
3. 执行 `npm run curriculum:standards:normalize`，按标题层级、条款、段落和表格生成稳定切片。
4. 执行 `npm run curriculum:standards:validate`，校验所有规范化文档、页码范围、哈希和切片。
5. 确认 `.env` 中的 `EMBEDDING_*` 指向获准处理课标正文的服务，执行
   `npm run curriculum:standards:import` 生成嵌入向量并写入 D1 草稿版本。
6. 执行 `npm run curriculum:standards:status`；所有 17 份文档均为 `ready` 后，执行
   `npm run curriculum:standards:publish` 发布整个版本。

后三步默认写入**本地** Wrangler D1（需先 `npm run db:migrate:local`；`--persist-to <目录>` 可指向
独立状态目录）。写入生产库必须显式追加 `-- --remote`，并且不要和其他远程操作混在一起。

可用 `--only 数学` 或 `--only curriculum_plan` 做单文档联调。该参数只用于索引联调，不能用于
发布不完整版本。默认版本同时包含 16 份学科课标和 1 份跨学科共用课程方案。

导入是幂等且可续跑的：已经完成的文档会跳过，中断的文档复用已保存的向量，不会重复调用嵌入服务。
已发布版本的正文不可改写；对已发布版本再次执行 `import` 只会补全缺失的向量和由标题路径派生的学段、
年级范围（例如从旧环境迁入后向量为空的数据），并刷新版本指纹使检索缓存失效。文档状态含义：

- `ready`：索引版本、切片数和向量都完整；
- `no_embeddings`：切片存在但向量缺失，重新 `import` 即可补全；
- `indexing`：上次导入在文档中途中断，重新 `import` 续跑；
- `missing` / `incomplete` / `stale`：文档缺失、切片数不符或索引版本落后于当前嵌入模型。

`import` 只读取 `normalized/*.chunks.json`，不会上传 PDF 或 PaddleOCR JSON。基于 PDF 直接入库的旧流程
（`init`、`pdf-import` 与清单文件）依赖已经停用的 Supabase Storage，已经移除。

规范化和索引的默认路径都可通过 `--source <目录>` 覆盖。例如：

```bash
npm run curriculum:standards:validate -- --source /path/to/normalized
```

推荐保留教育部发布的原始文件名；系统使用解析产物 SHA-256 判断内容版本。同名但内容不同的
文件不能覆盖已发布版本，应使用 `--release-key <新版本>` 创建新发布。生产环境仍应在 NAS、
OSS、R2 或离线归档中保存原始 PDF 和 OCR JSON，以便审计与重新索引。

用 `npm run eval:curriculum-standards` 评测导入后的检索质量，见 `evals/README.md`。
