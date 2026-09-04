import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irCallBuiltin,
  irConstant,
  irGenericAdd,
  irLoadField,
  irReturn,
  irStoreField,
  resetIRNodeIds,
  type CFGInstruction,
} from "../../../src/optimizing/ir/index.js";
import {
  countsCharacters,
  isAsciiRepresentable,
  summarizeWideText,
  utf8ByteLength,
  wideValuesIn,
  BYTEWISE_PROP,
} from "../../../src/optimizing/analyses/wide-text.js";
import { INPUT_BUILTIN } from "../../../src/optimizing/metadata/builtin-methods.js";

beforeEach(() => resetIRNodeIds());

const EVERYTHING_IS_TEXT = () => true;

function graphHolding(
  build: (graph: CFGFunction, add: (node: CFGInstruction) => CFGInstruction) => void,
): CFGFunction {
  const graph = new CFGFunction("holds");
  const block = graph.addBlock();
  build(graph, (node) => {
    block.addNode(node);
    return node;
  });
  graph.rebuildUses();
  return graph;
}

describe("telling text that is only ASCII from text that is not", () => {
  it("counts plain ASCII as representable", () => {
    expect(isAsciiRepresentable("hello, world")).toBe(true);
  });

  it("counts Vietnamese text as not representable", () => {
    expect(isAsciiRepresentable("Xin chào")).toBe(false);
  });

  it("counts an emoji as not representable", () => {
    expect(isAsciiRepresentable("done ✅")).toBe(false);
  });

  it("measures text by the bytes UTF-8 takes rather than the code units", () => {
    expect(utf8ByteLength("abc")).toBe(3);
    expect(utf8ByteLength("é")).toBe(2);
    expect(utf8ByteLength("ộ")).toBe(3);
    expect(utf8ByteLength("✅")).toBe(3);
    expect("Huế".length).toBe(3);
    expect(utf8ByteLength("Huế")).toBe(5);
  });
});

describe("the values that may hold text outside ASCII", () => {
  it("finds the constant that spells it", () => {
    let spelled: CFGInstruction | null = null;
    const graph = graphHolding((_graph, add) => {
      spelled = add(irConstant("Huế"));
      add(irReturn(spelled));
    });

    expect(wideValuesIn(graph, false, EVERYTHING_IS_TEXT).has(spelled!)).toBe(true);
  });

  it("leaves a constant that stays inside ASCII narrow", () => {
    let spelled: CFGInstruction | null = null;
    const graph = graphHolding((_graph, add) => {
      spelled = add(irConstant("Hue"));
      add(irReturn(spelled));
    });

    expect(wideValuesIn(graph, false, EVERYTHING_IS_TEXT).has(spelled!)).toBe(false);
  });

  it("carries it through the text a program builds from it", () => {
    let joined: CFGInstruction | null = null;
    const graph = graphHolding((_graph, add) => {
      const wide = add(irConstant("Huế"));
      const narrow = add(irConstant(" city"));
      joined = add(irGenericAdd(wide, narrow));
      add(irReturn(joined));
    });

    expect(wideValuesIn(graph, false, EVERYTHING_IS_TEXT).has(joined!)).toBe(true);
  });

  it("leaves what a program builds from ASCII alone narrow", () => {
    let joined: CFGInstruction | null = null;
    const graph = graphHolding((_graph, add) => {
      const left = add(irConstant("a"));
      const right = add(irConstant("b"));
      joined = add(irGenericAdd(left, right));
      add(irReturn(joined));
    });

    expect(wideValuesIn(graph, false, EVERYTHING_IS_TEXT).has(joined!)).toBe(false);
  });

  it("treats what arrives from the heap as wide once the module let some escape", () => {
    let loaded: CFGInstruction | null = null;
    const graph = graphHolding((graph, add) => {
      const object = graph.addParameter(0);
      loaded = add(irLoadField(object, 0));
      add(irReturn(loaded));
    });

    expect(wideValuesIn(graph, false, EVERYTHING_IS_TEXT).has(loaded!)).toBe(false);
    expect(wideValuesIn(graph, true, EVERYTHING_IS_TEXT).has(loaded!)).toBe(true);
  });

  it("treats a text parameter as wide once the module let some escape", () => {
    let taken: CFGInstruction | null = null;
    const graph = graphHolding((graph, add) => {
      taken = graph.addParameter(0);
      add(irReturn(taken));
    });

    expect(wideValuesIn(graph, false, EVERYTHING_IS_TEXT).has(taken!)).toBe(false);
    expect(wideValuesIn(graph, true, EVERYTHING_IS_TEXT).has(taken!)).toBe(true);
  });

  it("carries a wide parameter into what the function builds from it", () => {
    let joined: CFGInstruction | null = null;
    const graph = graphHolding((graph, add) => {
      const taken = graph.addParameter(0);
      joined = add(irGenericAdd(taken, add(irConstant("!"))));
      add(irReturn(joined));
    });

    expect(wideValuesIn(graph, true, EVERYTHING_IS_TEXT).has(joined!)).toBe(true);
  });

  it("leaves a parameter that holds no text narrow", () => {
    let taken: CFGInstruction | null = null;
    const graph = graphHolding((graph, add) => {
      taken = graph.addParameter(0);
      add(irReturn(taken));
    });

    expect(wideValuesIn(graph, true, () => false).has(taken!)).toBe(false);
  });

  it("holds no value wide when nothing in the module spells wide text", () => {
    const graph = graphHolding((_graph, add) => {
      const narrow = add(irConstant("plain"));
      add(irReturn(narrow));
    });

    expect(summarizeWideText([{ graph, isText: EVERYTHING_IS_TEXT }]).escapes).toBe(false);
  });

  it("reports an escape once wide text is stored where the analysis cannot follow", () => {
    const graph = graphHolding((graph, add) => {
      const object = graph.addParameter(0);
      const wide = add(irConstant("Huế"));
      add(irStoreField(object, 0, wide));
      add(irReturn(wide));
    });

    const model = summarizeWideText([{ graph, isText: EVERYTHING_IS_TEXT }]);
    expect(model.escapes).toBe(true);
    expect(model.reason).toBe("holds");
  });

  it("treats the text a program reads from outside itself as wide", () => {
    let typed: CFGInstruction | null = null;
    const graph = graphHolding((_graph, add) => {
      typed = add(irCallBuiltin(INPUT_BUILTIN, [add(irConstant("? "))]));
      add(irReturn(typed));
    });

    expect(wideValuesIn(graph, false, EVERYTHING_IS_TEXT).has(typed!)).toBe(true);
  });

  it("carries the text a program read from outside into what it builds from it", () => {
    let joined: CFGInstruction | null = null;
    const graph = graphHolding((_graph, add) => {
      const typed = add(irCallBuiltin(INPUT_BUILTIN, [add(irConstant("? "))]));
      joined = add(irGenericAdd(typed, add(irConstant("!"))));
      add(irReturn(joined));
    });

    expect(wideValuesIn(graph, false, EVERYTHING_IS_TEXT).has(joined!)).toBe(true);
  });

  it("holds the heap wide once read text is stored where the analysis cannot follow", () => {
    const graph = graphHolding((graph, add) => {
      const object = graph.addParameter(0);
      const typed = add(irCallBuiltin(INPUT_BUILTIN, [add(irConstant("? "))]));
      add(irStoreField(object, 0, typed));
      add(irReturn(typed));
    });

    const model = summarizeWideText([{ graph, isText: EVERYTHING_IS_TEXT }]);
    expect(model.escapes).toBe(true);
    expect(model.reason).toBe("holds");
  });

  it("leaves a module that only prints what it read narrow on the heap", () => {
    const graph = graphHolding((_graph, add) => {
      const typed = add(irCallBuiltin(INPUT_BUILTIN, [add(irConstant("? "))]));
      add(irCallBuiltin("print", [typed]));
      add(irReturn(add(irConstant(0))));
    });

    expect(summarizeWideText([{ graph, isText: EVERYTHING_IS_TEXT }]).escapes).toBe(false);
  });

  it("reports no escape for wide text the program only prints", () => {
    const graph = graphHolding((_graph, add) => {
      const wide = add(irConstant("Huế"));
      add(irCallBuiltin("print", [wide]));
      add(irReturn(add(irConstant(0))));
    });

    expect(summarizeWideText([{ graph, isText: EVERYTHING_IS_TEXT }]).escapes).toBe(false);
  });
});

describe("the string members whose answer depends on the encoding", () => {
  const builtin = (name: string, bytewise = false): CFGInstruction => {
    const node = irCallBuiltin(name, []);
    if (bytewise) node.props[BYTEWISE_PROP] = true;
    return node;
  };

  it("names the ones that count characters", () => {
    for (const member of ["length", "char_at", "slice", "index_of", "to_upper_case", "trim"]) {
      expect(countsCharacters(builtin(`string.${member}`))).toBe(true);
    }
  });

  it("leaves the ones whose answer is the same bytes either way", () => {
    for (const member of ["includes", "starts_with", "ends_with", "replace", "repeat"]) {
      expect(countsCharacters(builtin(`string.${member}`))).toBe(false);
    }
  });

  it("leaves a member of another owner alone", () => {
    expect(countsCharacters(builtin("Math.floor"))).toBe(false);
    expect(countsCharacters(builtin("int.to_string"))).toBe(false);
  });

  it("stands aside for a read a pass took on purpose in bytes", () => {
    expect(countsCharacters(builtin("string.length", true))).toBe(false);
    expect(countsCharacters(builtin("string.slice", true))).toBe(false);
  });
});
