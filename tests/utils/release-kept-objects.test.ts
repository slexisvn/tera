import { describe, expect, it } from "vitest";

let advanced = false;

describe("the event loop between two tests", () => {
  it("leaves a macrotask pending that no microtask can run", async () => {
    setImmediate(() => {
      advanced = true;
    });
    await Promise.resolve();
    expect(advanced).toBe(false);
  });

  it("has run that macrotask by the time the next test starts", () => {
    expect(advanced).toBe(true);
  });
});
