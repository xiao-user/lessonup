import { createHash } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import { config } from "../config.js";

export type McpScope = {
  userId: string;
  runId: string;
  notebookId: string;
  lessonFileId: string;
  allowedKnowledgeScopes: string[];
  attachmentSourceIds: string[];
};

const mcpScopeSchema = z.object({
  userId: z.uuid(),
  runId: z.uuid(),
  notebookId: z.string().min(1),
  lessonFileId: z.string().min(1),
  allowedKnowledgeScopes: z.array(z.string().min(1)).max(16),
  attachmentSourceIds: z.array(z.uuid()).max(8),
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
  return mcpScopeSchema.parse(payload);
}
