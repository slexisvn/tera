import { describe, expect, it } from "vitest";
import type {
  ClassMemberSurface,
  ClassSurface,
} from "../../../src/frontend/modules/interface.js";
import {
  buildClassTable,
  callableOf,
  CLASS_HEADER_BYTES,
  constructorFieldDisagreement,
} from "../../../src/optimizing/metadata/class-table.js";
import {
  builtinTypeEnv,
  latticeFromDeclaredType,
} from "../../../src/optimizing/types/declared.js";
import {
  aotScalarOf,
  SCALAR_FLOAT64,
  SCALAR_POINTER,
  SCALAR_TEXT,
  TEXT_STORAGE_BYTES,
} from "../../../src/optimizing/types/scalar.js";

function field(name: string, declaredType: string, owner: string): ClassMemberSurface {
  return {
    name,
    declaredType,
    member: "field",
    owner,
    abstract: false,
    visibility: "public",
    static: false,
  };
}

function method(
  name: string,
  declaredType: string,
  owner: string,
  abstract = false,
): ClassMemberSurface {
  return {
    name,
    declaredType,
    member: "method",
    owner,
    abstract,
    visibility: "public",
    static: false,
  };
}

function classSurface(
  name: string,
  members: readonly ClassMemberSurface[],
  parent: string | null = null,
  abstract = false,
): ClassSurface {
  return {
    name,
    parent,
    abstract,
    members,
    constructorParams: [],
    constructorParamNames: [],
  };
}

const POINT = classSurface("Point", [
  field("x", "int", "Point"),
  field("y", "int", "Point"),
]);

describe("class layout", () => {
  it("places the first field directly after the object header", () => {
    const table = buildClassTable([POINT]);

    expect(table.shapeOf("Point")!.fields.get("x")!.offset).toBe(CLASS_HEADER_BYTES);
  });

  it("packs an int field at its own width rather than the pointer width", () => {
    const table = buildClassTable([POINT]);
    const shape = table.shapeOf("Point")!;

    expect(shape.fields.get("y")!.offset).toBe(CLASS_HEADER_BYTES + 4);
  });

  it("aligns a float field that follows an int field", () => {
    const table = buildClassTable([
      classSurface("Mixed", [field("flag", "int", "Mixed"), field("ratio", "float", "Mixed")]),
    ]);
    const shape = table.shapeOf("Mixed")!;

    expect(shape.fields.get("flag")!.offset).toBe(CLASS_HEADER_BYTES);
    expect(shape.fields.get("ratio")!.offset).toBe(CLASS_HEADER_BYTES + 8);
  });

  it("gives a declared string field storage of its own rather than a pointer", () => {
    const table = buildClassTable([
      classSurface("Tag", [field("name", "string", "Tag"), field("count", "int", "Tag")]),
    ]);
    const shape = table.shapeOf("Tag")!;

    expect(shape.fields.get("name")!.scalar).toBe(SCALAR_TEXT);
    expect(shape.fields.get("count")!.offset).toBe(CLASS_HEADER_BYTES + TEXT_STORAGE_BYTES);
  });

  it("aligns text storage on the pointer width instead of its full size", () => {
    const table = buildClassTable([
      classSurface("Tag", [field("count", "int", "Tag"), field("name", "string", "Tag")]),
    ]);
    const shape = table.shapeOf("Tag")!;

    expect(shape.fields.get("name")!.offset).toBe(CLASS_HEADER_BYTES + 8);
  });

  it("rounds the instance size up to the object alignment", () => {
    const table = buildClassTable([classSurface("One", [field("only", "int", "One")])]);

    expect(table.shapeOf("One")!.size).toBe(CLASS_HEADER_BYTES + 8);
  });

  it("gives an inherited field the exact offset it has in the parent", () => {
    const table = buildClassTable([
      POINT,
      classSurface("Point3", [field("z", "int", "Point3")], "Point"),
    ]);
    const parent = table.shapeOf("Point")!;
    const child = table.shapeOf("Point3")!;

    expect(child.fields.get("x")!.offset).toBe(parent.fields.get("x")!.offset);
    expect(child.fields.get("y")!.offset).toBe(parent.fields.get("y")!.offset);
  });

  it("starts a subclass's own fields after the whole parent instance", () => {
    const table = buildClassTable([
      POINT,
      classSurface("Point3", [field("z", "int", "Point3")], "Point"),
    ]);

    expect(table.shapeOf("Point3")!.fields.get("z")!.offset).toBe(table.shapeOf("Point")!.size);
  });

  it("keeps the prefix property across a three-level chain declared out of order", () => {
    const table = buildClassTable([
      classSurface("C", [field("c", "int", "C")], "B"),
      classSurface("A", [field("a", "int", "A")]),
      classSurface("B", [field("b", "int", "B")], "A"),
    ]);
    const a = table.shapeOf("A")!;
    const c = table.shapeOf("C")!;

    expect(c.fields.get("a")!.offset).toBe(a.fields.get("a")!.offset);
    expect(c.fields.get("b")!.offset).toBe(table.shapeOf("B")!.fields.get("b")!.offset);
  });

  it("records a field whose declared type is not an AOT scalar instead of laying it out", () => {
    const table = buildClassTable([
      classSurface("Holder", [field("payload", "Unknown", "Holder")]),
    ]);
    const shape = table.shapeOf("Holder")!;

    expect(shape.unsupported).toEqual(["payload"]);
    expect(shape.fields.has("payload")).toBe(false);
  });

  it("lays out a field whose type is another class as a pointer", () => {
    const table = buildClassTable([
      POINT,
      classSurface("Segment", [field("start", "Point", "Segment")]),
    ]);
    const start = table.shapeOf("Segment")!.fields.get("start")!;

    expect(start.scalar).toBe(SCALAR_POINTER);
    expect(table.shapeOf("Segment")!.unsupported).toEqual([]);
  });
});

describe("class hierarchy analysis", () => {
  const shapes = [
    classSurface("Shape", [method("area", "() -> float", "Shape", true)], null, true),
    classSurface("Circle", [method("area", "() -> float", "Circle")], "Shape"),
    classSurface("Square", [method("area", "() -> float", "Square")], "Shape"),
    classSurface("Unit", [], "Circle"),
  ];

  it("includes the class itself and every transitive subclass in its cone", () => {
    const table = buildClassTable(shapes);

    expect(table.subclassesOf("Shape").map((shape) => shape.name).sort()).toEqual([
      "Circle",
      "Shape",
      "Square",
      "Unit",
    ]);
  });

  it("excludes siblings from a subclass cone", () => {
    const table = buildClassTable(shapes);

    expect(table.subclassesOf("Circle").map((shape) => shape.name).sort()).toEqual([
      "Circle",
      "Unit",
    ]);
  });

  it("resolves a call on a leaf class to exactly one implementation", () => {
    const table = buildClassTable(shapes);

    expect(table.implementationsOf("Square", "area", "method").map((target) => target.symbol)).toEqual([
      "Square.area",
    ]);
  });

  it("reports every overriding implementation reachable from the receiver type", () => {
    const table = buildClassTable(shapes);

    expect(table.implementationsOf("Shape", "area", "method").map((target) => target.symbol).sort()).toEqual([
      "Circle.area",
      "Square.area",
    ]);
  });

  it("attributes an inherited method to the class that defines it", () => {
    const table = buildClassTable(shapes);

    expect(callableOf(table.shapeOf("Unit")!.callables, "method", "area")!.owner).toBe("Circle");
  });

  it("omits an abstract declaration from the implementations of its own cone", () => {
    const table = buildClassTable(shapes);

    expect(
      table.implementationsOf("Shape", "area", "method").map((target) => target.owner),
    ).not.toContain("Shape");
  });
});

describe("constructor cross-check", () => {
  it("accepts a bytecode field list that matches the declared shape", () => {
    const table = buildClassTable([POINT]);

    expect(constructorFieldDisagreement(table.shapeOf("Point")!, ["y", "x"])).toBeNull();
  });

  it("names a field the constructor assigns but the shape never saw", () => {
    const table = buildClassTable([POINT]);
    const message = constructorFieldDisagreement(table.shapeOf("Point")!, ["x", "y", "z"]);

    expect(message).toContain("Point");
    expect(message).toContain("z");
  });

  it("names a field the shape declares that the constructor never assigns", () => {
    const table = buildClassTable([POINT]);
    const message = constructorFieldDisagreement(table.shapeOf("Point")!, ["x"]);

    expect(message).toContain("y");
  });

  it("counts a field with an unsupported type as declared rather than missing", () => {
    const table = buildClassTable([
      classSurface("Holder", [field("payload", "Unknown", "Holder")]),
    ]);

    expect(constructorFieldDisagreement(table.shapeOf("Holder")!, ["payload"])).toBeNull();
  });

  it("compares only the class's own fields, not inherited ones", () => {
    const table = buildClassTable([
      POINT,
      classSurface("Point3", [field("z", "int", "Point3")], "Point"),
    ]);

    expect(constructorFieldDisagreement(table.shapeOf("Point3")!, ["z"])).toBeNull();
  });
});

describe("nominal type resolution", () => {
  it("resolves a class name to a pointer rather than a float", () => {
    const table = buildClassTable([POINT]);
    const type = latticeFromDeclaredType("Point", builtinTypeEnv(), table);

    expect(aotScalarOf(type)).toBe(SCALAR_POINTER);
  });

  it("leaves an unresolvable type name widened to any for non-field positions", () => {
    const table = buildClassTable([POINT]);
    const type = latticeFromDeclaredType("Nowhere", builtinTypeEnv(), table);

    expect(aotScalarOf(type)).toBe(SCALAR_FLOAT64);
  });

  it("does not leak one compilation's classes into a table that lacks them", () => {
    buildClassTable([POINT]);
    const empty = buildClassTable([]);

    expect(aotScalarOf(latticeFromDeclaredType("Point", builtinTypeEnv(), empty))).toBe(
      SCALAR_FLOAT64,
    );
  });
});
