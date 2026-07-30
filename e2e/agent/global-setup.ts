import type { FullConfig } from "@playwright/test";
import { adminClient, e2eEmail, initialDocument, lessonFileId, notebookId } from "./test-data.js";

export default async function globalSetup(_config: FullConfig) {
  const client = adminClient();
  const { data: existing, error: listError } = await client.auth.admin.listUsers({ page: 1, perPage: 100 });
  if (listError) throw listError;
  for (const user of existing.users.filter((candidate) => candidate.email === e2eEmail)) {
    const { error } = await client.auth.admin.deleteUser(user.id);
    if (error) throw error;
  }

  const { data, error } = await client.auth.admin.createUser({
    email: e2eEmail,
    password: crypto.randomUUID(),
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error("agent_e2e_user_creation_failed");
  process.env.LESSONUP_E2E_USER_ID = data.user.id;

  const { error: importError } = await client.rpc("import_lessonup_notebooks", {
    p_owner_id: data.user.id,
    p_notebooks: [{
      id: notebookId,
      title: "语文备课本",
      className: "五年级 2 班",
      year: "2025—2026 学年",
      subject: "语文",
      files: [{
        id: lessonFileId,
        title: "春日的第一声鸟鸣",
        type: "阅读课",
        image: "/assets/paper-birds.png",
        pages: 1,
        lessonPlan: initialDocument,
      }],
    }],
  });
  if (importError) throw importError;
}
