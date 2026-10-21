import { describe, expect, it } from "vitest";
import { buildCliSessionDriftNote } from "../cli-session.js";
import { prependCliSessionResumeUserContext } from "./prompt-context.js";

const preservedTurnsContext = "Recorded completion: CHILD_RESULT; reply: Relayed.";
const currentInboundContext = { text: "Conversation info" };

describe("CLI resume user context", () => {
  it("puts the drift note before exchanges the resumed session missed", () => {
    expect(
      prependCliSessionResumeUserContext(
        currentInboundContext,
        {
          mode: "reuse-with-drift",
          sessionId: "native-bound",
          drift: { reasons: ["prompt-tools"] },
        },
        preservedTurnsContext,
      ),
    ).toEqual({
      text: [
        buildCliSessionDriftNote(["prompt-tools"]),
        preservedTurnsContext,
        "Conversation info",
      ].join("\n\n"),
    });
    expect(
      prependCliSessionResumeUserContext(
        undefined,
        { mode: "reuse", sessionId: "native-bound" },
        preservedTurnsContext,
      ),
    ).toEqual({ text: preservedTurnsContext });
  });

  it("leaves a fresh session to recover from saved history", () => {
    expect(
      prependCliSessionResumeUserContext(
        currentInboundContext,
        { mode: "invalidate", invalidatedReason: "mcp" },
        preservedTurnsContext,
      ),
    ).toBe(currentInboundContext);
  });
});
