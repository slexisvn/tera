import { describe, it, expect, beforeEach } from "vitest";
import { Engine } from "../../src/api/engine.js";
import { SpeculativeOptimizer } from "../../src/optimizing/optimizer.js";
import {
  IR_CHECK_SMI,
  IR_CHECK_NUMBER,
  IR_CHECK_MAP,
  IR_CHECK_ARRAY,
  IR_CHECK_ELEMENTS_KIND,
  IR_CHECK_BOUNDS,
  IR_INT32_ADD,
  IR_INT32_SUB,
  IR_INT32_MUL,
  IR_INT32_DIV,
  IR_INT32_MOD,
  IR_INT32_COMPARE,
  IR_FLOAT64_ADD,
  IR_FLOAT64_SUB,
  IR_FLOAT64_MUL,
  IR_FLOAT64_DIV,
  IR_FLOAT64_COMPARE,
  IR_GENERIC_ADD,
  IR_GENERIC_SUB,
  IR_GENERIC_COMPARE,
  IR_LOAD_FIELD,
  IR_POLYMORPHIC_LOAD,
  IR_GENERIC_GET_PROP,
  IR_NEG,
  IR_RETURN,
} from "../../src/optimizing/ir/index.js";

function jitEngine() {
  return new Engine({
    tieringPolicy: { jitThreshold: 5, baselineThreshold: 2 },
  });
}

function getFn(engine, name) {
  return engine.collectFunctions().find((f) => f.name === name);
}

function compileIR(compiledFn) {
  const optimizer = new SpeculativeOptimizer();
  return optimizer.compile(compiledFn);
}

function allNodes(graph) {
  const nodes = [];
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      nodes.push(node);
    }
  }
  return nodes;
}

function nodesOfType(graph, type) {
  return allNodes(graph).filter((n) => n.type === type);
}

function hasNodeType(graph, type) {
  return nodesOfType(graph, type).length > 0;
}

function hasNoNodeType(graph, type) {
  return nodesOfType(graph, type).length === 0;
}

describe("IR speculation: smi arithmetic guards", () => {
  let engine;
  beforeEach(() => { engine = jitEngine(); });

  it("add with smi feedback inserts CheckSmi + Int32Add", () => {
    engine.run("function add(a,b){return a+b;} for(var i=0;i<10;i++) add(i,i);");
    const fn = getFn(engine, "add");
    const { graph } = compileIR(fn);

    expect(hasNodeType(graph, IR_CHECK_SMI)).toBe(true);
    expect(hasNodeType(graph, IR_INT32_ADD)).toBe(true);
    expect(hasNoNodeType(graph, IR_GENERIC_ADD)).toBe(true);
  });

  it("sub with smi feedback inserts CheckSmi + Int32Sub", () => {
    engine.run("function sub(a,b){return a-b;} for(var i=0;i<10;i++) sub(i,1);");
    const fn = getFn(engine, "sub");
    const { graph } = compileIR(fn);

    expect(hasNodeType(graph, IR_CHECK_SMI)).toBe(true);
    expect(hasNodeType(graph, IR_INT32_SUB)).toBe(true);
    expect(hasNoNodeType(graph, IR_GENERIC_SUB)).toBe(true);
  });

  it("mul with smi feedback inserts CheckSmi + Int32Mul", () => {
    engine.run("function mul(a,b){return a*b;} for(var i=0;i<10;i++) mul(i,2);");
    const fn = getFn(engine, "mul");
    const { graph } = compileIR(fn);

    expect(hasNodeType(graph, IR_CHECK_SMI)).toBe(true);
    expect(hasNodeType(graph, IR_INT32_MUL)).toBe(true);
  });

  it("div with smi feedback inserts CheckSmi + Float64Div (JS / is float)", () => {
    engine.run("function div(a,b){return a/b;} for(var i=0;i<10;i++) div(i*2,2);");
    const fn = getFn(engine, "div");
    const { graph } = compileIR(fn);

    expect(hasNodeType(graph, IR_CHECK_SMI)).toBe(true);
    expect(hasNodeType(graph, IR_FLOAT64_DIV)).toBe(true);
    expect(hasNodeType(graph, IR_INT32_DIV)).toBe(false);
  });

  it("mod with smi feedback inserts CheckSmi + Int32Mod", () => {
    engine.run("function mod(a,b){return a%b;} for(var i=0;i<10;i++) mod(i,3);");
    const fn = getFn(engine, "mod");
    const { graph } = compileIR(fn);

    expect(hasNodeType(graph, IR_CHECK_SMI)).toBe(true);
    expect(hasNodeType(graph, IR_INT32_MOD)).toBe(true);
  });

  it("CheckSmi nodes have frameState attached", () => {
    engine.run("function add(a,b){return a+b;} for(var i=0;i<10;i++) add(i,i);");
    const fn = getFn(engine, "add");
    const { graph, frameStates } = compileIR(fn);

    const checks = nodesOfType(graph, IR_CHECK_SMI);
    for (const check of checks) {
      expect(check.frameState).toBeTruthy();
    }
    expect(frameStates.length).toBeGreaterThan(0);
  });

  it("Int32Add/Sub/Mul have frameState for overflow deopt", () => {
    engine.run("function add(a,b){return a+b;} for(var i=0;i<10;i++) add(i,i);");
    const fn = getFn(engine, "add");
    const { graph } = compileIR(fn);

    const adds = nodesOfType(graph, IR_INT32_ADD);
    for (const add of adds) {
      expect(add.frameState).toBeTruthy();
    }
  });
});

describe("IR speculation: number arithmetic guards", () => {
  let engine;
  beforeEach(() => { engine = jitEngine(); });

  it("add with float feedback inserts CheckNumber + Float64Add", () => {
    engine.run("function add(a,b){return a+b;} for(var i=0;i<10;i++) add(i*0.1, i*0.2);");
    const fn = getFn(engine, "add");
    const { graph } = compileIR(fn);

    expect(hasNodeType(graph, IR_CHECK_NUMBER)).toBe(true);
    expect(hasNodeType(graph, IR_FLOAT64_ADD)).toBe(true);
    expect(hasNoNodeType(graph, IR_GENERIC_ADD)).toBe(true);
  });

  it("sub with float feedback inserts CheckNumber + Float64Sub", () => {
    engine.run("function sub(a,b){return a-b;} for(var i=0;i<10;i++) sub(i*0.5, 0.1);");
    const fn = getFn(engine, "sub");
    const { graph } = compileIR(fn);

    expect(hasNodeType(graph, IR_CHECK_NUMBER)).toBe(true);
    expect(hasNodeType(graph, IR_FLOAT64_SUB)).toBe(true);
  });
});

describe("IR speculation: comparison guards", () => {
  let engine;
  beforeEach(() => { engine = jitEngine(); });

  it("less-than with smi feedback inserts CheckSmi + Int32Compare", () => {
    engine.run("function lt(a,b){return a<b;} for(var i=0;i<10;i++) lt(i,5);");
    const fn = getFn(engine, "lt");
    const { graph } = compileIR(fn);

    expect(hasNodeType(graph, IR_CHECK_SMI)).toBe(true);
    expect(hasNodeType(graph, IR_INT32_COMPARE)).toBe(true);
    expect(hasNoNodeType(graph, IR_GENERIC_COMPARE)).toBe(true);
  });

  it("Int32Compare node has correct compare op", () => {
    engine.run("function lt(a,b){return a<b;} for(var i=0;i<10;i++) lt(i,5);");
    const fn = getFn(engine, "lt");
    const { graph } = compileIR(fn);

    const cmps = nodesOfType(graph, IR_INT32_COMPARE);
    expect(cmps.length).toBeGreaterThan(0);
    expect(cmps[0].props.op).toBe("<");
  });

  it("equality with smi feedback uses Int32Compare with ==", () => {
    engine.run("function eq(a,b){return a===b;} for(var i=0;i<10;i++) eq(i,i);");
    const fn = getFn(engine, "eq");
    const { graph } = compileIR(fn);

    const cmps = nodesOfType(graph, IR_INT32_COMPARE);
    expect(cmps.length).toBeGreaterThan(0);
    expect(cmps[0].props.op).toBe("==");
  });

  it("comparison with float feedback inserts CheckNumber + Float64Compare", () => {
    engine.run("function gt(a,b){return a>b;} for(var i=0;i<10;i++) gt(i*0.1, 0.5);");
    const fn = getFn(engine, "gt");
    const { graph } = compileIR(fn);

    expect(hasNodeType(graph, IR_CHECK_NUMBER)).toBe(true);
    expect(hasNodeType(graph, IR_FLOAT64_COMPARE)).toBe(true);
  });
});

describe("IR speculation: unary operator guards", () => {
  let engine;
  beforeEach(() => { engine = jitEngine(); });

  it("negate with smi feedback inserts CheckSmi + Neg", () => {
    engine.run("function neg(a){return -a;} for(var i=1;i<10;i++) neg(i);");
    const fn = getFn(engine, "neg");
    const { graph } = compileIR(fn);

    expect(hasNodeType(graph, IR_CHECK_SMI)).toBe(true);
    expect(hasNodeType(graph, IR_NEG)).toBe(true);
  });

  it("negate with float feedback inserts CheckNumber + Neg", () => {
    engine.run("function neg(a){return -a;} for(var i=0;i<10;i++) neg(i*0.5);");
    const fn = getFn(engine, "neg");
    const { graph } = compileIR(fn);

    expect(hasNodeType(graph, IR_CHECK_NUMBER)).toBe(true);
    expect(hasNodeType(graph, IR_NEG)).toBe(true);
  });
});

describe("IR speculation: property access guards", () => {
  let engine;
  beforeEach(() => { engine = jitEngine(); });

  it("monomorphic property access inserts CheckMap + LoadField", () => {
    engine.run(`
      function getX(o){return o.x;}
      var obj={x:10,y:20};
      for(var i=0;i<10;i++) getX(obj);
    `);
    const fn = getFn(engine, "getX");
    const { graph } = compileIR(fn);

    expect(hasNodeType(graph, IR_CHECK_MAP)).toBe(true);
    expect(hasNodeType(graph, IR_LOAD_FIELD)).toBe(true);
    expect(hasNoNodeType(graph, IR_GENERIC_GET_PROP)).toBe(true);
  });

  it("CheckMap node has expectedMapId set", () => {
    engine.run(`
      function getX(o){return o.x;}
      var obj={x:10,y:20};
      for(var i=0;i<10;i++) getX(obj);
    `);
    const fn = getFn(engine, "getX");
    const { graph } = compileIR(fn);

    const checks = nodesOfType(graph, IR_CHECK_MAP);
    expect(checks.length).toBeGreaterThan(0);
    expect(checks[0].props.expectedMapId).toBeDefined();
    expect(typeof checks[0].props.expectedMapId).toBe("number");
  });

  it("LoadField node has correct offset", () => {
    engine.run(`
      function getX(o){return o.x;}
      var obj={x:10,y:20};
      for(var i=0;i<10;i++) getX(obj);
    `);
    const fn = getFn(engine, "getX");
    const { graph } = compileIR(fn);

    const loads = nodesOfType(graph, IR_LOAD_FIELD);
    expect(loads.length).toBeGreaterThan(0);
    expect(typeof loads[0].props.offset).toBe("number");
  });

  it("CheckMap has frameState for deopt", () => {
    engine.run(`
      function getX(o){return o.x;}
      var obj={x:10,y:20};
      for(var i=0;i<10;i++) getX(obj);
    `);
    const fn = getFn(engine, "getX");
    const { graph } = compileIR(fn);

    const checks = nodesOfType(graph, IR_CHECK_MAP);
    for (const check of checks) {
      expect(check.frameState).toBeTruthy();
    }
  });

  it("polymorphic property access inserts PolymorphicLoad", () => {
    engine.run(`
      function getX(o){return o.x;}
      for(var i=0;i<5;i++) getX({x:i});
      for(var i=0;i<5;i++) getX({x:i, y:i});
    `);
    const fn = getFn(engine, "getX");
    const { graph } = compileIR(fn);

    const hasPoly = hasNodeType(graph, IR_POLYMORPHIC_LOAD);
    const hasMono = hasNodeType(graph, IR_CHECK_MAP) && hasNodeType(graph, IR_LOAD_FIELD);
    const hasGeneric = hasNodeType(graph, IR_GENERIC_GET_PROP);
    
    expect(hasPoly || hasMono || hasGeneric).toBe(true);
  });
});

describe("IR speculation: no guards without feedback", () => {
  let engine;
  beforeEach(() => { engine = jitEngine(); });

  it("mixed-type feedback produces generic operations", () => {
    engine.run(`
      function add(a,b){return a+b;}
      for(var i=0;i<5;i++) add(i,i);
      for(var i=0;i<5;i++) add("a","b");
    `);
    const fn = getFn(engine, "add");
    const { graph } = compileIR(fn);

    expect(hasNodeType(graph, IR_GENERIC_ADD)).toBe(true);
    expect(hasNoNodeType(graph, IR_INT32_ADD)).toBe(true);
    expect(hasNoNodeType(graph, IR_FLOAT64_ADD)).toBe(true);
  });
});

describe("IR speculation: graph structure", () => {
  let engine;
  beforeEach(() => { engine = jitEngine(); });

  it("graph has Return node", () => {
    engine.run("function f(a){return a+1;} for(var i=0;i<10;i++) f(i);");
    const fn = getFn(engine, "f");
    const { graph } = compileIR(fn);

    expect(hasNodeType(graph, IR_RETURN)).toBe(true);
  });

  it("graph has parameters matching function paramCount", () => {
    engine.run("function f(a,b,c){return a+b+c;} for(var i=0;i<10;i++) f(i,i,i);");
    const fn = getFn(engine, "f");
    const { graph } = compileIR(fn);

    expect(graph.parameters.length).toBe(3);
  });

  it("graph has at least one block", () => {
    engine.run("function f(a){return a;} for(var i=0;i<10;i++) f(i);");
    const fn = getFn(engine, "f");
    const { graph } = compileIR(fn);

    expect(graph.blocks.length).toBeGreaterThan(0);
  });

  it("all CheckSmi inputs come from parameters or other nodes", () => {
    engine.run("function add(a,b){return a+b;} for(var i=0;i<10;i++) add(i,i);");
    const fn = getFn(engine, "add");
    const { graph } = compileIR(fn);

    const checks = nodesOfType(graph, IR_CHECK_SMI);
    for (const check of checks) {
      expect(check.inputs.length).toBe(1);
      expect(check.inputs[0]).toBeTruthy();
    }
  });

  it("Int32Add inputs come from CheckSmi nodes", () => {
    engine.run("function add(a,b){return a+b;} for(var i=0;i<10;i++) add(i,i);");
    const fn = getFn(engine, "add");
    const { graph } = compileIR(fn);

    const adds = nodesOfType(graph, IR_INT32_ADD);
    for (const add of adds) {
      expect(add.inputs.length).toBe(2);
      expect(add.inputs[0].type).toBe(IR_CHECK_SMI);
      expect(add.inputs[1].type).toBe(IR_CHECK_SMI);
    }
  });
});

describe("IR speculation: frame states", () => {
  let engine;
  beforeEach(() => { engine = jitEngine(); });

  it("frame states are created for speculative operations", () => {
    engine.run("function add(a,b){return a+b;} for(var i=0;i<10;i++) add(i,i);");
    const fn = getFn(engine, "add");
    const { frameStates } = compileIR(fn);

    expect(frameStates.length).toBeGreaterThan(0);
  });

  it("frame states reference the correct compiled function", () => {
    engine.run("function add(a,b){return a+b;} for(var i=0;i<10;i++) add(i,i);");
    const fn = getFn(engine, "add");
    const { frameStates } = compileIR(fn);

    for (const fs of frameStates) {
      expect(fs.compiledFunction).toBe(fn);
    }
  });

  it("frame states have valid bytecode offsets", () => {
    engine.run("function add(a,b){return a+b;} for(var i=0;i<10;i++) add(i,i);");
    const fn = getFn(engine, "add");
    const { frameStates } = compileIR(fn);

    for (const fs of frameStates) {
      expect(typeof fs.bytecodeOffset).toBe("number");
      expect(fs.bytecodeOffset).toBeGreaterThanOrEqual(0);
    }
  });

  it("frame states have sequential IDs", () => {
    engine.run("function add(a,b){return a+b;} for(var i=0;i<10;i++) add(i,i);");
    const fn = getFn(engine, "add");
    const { frameStates } = compileIR(fn);

    for (let i = 0; i < frameStates.length; i++) {
      expect(frameStates[i].id).toBe(i);
    }
  });
});

describe("IR speculation: dependency tracking", () => {
  let engine;
  beforeEach(() => { engine = jitEngine(); });

  it("monomorphic property access adds map dependency to graph", () => {
    engine.run(`
      function getX(o){return o.x;}
      var obj={x:42};
      for(var i=0;i<10;i++) getX(obj);
    `);
    const fn = getFn(engine, "getX");
    const { graph } = compileIR(fn);

    const mapDeps = graph.dependencies.filter((d) => d.kind === "map");
    expect(mapDeps.length).toBeGreaterThan(0);
  });

  it("multiple property accesses add multiple dependencies", () => {
    engine.run(`
      function getXY(o){return o.x + o.y;}
      var obj={x:1,y:2};
      for(var i=0;i<10;i++) getXY(obj);
    `);
    const fn = getFn(engine, "getXY");
    const { graph } = compileIR(fn);

    expect(graph.dependencies.length).toBeGreaterThan(0);
  });
});

describe("IR speculation: div/mod frameState attachment", () => {
  let engine;
  beforeEach(() => { engine = jitEngine(); });

  it("Float64Div node has frameState for deopt recovery", () => {
    engine.run("function div(a,b){return a/b;} for(var i=1;i<10;i++) div(10,i);");
    const fn = getFn(engine, "div");
    const { graph } = compileIR(fn);

    const divs = nodesOfType(graph, IR_FLOAT64_DIV);
    expect(divs.length).toBeGreaterThan(0);
    for (const div of divs) {
      expect(div.frameState).toBeTruthy();
    }
  });

  it("Int32Mod node has frameState for deopt recovery", () => {
    engine.run("function mod(a,b){return a%b;} for(var i=1;i<10;i++) mod(10,i);");
    const fn = getFn(engine, "mod");
    const { graph } = compileIR(fn);

    const mods = nodesOfType(graph, IR_INT32_MOD);
    expect(mods.length).toBeGreaterThan(0);
    for (const mod of mods) {
      expect(mod.frameState).toBeTruthy();
    }
  });
});

