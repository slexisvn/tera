import { describe, expect, it } from "vitest";
import { teraHoverDocFor } from "../src/extensions/tera-language";
import { languageData } from "../src/language-data";

function hoverMember(source: string) {
  const dot = source.indexOf(".");
  const token = /^[\w$]+/.exec(source.slice(dot + 1))![0];
  return teraHoverDocFor(source, token, dot + 1);
}

function hoverToken(source: string, token: string) {
  return teraHoverDocFor(source, token, source.indexOf(token));
}

const sharedNames = (() => {
  const owners = new Map<string, string[]>();
  for (const [typeName, methods] of Object.entries(languageData.pseudoTypes)) {
    for (const method of methods) owners.set(method.name, [...(owners.get(method.name) ?? []), typeName]);
  }
  return [...owners].filter(([, list]) => list.length > 1);
})();

describe("the hover card for a member access", () => {
  it("names the type written in front of the dot, not another that shares the name", () => {
    expect(hoverMember("Math.sqrt(2)")?.title).toBe("Math.sqrt");
    expect(hoverMember("JSON.stringify(x)")?.title).toBe("JSON.stringify");
  });

  it("refuses to pick an owner when the receiver is a variable and the name is shared", () => {
    const doc = hoverMember("xs.slice(1)");

    expect(doc?.title).toBe("slice");
    expect(doc?.description).toMatch(/^Defined on .*Array/);
    expect(doc?.description).not.toMatch(/^Defined on [A-Za-z]+\.$/);
  });

  it("still answers with the one type that has it when only one does", () => {
    const [name, owners] = Object.entries(languageData.pseudoTypes)
      .flatMap(([typeName, methods]) => methods.map((method) => [method.name, typeName] as const))
      .find(([methodName]) => !sharedNames.some(([shared]) => shared === methodName))!;
    const doc = hoverMember(`value.${name}()`);

    expect(doc?.title).toBe(`${owners}.${name}`);
  });

  it("never claims an owner it was not given, for any shared name", () => {
    for (const [name, owners] of sharedNames) {
      const doc = hoverMember(`value.${name}`);

      expect(doc).not.toBeNull();
      expect(doc!.title).toBe(name);
      for (const owner of owners) expect(doc!.description).toContain(owner);
    }
  });

  it("keeps chart on its own shelf, since chart is a value and not a type", () => {
    expect(hoverMember("chart.line(rows)")?.title).toBe("chart.line");
    expect(hoverMember("chart.line(rows)")?.kind).toBe("chart");
  });

  it("answers nothing for a member no type defines", () => {
    expect(hoverMember("value.no_such_member()")).toBeNull();
  });
});

describe("the hover card elsewhere in the line", () => {
  it("says nothing inside the text of a string, whatever the word spells", () => {
    expect(hoverToken('label = "return the length"', "length")).toBeNull();
    expect(hoverToken('label = "return the length"', "return")).toBeNull();
  });

  it("describes a builtin by the name that was hovered", () => {
    const builtin = languageData.builtins.find((item) => item.name === "print") ?? languageData.builtins[0]!;
    const doc = hoverToken(`${builtin.name}(1)`, builtin.name);

    expect(doc?.title).toBe(builtin.name);
  });

  it("carries a diagnostic that covers the hovered token", () => {
    const source = "x = boom\n";
    const doc = teraHoverDocFor(source, "boom", 4, {
      diagnostics: [{ from: 4, to: 8, severity: "error", message: "no such name" }],
    });

    expect(doc?.diagnostics?.map((item) => item.message)).toEqual(["no such name"]);
  });

  it("leaves out a diagnostic that covers a different part of the line", () => {
    const source = "x = boom\n";
    const doc = teraHoverDocFor(source, "boom", 4, {
      diagnostics: [{ from: 0, to: 1, severity: "error", message: "elsewhere" }],
    });

    expect(doc?.diagnostics ?? []).toEqual([]);
  });
});
