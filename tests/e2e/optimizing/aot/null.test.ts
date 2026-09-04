import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";
import { itNative } from "../../../helpers/c-executor.js";
import { cAgreement, image, interpreted, peAgrees } from "../../../helpers/aot-agreement.js";

const src = (...lines: string[]) => lines.join("\n");

const native = cAgreement();

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
    "tree = Branch(1)",
    "tree.left = Branch(2)",
    "tree.right = Branch(3)",
    "total = tree.v",
    "if tree.left != null:",
    "  total = total + tree.left.v",
    "if tree.right != null:",
    "  total = total + tree.right.v",
    "print(total)",
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
    itRunsPe(`${name} the way the interpreter does`, () => peAgrees(source));
    itNative(`${name} the same way through the C backend`, native.agrees(source));
  }
});

describe("AOT text that can be absent", () => {
  for (const [name, source] of ABSENT_TEXT_PROGRAMS) {
    itRunsPe(`${name} the way the interpreter does`, () => peAgrees(source));
    itNative(`${name} the same way through the C backend`, native.agrees(source));
  }
});

describe("AOT nullable references", () => {
  for (const [name, source] of PROGRAMS) {
    itRunsPe(`${name} the way the interpreter does`, () => peAgrees(source));
    itNative(`${name} the same way through the C backend`, native.agrees(source));
  }

  itRunsPe("stores the null pointer for a field that was never assigned", () => {
    const run = runPe(image(src(...NODE, "n = Node(1)", "print(n.next == null, n.v)")));

    expect(run.stdout).toBe("true 1\n");
  });

  it("refuses returning null where a number is declared", () => {
    expect(() =>
      declined(src("fn pick(f: bool) -> int:", "  if f:", "    return 1", "  return null")),
    ).toThrow("Type 'null' is not assignable to return type 'int'");
  });
  itRunsPe("short-circuits an optional field read to null", () => {
    peAgrees(
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
    peAgrees(
      src(
        "names: string[] = [\"ann\", \"bobby\"]",
        "print(names.find(n => n.length > 4))",
        "print(names.find(n => n.length > 9))",
      ),
    );
  });

  itRunsPe("answers null from a find over numbers", () => {
    peAgrees(src("xs: int[] = [1, 2, 3]", "print(xs.find(v => v > 1))", "print(xs.find(v => v > 9))"));
  });

  itRunsPe("adds to a nullable int once a default has filled it in", () => {
    peAgrees(
      src(
        "fn bump(x: int | null) -> int:",
        "  return (x ?? 0) + 1",
        "print(bump(5), bump(null))",
      ),
    );
  });

  itNative(
    "adds to a nullable int the same way through the C backend",
    native.agrees(
      src(
        "fn bump(x: int | null) -> int:",
        "  return (x ?? 0) + 1",
        "print(bump(5), bump(null))",
      ),
    ),
  );

  itRunsPe("compares a nullable float a default has filled in", () => {
    peAgrees(
      src(
        "fn over(x: float | null, limit: float) -> bool:",
        "  return (x ?? 0.0) > limit",
        "print(over(2.5, 1.0), over(null, 1.0))",
      ),
    );
  });
});

describe("AOT undefined", () => {
  const ANSWERS_UNSET = src(
    "fn at(n: int) -> int | undefined:",
    "  if n > 0:",
    "    return 7",
    "  return undefined",
  );

  itRunsPe("prints undefined where the interpreter prints undefined, not null", () => {
    peAgrees(src(ANSWERS_UNSET, "print(at(0))", "print(at(1))"));
  });

  itNative(
    "prints it the same way through the C backend",
    native.agrees(src(ANSWERS_UNSET, "print(at(0))", "print(at(1))")),
  );

  itRunsPe("keeps null printing as null alongside it", () => {
    peAgrees(
      src(
        ANSWERS_UNSET,
        "fn missing(n: int) -> int | null:",
        "  if n > 0:",
        "    return 7",
        "  return null",
        "print(at(0))",
        "print(missing(0))",
      ),
    );
  });

  itRunsPe("still answers true when undefined is compared against null", () => {
    peAgrees(src(ANSWERS_UNSET, "print(at(0) == null)", "print(at(1) == null)"));
  });

  itNative(
    "compares it against null the same way through the C backend",
    native.agrees(src(ANSWERS_UNSET, "print(at(0) == null)", "print(at(1) == null)")),
  );

  itRunsPe("does not read a real NaN as absent", () => {
    peAgrees(src("x = 0.0 / 0.0", "print(x)", "print(x == null)"));
  });

  itRunsPe("carries undefined through a declared field", () => {
    peAgrees(
      src(
        "class Slot:",
        "  public held: int | undefined = undefined",
        "s = Slot()",
        "print(s.held)",
        "s.held = 4",
        "print(s.held)",
      ),
    );
  });

  itRunsPe("carries undefined through an array element", () => {
    peAgrees(src("xs: (int | undefined)[] = [1, undefined]", "print(xs[0])", "print(xs[1])"));
  });

  const NAMES_OR_UNSET = src(
    "fn name(n: int) -> string | undefined:",
    "  if n > 0:",
    '    return "ada"',
    "  return undefined",
  );

  itRunsPe("spells undefined for a reference the declared type says is unset", () => {
    peAgrees(src(NAMES_OR_UNSET, "print(name(0))", "print(name(1))"));
  });

  itNative(
    "spells it the same way through the C backend",
    native.agrees(src(NAMES_OR_UNSET, "print(name(0))", "print(name(1))")),
  );

  itRunsPe("keeps a null-carrying reference printing as null beside it", () => {
    peAgrees(
      src(
        NAMES_OR_UNSET,
        "fn missing(n: int) -> string | null:",
        "  if n > 0:",
        '    return "ada"',
        "  return null",
        "print(name(0))",
        "print(missing(0))",
      ),
    );
  });

  itRunsPe("spells it for text an unset reference is joined into", () => {
    peAgrees(src(NAMES_OR_UNSET, 'print("v=" + name(0))', 'print("v=" + name(1))'));
  });

  itRunsPe("compares an unset reference against null the way the interpreter does", () => {
    peAgrees(src(NAMES_OR_UNSET, "print(name(0) == null)", "print(name(1) == null)"));
  });

  itRunsPe("carries an unset reference through a declared field", () => {
    peAgrees(
      src(
        "class Slot:",
        "  public held: string | undefined = undefined",
        "s = Slot()",
        "print(s.held)",
        's.held = "ada"',
        "print(s.held)",
      ),
    );
  });

  itRunsPe("passes an unset reference on to a declared parameter", () => {
    peAgrees(
      src(
        NAMES_OR_UNSET,
        "fn show(s: string | undefined) -> int:",
        "  print(s)",
        "  return 0",
        "show(name(0))",
        "show(name(1))",
      ),
    );
  });

  it("still refuses a reference whose type admits both absences, since they share one pointer", () => {
    expect(
      declined(
        src(
          "fn name(n: int) -> string | null | undefined:",
          "  if n > 1:",
          '    return "ada"',
          "  if n > 0:",
          "    return null",
          "  return undefined",
          "print(name(0))",
        ),
      ),
    ).toContain("cannot be told apart");
  });
});

describe("AOT arrays whose elements may be absent", () => {
  const holds = (element: string, absent: string, first: string) =>
    src(
      `xs: (${element})[] = [${first}, ${absent}]`,
      `fn at(i: int) -> ${element}:`,
      "  return xs[i]",
      "print(at(0))",
      "print(at(1))",
    );

  itRunsPe("reads back an int element that is absent", () => {
    peAgrees(holds("int | null", "null", "1"));
  });

  itRunsPe("reads back an int element that is unset", () => {
    peAgrees(holds("int | undefined", "undefined", "1"));
  });

  itRunsPe("reads back a float element that is absent", () => {
    peAgrees(holds("float | null", "null", "1.5"));
  });

  itNative(
    "reads it back the same way through the C backend",
    native.agrees(holds("int | null", "null", "1")),
  );

  itRunsPe("prints the whole array with the absent element spelled out", () => {
    peAgrees(src("xs: (int | null)[] = [1, null]", "print(xs)"));
  });

  itRunsPe("keeps a plain int array packed as ints beside a nullable one", () => {
    peAgrees(
      src(
        "plain: int[] = [7, 8]",
        "maybe: (int | null)[] = [1, null]",
        "fn a(i: int) -> int:",
        "  return plain[i]",
        "fn b(i: int) -> int | null:",
        "  return maybe[i]",
        "print(a(0))",
        "print(a(1))",
        "print(b(0))",
        "print(b(1))",
      ),
    );
  });

  it("still declines a text element, which has no room for an absence beside the characters", () => {
    expect(declined(holds("string | null", "null", '"a"'))).not.toBe("");
  });

  it("still declines an element whose type has no name once the absence joins it", () => {
    expect(declined(holds("bool | null", "null", "true"))).not.toBe("");
  });
});

describe("AOT printing an aggregate that may be absent", () => {
  const finds = (returns: string, absent: string) =>
    src(
      "class P:",
      "  public v: int = 1",
      `fn find(n: int) -> ${returns}:`,
      "  if n == 0:",
      "    return P()",
      `  return ${absent}`,
    );

  itRunsPe("spells null instead of reading fields off a pointer that holds none", () => {
    peAgrees(src(finds("P | null", "null"), "print(find(0))", "print(find(1))"));
  });

  itRunsPe("spells undefined for the flavour the declared type names", () => {
    peAgrees(src(finds("P | undefined", "undefined"), "print(find(0))", "print(find(1))"));
  });

  itNative(
    "spells it the same way through the C backend",
    native.agrees(src(finds("P | null", "null"), "print(find(0))", "print(find(1))")),
  );

  itRunsPe("still prints the fields when the reference holds an object", () => {
    peAgrees(src(finds("P | null", "null"), "print(find(0))"));
  });
});

describe("AOT null comparison soundness", () => {
  const KEEPS_A_LINK = src(
    "class Box:",
    "  public link: Box | null = null",
    "  public constructor(v: int):",
    "    this.v = v",
  );

  itRunsPe("answers a nullable parameter compared against null, beside a null store", () => {
    peAgrees(
      src(
        KEEPS_A_LINK,
        "fn probe(n: int | null, b: Box) -> bool:",
        "  b.link = null",
        "  return n == null",
        "b = Box(1)",
        "print(probe(null, b))",
        "print(probe(3, b))",
      ),
    );
  });

  itNative(
    "answers it the same way through the C backend",
    native.agrees(
      src(
        KEEPS_A_LINK,
        "fn probe(n: int | null, b: Box) -> bool:",
        "  b.link = null",
        "  return n == null",
        "b = Box(1)",
        "print(probe(null, b))",
        "print(probe(3, b))",
      ),
    ),
  );

  itRunsPe("branches on a nullable parameter beside a null store", () => {
    peAgrees(
      src(
        KEEPS_A_LINK,
        "fn probe(n: int | null, b: Box) -> int:",
        "  b.link = null",
        "  if n == null:",
        "    return -1",
        "  return n + 1",
        "b = Box(1)",
        "print(probe(null, b))",
        "print(probe(3, b))",
      ),
    );
  });
});
