import { readCodexAppServerThreadOwnershipState } from "./client-runtime.js";
import { isThreadBackgroundOnly } from "./client-thread-owner.js";
import type { CodexAppServerClient } from "./client.js";

/** Completed foreground work may leave cleanup custody with native background work. */
export function isCodexAppServerLiveThreadBackgroundOnly(
  client: CodexAppServerClient,
  threadId: string,
  configFingerprint?: string,
): boolean {
  return isThreadBackgroundOnly(
    readCodexAppServerThreadOwnershipState(client),
    threadId,
    configFingerprint,
  );
}
