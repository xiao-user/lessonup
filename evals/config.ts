export function resolveEvalGraderConfig(
  environment: Record<string, string | undefined>,
) {
  const apiKey = environment.LESSONUP_EVAL_GRADER_API_KEY
    ?? environment.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error(
      "missing_required_environment:DEEPSEEK_API_KEY_or_LESSONUP_EVAL_GRADER_API_KEY",
    );
  }
  return {
    apiKey,
    baseURL: environment.LESSONUP_EVAL_GRADER_BASE_URL
      ?? environment.DEEPSEEK_BASE_URL
      ?? "https://api.deepseek.com",
    model: environment.LESSONUP_EVAL_GRADER_MODEL
      ?? environment.DEEPSEEK_FLASH_MODEL
      ?? "deepseek-v4-flash",
  };
}
