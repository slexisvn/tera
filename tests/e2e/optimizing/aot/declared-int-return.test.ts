import { describe, expect, it } from "vitest";
import { cText, interpreted, peAgrees } from "../../../helpers/aot-agreement.js";
import { itRunsPe } from "../../../helpers/pe-runner.js";

const src = (...lines: string[]) => lines.join("\n");

const OVERFLOWING = src(
  "fn big() -> int:",
  "  return 3000000000",
  "print(big())",
);

const OVERFLOWING_PRODUCT = src(
  "fn product(a: int, b: int) -> int:",
  "  return a * b",
  "print(product(100000, 100000))",
);

describe("a declared int return wraps the way the interpreter wraps it", () => {
  it("keeps the wrap when the call is inlined", () => {
    expect(cText(OVERFLOWING)).toContain("tera_to_i32");
  });

  it("answers the interpreter's value for an out-of-range constant", () => {
    expect(interpreted(OVERFLOWING)).toBe("-1294967296\n");
  });

  itRunsPe("agrees with the interpreter on an out-of-range constant", () =>
    peAgrees(OVERFLOWING),
  );

  itRunsPe("agrees with the interpreter on a product that leaves int32", () =>
    peAgrees(OVERFLOWING_PRODUCT),
  );

  itRunsPe("agrees with the interpreter when the result stays in range", () =>
    peAgrees(src("fn twice(n: int) -> int:", "  return n * 2", "print(twice(21))")),
  );
});
