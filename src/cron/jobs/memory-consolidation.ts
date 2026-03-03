import { resolveCronStyleNow } from "../../agents/current-time.js";
import type { OpenClawConfig } from "../../config/config.js";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import type { CronService } from "../service.js";

const DEFAULT_DAILY_CRON_EXPR = "0 2 * * *";
const DEFAULT_WEEKLY_CRON_EXPR = "0 3 * * 0";

const BUILTIN_DAILY_JOB_NAME = "memory-daily-consolidation";
const BUILTIN_WEEKLY_JOB_NAME = "memory-weekly-curation";

function formatDateStampInTimezone(nowMs: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (year && month && day) {
    return `${year}-${month}-${day}`;
  }
  return new Date(nowMs).toISOString().slice(0, 10);
}

function buildDailyConsolidationMessage(cfg: OpenClawConfig): string {
  const nowMs = Date.now();
  const { userTimezone } = resolveCronStyleNow(cfg, nowMs);
  const dateStamp = formatDateStampInTimezone(nowMs, userTimezone);
  return [
    `Daily memory consolidation.`,
    `Read today's debrief file at memory/debriefs/${dateStamp}.md.`,
    `Identify recurring themes, quality patterns, and outcomes.`,
    `Write a concise consolidated summary to memory/daily/${dateStamp}.md.`,
    `Focus on: what types of tasks were handled well, what failed, any patterns worth tracking.`,
    `If the debrief file doesn't exist or is empty, reply with ${SILENT_REPLY_TOKEN}.`,
  ].join("\n");
}

function buildWeeklyCurationMessage(): string {
  return [
    `Weekly memory curation.`,
    `Read daily summaries from memory/daily/ for the past 7 days.`,
    `Extract lasting patterns: what types of requests succeed, what approaches work, what recurring blockers exist, what the user cares most about.`,
    `APPEND new patterns to MEMORY.md. Do not repeat entries already there.`,
    `Use concise bullet points under a ## Patterns section dated YYYY-WW.`,
    `If nothing new to add, reply with ${SILENT_REPLY_TOKEN}.`,
  ].join("\n");
}

async function jobExistsByName(cron: CronService, name: string): Promise<boolean> {
  const jobs = await cron.list({ includeDisabled: true });
  return jobs.some((job) => job.name === name);
}

export async function registerMemoryConsolidationJobs(
  cron: CronService,
  cfg: OpenClawConfig,
): Promise<void> {
  const compaction = cfg.agents?.defaults?.compaction;

  const dailyCfg = compaction?.dailyConsolidation;
  if (dailyCfg?.enabled === true) {
    const alreadyExists = await jobExistsByName(cron, BUILTIN_DAILY_JOB_NAME);
    if (!alreadyExists) {
      const cronExpr = dailyCfg.cronExpr?.trim() || DEFAULT_DAILY_CRON_EXPR;
      await cron.add({
        name: BUILTIN_DAILY_JOB_NAME,
        enabled: true,
        sessionTarget: "isolated",
        wakeMode: "now",
        schedule: { kind: "cron", expr: cronExpr },
        payload: {
          kind: "agentTurn",
          message: buildDailyConsolidationMessage(cfg),
          ...(dailyCfg.model ? { model: dailyCfg.model } : {}),
          lightContext: true,
        },
        delivery: { mode: "none" },
        failureAlert: false,
      });
    }
  }

  const weeklyCfg = compaction?.weeklyCuration;
  if (weeklyCfg?.enabled === true) {
    const alreadyExists = await jobExistsByName(cron, BUILTIN_WEEKLY_JOB_NAME);
    if (!alreadyExists) {
      const cronExpr = weeklyCfg.cronExpr?.trim() || DEFAULT_WEEKLY_CRON_EXPR;
      await cron.add({
        name: BUILTIN_WEEKLY_JOB_NAME,
        enabled: true,
        sessionTarget: "isolated",
        wakeMode: "now",
        schedule: { kind: "cron", expr: cronExpr },
        payload: {
          kind: "agentTurn",
          message: buildWeeklyCurationMessage(),
          ...(weeklyCfg.model ? { model: weeklyCfg.model } : {}),
          lightContext: true,
        },
        delivery: { mode: "none" },
        failureAlert: false,
      });
    }
  }
}
