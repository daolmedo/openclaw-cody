import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import { authorizeHttpGatewayConnect, type ResolvedGatewayAuth } from "./auth.js";
import { sendGatewayAuthFailure, sendJson, sendMethodNotAllowed } from "./http-common.js";
import { getBearerToken } from "./http-utils.js";

type AgentEntry = {
  id: string;
  name?: string;
  workspace?: string;
  agentDir?: string;
  default?: boolean;
};

type BehaviorFileKey = "soul" | "memory" | "agents";

const BEHAVIOR_FILES: Record<BehaviorFileKey, string> = {
  soul: "SOUL.md",
  memory: "MEMORY.md",
  agents: "AGENTS.md",
};

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function loadAgent(agentId: string): AgentEntry | null {
  const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
  const raw = fs.readFileSync(configPath, "utf8");
  const config = JSON.parse(raw) as Record<string, unknown>;
  const agentsList =
    (config.agents as { list?: AgentEntry[] } | undefined)?.list ?? [];
  return agentsList.find((agent) => agent.id === agentId) ?? null;
}

function resolveBehaviorDir(agent: AgentEntry): string {
  const home = os.homedir();

  const candidates =
    agent.id === "main"
      ? [agent.workspace, path.join(home, ".openclaw", "workspace"), agent.agentDir]
      : [agent.agentDir, agent.workspace, path.join(home, `${agent.id}-agent`)];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return path.resolve(candidate);
    }
  }

  return path.resolve(candidates.find((candidate): candidate is string => !!candidate) ?? home);
}

function resolveBehaviorPath(baseDir: string, key: BehaviorFileKey): string {
  const targetPath = path.resolve(baseDir, BEHAVIOR_FILES[key]);
  if (path.dirname(targetPath) !== baseDir) {
    throw new Error("Invalid behavior file path");
  }
  return targetPath;
}

function readBehaviorFile(baseDir: string, key: BehaviorFileKey) {
  const filePath = resolveBehaviorPath(baseDir, key);
  try {
    const stat = fs.statSync(filePath);
    return {
      key,
      fileName: BEHAVIOR_FILES[key],
      exists: true,
      content: fs.readFileSync(filePath, "utf8"),
      updatedAtMs: stat.mtimeMs,
    };
  } catch {
    return {
      key,
      fileName: BEHAVIOR_FILES[key],
      exists: false,
      content: "",
    };
  }
}

export async function handleAgentBehaviorHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { auth: ResolvedGatewayAuth; rateLimiter?: AuthRateLimiter },
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const match = url.pathname.match(/^\/api\/agents\/([^/]+)\/behavior$/);
  if (!match) return false;

  if (req.method !== "GET" && req.method !== "POST") {
    sendMethodNotAllowed(res, "GET, POST");
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

  const agentId = decodeURIComponent(match[1] ?? "").trim();
  if (!agentId) {
    sendJson(res, 400, { ok: false, error: "Missing agent id" });
    return true;
  }

  let agent: AgentEntry | null = null;
  try {
    agent = loadAgent(agentId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { ok: false, error: `Could not load agent config: ${message}` });
    return true;
  }

  if (!agent) {
    sendJson(res, 404, { ok: false, error: `No configured agent found for id: ${agentId}` });
    return true;
  }

  const baseDir = resolveBehaviorDir(agent);

  if (req.method === "POST") {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
      return true;
    }

    const input = body as { file?: unknown; content?: unknown };
    const fileKey = typeof input.file === "string" ? input.file.trim() : "";
    if (!(fileKey in BEHAVIOR_FILES)) {
      sendJson(res, 400, { ok: false, error: "Invalid behavior file" });
      return true;
    }
    if (typeof input.content !== "string") {
      sendJson(res, 400, { ok: false, error: "Missing content" });
      return true;
    }

    try {
      fs.mkdirSync(baseDir, { recursive: true });
      const targetPath = resolveBehaviorPath(baseDir, fileKey as BehaviorFileKey);
      const tmpPath = `${targetPath}.tmp-${process.pid}`;
      fs.writeFileSync(tmpPath, input.content, "utf8");
      fs.renameSync(tmpPath, targetPath);
      sendJson(res, 200, {
        ok: true,
        file: readBehaviorFile(baseDir, fileKey as BehaviorFileKey),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { ok: false, error: `Write failed: ${message}` });
    }
    return true;
  }

  sendJson(res, 200, {
    ok: true,
    agent: { id: agent.id, name: agent.name },
    files: (Object.keys(BEHAVIOR_FILES) as BehaviorFileKey[]).map((key) =>
      readBehaviorFile(baseDir, key),
    ),
  });

  return true;
}
