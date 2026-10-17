# Curriculum knowledge pilots

此目录存放经过校验、可重复导入的教材知识点试点数据。它与 `data/curriculum` 下的
SmartEdu 官方教材目录分开版本化：目录只描述书目和章节层级，知识点数据通过独立发布版本
关联到稳定的 `curriculum_nodes`。

当前试点文件由项目方提供。导入器会校验教材身份、章节唯一匹配、知识点引用、课时映射与
核验状态；完全重复的“学生动作/达标判据”占位字段不会进入 Agent 可检索数据。

导入依赖已发布的教材目录，先执行 `npm run curriculum:import`。不带 `--apply-draft` 或 `--publish`
时只输出校验报告；`--apply-draft` 写入不可见的草稿版本，`--publish` 通过发布检查后替换同一范围
的旧版本。默认写入本地 Wrangler D1，写入生产库需追加 `-- --remote`。`--embed` 会调用配置的嵌入服务
为知识点生成向量。

```bash
npm run curriculum:knowledge:import -- --source data/curriculum/knowledge/<样本文件>.json
```
