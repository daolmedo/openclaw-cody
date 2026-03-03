import { resolveCronStyleNow } from "../../agents/current-time.js";
import type { OpenClawConfig } from "../../config/config.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";

export const DEFAULT_DEBRIEF_PROMPT = `Pre-compaction structured debrief. Write a debrief entry to memory/debriefs/YYYY-MM-DD.md (create the file if missing; APPEND a new entry, never overwrite).

Use this exact structure:

---
## Debrief — [timestamp]

### Accomplished
[What was completed or progressed in this session]

### Worked well
[Approaches, tools, or patterns that produced good results]

### Didn't work / blockers
[What failed, was unclear, or took longer than expected]

### Learnings
[1–3 concise insights to carry forward]

---

If nothing meaningful to capture, reply with ${SILENT_REPLY_TOKEN}.`;

export type DebriefSettings = {
  enabled: boolean;
  prompt: string;
};

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

export function resolveDebriefSettings(cfg?: OpenClawConfig): DebriefSettings | null {
  const compaction = cfg?.agents?.defaults?.compaction;
  const debriefCfg = compaction?.debrief;
  // Default: enabled when config block is present, or when not explicitly disabled
  const enabled = debriefCfg?.enabled ?? true;
  if (!enabled) {
    return null;
  }
  const prompt = debriefCfg?.prompt?.trim() || DEFAULT_DEBRIEF_PROMPT;
  return {
    enabled,
    prompt: ensureNoReplyHint(prompt),
  };
}

function ensureNoReplyHint(text: string): string {
  if (text.includes(SILENT_REPLY_TOKEN)) {
    return text;
  }
  return `${text}\n\nIf no user-visible reply is needed, start with ${SILENT_REPLY_TOKEN}.`;
}

export function resolveDebriefPromptForRun(params: {
  prompt: string;
  cfg?: OpenClawConfig;
  nowMs?: number;
}): string {
  const nowMs = Number.isFinite(params.nowMs) ? (params.nowMs as number) : Date.now();
  const { userTimezone, timeLine } = resolveCronStyleNow(params.cfg ?? {}, nowMs);
  const dateStamp = formatDateStampInTimezone(nowMs, userTimezone);
  const withDate = params.prompt.replaceAll("YYYY-MM-DD", dateStamp).trimEnd();
  if (!withDate) {
    return timeLine;
  }
  if (withDate.includes("Current time:")) {
    return withDate;
  }
  return `${withDate}\n${timeLine}`;
}
