import { describe } from "vitest";
import { itRunsPe } from "../../../helpers/pe-runner.js";
import { itNative } from "../../../helpers/c-executor.js";
import { cAgreement, peAgrees } from "../../../helpers/aot-agreement.js";

const src = (...lines: string[]) => lines.join("\n");

const native = cAgreement();

const MAKES = src("async fn make(key: string) -> string:", "  return `v${key}`");

const AUDITED = src(
  MAKES,
  "async fn safely(key: string) -> string:",
  '  audit = "start"',
  "  try:",
  "    held = await make(key)",
  '    audit = "committed"',
  "    return held",
  "  catch failure:",
  "    return `FAILED(${key}): ${failure}`",
  "  finally:",
  "    print(`  [audit ${key}] ${audit}`)",
);

const PROGRAMS: readonly (readonly [string, string])[] = [
  [
    "reads a string parameter again after another string was built",
    src(
      MAKES,
      "async fn safely(key: string) -> string:",
      "  try:",
      "    held = await make(key)",
      "    return held",
      "  catch failure:",
      "    return `FAILED(${key}): ${failure}`",
      "  finally:",
      "    print(`  [audit ${key}]`)",
      'answered = safely("alpha")',
    ),
  ],
  [
    "audits every order it placed",
    src(
      AUDITED,
      "async fn run() -> void:",
      '  keys: string[] = ["alpha", "beta", "gamma"]',
      "  for key of keys:",
      "    line = await safely(key)",
      "    print(line)",
      "run()",
    ),
  ],
  [
    "audits an order that threw as well",
    src(
      "async fn make(key: string) -> string:",
      '  if key == "missing":',
      "    throw `unknown key: ${key}`",
      "  return `v${key}`",
      "async fn safely(key: string) -> string:",
      "  try:",
      "    held = await make(key)",
      "    return held",
      "  catch failure:",
      "    return `FAILED(${key}): ${failure}`",
      "  finally:",
      "    print(`  [audit ${key}]`)",
      "async fn run() -> void:",
      '  keys: string[] = ["alpha", "missing", "gamma"]',
      "  for key of keys:",
      "    line = await safely(key)",
      "    print(line)",
      "run()",
    ),
  ],
];

describe("AOT strings a coroutine holds across a suspension", () => {
  for (const [name, source] of PROGRAMS) {
    itRunsPe(`${name} the way the interpreter does`, () => peAgrees(source));
  }

  itNative(
    "audits every order the same way through the C backend",
    native.agrees(
      src(
        AUDITED,
        "async fn run() -> void:",
        '  keys: string[] = ["alpha", "beta"]',
        "  for key of keys:",
        "    line = await safely(key)",
        "    print(line)",
        "run()",
      ),
    ),
  );
});
