import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import { authorizeHttpGatewayConnect, type ResolvedGatewayAuth } from "./auth.js";
import { sendGatewayAuthFailure, sendJson, sendMethodNotAllowed } from "./http-common.js";
import { getBearerToken } from "./http-utils.js";

/** Resolve the docs/ directory for a given agentId, or null if not found. */
function resolveDocsDir(agentId: string): string | null {
  const home = os.homedir();

  if (agentId === "main") {
    return path.join(home, ".openclaw", "workspace", "docs");
  }

  // Prefer ~/.openclaw/workspace-{id}/docs
  const primary = path.join(home, ".openclaw", `workspace-${agentId}`, "docs");
  if (fs.existsSync(primary)) return primary;

  // Fall back to ~/HOME/{id}-agent/docs
  const fallback = path.join(home, `${agentId}-agent`, "docs");
  if (fs.existsSync(fallback)) return fallback;

  return null;
}

/** Validate that a relative path is safe (no traversal, only .md/.csv). */
function validateRelativePath(relPath: string): string | null {
  if (!relPath || typeof relPath !== "string") return "Missing path";
  if (path.isAbsolute(relPath)) return "Path must be relative";

  const normalized = path.normalize(relPath);
  if (normalized.startsWith("..")) return "Path traversal not allowed";

  const ext = path.extname(normalized).toLowerCase();
  if (ext !== ".md" && ext !== ".csv") return "Only .md and .csv files are writable";

  return null; // valid
}

export async function handleFilesHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { auth: ResolvedGatewayAuth; rateLimiter?: AuthRateLimiter },
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/api/files/write") return false;

  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }

  const token = getBearerToken(req);
  const authResult = await authorizeHttpGatewayConnect({
    auth: opts.auth,
    connectAuth: token ? { token, password: token } : null,
    req,
    trustedProxies: [],
    allowRealIpFallback: false,
    rateLimiter: opts.rateLimiter,
  });
  if (!authResult.ok) {
    sendGatewayAuthFailure(res, authResult);
    return true;
  }

  // Parse JSON body
  let body: { agentId?: unknown; path?: unknown; content?: unknown };
  try {
    const rawBody = await new Promise<string>((resolve, reject) => {
      let data = "";
      req.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });
    body = JSON.parse(rawBody);
  } catch {
    sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
    return true;
  }

  const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
  const relPath = typeof body.path === "string" ? body.path.trim() : "";
  const content = typeof body.content === "string" ? body.content : "";

  if (!agentId) {
    sendJson(res, 400, { ok: false, error: "Missing agentId" });
    return true;
  }

  const pathError = validateRelativePath(relPath);
  if (pathError) {
    sendJson(res, 400, { ok: false, error: pathError });
    return true;
  }

  const docsDir = resolveDocsDir(agentId);
  if (!docsDir) {
    sendJson(res, 404, { ok: false, error: `No workspace found for agent: ${agentId}` });
    return true;
  }

  try {
    const targetPath = path.join(docsDir, path.normalize(relPath));

    // Safety check: ensure resolved path is still inside docsDir
    if (!targetPath.startsWith(docsDir + path.sep) && targetPath !== docsDir) {
      sendJson(res, 400, { ok: false, error: "Path traversal not allowed" });
      return true;
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content, "utf-8");

    sendJson(res, 200, { ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { ok: false, error: `Write failed: ${message}` });
  }

  return true;
}
