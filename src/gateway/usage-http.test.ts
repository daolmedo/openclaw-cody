import { describe, expect, it } from "vitest";
import { resolveUsagePeriodFromQuery } from "./usage-http.js";

describe("usage-http", () => {
  it("defaults to the current UTC month when no period query is provided", () => {
    const period = resolveUsagePeriodFromQuery(
      new URLSearchParams(),
      Date.UTC(2026, 6, 15, 12, 34, 56, 789),
    );

    expect(period).toMatchObject({
      startMs: Date.UTC(2026, 6, 1),
      endMs: Date.UTC(2026, 6, 15, 12, 34, 56, 789),
    });
  });

  it("parses date-only from/to as UTC day boundaries", () => {
    const period = resolveUsagePeriodFromQuery(
      new URLSearchParams("from=2026-06-27&to=2026-07-01"),
      Date.UTC(2026, 6, 15),
    );

    expect(period).toMatchObject({
      startMs: Date.UTC(2026, 5, 27),
      endMs: Date.UTC(2026, 6, 1, 23, 59, 59, 999),
    });
  });

  it("parses ISO timestamp from/to and aliases start/end", () => {
    const period = resolveUsagePeriodFromQuery(
      new URLSearchParams(
        "start=2026-06-27T10%3A30%3A00.000Z&end=2026-07-01T11%3A45%3A00.000Z",
      ),
      Date.UTC(2026, 6, 15),
    );

    expect(period).toMatchObject({
      startMs: Date.UTC(2026, 5, 27, 10, 30),
      endMs: Date.UTC(2026, 6, 1, 11, 45),
    });
  });

  it("rejects invalid and inverted ranges", () => {
    expect(resolveUsagePeriodFromQuery(new URLSearchParams("from=nope"))).toHaveProperty("error");
    expect(
      resolveUsagePeriodFromQuery(new URLSearchParams("from=2026-07-02&to=2026-07-01")),
    ).toHaveProperty("error");
  });
});
