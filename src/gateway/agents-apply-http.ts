import { spawn } from "node:child_process";
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
  name: string;
  workspace: string;
  agentDir: string;
  [key: string]: unknown;
};

type Binding = {
  agentId: string;
  match: unknown;
};

export async function handleAgentsApplyHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { auth: ResolvedGatewayAuth; rateLimiter?: AuthRateLimiter },
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/api/agents/apply") return false;

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

  // Read request body
  let body: Record<string, unknown>;
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

  try {
    const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
    const raw = fs.readFileSync(configPath, "utf8");
    const config = JSON.parse(raw) as Record<string, unknown>;

    // Backup
    const backupPath = `${configPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.writeFileSync(backupPath, raw);

    // Merge agents.list (upsert by id, preserve unknown agents)
    const incoming = (body.agentsList as AgentEntry[]) ?? [];
    const existingAgents = config.agents as { list?: AgentEntry[] } | undefined;
    const existingList: AgentEntry[] = existingAgents?.list ?? [];
    for (const agent of incoming) {
      const idx = existingList.findIndex((a) => a.id === agent.id);
      if (idx >= 0) existingList[idx] = { ...existingList[idx], ...agent };
      else existingList.push(agent);
    }
    config.agents = { ...(config.agents as object ?? {}), list: existingList };

    // Merge bindings: update if agentId already has one, append if new, never remove others
    const existingBindings: Binding[] = (config.bindings as Binding[]) ?? [];
    for (const b of (body.bindings as Binding[]) ?? []) {
      const idx = existingBindings.findIndex((e) => e.agentId === b.agentId);
      if (idx >= 0) {
        existingBindings[idx] = b; // update channel assignment on re-deploy
      } else {
        existingBindings.push(b);
      }
    }
    config.bindings = existingBindings;

    // Ensure cron concurrency is always set — without this a zombie job blocks everything
    const cron = config.cron as Record<string, unknown> | undefined ?? {};
    if (!cron.maxConcurrentRuns || (cron.maxConcurrentRuns as number) < 4) {
      config.cron = { ...cron, maxConcurrentRuns: 4 };
    }

    // Ensure full tool access — default 'coding' profile excludes web_search/web_fetch
    const tools = config.tools as Record<string, unknown> | undefined ?? {};
    if (tools.profile !== "full") {
      config.tools = { ...tools, profile: "full" };
    }

    // Merge channel configs (requireMention etc.) into channels.slack.channels
    const channelConfigs = (body.channelConfigs as Record<string, Record<string, unknown>>) ?? {};
    if (Object.keys(channelConfigs).length > 0) {
      const channels = config.channels as Record<string, unknown> | undefined ?? {};
      const slack = channels.slack as Record<string, unknown> | undefined ?? {};
      const slackChannels = slack.channels as Record<string, unknown> | undefined ?? {};
      for (const [chId, chCfg] of Object.entries(channelConfigs)) {
        slackChannels[chId] = { ...(slackChannels[chId] as object ?? {}), ...chCfg };
      }
      config.channels = { ...channels, slack: { ...slack, channels: slackChannels } };
    }

    // Write atomically (temp file + rename)
    const tmpPath = `${configPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2));
    fs.renameSync(tmpPath, configPath);

    // Create directories + write workspace files
    const workspaceFiles = (body.workspaceFiles as Record<string, Record<string, string>>) ?? {};
    for (const [agentId, files] of Object.entries(workspaceFiles)) {
      const agent = incoming.find((a) => a.id === agentId);
      if (!agent) continue;
      fs.mkdirSync(agent.agentDir, { recursive: true });
      fs.mkdirSync(agent.workspace, { recursive: true });
      for (const [filename, content] of Object.entries(files)) {
        if (content !== undefined && content !== "") {
          fs.writeFileSync(path.join(agent.agentDir, filename), content);
        }
      }
    }

    // Write skill files to ~/.openclaw/skills/<id>/SKILL.md
    // Only write if the file doesn't exist — agents may have customised it since initial deploy
    const skillFiles = (body.skillFiles as Record<string, string>) ?? {};
    for (const [skillId, content] of Object.entries(skillFiles)) {
      const skillDir = path.join(os.homedir(), ".openclaw", "skills", skillId);
      const skillPath = path.join(skillDir, "SKILL.md");
      if (!fs.existsSync(skillPath)) {
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(skillPath, content, "utf8");
      }
    }

    // Send response first, then restart gateway (restart kills this process)
    sendJson(res, 200, { ok: true, agentCount: incoming.length });

    // Fire-and-forget restart via systemctl (openclaw gateway restart uses WebSocket
    // which fails if gateway.remote.token != gateway.auth.token)
    spawn("systemctl", ["--user", "restart", "openclaw-gateway.service"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, XDG_RUNTIME_DIR: "/run/user/1000" },
    }).unref();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { ok: false, error: msg });
  }

  return true;
}
