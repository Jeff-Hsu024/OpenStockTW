import { createHash, timingSafeEqual } from "node:crypto";

/** Phase-1 service account: callers cannot select the MongoDB userId. */
export function mcpUserId(): string {
  const userId = process.env.OPENSTOCK_MCP_USER_ID?.trim();
  if (!userId) throw new Error("OPENSTOCK_MCP_USER_ID is not configured");
  return userId;
}

export function isMcpConfigured(): boolean {
  return Boolean(
    process.env.OPENSTOCK_MCP_USER_ID?.trim() &&
      (process.env.OPENSTOCK_MCP_TOKEN?.length ?? 0) >= 32
  );
}

/** Hash both sides before a timing-safe comparison, even if lengths differ. */
export function isAuthorizedMcpRequest(
  request: Request,
  expectedToken = process.env.OPENSTOCK_MCP_TOKEN
): boolean {
  if (!expectedToken || expectedToken.length < 32) return false;
  const match = /^Bearer (\S+)$/i.exec(request.headers.get("authorization") ?? "");
  if (!match) return false;
  const sha256 = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(sha256(match[1]), sha256(expectedToken));
}
