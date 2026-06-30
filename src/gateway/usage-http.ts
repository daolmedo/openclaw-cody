import type { IncomingMessage, ServerResponse } from "node:http";
import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CostUsageSummary, CostUsageTotals } from "../infra/session-cost-usage.js";
import { loadCostUsageSummaryFromCache } from "../infra/session-cost-usage.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import { authorizeHttpGatewayConnect, type ResolvedGatewayAuth } from "./auth.js";
import { sendGatewayAuthFailure, sendJson, sendMethodNotAllowed } from "./http-common.js";
import { getBearerToken } from "./http-utils.js";
import { listAgentsForGateway } from "./session-utils.js";

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

async function loadAllAgentUsageSummary(params: {
  startMs: number;
  endMs: number;
  config: OpenClawConfig;
}): Promise<CostUsageSummary> {
  const agentIds = listAgentsForGateway(params.config).agents.map((agent) =>
    normalizeAgentId(agent.id),
  );
  const summaries = await Promise.all(
    agentIds.map((agentId) =>
      loadCostUsageSummaryFromCache({
        startMs: params.startMs,
        endMs: params.endMs,
        config: params.config,
        agentId,
        requestRefresh: true,
        refreshMode: "sync-when-empty",
      }),
    ),
  );
  const dailyByDate = new Map<string, CostUsageTotals & { date: string }>();
  const totals = emptyTotals();
  let updatedAt = 0;
  let days = 0;

  for (const summary of summaries) {
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
  const now = Date.now();
  const startOfMonth = new Date();
  startOfMonth.setUTCDate(1);
  startOfMonth.setUTCHours(0, 0, 0, 0);

  const summary = await loadAllAgentUsageSummary({
    startMs: startOfMonth.getTime(),
    endMs: now,
    config,
  });

  // CostUsageTotals shape: { input, output, cacheRead, cacheWrite, totalTokens,
  //   totalCost, inputCost, outputCost, cacheReadCost, cacheWriteCost, missingCostEntries }
  sendJson(res, 200, {
    ok: true,
    period: { start: startOfMonth.toISOString(), end: new Date(now).toISOString() },
    totals: summary.totals,
  });
  return true;
}
