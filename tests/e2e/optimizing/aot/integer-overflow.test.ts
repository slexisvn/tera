import { describe, expect, it } from "vitest";
import { cText, peAgrees } from "../../../helpers/aot-agreement.js";
import { itRunsPe } from "../../../helpers/pe-runner.js";

const src = (...lines: string[]) => lines.join("\n");

const SUMS_PAST_INT32 = src(
  "t = 0",
  "for i of range(0, 100000):",
  "  t = t + i",
  "print(t)",
);

const COUNTS_IN_INT32 = src(
  "fn total(n: int) -> int:",
  "  acc: int = 0",
  "  i: int = 0",
  "  while i < n:",
  "    acc = acc + i * 3 - 1",
  "    i = i + 1",
  "  return acc",
  "print(total(4))",
);

describe("arithmetic that leaves int32 answers what the interpreter answers", () => {
  itRunsPe("sums a loop past int32", () => peAgrees(SUMS_PAST_INT32));

  itRunsPe("sums a loop past int32 into a float", () =>
    peAgrees(src("t: float = 0.0", "for i of range(0, 100000):", "  t = t + i", "print(t)")),
  );

  itRunsPe("sums a loop past int32 into an int", () =>
    peAgrees(src("t: int = 0", "for i of range(0, 100000):", "  t = t + i", "print(t)")),
  );

  itRunsPe("multiplies past int32", () =>
    peAgrees(src("a = 100000", "b = 100000", "print(a * b)")),
  );

  itRunsPe("multiplies declared ints past int32", () =>
    peAgrees(
      src("fn product(a: int, b: int) -> float:", "  return a * b", "print(product(100000, 100000))"),
    ),
  );

  itRunsPe("agrees on recursion that takes an int", () =>
    peAgrees(
      src("fn fib(n: int) -> int:", "  if n < 2:", "    return n", "  return fib(n - 1) + fib(n - 2)", "print(fib(20))"),
    ),
  );

  it("still counts a bounded loop in int32", () => {
    const text = cText(COUNTS_IN_INT32);
    const body = text.slice(text.indexOf("int32_t total("));

    expect(body.slice(0, body.indexOf("\n}"))).toContain("tera_i32_add");
    expect(body.slice(0, body.indexOf("\n}"))).not.toContain("double");
  });

  itRunsPe("agrees on the bounded loop it counts in int32", () => peAgrees(COUNTS_IN_INT32));
});
