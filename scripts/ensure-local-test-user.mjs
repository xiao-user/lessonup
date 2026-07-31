import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const localHosts = new Set(["127.0.0.1", "localhost"]);

if (!url || !serviceRoleKey) {
  throw new Error("local_supabase_credentials_missing");
}

const parsedUrl = new URL(url);
if (!localHosts.has(parsedUrl.hostname)) {
  throw new Error("refusing_to_seed_non_local_supabase");
}

const client = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const email = "admin@lessonup.local";
const password = "1234";

const { data: page, error: listError } = await client.auth.admin.listUsers({
  page: 1,
  perPage: 1000,
});
if (listError) throw listError;

const existing = page.users.find((user) => user.email === email);
let userId = existing?.id;

if (existing) {
  const { error } = await client.auth.admin.updateUserById(existing.id, {
    email_confirm: true,
    user_metadata: { username: "admin", localTestAccount: true },
  });
  if (error) throw error;
} else {
  const { data, error } = await client.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { username: "admin", localTestAccount: true },
  });
  if (error || !data.user) throw error ?? new Error("local_test_user_creation_failed");
  userId = data.user.id;
}

const { count: notebookCount, error: countError } = await client
  .from("notebooks")
  .select("id", { count: "exact", head: true })
  .eq("owner_id", userId);
if (countError) throw countError;

if (!notebookCount) {
  const { error } = await client.rpc("import_lessonup_notebooks", {
    p_owner_id: userId,
    p_notebooks: [{
      id: "local-admin-notebook",
      title: "数学备课本",
      className: "八年级（1）班",
      year: "2025—2026 学年",
      subject: "数学",
      tone: "sage",
      files: [{
        id: "local-admin-lesson",
        title: "轴对称与几何之美",
        type: "概念课",
        image: "/assets/lesson-geometry.png",
        pages: 1,
        lessonPlan: {
          unit: "第五章 图形的轴对称",
          period: "第 1 课时",
          totalPeriods: "共 3 课时",
          topic: "轴对称与几何之美",
          objectives: "理解轴对称图形与对称轴的含义，能够从生活实例中识别轴对称。",
          focus: "通过观察、折叠和比较，归纳轴对称图形的共同特征。",
          preparation: "方格纸、剪刀、常见轴对称图形图片。",
          process: "一、观察生活中的对称现象。\n二、通过折叠实验形成轴对称概念。\n三、判断图形并说明依据。\n四、总结对称轴的判断方法。",
          assessment: "根据学生对图形的判断依据和折叠实验记录进行形成性评价。",
          homework: "寻找三个生活中的轴对称实例，并标出可能的对称轴。",
          board: "轴对称图形\n沿一条直线折叠，两侧能够完全重合\n这条直线叫作对称轴",
          reflection: "",
        },
      }],
    }],
  });
  if (error) throw error;
}

console.log("Local LessonUp test account is ready.");
