import { describe, expect, it } from "vitest";
import {
  C_KEYWORDS,
  C_LIBRARY_NAMES,
  MODULE_INIT_TABLE,
  SYMBOL_PREFIX,
  moduleInitTable,
  sanitizeSymbol,
} from "../../../src/optimizing/target/symbols.js";

const RESERVED = new Set<string>([...C_KEYWORDS, ...C_LIBRARY_NAMES]);

const sanitize = (name: string, reserved: ReadonlySet<string> = RESERVED): string =>
  sanitizeSymbol(name, reserved);

describe("turning a Tera name into a C identifier", () => {
  it("leaves a name that is already an identifier alone", () => {
    expect(sanitize("total_bytes")).toBe("total_bytes");
  });

  it("replaces every character a C identifier cannot hold", () => {
    expect(sanitize("a-b.c d")).toBe("a_b_c_d");
    expect(sanitize("π+1")).toBe("__1");
  });

  it("prefixes a name that opens with a digit so it can start an identifier", () => {
    expect(sanitize("2fast")).toBe("fn_2fast");
  });

  it("prefixes an empty name, which cannot start an identifier on its own", () => {
    expect(sanitize("")).toBe("fn_");
  });

  it("leaves a name made only of illegal characters alone once they become underscores", () => {
    expect(sanitize("!!!")).toBe("___");
  });

  it("prefixes a reserved name so it cannot collide with the C surface", () => {
    expect(sanitize("int")).toBe(`${SYMBOL_PREFIX}int`);
    expect(sanitize("printf")).toBe(`${SYMBOL_PREFIX}printf`);
  });

  it("checks the reserved set after sanitizing, not before", () => {
    expect(sanitize("in t", new Set(["in_t"]))).toBe(`${SYMBOL_PREFIX}in_t`);
    expect(sanitize("in-t", new Set(["in-t"]))).toBe("in_t");
  });

  it("leaves a name reserved elsewhere alone when this caller did not reserve it", () => {
    expect(sanitize("int", new Set())).toBe("int");
  });

  it("never hands back a name the caller reserved", () => {
    for (const reserved of RESERVED) {
      expect(RESERVED.has(sanitize(reserved))).toBe(false);
    }
  });

  it("keeps names that only differ by an illegal character apart from nothing else", () => {
    expect(sanitize("a-b")).toBe(sanitize("a.b"));
  });

  it("produces something that can start a C declaration for every reserved name", () => {
    for (const reserved of RESERVED) {
      expect(sanitize(reserved)).toMatch(/^[A-Za-z_]\w*$/);
    }
  });
});

describe("the table that lists a program's module initializers", () => {
  it("emits nothing when no module needs initializing", () => {
    expect(moduleInitTable([])).toBe("");
  });

  it("names the table so the runtime can find it", () => {
    expect(moduleInitTable(["init_a"])).toContain(MODULE_INIT_TABLE);
  });

  it("lists every initializer in the order it was given", () => {
    const table = moduleInitTable(["init_a", "init_b", "init_c"]);
    const positions = ["init_a", "init_b", "init_c"].map((name) => table.indexOf(name));

    expect(positions.every((position) => position > -1)).toBe(true);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
  });

  it("terminates the table so a walker knows where to stop", () => {
    const lines = moduleInitTable(["init_a"]).split("\n");

    expect(lines.at(-2)).toBe("  0,");
    expect(lines.at(-1)).toBe("};");
  });

  it("declares the function pointer type the table holds", () => {
    expect(moduleInitTable(["init_a"])).toContain("int32_t (*tera_module_init_fn)(void)");
  });

  it("grows by exactly one line per initializer", () => {
    const one = moduleInitTable(["init_a"]).split("\n").length;
    const three = moduleInitTable(["init_a", "init_b", "init_c"]).split("\n").length;

    expect(three - one).toBe(2);
  });
});
