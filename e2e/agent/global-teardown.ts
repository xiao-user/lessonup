import type { FullConfig } from "@playwright/test";
import { adminClient, findE2EUserId } from "./test-data.js";

export default async function globalTeardown(_config: FullConfig) {
  const userId = process.env.LESSONUP_E2E_USER_ID ?? await findE2EUserId();
  if (!userId) return;
  const { error } = await adminClient().auth.admin.deleteUser(userId);
  if (error) throw error;
}
