import { describe, expect } from "vitest";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";
import { image, interpreted, peAgrees } from "../../../helpers/aot-agreement.js";

function statements(count: number): string {
  const lines: string[] = [];
  for (let at = 1; at <= count; at++) {
    lines.push(`a${at}: int[] = [${at}, 2, 3, 4]`);
    lines.push(`a${at}.unshift(100)`);
    lines.push(`print(a${at}, a${at}.length)`);
  }
  return lines.join("\n");
}

describe("an entry frame that spans several stack guard pages", () => {
  itRunsPe("runs a program whose frame reaches past one guard page", () => {
    peAgrees(statements(120));
  });

  itRunsPe("prints every line of a program whose frame skips guard pages", () => {
    const source = statements(520);
    const run = runPe(image(source));

    expect(run.status).toBe(0);
    expect(run.stdout.split("\n").length).toBe(521);
    expect(run.stdout).toBe(interpreted(source));
  });
});
