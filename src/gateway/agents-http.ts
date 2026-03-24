import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import { authorizeHttpGatewayConnect, type ResolvedGatewayAuth } from "./auth.js";
import { sendGatewayAuthFailure, sendJson, sendMethodNotAllowed } from "./http-common.js";
import { getBearerToken } from "./http-utils.js";

function listSkillIds(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((entry) =>
      fs.existsSync(path.join(dir, entry, "SKILL.md")),
    );
  } catch {
    return [];
  }
}

export async function handleAgentsHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { auth: ResolvedGatewayAuth; rateLimiter?: AuthRateLimiter },
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/api/agents") return false;

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

  try {
    const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
    const raw = fs.readFileSync(configPath, "utf8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    const agentsList =
      (config.agents as { list?: Array<{ id: string; name?: string; workspace?: string }> } | undefined)?.list ?? [];

    // Shared skills visible to all agents
    const sharedSkillIds = listSkillIds(path.join(os.homedir(), ".openclaw", "skills"));

    const agents = agentsList.map((agent) => {
      // Per-agent skills from the agent's own workspace
      const workspaceSkillIds = agent.workspace
        ? listSkillIds(path.join(agent.workspace, "skills"))
        : [];
      // Combine: workspace skills take precedence, shared fill the rest
      const skills = [...new Set([...workspaceSkillIds, ...sharedSkillIds])];
      return { id: agent.id, name: agent.name, skills };
    });

    sendJson(res, 200, { ok: true, agents });
  } catch {
    sendJson(res, 200, { ok: true, agents: [] });
  }

  return true;
}
