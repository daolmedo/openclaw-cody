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
    const removeAgentIds = new Set<string>((body.removeAgentIds as string[] | undefined) ?? []);
    const existingAgents = config.agents as { list?: AgentEntry[] } | undefined;
    let existingList: AgentEntry[] = existingAgents?.list ?? [];
    for (const agent of incoming) {
      const idx = existingList.findIndex((a) => a.id === agent.id);
      if (idx >= 0) existingList[idx] = { ...existingList[idx], ...agent };
      else existingList.push(agent);
    }
    // Remove agents that were explicitly deleted from the canvas
    if (removeAgentIds.size > 0) {
      existingList = existingList.filter((a) => !removeAgentIds.has(a.id));
    }
    config.agents = { ...(config.agents as object ?? {}), list: existingList };

    // Merge bindings keyed on agentId + channel: an agent can have up to one binding
    // per channel (slack, twilio-whatsapp, cody-direct-chat) so we must not clobber
    // a different-channel binding when upserting.
    const existingBindings: Binding[] = (config.bindings as Binding[]) ?? [];
    const newBindings = (body.bindings as Binding[]) ?? [];
    const bindingChannel = (b: Binding) => (b.match as Record<string, unknown>)?.channel as string | undefined;
    const bindingKey = (b: Binding) => `${b.agentId}:${bindingChannel(b)}`;
    for (const b of newBindings) {
      const key = bindingKey(b);
      const idx = existingBindings.findIndex((e) => bindingKey(e) === key);
      if (idx >= 0) {
        existingBindings[idx] = b;
      } else {
        existingBindings.push(b);
      }
    }
    // Remove stale bindings per agentId+channel: if a canvas agent has no new binding
    // for a specific channel, that channel binding is removed (e.g. Slack unassigned).
    const canvasAgentIds = new Set(incoming.map((a) => a.id));
    const newBindingKeys = new Set(newBindings.map(bindingKey));
    let updatedBindings = existingBindings.filter(
      (b) => !canvasAgentIds.has(b.agentId) || newBindingKeys.has(bindingKey(b)),
    );
    if (removeAgentIds.size > 0) {
      updatedBindings = updatedBindings.filter((b) => !removeAgentIds.has(b.agentId));
    }
    config.bindings = updatedBindings;

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

    // Merge MS Teams per-channel configs (requireMention etc.) into the deeper
    // channels.msteams.teams.<teamId>.channels.<conversationId> path. Teams nests one
    // level deeper than Slack (channels.slack.channels.<id>) because Teams channels live
    // under a team. Shape: { [teamId]: { [conversationId]: { ...chCfg } } }.
    const msteamsChannelConfigs =
      (body.msteamsChannelConfigs as Record<string, Record<string, Record<string, unknown>>>) ?? {};
    if (Object.keys(msteamsChannelConfigs).length > 0) {
      const channels = config.channels as Record<string, unknown> | undefined ?? {};
      const msteams = channels.msteams as Record<string, unknown> | undefined ?? {};
      const teams = msteams.teams as Record<string, Record<string, unknown>> | undefined ?? {};
      for (const [teamId, convConfigs] of Object.entries(msteamsChannelConfigs)) {
        const team = (teams[teamId] as Record<string, unknown> | undefined) ?? {};
        const teamChannels = (team.channels as Record<string, unknown> | undefined) ?? {};
        for (const [convId, chCfg] of Object.entries(convConfigs)) {
          teamChannels[convId] = { ...(teamChannels[convId] as object ?? {}), ...chCfg };
        }
        teams[teamId] = { ...team, channels: teamChannels };
      }
      config.channels = { ...channels, msteams: { ...msteams, teams } };
    }

    // Update Slack credentials — sets up channels.slack if not present yet.
    // Accepts { botToken, appToken, signingSecret }. On first deploy for accounts
    // provisioned without Slack (e.g. WhatsApp-first), this writes the full channel
    // config. On re-deploys it only updates credentials, preserving other settings.
    const slackAccount = body.slackAccount as { botToken?: string; appToken?: string; signingSecret?: string } | undefined;
    if (slackAccount?.botToken && slackAccount?.appToken && slackAccount?.signingSecret) {
      const channels = config.channels as Record<string, unknown> | undefined ?? {};
      const existingSlack = channels.slack as Record<string, unknown> | undefined ?? {};
      channels.slack = {
        mode: "http",
        webhookPath: "/slack/events",
        enabled: true,
        commands: { native: true },
        userTokenReadOnly: false,
        groupPolicy: "open",
        dmPolicy: "open",
        allowFrom: ["*"],
        ackReaction: "hourglass_flowing_sand",
        ...existingSlack,
        botToken: slackAccount.botToken,
        appToken: slackAccount.appToken,
        signingSecret: slackAccount.signingSecret,
        streaming: { mode: "off", nativeTransport: false },
      };
      config.channels = channels;
    }

    // Update MS Teams credentials — sets up channels.msteams if not present yet.
    // Accepts { appId, appPassword, tenantId }. On first deploy for accounts provisioned
    // without Teams (e.g. Slack-first), this writes the full channel config; on re-deploys
    // it only updates credentials, preserving other settings (e.g. teams.* per-channel config).
    // OpenClaw msteams runs its own webhook server on port 3978; requireMention:false so a
    // bound channel's agent answers every message ("each agent owns its channel").
    const msteamsAccount = body.msteamsAccount as { appId?: string; appPassword?: string; tenantId?: string } | undefined;
    if (msteamsAccount?.appId && msteamsAccount?.appPassword && msteamsAccount?.tenantId) {
      const channels = config.channels as Record<string, unknown> | undefined ?? {};
      const existingMsteams = channels.msteams as Record<string, unknown> | undefined ?? {};
      channels.msteams = {
        enabled: true,
        webhook: { port: 3978, path: "/api/messages" },
        dmPolicy: "open",
        groupPolicy: "open",
        allowFrom: ["*"],
        requireMention: false,
        ...existingMsteams,
        appId: msteamsAccount.appId,
        appPassword: msteamsAccount.appPassword,
        tenantId: msteamsAccount.tenantId,
      };
      config.channels = channels;
    }

    // Update WhatsApp accounts.
    // whatsappPhoneNumber (legacy): updates only accounts.default.phoneNumber
    // whatsappAccounts: { accountId: { phoneNumber, accountSid, authToken } } (preferred)
    //                or { accountId: phoneNumber } (legacy string format, backward compat)
    const whatsappPhoneNumber = body.whatsappPhoneNumber as string | undefined;
    const whatsappAccounts = body.whatsappAccounts as Record<string, string | Record<string, unknown>> | undefined;
    if (whatsappPhoneNumber || whatsappAccounts) {
      const channels = config.channels as Record<string, unknown> | undefined ?? {};
      const tw = channels["twilio-whatsapp"] as Record<string, unknown> | undefined ?? {};
      const accounts = tw.accounts as Record<string, Record<string, unknown>> | undefined ?? {};

      // Fallback shared creds for legacy string-format entries (scan all existing accounts)
      const sharedCreds: { accountSid?: unknown; authToken?: unknown } = (() => {
        for (const acct of Object.values(accounts)) {
          if (acct.accountSid && acct.authToken) {
            return { accountSid: acct.accountSid, authToken: acct.authToken };
          }
        }
        return {};
      })();

      if (whatsappPhoneNumber) {
        accounts.default = { ...sharedCreds, ...(accounts.default ?? {}), phoneNumber: whatsappPhoneNumber };
      }
      if (whatsappAccounts) {
        // Replace the entire accounts map so phones removed from the canvas are cleared.
        const newAccounts: Record<string, Record<string, unknown>> = {};
        for (const [accountId, value] of Object.entries(whatsappAccounts)) {
          if (typeof value === "string") {
            // Legacy: just a phone number — inherit credentials from existing or shared
            newAccounts[accountId] = { ...sharedCreds, ...(accounts[accountId] ?? {}), phoneNumber: value };
          } else {
            // New format: full account object with credentials supplied by backend
            newAccounts[accountId] = { ...(accounts[accountId] ?? {}), ...value };
          }
        }
        tw.accounts = newAccounts;
      } else {
        tw.accounts = accounts;
      }
      channels["twilio-whatsapp"] = tw;
      config.channels = channels;
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

    // Write shared skill files to ~/.openclaw/skills/<id>/SKILL.md
    // These are visible to all agents (e.g. documenting-tasks, integrations).
    // Only write if the file doesn't exist — agents may have customised it since initial deploy.
    const sharedSkillFiles = (body.sharedSkillFiles as Record<string, string> | undefined)
      ?? (body.skillFiles as Record<string, string> | undefined) // legacy fallback
      ?? {};
    for (const [skillId, content] of Object.entries(sharedSkillFiles)) {
      const skillDir = path.join(os.homedir(), ".openclaw", "skills", skillId);
      const skillPath = path.join(skillDir, "SKILL.md");
      if (!fs.existsSync(skillPath)) {
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(skillPath, content, "utf8");
      }
    }

    // Write per-agent skill files to <workspace>/skills/<id>/SKILL.md
    // These are only visible to the owning agent.
    // Only write if the file doesn't exist — agents may have customised it since initial deploy.
    const agentSkillFiles = (body.agentSkillFiles as Record<string, Record<string, string>>) ?? {};
    for (const agent of incoming) {
      const agentSkills = agentSkillFiles[agent.id];
      if (!agentSkills || !agent.workspace) continue;
      for (const [skillId, content] of Object.entries(agentSkills)) {
        const skillDir = path.join(agent.workspace, "skills", skillId);
        const skillPath = path.join(skillDir, "SKILL.md");
        if (!fs.existsSync(skillPath)) {
          fs.mkdirSync(skillDir, { recursive: true });
          fs.writeFileSync(skillPath, content, "utf8");
        }
      }
    }

    // Sync exec-approvals.json for agents in "integrations-only" mode (exec.security: "allowlist").
    // Only SAK is pre-approved; all other bash is hard-blocked for those agents.
    // Only writes when something actually needs to change.
    const SAK_PATH = "/home/ubuntu/.npm-global/bin/sak";
    const approvalsPath = path.join(os.homedir(), ".openclaw", "exec-approvals.json");

    const allowlistAgentIds = new Set(
      existingList
        .filter((a) => {
          const tools = a.tools as Record<string, unknown> | undefined;
          return (tools?.exec as Record<string, unknown> | undefined)?.security === "allowlist";
        })
        .map((a) => a.id),
    );

    let existingApprovals: Record<string, unknown> | null = null;
    try {
      existingApprovals = JSON.parse(fs.readFileSync(approvalsPath, "utf8"));
    } catch { /* file may not exist */ }

    const existingAgentApprovals = (existingApprovals?.agents as Record<string, unknown>) ?? {};
    const agentsWithSak = new Set(
      Object.keys(existingAgentApprovals).filter((id) => {
        const allowlist = (existingAgentApprovals[id] as Record<string, unknown>)?.allowlist as Array<Record<string, unknown>> | undefined;
        return allowlist?.some((e) => e.pattern === SAK_PATH);
      }),
    );

    const needsApprovalsWrite = allowlistAgentIds.size > 0 || agentsWithSak.size > 0;
    if (needsApprovalsWrite) {
      if (!existingApprovals) existingApprovals = { version: 1, socket: {}, defaults: {}, agents: {} };
      const agentApprovals = (existingApprovals.agents as Record<string, Record<string, unknown>>) ?? {};

      for (const agent of existingList) {
        if (allowlistAgentIds.has(agent.id)) {
          const existing = agentApprovals[agent.id] ?? {};
          const allowlist = (existing.allowlist as Array<Record<string, unknown>>) ?? [];
          if (!allowlist.some((e) => e.pattern === SAK_PATH)) {
            allowlist.push({ pattern: SAK_PATH });
          }
          agentApprovals[agent.id] = { ...existing, security: "allowlist", ask: "on-miss", askFallback: "deny", allowlist };
        } else if (agentsWithSak.has(agent.id)) {
          // Agent left allowlist mode — delete entry entirely so no stale security override remains
          // (effective policy = stricter of openclaw.json and exec-approvals.json)
          delete agentApprovals[agent.id];
        }
      }

      existingApprovals.agents = agentApprovals;
      const tmpApprovals = `${approvalsPath}.tmp`;
      fs.writeFileSync(tmpApprovals, JSON.stringify(existingApprovals, null, 2));
      fs.renameSync(tmpApprovals, approvalsPath);
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
