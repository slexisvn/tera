import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { itRunsPe } from "../../../helpers/pe-runner.js";
import { itNative } from "../../../helpers/c-executor.js";
import { cAgreement, peAgrees } from "../../../helpers/aot-agreement.js";

const src = (...lines: string[]) => lines.join("\n");

const native = cAgreement();

function declined(source: string): string {
  const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`);
  return program.skipped.map((entry) => entry.reason).join("; ");
}

const TABLE = 'table = { "A1": 5, "B2": 0, "C3": 12 }';

const GUARDED_LOOKUP = src(
  TABLE,
  "fn stock(sku: string) -> int:",
  "  if not (sku in table):",
  "    return -1",
  "  return table[sku]",
  'print(stock("A1"))',
  'print(stock("B2"))',
  'print(stock("C3"))',
  'print(stock("ZZ"))',
);

const LOOKUPS: readonly (readonly [string, string])[] = [
  ["answers a key the record carries", GUARDED_LOOKUP],
  [
    "answers whether a runtime key is carried",
    src(
      TABLE,
      "fn has(sku: string) -> bool:",
      "  return sku in table",
      'print(has("A1"))',
      'print(has("C3"))',
      'print(has("ZZ"))',
    ),
  ],
  [
    "answers undefined for a key the record does not carry",
    src(TABLE, "fn show(sku: string):", "  print(table[sku])", 'show("B2")', 'show("ZZ")'),
  ],
  [
    "answers a nullable return without a guard",
    src(
      TABLE,
      "fn stock(sku: string) -> int | undefined:",
      "  return table[sku]",
      'print(stock("C3"))',
      'print(stock("ZZ"))',
    ),
  ],
  [
    "looks keys up while walking an array",
    src(
      TABLE,
      'skus: string[] = ["A1", "ZZ", "C3"]',
      "for sku of skus:",
      "  if sku in table:",
      "    print(table[sku])",
      "  else:",
      '    print("unknown")',
    ),
  ],
  [
    "looks up a record of floats",
    src(
      'rates = { "usd": 1.0, "eur": 1.08, "gbp": 1.27 }',
      "fn rate(code: string) -> float:",
      "  if not (code in rates):",
      "    return 0.0",
      "  return rates[code]",
      'print(rate("eur"))',
      'print(rate("gbp"))',
      'print(rate("jpy"))',
    ),
  ],
  [
    "answers a constant key the record does not carry",
    src(TABLE, 'print(table["ZZ"])'),
  ],
];

describe("AOT record used as a lookup table", () => {
  for (const [name, source] of LOOKUPS) {
    itRunsPe(`${name} the way the interpreter does`, () => peAgrees(source));
  }

  itNative("answers a guarded lookup through the C backend", native.agrees(GUARDED_LOOKUP));

  itNative(
    "answers membership through the C backend",
    native.agrees(
      src(TABLE, "fn has(sku: string) -> bool:", "  return sku in table", 'print(has("A1"))'),
    ),
  );

  itRunsPe("looks up with a key an array handed back", () => {
    peAgrees(
      src(
        'rates = { "usd": 1.5, "eur": 1.08 }',
        'codes: string[] = ["usd", "eur", "jpy"]',
        "seen: float[] = []",
        "while codes.length > 0:",
        "  code = codes.shift()",
        "  if code in rates:",
        "    seen.push(rates[code])",
        "print(seen.length)",
        "print(seen[0])",
        "print(seen[1])",
      ),
    );
  });

  it("refuses an unguarded lookup answered as a whole number", () => {
    expect(
      declined(
        src(
          TABLE,
          "fn stock(sku: string) -> int:",
          "  return table[sku]",
          'print(stock("ZZ"))',
        ),
      ),
    ).toContain("no way to say absent");
  });

  it("leaves a record whose fields do not share one scalar alone", () => {
    expect(
      declined(
        src(
          'mixed = { "name": "ada", "age": 36 }',
          "fn look(k: string):",
          "  print(mixed[k])",
          'look("age")',
        ),
      ),
    ).toContain("GenericGetIndex");
  });
});
