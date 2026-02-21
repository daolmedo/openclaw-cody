import type { IncomingMessage, ServerResponse } from "node:http";
import { loadConfig } from "../config/config.js";
import { loadCostUsageSummary } from "../infra/session-cost-usage.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import { authorizeHttpGatewayConnect, type ResolvedGatewayAuth } from "./auth.js";
import { sendGatewayAuthFailure, sendJson, sendMethodNotAllowed } from "./http-common.js";
import { getBearerToken } from "./http-utils.js";

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

  const summary = await loadCostUsageSummary({
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
