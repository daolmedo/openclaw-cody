import type { IncomingMessage, ServerResponse } from "node:http";
import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CostUsageSummary, CostUsageTotals } from "../infra/session-cost-usage.js";
import { loadCostUsageSummaryFromCache } from "../infra/session-cost-usage.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import { authorizeHttpGatewayConnect, type ResolvedGatewayAuth } from "./auth.js";
import {
  sendGatewayAuthFailure,
  sendJson,
  sendMethodNotAllowed,
  sendText,
} from "./http-common.js";
import { getBearerToken } from "./http-utils.js";
import { listAgentsForGateway } from "./session-utils.js";

type GatewayUsageAgent = ReturnType<typeof listAgentsForGateway>["agents"][number];

type AgentUsageSummary = {
  id: string;
  name?: GatewayUsageAgent["name"];
  identity?: GatewayUsageAgent["identity"];
  model?: GatewayUsageAgent["model"];
  totals: CostUsageTotals;
  daily: CostUsageSummary["daily"];
};

type AllAgentUsageSummary = CostUsageSummary & {
  agents: AgentUsageSummary[];
};

type UsagePeriod = {
  startMs: number;
  endMs: number;
  start: Date;
  end: Date;
};

function emptyTotals(): CostUsageTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    totalCost: 0,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    missingCostEntries: 0,
  };
}

function addTotals(target: CostUsageTotals, source: CostUsageTotals): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.totalTokens += source.totalTokens;
  target.totalCost += source.totalCost;
  target.inputCost += source.inputCost;
  target.outputCost += source.outputCost;
  target.cacheReadCost += source.cacheReadCost;
  target.cacheWriteCost += source.cacheWriteCost;
  target.missingCostEntries += source.missingCostEntries;
}

function parseUsageBoundary(raw: string | null, boundary: "start" | "end"): number | undefined {
  if (!raw) return undefined;
  const value = raw.trim();
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const suffix = boundary === "start" ? "T00:00:00.000Z" : "T23:59:59.999Z";
    const parsed = Date.parse(`${value}${suffix}`);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function resolveUsagePeriodFromQuery(
  searchParams: URLSearchParams,
  nowMs = Date.now(),
): UsagePeriod | { error: string } {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const startOfMonth = new Date(now);
  startOfMonth.setUTCDate(1);
  startOfMonth.setUTCHours(0, 0, 0, 0);

  const requestedStart = parseUsageBoundary(
    searchParams.get("from") ?? searchParams.get("start"),
    "start",
  );
  const requestedEnd = parseUsageBoundary(searchParams.get("to") ?? searchParams.get("end"), "end");

  if (Number.isNaN(requestedStart) || Number.isNaN(requestedEnd)) {
    return { error: "Invalid usage period. Use ISO timestamps or YYYY-MM-DD for from/to." };
  }

  const startMs = requestedStart ?? startOfMonth.getTime();
  const endMs = requestedEnd ?? now;
  if (startMs > endMs) {
    return { error: "Invalid usage period. from must be before to." };
  }

  return {
    startMs,
    endMs,
    start: new Date(startMs),
    end: new Date(endMs),
  };
}

async function loadAllAgentUsageSummary(params: {
  startMs: number;
  endMs: number;
  config: OpenClawConfig;
}): Promise<AllAgentUsageSummary> {
  const agents = listAgentsForGateway(params.config).agents;
  const summaries = await Promise.all(
    agents.map(async (agent) => {
      const agentId = normalizeAgentId(agent.id);
      const summary = await loadCostUsageSummaryFromCache({
        startMs: params.startMs,
        endMs: params.endMs,
        config: params.config,
        agentId,
        requestRefresh: true,
        refreshMode: "sync-when-empty",
      });
      return { agent, agentId, summary };
    }),
  );
  const dailyByDate = new Map<string, CostUsageTotals & { date: string }>();
  const totals = emptyTotals();
  let updatedAt = 0;
  let days = 0;

  for (const { summary } of summaries) {
    updatedAt = Math.max(updatedAt, summary.updatedAt);
    days = Math.max(days, summary.days);
    addTotals(totals, summary.totals);
    for (const day of summary.daily) {
      const entry = dailyByDate.get(day.date) ?? { date: day.date, ...emptyTotals() };
      addTotals(entry, day);
      dailyByDate.set(day.date, entry);
    }
  }

  return {
    updatedAt,
    days,
    daily: Array.from(dailyByDate.values()).toSorted((a, b) => a.date.localeCompare(b.date)),
    totals,
    agents: summaries.map(({ agent, agentId, summary }) => ({
      id: agentId,
      ...(agent.name ? { name: agent.name } : {}),
      ...(agent.identity ? { identity: agent.identity } : {}),
      ...(agent.model ? { model: agent.model } : {}),
      totals: summary.totals,
      daily: summary.daily,
    })),
  };
}

export async function handleUsageHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { auth: ResolvedGatewayAuth; rateLimiter?: AuthRateLimiter },
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/api/usage") return false;

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

  const config = loadConfig();
  const period = resolveUsagePeriodFromQuery(url.searchParams);
  if ("error" in period) {
    sendText(res, 400, period.error);
    return true;
  }

  const summary = await loadAllAgentUsageSummary({
    startMs: period.startMs,
    endMs: period.endMs,
    config,
  });

  // CostUsageTotals shape: { input, output, cacheRead, cacheWrite, totalTokens,
  //   totalCost, inputCost, outputCost, cacheReadCost, cacheWriteCost, missingCostEntries }
  sendJson(res, 200, {
    ok: true,
    period: { start: period.start.toISOString(), end: period.end.toISOString() },
    totals: summary.totals,
    agents: summary.agents,
  });
  return true;
}
