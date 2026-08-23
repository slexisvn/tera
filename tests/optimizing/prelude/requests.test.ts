import { describe, expect, it } from "vitest";
import { parse } from "../../../src/frontend/parser/language.js";
import { collectionRequestsIn } from "../../../src/optimizing/prelude/requests.js";
import { everyCollection } from "../../../src/optimizing/prelude/collections.js";

const src = (...lines: string[]) => `${lines.join("\n")}\n`;

const requestsFor = (source: string) => collectionRequestsIn(parse(source));

const shapesOf = (source: string) =>
  requestsFor(source)
    .map((request) => `${request.kind}<${request.key}${request.value === null ? "" : `,${request.value}`}>`)
    .sort();

const POINT = [
  "class Point:",
  "  public constructor(x: int):",
  "    this.x = x",
];

describe("collectionRequestsIn", () => {
  it("asks for every collection when the program mentions none", () => {
    expect(requestsFor(src("print(1)"))).toEqual(everyCollection());
  });

  it("asks only for the set a program builds", () => {
    expect(shapesOf(src("s = Set()", 's.add("a")'))).toEqual(["Set<string>"]);
  });

  it("keeps the key kind the literal spells", () => {
    expect(shapesOf(src("s = Set()", "s.add(1)"))).toEqual(["Set<int>"]);
    expect(shapesOf(src("s = Set()", "s.add(1.5)"))).toEqual(["Set<float>"]);
  });

  it("names the class a constructor call stores", () => {
    expect(shapesOf(src(...POINT, "m = Map()", 'm.set("a", Point(1))'))).toEqual([
      "Map<string,Point>",
    ]);
  });

  it("follows a variable that holds a constructed class", () => {
    expect(
      shapesOf(src(...POINT, "p = Point(1)", "m = Map()", 'm.set("a", p)')),
    ).toEqual(["Map<string,Point>"]);
  });

  it("follows a declaration that names the class", () => {
    expect(
      shapesOf(src(...POINT, "q: Point = Point(1)", "m = Map()", 'm.set("a", q)')),
    ).toEqual(["Map<string,Point>"]);
  });

  it("follows a parameter that declares the class", () => {
    expect(
      shapesOf(
        src(
          ...POINT,
          "fn keep(m: Map, p: Point) -> int:",
          '  m.set("a", p)',
          "  return 1",
        ),
      ),
    ).toEqual(["Map<string,Point>"]);
  });

  it("falls back to the primitive values when it cannot name what is stored", () => {
    expect(shapesOf(src("m = Map()", "fn other() -> int:", "  return 1", 'm.set("a", other())'))).toEqual([
      "Map<string,float>",
      "Map<string,int>",
      "Map<string,string>",
    ]);
  });

  it("asks for every key kind when the key is not a literal", () => {
    const keys = requestsFor(src("m = Map()", "k = 1", "m.set(k, 2)")).map((request) => request.key);

    expect([...new Set(keys)].sort()).toEqual(["float", "int", "string"]);
  });
});
