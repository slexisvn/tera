import { describe, expect, it } from "vitest";
import type {
  ClassMemberSurface,
  ClassSurface,
} from "../../../src/frontend/modules/interface.js";
import {
  buildClassTable,
  callableOf,
  type ClassShape,
  type ClassTable,
  CLASS_HEADER_BYTES,
  constructorFieldDisagreement,
  descendsFrom,
  joinedLiteralShape,
  literalShapeSurface,
  sameFieldLayout,
  type LiteralField,
} from "../../../src/optimizing/metadata/class-table.js";
import {
  createTypeEnv,
  type TypeEnv,
} from "../../../src/frontend/checker/type-system.js";
import {
  builtinTypeEnv,
  latticeFromDeclaredType,
} from "../../../src/optimizing/types/declared.js";
import {
  aotScalarOf,
  SCALAR_FLOAT64,
  SCALAR_POINTER,
  SCALAR_STRING,
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

  const coneOf = (table: ReturnType<typeof buildClassTable>, name: string): string[] =>
    table.dispatchConeOf(name).map((shape) => shape.name).sort();

  it("includes every concrete subclass of an abstract base in its cone", () => {
    const table = buildClassTable(shapes);

    expect(coneOf(table, "Shape")).toEqual(["Circle", "Square", "Unit"]);
  });

  it("leaves the abstract base itself out of its own cone", () => {
    const table = buildClassTable(shapes);

    expect(coneOf(table, "Shape")).not.toContain("Shape");
  });

  it("covers an unrelated class that carries the same surface", () => {
    const table = buildClassTable([
      ...shapes,
      classSurface("Blob", [method("area", "() -> float", "Blob")]),
    ]);

    expect(coneOf(table, "Circle")).toEqual(["Blob", "Circle", "Square", "Unit"]);
  });

  it("leaves out a class that is missing part of the surface", () => {
    const table = buildClassTable([
      ...shapes,
      classSurface("Point", [field("x", "float", "Point")]),
    ]);

    expect(coneOf(table, "Circle")).not.toContain("Point");
  });

  it("leaves out a class whose member of the same name takes a different arity", () => {
    const table = buildClassTable([
      ...shapes,
      classSurface("Grid", [method("area", "(float) -> float", "Grid")]),
    ]);

    expect(coneOf(table, "Circle")).not.toContain("Grid");
  });

  it("leaves out a class that puts a shared field in a different slot", () => {
    const table = buildClassTable([
      classSurface("Header", [field("tag", "float", "Header"), field("size", "float", "Header")]),
      classSurface("Footer", [field("size", "float", "Footer"), field("tag", "float", "Footer")]),
    ]);

    expect(coneOf(table, "Header")).toEqual(["Header"]);
  });

  it("reports every implementation reachable from the receiver type", () => {
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

describe("nominal ancestry", () => {
  const shapes = [
    classSurface("Shape", [method("area", "() -> float", "Shape")]),
    classSurface("Circle", [method("area", "() -> float", "Circle")], "Shape"),
    classSurface("Square", [method("area", "() -> float", "Square")], "Shape"),
    classSurface("Unit", [], "Circle"),
    classSurface("Blob", [method("area", "() -> float", "Blob")]),
  ];

  const table = buildClassTable(shapes);
  const descends = (name: string, ancestor: string): boolean =>
    descendsFrom(table, table.shapeOf(name)!, ancestor);

  it("counts a class as descending from itself", () => {
    expect(descends("Circle", "Circle")).toBe(true);
  });

  it("follows a direct parent link", () => {
    expect(descends("Circle", "Shape")).toBe(true);
  });

  it("follows the whole chain of parents", () => {
    expect(descends("Unit", "Shape")).toBe(true);
  });

  it("does not run the chain backwards", () => {
    expect(descends("Shape", "Circle")).toBe(false);
  });

  it("separates siblings that share a base", () => {
    expect(descends("Circle", "Square")).toBe(false);
  });

  it("separates a class that merely carries the same surface", () => {
    expect(descends("Blob", "Shape")).toBe(false);
  });

  it("parts company with the structural dispatch cone", () => {
    expect(table.dispatchConeOf("Shape").map((shape) => shape.name)).toContain("Blob");
    expect(descends("Blob", "Shape")).toBe(false);
  });

  it("says nothing descends from a name the table never saw", () => {
    expect(descends("Circle", "Missing")).toBe(false);
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


const OUTERMOST = "Scene";

const NESTED_ALIASES: Readonly<Record<string, string>> = {
  Point: "{ x: int, y: int }",
  Box: "{ lo: Point, hi: Point }",
  [OUTERMOST]: "{ area: Box, marks: int[] }",
};

function aliasEnv(spellings: Readonly<Record<string, string>>): TypeEnv {
  const env = createTypeEnv();
  for (const [name, type] of Object.entries(spellings)) {
    env.aliases.set(name, { typeParams: [], type });
  }
  return env;
}

function mintedOutermostFirst(): ClassTable {
  const table = buildClassTable([], aliasEnv(NESTED_ALIASES));
  table.shapeIdOf(OUTERMOST);
  return table;
}

describe("structural shapes of declared object types", () => {
  it("gives a shape minted inside an outer one an id of its own", () => {
    const table = mintedOutermostFirst();

    const ids = Object.keys(NESTED_ALIASES).map((name) => table.shapeIdOf(name));

    expect(ids).not.toContain(null);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("answers each nested shape by the id it was minted under", () => {
    const table = mintedOutermostFirst();

    const held = Object.keys(NESTED_ALIASES).map((name) => [
      ...table.shapeById(table.shapeIdOf(name)!)!.fields.keys(),
    ]);

    expect(held).toEqual([["x", "y"], ["lo", "hi"], ["area", "marks"]]);
  });

  it("resolves an outer shape's field to the shape its inner alias names", () => {
    const table = mintedOutermostFirst();

    const area = table.shapeById(table.shapeIdOf(OUTERMOST)!)!.fields.get("area")!;

    expect([...table.shapeById(table.shapeIdOf(area.declaredType)!)!.fields.keys()]).toEqual([
      "lo",
      "hi",
    ]);
  });
});

describe("sameFieldLayout", () => {
  const literalOf = (classes: ClassTable, fields: readonly LiteralField[]): ClassShape =>
    classes.defineSynthetic(literalShapeSurface(fields));

  const declaredRow = (): ClassTable =>
    buildClassTable([
      {
        name: "Row",
        parent: null,
        abstract: false,
        members: [field("n", "int", "Row")],
        constructorParams: [],
        constructorParamNames: [],
      },
    ]);

  it("accepts a literal that lays its fields out like the class it stands in for", () => {
    const classes = declaredRow();
    const literal = literalOf(classes, [{ name: "n", declaredType: "int" }]);

    expect(sameFieldLayout(literal, classes.shapeOf("Row")!)).toBe(true);
  });

  it("refuses a literal that holds the same field as a different scalar", () => {
    const classes = declaredRow();
    const literal = literalOf(classes, [{ name: "n", declaredType: "float" }]);

    expect(sameFieldLayout(literal, classes.shapeOf("Row")!)).toBe(false);
  });

  it("refuses a shape that holds a field the other does not", () => {
    const classes = declaredRow();
    const literal = literalOf(classes, [
      { name: "n", declaredType: "int" },
      { name: "m", declaredType: "int" },
    ]);

    expect(sameFieldLayout(literal, classes.shapeOf("Row")!)).toBe(false);
  });
});

describe("joinedLiteralShape", () => {
  const literal = (classes: ClassTable, fields: readonly LiteralField[]): ClassShape =>
    classes.defineSynthetic(literalShapeSurface(fields));

  const held = (classes: ClassTable, fields: readonly (readonly LiteralField[])[]) =>
    joinedLiteralShape(
      classes,
      fields.map((entry) => literal(classes, entry)),
    );

  it("widens a field one literal holds as an int and another as a float", () => {
    const classes = buildClassTable([]);

    const joined = held(classes, [
      [{ name: "h", declaredType: "int" }],
      [{ name: "h", declaredType: "float" }],
    ]);

    expect(joined?.fields.get("h")?.declaredType).toBe("float");
  });

  it("stores the widened field as a float64 so either literal reads back", () => {
    const classes = buildClassTable([]);

    const joined = held(classes, [
      [{ name: "h", declaredType: "int" }],
      [{ name: "h", declaredType: "float" }],
    ]);

    expect(joined?.fields.get("h")?.scalar).toBe(SCALAR_FLOAT64);
  });

  it("leaves a field both literals declare the same way untouched", () => {
    const classes = buildClassTable([]);

    const joined = held(classes, [
      [{ name: "n", declaredType: "string" }, { name: "h", declaredType: "int" }],
      [{ name: "n", declaredType: "string" }, { name: "h", declaredType: "int" }],
    ]);

    expect([...joined!.fields.values()].map((entry) => entry.declaredType)).toEqual([
      "string",
      "int",
    ]);
  });

  it("widens only the numeric field of a record that also carries a string", () => {
    const classes = buildClassTable([]);

    const joined = held(classes, [
      [{ name: "n", declaredType: "string" }, { name: "h", declaredType: "float" }],
      [{ name: "n", declaredType: "string" }, { name: "h", declaredType: "int" }],
    ]);

    expect([...joined!.fields.values()].map((entry) => entry.declaredType)).toEqual([
      "string",
      "float",
    ]);
  });

  it("widens a field one literal holds as a string and another leaves empty", () => {
    const classes = buildClassTable([]);

    const joined = held(classes, [
      [{ name: "note", declaredType: "string" }],
      [{ name: "note", declaredType: "null" }],
    ]);

    expect(joined?.fields.get("note")?.declaredType).toBe("string | null");
  });

  it("keeps the widened text field a reference so it can hold nothing", () => {
    const classes = buildClassTable([]);

    const joined = held(classes, [
      [{ name: "note", declaredType: "string" }],
      [{ name: "note", declaredType: "null" }],
    ]);

    expect(joined?.fields.get("note")?.scalar).toBe(SCALAR_STRING);
  });

  it("names a shape holding an either-or field so the name reads back as that shape", () => {
    const classes = buildClassTable([]);

    const shape = literal(classes, [{ name: "note", declaredType: "string | null" }]);

    expect(latticeFromDeclaredType(shape.name, builtinTypeEnv(), classes).map).toBe(shape.id);
  });

  it("refuses a field one literal holds as a string and another as a number", () => {
    const classes = buildClassTable([]);

    expect(
      held(classes, [
        [{ name: "h", declaredType: "string" }],
        [{ name: "h", declaredType: "float" }],
      ]),
    ).toBeNull();
  });

  it("refuses literals that do not carry the same fields", () => {
    const classes = buildClassTable([]);

    expect(
      held(classes, [
        [{ name: "h", declaredType: "int" }],
        [{ name: "n", declaredType: "int" }],
      ]),
    ).toBeNull();
  });

  it("refuses literals that carry their shared fields in a different order", () => {
    const classes = buildClassTable([]);

    expect(
      held(classes, [
        [{ name: "n", declaredType: "float" }, { name: "h", declaredType: "float" }],
        [{ name: "h", declaredType: "float" }, { name: "n", declaredType: "float" }],
      ]),
    ).toBeNull();
  });

  it("refuses a named class, which is nominal rather than structural", () => {
    const classes = buildClassTable([classSurface("Row", [field("h", "float", "Row")])]);

    expect(joinedLiteralShape(classes, [classes.shapeOf("Row")!])).toBeNull();
  });
});
