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

function readSessionTranscript(sessionsDir: string, sessionId: string): unknown[] {
  const filePath = path.join(sessionsDir, `${sessionId}.jsonl`);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const messages: unknown[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as Record<string, unknown>;
        // Skip the session header line, include message entries
        if (entry.type !== "session" && entry.message) {
          messages.push(entry.message);
        }
      } catch {
        // skip malformed lines
      }
    }
    return messages;
  } catch {
    return [];
  }
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
    // Return transcript for a specific session
    const sessionId = safeSegment(rawSessionId);
    if (!sessionId) {
      sendJson(res, 400, { ok: false, error: "Invalid session ID" });
      return true;
    }
    const messages = readSessionTranscript(sessionsDir, sessionId);
    sendJson(res, 200, { ok: true, messages });
    return true;
  }

  // List sessions for the agent
  const store = readSessionStore(sessionsDir);
  const sessions = Object.values(store).map((entry) => {
    const e = entry as Record<string, unknown>;
    return {
      sessionId: e.sessionId,
      updatedAt: e.updatedAt,
      startedAt: e.startedAt,
      origin: e.origin,
      sessionFile: typeof e.sessionFile === "string" ? path.basename(e.sessionFile) : undefined,
    };
  });

  // Sort by most recently updated first
  sessions.sort((a, b) => {
    const ta = typeof a.updatedAt === "number" ? a.updatedAt : 0;
    const tb = typeof b.updatedAt === "number" ? b.updatedAt : 0;
    return tb - ta;
  });

  sendJson(res, 200, { ok: true, sessions });
  return true;
}
