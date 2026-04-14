import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import { authorizeHttpGatewayConnect, type ResolvedGatewayAuth } from "./auth.js";
import { sendGatewayAuthFailure, sendJson, sendMethodNotAllowed } from "./http-common.js";
import { getBearerToken } from "./http-utils.js";

// Matches /api/agents/<agentId>/sessions or /api/agents/<agentId>/sessions/<sessionId>
const SESSIONS_PATH_RE = /^\/api\/agents\/([^/]+)\/sessions(?:\/([^/]+))?$/;

const SAFE_SEGMENT_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

function safeSegment(s: string): string | null {
  const trimmed = s.trim();
  return SAFE_SEGMENT_RE.test(trimmed) ? trimmed : null;
}

function resolveAgentSessionsDir(agentId: string): string {
  return path.join(os.homedir(), ".openclaw", "agents", agentId, "sessions");
}

function readSessionStore(sessionsDir: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(path.join(sessionsDir, "sessions.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/** Read the first ~3KB of a session file and extract the first user message text for a preview. */
function readSessionPreview(sessionsDir: string, sessionFile: string | undefined, sessionId: string): string | undefined {
  const fileName = sessionFile ?? `${sessionId}.jsonl`;
  const filePath = path.isAbsolute(fileName) ? fileName : path.join(sessionsDir, path.basename(fileName));
  try {
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(4096);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const chunk = buf.slice(0, bytesRead).toString("utf8");
    for (const line of chunk.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as Record<string, unknown>;
        if (entry.type !== "message") continue;
        const msg = entry.message as Record<string, unknown> | undefined;
        if (!msg || msg.role !== "user") continue;
        const content = msg.content;
        if (typeof content === "string") return content.slice(0, 120);
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as Record<string, unknown>;
            if (b.type === "text" && typeof b.text === "string") {
              // strip cron prefix like "[cron:xxx name]"
              const text = b.text.replace(/^\[cron:[^\]]+\]\s*/, "").trim();
              return text.slice(0, 120);
            }
          }
        }
      } catch {
        // skip
      }
    }
  } catch {
    // file not readable
  }
  return undefined;
}

type TranscriptEntry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; blocks: AssistantBlock[] }
  | { kind: "tool_result"; toolCallId: string; text: string; isError: boolean }
  | { kind: "status"; event: string; data?: unknown };

type AssistantBlock =
  | { type: "text"; text: string }
  | { type: "thinking" }
  | { type: "tool_call"; id: string; name: string; arguments: unknown };

function parseTranscript(sessionsDir: string, sessionId: string): TranscriptEntry[] {
  const filePath = path.join(sessionsDir, `${sessionId}.jsonl`);
  const entries: TranscriptEntry[] = [];
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return entries;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = obj.type as string | undefined;

    if (type === "session" || type === "thinking_level_change") continue;

    if (type === "model_change") {
      entries.push({ kind: "status", event: "model_change", data: { provider: obj.provider, modelId: obj.modelId } });
      continue;
    }

    if (type === "custom") {
      const ct = (obj.data as Record<string, unknown> | undefined);
      if (ct && obj.customType === "model-snapshot") {
        // skip — model_change already covers this
      }
      continue;
    }

    if (type !== "message") continue;

    const msg = obj.message as Record<string, unknown> | undefined;
    if (!msg) continue;

    const role = msg.role as string;
    const content = msg.content;

    if (role === "user") {
      let text = "";
      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        text = (content as Array<Record<string, unknown>>)
          .filter((b) => b.type === "text")
          .map((b) => String(b.text ?? ""))
          .join("\n");
      }
      // strip cron prefix
      text = text.replace(/^\[cron:[^\]]+\]\s*/, "").trim();
      if (text) entries.push({ kind: "user", text });
      continue;
    }

    if (role === "assistant") {
      const blocks: AssistantBlock[] = [];
      if (Array.isArray(content)) {
        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type === "thinking") {
            blocks.push({ type: "thinking" });
          } else if (block.type === "toolCall") {
            blocks.push({
              type: "tool_call",
              id: String(block.id ?? ""),
              name: String(block.name ?? ""),
              arguments: block.arguments ?? {},
            });
          } else if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
            blocks.push({ type: "text", text: block.text });
          }
        }
      } else if (typeof content === "string" && content.trim()) {
        blocks.push({ type: "text", text: content });
      }
      if (blocks.length > 0) entries.push({ kind: "assistant", blocks });
      continue;
    }

    if (role === "toolResult") {
      const toolCallId = String(msg.toolCallId ?? "");
      let text = "";
      let isError = false;
      if (Array.isArray(content)) {
        text = (content as Array<Record<string, unknown>>)
          .filter((b) => b.type === "text")
          .map((b) => String(b.text ?? ""))
          .join("\n");
        // detect error from JSON result
        try {
          const parsed = JSON.parse(text) as Record<string, unknown>;
          if (parsed.status === "error") isError = true;
        } catch { /* not json */ }
      } else if (typeof content === "string") {
        text = content;
      }
      entries.push({ kind: "tool_result", toolCallId, text, isError });
    }
  }

  return entries;
}

export async function handleAgentSessionsHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { auth: ResolvedGatewayAuth; rateLimiter?: AuthRateLimiter },
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const match = SESSIONS_PATH_RE.exec(url.pathname);
  if (!match) return false;

  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
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

  const rawAgentId = match[1] ?? "";
  const rawSessionId = match[2];

  const agentId = safeSegment(rawAgentId);
  if (!agentId) {
    sendJson(res, 400, { ok: false, error: "Invalid agent ID" });
    return true;
  }

  const sessionsDir = resolveAgentSessionsDir(agentId);

  if (rawSessionId !== undefined) {
    const sessionId = safeSegment(rawSessionId);
    if (!sessionId) {
      sendJson(res, 400, { ok: false, error: "Invalid session ID" });
      return true;
    }
    const entries = parseTranscript(sessionsDir, sessionId);
    sendJson(res, 200, { ok: true, entries });
    return true;
  }

  // List sessions for the agent — deduplicate by sessionId (multiple store keys can share one session)
  const store = readSessionStore(sessionsDir);
  const seen = new Set<string>();
  const sessions = Object.values(store).map((entry) => {
    const e = entry as Record<string, unknown>;
    const sessionFile = typeof e.sessionFile === "string" ? e.sessionFile : undefined;
    const sessionId = String(e.sessionId ?? "");
    const preview = readSessionPreview(sessionsDir, sessionFile, sessionId);
    return {
      sessionId,
      updatedAt: e.updatedAt,
      startedAt: e.startedAt,
      status: e.status,
      origin: e.origin,
      sessionFile: sessionFile ? path.basename(sessionFile) : undefined,
      preview,
      label: typeof e.label === "string" ? e.label : undefined,
    };
  }).filter((s) => {
    if (!s.sessionId) return false;
    if (seen.has(s.sessionId)) return false;
    seen.add(s.sessionId);
    return true;
  });

  sessions.sort((a, b) => {
    const ta = typeof a.updatedAt === "number" ? a.updatedAt : 0;
    const tb = typeof b.updatedAt === "number" ? b.updatedAt : 0;
    return tb - ta;
  });

  sendJson(res, 200, { ok: true, sessions });
  return true;
}
