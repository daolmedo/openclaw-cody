import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  annotateInterSessionPromptText,
  PROGRESS_CARD_REFRESH_SOURCE_TOOL,
  type InputProvenance,
} from "../../sessions/input-provenance.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { buildAssistantMessage, buildUsageWithNoCost } from "../stream-message-shared.js";
import { loadCliSessionPromptContext } from "./session-history.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    for (const stateDir of tempDirs.dirs) {
      await cleanupSessionStateForTest({ stateDir });
    }
    cleanup();
  });
});

async function createSession() {
  const dir = tempDirs.make("openclaw-cli-preserved-");
  const target = {
    agentId: "main",
    sessionId: "history-session",
    sessionKey: "agent:main:history",
    storePath: path.join(dir, "openclaw-agent.sqlite"),
  };
  await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
  return { target, params: { sessionTarget: target } };
}

describe("preserved Claude turns", () => {
  it("carries completion exchanges since the last ordinary reply, and withholds them across the account boundary", async () => {
    const { target, params } = await createSession();
    const reply = async (index: number, runId = `run-${index}`) =>
      await appendTranscriptMessage(target, {
        eventId: `assistant-${index}`,
        now: index * 2000 + 2000,
        message: {
          ...buildAssistantMessage({
            model: { api: "cli", provider: "claude-cli", id: "test-model" },
            content: [{ type: "text", text: `reply-${index}` }],
            stopReason: "stop",
            usage: buildUsageWithNoCost({}),
          }),
          __openclaw: { runId },
        },
      });
    const turn = async (index: number, text: string, provenance?: InputProvenance) => {
      await appendTranscriptMessage(target, {
        eventId: `user-${index}`,
        now: index * 2000 + 1000,
        message: {
          ...makeUserMessage(text, index * 2000 + 1000),
          ...(provenance && { provenance }),
        },
      });
      await reply(index);
    };
    const completion = { kind: "inter_session", sourceTool: "subagent_announce" } as const;
    const resumed = {
      ...params,
      nativeSessionId: "native-session",
      provider: "claude-cli",
    };
    await turn(0, "Spawn the review.");
    await turn(1, "Child result: CHILD_RESULT_7f3a9c", completion);
    await turn(2, "Refresh the card.", {
      kind: "internal_system",
      sourceTool: PROGRESS_CARD_REFRESH_SOURCE_TOOL,
    });
    // A direct completion saves only its reply, under the announce run id.
    await reply(3, "announce:v1:agent:main:subagent:child:run-2");

    const context = await loadCliSessionPromptContext(resumed);
    expect(context.preservedTurnsContext).toContain(
      JSON.stringify([
        {
          source: "subagent_announce",
          prompt: annotateInterSessionPromptText("Child result: CHILD_RESULT_7f3a9c", completion),
          reply: "reply-1",
        },
        { source: "subagent_announce", reply: "reply-3" },
      ]),
    );
    expect(context.preservedTurnsContext).toContain("Verify current and time-sensitive facts");
    expect(
      (await loadCliSessionPromptContext({ ...resumed, nativeSessionId: undefined }))
        .preservedTurnsContext,
    ).toBeUndefined();

    const withheld = await loadCliSessionPromptContext({
      ...resumed,
      rawTranscriptReseedReason: "auth-unknown",
    });
    expect(withheld.preservedTurnsContext).toBeUndefined();

    // The next ordinary reply means the bound session has now seen them.
    await turn(4, "What did the review find?");
    expect((await loadCliSessionPromptContext(resumed)).preservedTurnsContext).toBeUndefined();

    // The newest eight are carried; older ones stay in saved history.
    for (let index = 5; index < 14; index++) {
      await reply(index, `announce:v1:agent:main:subagent:child:run-${index}`);
    }
    await appendTranscriptMessage(target, {
      eventId: "long-completion",
      message: {
        ...buildAssistantMessage({
          model: { api: "cli", provider: "claude-cli", id: "test-model" },
          content: [{ type: "text", text: "```" + "x".repeat(3_000) }],
          stopReason: "stop",
          usage: buildUsageWithNoCost({}),
        }),
        __openclaw: { runId: "announce:long" },
      },
    });
    const newest = (await loadCliSessionPromptContext(resumed)).preservedTurnsContext;
    expect(newest).not.toContain('"reply":"reply-6"');
    for (let index = 7; index < 14; index++) {
      expect(newest).toContain(`"reply":"reply-${index}"`);
    }
    expect(newest).toContain("`\u200b``");
    expect(newest).toContain("…[truncated]");
    expect(newest).not.toContain("x".repeat(2_000));
  });
});
