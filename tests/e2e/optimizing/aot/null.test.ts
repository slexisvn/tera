import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";
import { cSource, itNative, runCProgram } from "../../../helpers/c-executor.js";

const src = (...lines: string[]) => lines.join("\n");

function interpreted(source: string): string {
  const stream: string[] = [];
  nodeEngine({ typecheck: "off", output: (text) => stream.push(`${text}\n`) }).run(
    `${source}\n`,
  );
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

function agrees(source: string): void {
  const run = runPe(image(source));

  expect(run.status).toBe(0);
  expect(run.stdout).toBe(interpreted(source));
}

function agreesInC(source: string): void {
  const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
    backend: "c",
    format: "assembly",
  });

  expect(program.skipped).toEqual([]);
  expect(runCProgram(cSource(program)).stdout).toBe(interpreted(source));
}

function declined(source: string): string {
  const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`);
  return program.skipped.map((entry) => entry.reason).join("; ");
}

const NODE = [
  "class Node:",
  "  public next: Node | null = null",
  "  public constructor(v: int):",
  "    this.v = v",
];

const PROGRAMS: readonly (readonly [string, string])[] = [
  ["starts a declared reference field as null", src(...NODE, "n = Node(1)", "print(n.next == null)")],
  ["reports a field holding an object as not null", src(
    ...NODE,
    "a = Node(1)",
    "a.next = Node(2)",
    "print(a.next == null)",
  )],
  ["compares the other way round", src(...NODE, "a = Node(1)", "print(a.next != null)")],
  ["reads through a field that holds an object", src(
    ...NODE,
    "a = Node(1)",
    "a.next = Node(2)",
    "print(a.next.v)",
  )],
  ["walks a linked list to its end", src(
    ...NODE,
    "a = Node(1)",
    "b = Node(2)",
    "c = Node(3)",
    "a.next = b",
    "b.next = c",
    "walker = a",
    "total = 0",
    "while walker != null:",
    "  total = total + walker.v",
    "  walker = walker.next",
    "print(total)",
  )],
  ["counts the links of a list", src(
    ...NODE,
    "a = Node(1)",
    "a.next = Node(2)",
    "walker = a",
    "links = 0",
    "while walker.next != null:",
    "  links = links + 1",
    "  walker = walker.next",
    "print(links)",
  )],
  ["returns null from a declared nullable return", src(
    ...NODE,
    "fn pick(f: bool) -> Node | null:",
    "  if f:",
    "    return Node(7)",
    "  return null",
    "print(pick(false) == null)",
  )],
  ["returns an object from a declared nullable return", src(
    ...NODE,
    "fn pick(f: bool) -> Node | null:",
    "  if f:",
    "    return Node(7)",
    "  return null",
    "print(pick(true) == null)",
  )],
  ["reads a field off a nullable return", src(
    ...NODE,
    "fn pick(f: bool) -> Node | null:",
    "  if f:",
    "    return Node(7)",
    "  return null",
    "found = pick(true)",
    "if found != null:",
    "  print(found.v)",
  )],
  ["takes null as an argument", src(
    ...NODE,
    "fn empty(n: Node | null) -> bool:",
    "  return n == null",
    "print(empty(null))",
  )],
  ["takes an object where null is allowed", src(
    ...NODE,
    "fn empty(n: Node | null) -> bool:",
    "  return n == null",
    "print(empty(Node(1)))",
  )],
  ["clears a field back to null", src(
    ...NODE,
    "a = Node(1)",
    "a.next = Node(2)",
    "a.next = null",
    "print(a.next == null)",
  )],
  ["compares two objects for identity", src(
    ...NODE,
    "a = Node(1)",
    "b = Node(2)",
    "print(a == b)",
  )],
  ["compares an object with itself", src(...NODE, "a = Node(1)", "b = a", "print(a == b)")],
  ["builds a two-level tree", src(
    "class Branch:",
    "  public left: Branch | null = null",
    "  public right: Branch | null = null",
    "  public constructor(v: int):",
    "    this.v = v",
    "root = Branch(1)",
    "root.left = Branch(2)",
    "root.right = Branch(3)",
    "sum = root.v",
    "if root.left != null:",
    "  sum = sum + root.left.v",
    "if root.right != null:",
    "  sum = sum + root.right.v",
    "print(sum)",
  )],
];

const FIND = [
  "fn find(xs: int[], t: int) -> int | null:",
  "  i: int = 0",
  "  while i < xs.length:",
  "    if xs[i] == t:",
  "      return xs[i]",
  "    i = i + 1",
  "  return null",
];

const BOX = [
  "class Box:",
  "  public v: int | null = null",
  "  public constructor(n: int):",
  "    this.n = n",
];

const ABSENT_NUMBER_PROGRAMS: readonly (readonly [string, string])[] = [
  ["answers the number it found", src(...FIND, "print(find([1, 2, 3], 2))")],
  ["answers null when it found nothing", src(...FIND, "print(find([1, 2, 3], 9))")],
  ["compares a miss with null", src(...FIND, "print(find([1, 2], 9) == null)")],
  ["compares a hit with null", src(...FIND, "print(find([1, 2], 2) == null)")],
  ["branches on a miss", src(
    ...FIND,
    "if find([1, 2], 9) == null:",
    '  print("missing")',
    "else:",
    '  print("found")',
  )],
  ["answers a fraction or null", src(
    "fn half(t: bool) -> float | null:",
    "  if t:",
    "    return 1.5",
    "  return null",
    "print(half(true), half(false))",
  )],
  ["starts a declared number field as null", src(...BOX, "print(Box(1).v)")],
  ["reports an unset number field as null", src(...BOX, "print(Box(1).v == null)")],
  ["reports an assigned number field as present", src(
    ...BOX,
    "b = Box(1)",
    "b.v = 5",
    "print(b.v, b.v == null)",
  )],
  ["keeps zero apart from absence", src(...BOX, "b = Box(1)", "b.v = 0", "print(b.v, b.v == null)")],
  ["keeps a number that is not a number apart from absence", src(
    'n = parse_int("abc")',
    "print(n, n == null)",
  )],
  ["starts an unannotated field as null", src(
    "class Empty:",
    "  public constructor():",
    "    this.v = null",
    "print(Empty().v == null)",
  )],
  ["prints an object holding an absent number", src(...BOX, "print(Box(2))")],
];

const USER = [
  "class User:",
  "  public nick: string | null = null",
  "  public constructor(name: string):",
  "    this.name = name",
];

const PICK = [
  "fn pick(f: bool) -> string | null:",
  "  if f:",
  '    return "yes"',
  "  return null",
];

const ABSENT_TEXT_PROGRAMS: readonly (readonly [string, string])[] = [
  ["starts a declared text field as null", src(...USER, 'print(User("ann").nick)')],
  ["reports an unset text field as null", src(...USER, 'print(User("ann").nick == null)')],
  ["reports an assigned text field as present", src(
    ...USER,
    'u = User("ann")',
    'u.nick = "a"',
    "print(u.nick, u.nick == null)",
  )],
  ["prints an object holding absent text", src(...USER, 'print(User("ann"))')],
  ["answers the text it has", src(...PICK, "print(pick(true))")],
  ["answers null when it has no text", src(...PICK, "print(pick(false))")],
  ["compares answered text with null", src(...PICK, "print(pick(false) == null, pick(true) == null)")],
];

describe("AOT numbers that can be absent", () => {
  for (const [name, source] of ABSENT_NUMBER_PROGRAMS) {
    itRunsPe(`${name} the way the interpreter does`, () => agrees(source));
    itNative(`${name} the same way through the C backend`, () => agreesInC(source));
  }
});

describe("AOT text that can be absent", () => {
  for (const [name, source] of ABSENT_TEXT_PROGRAMS) {
    itRunsPe(`${name} the way the interpreter does`, () => agrees(source));
    itNative(`${name} the same way through the C backend`, () => agreesInC(source));
  }
});

describe("AOT nullable references", () => {
  for (const [name, source] of PROGRAMS) {
    itRunsPe(`${name} the way the interpreter does`, () => agrees(source));
    itNative(`${name} the same way through the C backend`, () => agreesInC(source));
  }

  itRunsPe("stores the null pointer for a field that was never assigned", () => {
    const run = runPe(image(src(...NODE, "n = Node(1)", "print(n.next == null, n.v)")));

    expect(run.stdout).toBe("true 1\n");
  });

  it("declines returning null where a number is declared", () => {
    expect(
      declined(src("fn pick(f: bool) -> int:", "  if f:", "    return 1", "  return null")),
    ).toContain("answers null where its return type has no null");
  });
  itRunsPe("short-circuits an optional field read to null", () => {
    agrees(
      src(
        "class P:",
        "  public constructor(name: string):",
        "    this.name = name",
        "fn label(p: P | null) -> string:",
        "  return p?.name ?? \"none\"",
        "print(label(null))",
        "print(label(P(\"ann\")))",
      ),
    );
  });

  itRunsPe("answers null from a find that matches nothing", () => {
    agrees(
      src(
        "names: string[] = [\"ann\", \"bobby\"]",
        "print(names.find(n => n.length > 4))",
        "print(names.find(n => n.length > 9))",
      ),
    );
  });

  itRunsPe("answers null from a find over numbers", () => {
    agrees(src("xs: int[] = [1, 2, 3]", "print(xs.find(v => v > 1))", "print(xs.find(v => v > 9))"));
  });
});
