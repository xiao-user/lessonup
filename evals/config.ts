export function resolveEvalGraderConfig(
  environment: Record<string, string | undefined>,
) {
  const apiKey = environment.LESSONUP_EVAL_GRADER_API_KEY
    ?? environment.MODEL_API_KEY;
  const baseURL = environment.LESSONUP_EVAL_GRADER_BASE_URL
    ?? environment.MODEL_BASE_URL;
  const model = environment.LESSONUP_EVAL_GRADER_MODEL
    ?? environment.MODEL_ID;
  const api = environment.LESSONUP_EVAL_GRADER_API
    ?? environment.MODEL_API;
  const contextWindow = Number(
    environment.LESSONUP_EVAL_GRADER_CONTEXT_WINDOW
      ?? environment.MODEL_CONTEXT_WINDOW,
  );
  const maxTokens = Number(
    environment.LESSONUP_EVAL_GRADER_MAX_TOKENS
      ?? environment.MODEL_MAX_TOKENS,
  );
  if (
    !apiKey
    || !baseURL
    || !model
    || (api !== "openai-responses" && api !== "openai-completions")
    || !Number.isInteger(contextWindow)
    || contextWindow < 1
    || !Number.isInteger(maxTokens)
    || maxTokens < 1
  ) {
    throw new Error(
      "missing_required_environment:eval_model_configuration",
    );
  }
  return { apiKey, baseURL, model, api, contextWindow, maxTokens };
}
