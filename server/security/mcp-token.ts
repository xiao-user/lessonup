import { createHash } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import { config } from "../config.js";

type McpScopeBase = {
  userId: string;
  runId: string;
  notebookId: string;
  allowedKnowledgeScopes: string[];
  attachmentSourceIds: string[];
};

export type McpScope = McpScopeBase & (
  | { resourceType?: "lesson_file"; lessonFileId: string; semesterFrameworkId?: never }
  | { resourceType: "semester_framework"; lessonFileId?: never; semesterFrameworkId: string }
);

const mcpScopeSchema = z.object({
  userId: z.uuid(),
  runId: z.uuid(),
  notebookId: z.string().min(1),
  resourceType: z.enum(["lesson_file", "semester_framework"]).optional(),
  lessonFileId: z.string().min(1).optional(),
  semesterFrameworkId: z.uuid().optional(),
  allowedKnowledgeScopes: z.array(z.string().min(1)).max(16),
  attachmentSourceIds: z.array(z.uuid()).max(8),
}).superRefine((value, context) => {
  const resourceType = value.resourceType ?? "lesson_file";
  const valid = resourceType === "lesson_file"
    ? Boolean(value.lessonFileId) && !value.semesterFrameworkId
    : Boolean(value.semesterFrameworkId) && !value.lessonFileId;
  if (!valid) context.addIssue({ code: "custom", message: "mcp_resource_scope_invalid" });
});

const secret = () => new TextEncoder().encode(
  config.MCP_TOKEN_SECRET
    ?? createHash("sha256").update("lessonup-development-mcp-secret").digest("hex"),
);

export async function createMcpScopeToken(scope: McpScope) {
  const validated = mcpScopeSchema.parse(scope);
  return new SignJWT(validated)
    .setProtectedHeader({ alg: "HS256" })
    .setAudience("lessonup-mcp")
    .setIssuer("lessonup-api")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(secret());
}

export async function verifyMcpScopeToken(token: string): Promise<McpScope> {
  const { payload } = await jwtVerify(token, secret(), {
    audience: "lessonup-mcp",
    issuer: "lessonup-api",
  });
  return mcpScopeSchema.parse(payload) as McpScope;
}
