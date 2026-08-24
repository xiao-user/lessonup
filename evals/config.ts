export function resolveEvalGraderConfig(
  environment: Record<string, string | undefined>,
) {
  const apiKey = environment.LESSONUP_EVAL_GRADER_API_KEY
    ?? environment.MODEL_API_KEY;
  const baseURL = environment.LESSONUP_EVAL_GRADER_BASE_URL
    ?? environment.MODEL_BASE_URL;
  const model = environment.LESSONUP_EVAL_GRADER_MODEL
    ?? environment.MODEL_ID;
  if (!apiKey || !baseURL || !model) {
    throw new Error(
      "missing_required_environment:eval_model_configuration",
    );
  }
  return { apiKey, baseURL, model };
}
