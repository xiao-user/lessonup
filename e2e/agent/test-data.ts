import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

export const e2eEmail = "lessonup-agent-e2e@local.test";
export const notebookId = "chinese";
export const lessonFileId = "c1";
export const initialObjective = "1. 理解本课核心概念，并能够用自己的语言进行解释。";
export const approvedObjective = "1. 能从文本证据中解释春日意象的形成。";

export const initialDocument = {
  unit: "语文课程单元",
  period: "第 1 课时",
  totalPeriods: "2 课时",
  topic: "春日的第一声鸟鸣",
  objectives: `${initialObjective}\n2. 在观察、比较与讨论中形成解决问题的方法。\n3. 能够将所学内容迁移到新的学习情境中。`,
  focus: "教学重点：理解核心概念之间的关系，并能够准确表达。\n教学难点：从具体情境中抽象方法，并完成迁移应用。",
  preparation: "教师：课件、示例材料与课堂任务单。\n学生：预习教材，准备学习用品并记录已有问题。",
  process: "一、情境导入（5 分钟）\n从学生熟悉的现象切入，提出本课核心问题。\n\n二、探究新知（20 分钟）\n学生观察材料、独立思考并在小组内交流；教师通过递进问题帮助学生建立概念联系。\n\n三、巩固应用（12 分钟）\n完成基础任务与迁移任务，结合典型错误进行即时反馈。\n\n四、课堂小结（3 分钟）\n学生回顾学习路径，归纳本课的关键方法。",
  assessment: "通过课堂表达、任务完成情况和迁移练习观察学习目标的达成度；针对不同表现给予即时反馈。",
  homework: "基础任务：完成教材对应练习。\n拓展任务：选择一个真实情境，说明本课方法如何应用其中。",
  board: "春日的第一声鸟鸣\n核心概念 → 关键关系 → 解决方法 → 迁移应用",
  reflection: "课后记录目标达成情况、学生生成的问题，以及下一课时需要调整的教学环节。",
};

export function adminClient() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("agent_e2e_requires_local_supabase_env");
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function findE2EUserId() {
  const client = adminClient();
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw error;
    const user = data.users.find((candidate) => candidate.email === e2eEmail);
    if (user) return user.id;
    if (data.users.length < 100) break;
  }
  return null;
}

export async function resetE2EState(userId: string) {
  const client = adminClient();
  const queries = [
    client.from("agent_threads").delete().eq("owner_id", userId),
    client.from("lesson_file_versions").delete().eq("owner_id", userId).eq("lesson_file_id", lessonFileId),
  ];
  for (const query of queries) {
    const { error } = await query;
    if (error) throw error;
  }
  const { error: updateError } = await client.from("lesson_files").update({
    document: initialDocument,
    document_version: 0,
    page_count: 1,
  }).eq("owner_id", userId).eq("id", lessonFileId);
  if (updateError) throw updateError;
  const { error: versionError } = await client.from("lesson_file_versions").insert({
    owner_id: userId,
    lesson_file_id: lessonFileId,
    document_version: 0,
    document: initialDocument,
    page_count: 1,
    actor: "import",
    idempotency_key: `e2e-reset:${crypto.randomUUID()}`,
  });
  if (versionError) throw versionError;
}
