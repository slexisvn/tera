import { describe, expect } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";
import { cBatch, itNative } from "../../../helpers/c-executor.js";
import { cText } from "../../../helpers/aot-agreement.js";

const src = (...lines: string[]) => lines.join("\n");

function interpreted(source: string, lines: readonly string[]): string {
  const stream: string[] = [];
  let index = 0;
  nodeEngine({
    typecheck: "off",
    output: (text) => stream.push(`${text}\n`),
    input: () => (index < lines.length ? lines[index++]! : null),
  }).run(`${source}\n`);
  return stream.join("");
}

function image(source: string): Uint8Array {
  const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
    backend: "x64-windows",
    format: "executable",
  });
  expect(program.skipped).toEqual([]);
  return program.files[0]!.contents as Uint8Array;
}

function agrees(source: string, lines: readonly string[] = []): void {
  const run = runPe(image(source), lines.map((line) => `${line}\r\n`).join(""));

  expect(run.status).toBe(0);
  expect(run.stdout).toBe(interpreted(source, lines));
}

const batch = cBatch();

function agreesInC(source: string): () => void {
  const run = batch.program(() => cText(source));
  return () => {
    expect(run().stdout).toBe(interpreted(source, []));
  };
}

const PROGRAMS: readonly (readonly [string, string])[] = [
  [
    "a recursive call whose result is appended",
    src(
      "fn suffix(n: int) -> string:",
      "  if n == 0:",
      '    return "x"',
      '  return suffix(n - 1) + ")"',
      "print(suffix(3))",
    ),
  ],
  [
    "a recursive call whose result is prepended",
    src(
      "fn prefix(n: int) -> string:",
      "  if n == 0:",
      '    return "x"',
      '  return "<" + prefix(n - 1)',
      "print(prefix(3))",
    ),
  ],
  [
    "a recursive call wrapped on both sides",
    src(
      "fn wrap(n: int) -> string:",
      "  if n == 0:",
      '    return "x"',
      '  return "(" + wrap(n - 1) + ")"',
      "print(wrap(3))",
    ),
  ],
  [
    "a recursive result used twice in one expression",
    src(
      "fn pad(n: int) -> string:",
      "  if n == 0:",
      '    return "x"',
      "  left = pad(n - 1)",
      '  return "a" + left + "b" + left',
      "print(pad(2))",
    ),
  ],
  [
    "a chain of decorators dispatched through an interface",
    src(
      "interface Notifier:",
      "  send(message: string) -> string",
      "class Plain implements Notifier:",
      "  public send(message: string) -> string:",
      "    return message",
      "class Email implements Notifier:",
      "  public next: Notifier",
      "  public constructor(next: Notifier):",
      "    this.next = next",
      "  public send(message: string) -> string:",
      '    return "email(" + this.next.send(message) + ")"',
      "class Sms implements Notifier:",
      "  public next: Notifier",
      "  public constructor(next: Notifier):",
      "    this.next = next",
      "  public send(message: string) -> string:",
      '    return "sms(" + this.next.send(message) + ")"',
      "chain = Sms(Email(Plain()))",
      'print(chain.send("done"))',
    ),
  ],
];

describe("strings built across a call that can re-enter", () => {
  for (const [name, source] of PROGRAMS) {
    itRunsPe(`builds ${name} the way the interpreter does`, () => agrees(source));
    itNative(`builds ${name} the same way through the C backend`, agreesInC(source));
  }

  itRunsPe("keeps each activation's line of input to itself", () => {
    agrees(
      src(
        "fn echo(n: int) -> int:",
        "  line = input()",
        "  if n > 0:",
        "    echo(n - 1)",
        "  print(line)",
        "  return 0",
        "echo(2)",
      ),
      ["one", "two", "three"],
    );
  });

  itNative("declines a loop-carried string held across a call that can re-enter", () => {
    const program = nodeEngine({ typecheck: "off" }).compileAot(
      src(
        "fn tag(n: int) -> string:",
        '  out = ""',
        "  for i of range(0, n):",
        '    out = out + "x"',
        "  if n > 0:",
        "    tag(n - 1)",
        "  return out",
        "",
      ),
    );

    expect(program.skipped.map((fn) => fn.reason).join("; ")).toContain(
      "tag keeps the string it built across a call to tag",
    );
  });
});
