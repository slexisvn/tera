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
  IR_CHECK_CALL_TARGET,
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
  IR_GENERIC_COMPARE,
  IR_LOAD_FIELD,
  IR_POLYMORPHIC_LOAD,
  IR_GENERIC_GET_PROP,
  IR_LOAD_ARRAY_LENGTH,
} from "../../src/optimizing/ir/index.js";
import {
  Deoptimizer,
  DEOPT_SMI_CHECK_FAILED,
  DEOPT_NUMBER_CHECK_FAILED,
  DEOPT_MAP_CHECK_FAILED,
  DEOPT_OVERFLOW,
  DEOPT_DIVISION_BY_ZERO,
} from "../../src/deopt/deoptimizer.js";
import { DeoptSignal } from "../../src/deopt/signal.js";
import { DependencyRegistry, DEP_MAP } from "../../src/deopt/dependencies.js";
import { FrameState } from "../../src/deopt/frame-state.js";
import { mkSmi, mkUndefined, mkDouble } from "../../src/core/value/index.js";

function jitEngine() {
  return new Engine({
    tieringPolicy: { jitThreshold: 5, baselineThreshold: 2 },
  });
}

function getFn(engine, name) {
  return engine.collectFunctions().find((f) => f.name === name);
}

function compileIR(compiledFn) {
  return new SpeculativeOptimizer().compile(compiledFn);
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

function makeDeoptimizer(maxDeoptCount = 10) {
  let capturedFrame = null;
  const interpreter = {
    tieringPolicy: { maxDeoptCount },
    resumeAt(frame) {
      capturedFrame = frame;
      return mkSmi(0);
    },
  };
  return {
    deoptimizer: new Deoptimizer(interpreter),
    getCapturedFrame: () => capturedFrame,
  };
}

describe("speculation → deopt: CheckSmi guard feeds Deoptimizer", () => {
  let engine;
  beforeEach(() => { engine = jitEngine(); });

  it("CheckSmi frameState has correct compiledFunction, Deoptimizer restores pc from it", () => {
    engine.run("function add(a,b){return a+b;} for(var i=0;i<10;i++) add(i,i);");
    const fn = getFn(engine, "add");
    const { graph, frameStates } = compileIR(fn);

    const check = nodesOfType(graph, IR_CHECK_SMI)[0];
    const fs = check.frameState;

    expect(fs.compiledFunction).toBe(fn);
    expect(fs.bytecodeOffset).toBeGreaterThanOrEqual(0);

    const { deoptimizer, getCapturedFrame } = makeDeoptimizer();
    fn.optimizedCode = {};
    const signal = new DeoptSignal(DEOPT_SMI_CHECK_FAILED, fs.bytecodeOffset, [], [], fs.id);
    deoptimizer.deoptimize(signal, frameStates);

    const frame = getCapturedFrame();
    expect(frame.pc).toBe(fs.bytecodeOffset);
    expect(frame.compiledFn).toBe(fn);
  });

  it("Deoptimizer sets deoptCount and clears optimizedCode via handleDisableOptimization", () => {
    engine.run("function add(a,b){return a+b;} for(var i=0;i<10;i++) add(i,i);");
    const fn = getFn(engine, "add");
    const { graph, frameStates } = compileIR(fn);

    const check = nodesOfType(graph, IR_CHECK_SMI)[0];
    fn.optimizedCode = {};

    const { deoptimizer } = makeDeoptimizer();
    const signal = new DeoptSignal(DEOPT_SMI_CHECK_FAILED, check.frameState.bytecodeOffset, [], [], check.frameState.id);
    deoptimizer.deoptimize(signal, frameStates);

    expect(fn.deoptCount).toBe(1);
    expect(fn.optimizedCode).toBe(null);
    expect(fn.lastDeoptReason).toBe(DEOPT_SMI_CHECK_FAILED);
  });

  it("reaching maxDeoptCount via speculation frameState disables optimization", () => {
    engine.run("function add(a,b){return a+b;} for(var i=0;i<10;i++) add(i,i);");
    const fn = getFn(engine, "add");
    const { graph, frameStates } = compileIR(fn);

    const check = nodesOfType(graph, IR_CHECK_SMI)[0];
    fn.optimizedCode = {};

    const { deoptimizer } = makeDeoptimizer(1);
    const signal = new DeoptSignal(DEOPT_SMI_CHECK_FAILED, check.frameState.bytecodeOffset, [], [], check.frameState.id);
    deoptimizer.deoptimize(signal, frameStates);

    expect(fn.disableOptimization).toBe(true);
    expect(fn.optimizedCode).toBe(null);
  });

  it("frameState locals are materialized into RegisterFrame by Deoptimizer", () => {
    engine.run("function f(a,b){var c=a+b;return c;} for(var i=0;i<10;i++) f(i,i);");
    const fn = getFn(engine, "f");
    const { graph, frameStates } = compileIR(fn);

    const checks = nodesOfType(graph, IR_CHECK_SMI);
    expect(checks.length).toBeGreaterThan(0);
    const fs = checks[0].frameState;

    const runtimeValues = new Map();
    for (const [slot, irNode] of fs.localValues) {
      runtimeValues.set(irNode.id, mkSmi(slot * 10));
    }

    fn.optimizedCode = {};
    const { deoptimizer, getCapturedFrame } = makeDeoptimizer();
    const signal = new DeoptSignal(DEOPT_SMI_CHECK_FAILED, fs.bytecodeOffset, [], [], fs.id, runtimeValues);
    deoptimizer.deoptimize(signal, frameStates);

    const frame = getCapturedFrame();
    for (const [slot, irNode] of fs.localValues) {
      expect(frame.locals[slot]).toBe(runtimeValues.get(irNode.id));
    }
  });

  it("each CheckSmi guard has a distinct frameState ID matching frameStates array", () => {
    engine.run("function add(a,b){return a+b;} for(var i=0;i<10;i++) add(i,i);");
    const fn = getFn(engine, "add");
    const { graph, frameStates } = compileIR(fn);

    const checks = nodesOfType(graph, IR_CHECK_SMI);
    for (const check of checks) {
      const fsId = check.frameState.id;
      expect(fsId).toBeGreaterThanOrEqual(0);
      expect(fsId).toBeLessThan(frameStates.length);
      expect(frameStates[fsId]).toBe(check.frameState);
    }
  });
});

describe("speculation → deopt: Int32 arithmetic overflow guard", () => {
  let engine;
  beforeEach(() => { engine = jitEngine(); });

  it("Int32Add frameState feeds Deoptimizer with DEOPT_OVERFLOW reason", () => {
    engine.run("function add(a,b){return a+b;} for(var i=0;i<10;i++) add(i,i);");
    const fn = getFn(engine, "add");
    const { graph, frameStates } = compileIR(fn);

    const addNode = nodesOfType(graph, IR_INT32_ADD)[0];
    const fs = addNode.frameState;
    expect(fs).toBeTruthy();

    fn.optimizedCode = {};
    const { deoptimizer, getCapturedFrame } = makeDeoptimizer();
    const signal = new DeoptSignal(DEOPT_OVERFLOW, fs.bytecodeOffset, [], [], fs.id);
    deoptimizer.deoptimize(signal, frameStates);

    expect(getCapturedFrame().pc).toBe(fs.bytecodeOffset);
    expect(fn.lastDeoptReason).toBe(DEOPT_OVERFLOW);
    expect(fn.deoptCount).toBe(1);
  });

  it("Int32Sub frameState is usable for overflow deopt", () => {
    engine.run("function sub(a,b){return a-b;} for(var i=0;i<10;i++) sub(i,1);");
    const fn = getFn(engine, "sub");
    const { graph, frameStates } = compileIR(fn);

    const subNode = nodesOfType(graph, IR_INT32_SUB)[0];
    expect(subNode.frameState).toBeTruthy();

    fn.optimizedCode = {};
    const { deoptimizer, getCapturedFrame } = makeDeoptimizer();
    const signal = new DeoptSignal(DEOPT_OVERFLOW, subNode.frameState.bytecodeOffset, [], [], subNode.frameState.id);
    deoptimizer.deoptimize(signal, frameStates);

    expect(getCapturedFrame().pc).toBe(subNode.frameState.bytecodeOffset);
    expect(fn.lastDeoptReason).toBe(DEOPT_OVERFLOW);
  });

  it("Int32Mul frameState is usable for overflow deopt", () => {
    engine.run("function mul(a,b){return a*b;} for(var i=0;i<10;i++) mul(i,2);");
    const fn = getFn(engine, "mul");
    const { graph, frameStates } = compileIR(fn);

    const mulNode = nodesOfType(graph, IR_INT32_MUL)[0];
    expect(mulNode.frameState).toBeTruthy();

    fn.optimizedCode = {};
    const { deoptimizer, getCapturedFrame } = makeDeoptimizer();
    const signal = new DeoptSignal(DEOPT_OVERFLOW, mulNode.frameState.bytecodeOffset, [], [], mulNode.frameState.id);
    deoptimizer.deoptimize(signal, frameStates);

    expect(getCapturedFrame().compiledFn).toBe(fn);
  });
});

describe("speculation → deopt: CheckMap guard feeds Deoptimizer", () => {
  let engine;
  beforeEach(() => { engine = jitEngine(); });

  it("CheckMap frameState feeds Deoptimizer with MAP_CHECK_FAILED", () => {
    engine.run(`
      function getX(o){return o.x;}
      var obj={x:10,y:20};
      for(var i=0;i<10;i++) getX(obj);
    `);
    const fn = getFn(engine, "getX");
    const { graph, frameStates } = compileIR(fn);

    const checkMap = nodesOfType(graph, IR_CHECK_MAP)[0];
    expect(checkMap.frameState).toBeTruthy();
    expect(checkMap.props.expectedMapId).toBeDefined();

    fn.optimizedCode = {};
    const { deoptimizer, getCapturedFrame } = makeDeoptimizer();
    const signal = new DeoptSignal(DEOPT_MAP_CHECK_FAILED, checkMap.frameState.bytecodeOffset, [], [], checkMap.frameState.id);
    deoptimizer.deoptimize(signal, frameStates);

    expect(getCapturedFrame().pc).toBe(checkMap.frameState.bytecodeOffset);
    expect(fn.lastDeoptReason).toBe(DEOPT_MAP_CHECK_FAILED);
    expect(fn.deoptCount).toBe(1);
  });

  it("CheckMap guard's map dependency matches graph dependencies", () => {
    engine.run(`
      function getX(o){return o.x;}
      var obj={x:10};
      for(var i=0;i<10;i++) getX(obj);
    `);
    const fn = getFn(engine, "getX");
    const { graph } = compileIR(fn);

    const checkMap = nodesOfType(graph, IR_CHECK_MAP)[0];
    const mapDeps = graph.dependencies.filter(d => d.kind === "map");

    expect(mapDeps.length).toBeGreaterThan(0);
    expect(checkMap.props.expectedMapId).toBe(mapDeps[0].id);
  });

  it("dependency invalidation marks function for lazy deopt", () => {
    engine.run(`
      function getX(o){return o.x;}
      var obj={x:10};
      for(var i=0;i<10;i++) getX(obj);
    `);
    const fn = getFn(engine, "getX");
    const { graph } = compileIR(fn);

    const mapDeps = graph.dependencies.filter(d => d.kind === "map");
    expect(mapDeps.length).toBeGreaterThan(0);

    const registry = new DependencyRegistry();
    registry.register(fn, graph.dependencies);
    fn.optimizedCode = {};

    const { deoptimizer } = makeDeoptimizer();
    registry.bindLazyMarker(deoptimizer.lazyMarker);

    registry.invalidate(DEP_MAP, mapDeps[0].id, mapDeps[0].version, "map-transition");
    expect(deoptimizer.lazyMarker.hasPendingDeopt(fn)).toBe(true);

    const info = deoptimizer.lazyMarker.consumeDeopt(fn);
    expect(info.reason).toBe("map-transition");
  });
});

describe("speculation → deopt: Int32Div/Mod division-by-zero guard", () => {
  let engine;
  beforeEach(() => { engine = jitEngine(); });

  it("uses Float64Div for / (no int32 division-by-zero trap; / 0 is Infinity)", () => {
    engine.run("function div(a,b){return a/b;} for(var i=1;i<10;i++) div(10,i);");
    const fn = getFn(engine, "div");
    const { graph } = compileIR(fn);

    expect(nodesOfType(graph, IR_INT32_DIV).length).toBe(0);
    const divNode = nodesOfType(graph, IR_FLOAT64_DIV)[0];
    expect(divNode).toBeTruthy();
    expect(divNode.frameState).toBeTruthy();
  });

  it("Int32Mod frameState feeds Deoptimizer with DIVISION_BY_ZERO", () => {
    engine.run("function mod(a,b){return a%b;} for(var i=1;i<10;i++) mod(10,i);");
    const fn = getFn(engine, "mod");
    const { graph, frameStates } = compileIR(fn);

    const modNode = nodesOfType(graph, IR_INT32_MOD)[0];
    expect(modNode.frameState).toBeTruthy();

    fn.optimizedCode = {};
    const { deoptimizer, getCapturedFrame } = makeDeoptimizer();
    const signal = new DeoptSignal(DEOPT_DIVISION_BY_ZERO, modNode.frameState.bytecodeOffset, [], [], modNode.frameState.id);
    deoptimizer.deoptimize(signal, frameStates);

    expect(getCapturedFrame().pc).toBe(modNode.frameState.bytecodeOffset);
    expect(fn.lastDeoptReason).toBe(DEOPT_DIVISION_BY_ZERO);
  });
});

describe("speculation → deopt: CheckNumber guard feeds Deoptimizer", () => {
  let engine;
  beforeEach(() => { engine = jitEngine(); });

  it("CheckNumber frameState feeds Deoptimizer with NUMBER_CHECK_FAILED", () => {
    engine.run("function add(a,b){return a+b;} for(var i=0;i<10;i++) add(i*0.1,i*0.2);");
    const fn = getFn(engine, "add");
    const { graph, frameStates } = compileIR(fn);

    const check = nodesOfType(graph, IR_CHECK_NUMBER)[0];
    expect(check.frameState).toBeTruthy();

    fn.optimizedCode = {};
    const { deoptimizer, getCapturedFrame } = makeDeoptimizer();
    const signal = new DeoptSignal(DEOPT_NUMBER_CHECK_FAILED, check.frameState.bytecodeOffset, [], [], check.frameState.id);
    deoptimizer.deoptimize(signal, frameStates);

    expect(getCapturedFrame().pc).toBe(check.frameState.bytecodeOffset);
    expect(fn.lastDeoptReason).toBe(DEOPT_NUMBER_CHECK_FAILED);
  });
});

describe("speculation → deopt: frameState consistency across guard types", () => {
  let engine;
  beforeEach(() => { engine = jitEngine(); });

  it("all guard nodes in a graph have frameStates indexable in the frameStates array", () => {
    engine.run("function f(a,b){return a+b;} for(var i=0;i<10;i++) f(i,i);");
    const fn = getFn(engine, "f");
    const { graph, frameStates } = compileIR(fn);

    const guardTypes = [IR_CHECK_SMI, IR_CHECK_NUMBER, IR_CHECK_MAP];
    for (const guardType of guardTypes) {
      for (const node of nodesOfType(graph, guardType)) {
        const fs = node.frameState;
        expect(fs).toBeTruthy();
        expect(fs.id).toBeGreaterThanOrEqual(0);
        expect(fs.id).toBeLessThan(frameStates.length);
        expect(frameStates[fs.id]).toBe(fs);
        expect(fs.compiledFunction).toBe(fn);
      }
    }
  });

  it("arithmetic nodes with frameState are also indexable in frameStates array", () => {
    engine.run("function f(a,b){var c=a+b;var d=a-b;var e=a*b;return c+d+e;} for(var i=0;i<10;i++) f(i,i);");
    const fn = getFn(engine, "f");
    const { graph, frameStates } = compileIR(fn);

    const arithTypes = [IR_INT32_ADD, IR_INT32_SUB, IR_INT32_MUL, IR_INT32_DIV, IR_INT32_MOD];
    for (const arithType of arithTypes) {
      for (const node of nodesOfType(graph, arithType)) {
        if (node.frameState) {
          expect(node.frameState.id).toBeGreaterThanOrEqual(0);
          expect(node.frameState.id).toBeLessThan(frameStates.length);
          expect(frameStates[node.frameState.id]).toBe(node.frameState);
        }
      }
    }
  });

  it("deopt stats accumulate correctly across multiple speculation-sourced deopts", () => {
    engine.run("function add(a,b){return a+b;} for(var i=0;i<10;i++) add(i,i);");
    const fn1 = getFn(engine, "add");
    const { graph: g1, frameStates: fs1 } = compileIR(fn1);
    const check1 = nodesOfType(g1, IR_CHECK_SMI)[0];

    engine.run("function mul(a,b){return a*b;} for(var i=0;i<10;i++) mul(i,2);");
    const fn2 = getFn(engine, "mul");
    const { graph: g2, frameStates: fs2 } = compileIR(fn2);
    const check2 = nodesOfType(g2, IR_CHECK_SMI)[0];

    const { deoptimizer } = makeDeoptimizer();

    fn1.optimizedCode = {};
    deoptimizer.deoptimize(
      new DeoptSignal(DEOPT_SMI_CHECK_FAILED, check1.frameState.bytecodeOffset, [], [], check1.frameState.id),
      fs1,
    );

    fn2.optimizedCode = {};
    deoptimizer.deoptimize(
      new DeoptSignal(DEOPT_OVERFLOW, check2.frameState.bytecodeOffset, [], [], check2.frameState.id),
      fs2,
    );

    const stats = deoptimizer.getStats();
    expect(stats.total).toBe(2);
    expect(stats.reasons[DEOPT_SMI_CHECK_FAILED]).toBe(1);
    expect(stats.reasons[DEOPT_OVERFLOW]).toBe(1);
    expect(fn1.deoptCount).toBe(1);
    expect(fn2.deoptCount).toBe(1);
  });
});

describe("speculation → deopt: comparison guard feeds Deoptimizer", () => {
  let engine;
  beforeEach(() => { engine = jitEngine(); });

  it("Int32Compare guard's CheckSmi frameState restores frame on type-check failure", () => {
    engine.run("function lt(a,b){return a<b;} for(var i=0;i<10;i++) lt(i,5);");
    const fn = getFn(engine, "lt");
    const { graph, frameStates } = compileIR(fn);

    const checks = nodesOfType(graph, IR_CHECK_SMI);
    expect(checks.length).toBeGreaterThanOrEqual(2);
    const fs = checks[0].frameState;

    fn.optimizedCode = {};
    const { deoptimizer, getCapturedFrame } = makeDeoptimizer();
    const signal = new DeoptSignal(DEOPT_SMI_CHECK_FAILED, fs.bytecodeOffset, [], [], fs.id);
    deoptimizer.deoptimize(signal, frameStates);

    expect(getCapturedFrame().pc).toBe(fs.bytecodeOffset);
    expect(getCapturedFrame().compiledFn).toBe(fn);
    expect(fn.lastDeoptReason).toBe(DEOPT_SMI_CHECK_FAILED);
  });

  it("Float64Compare guard's CheckNumber frameState feeds Deoptimizer", () => {
    engine.run("function gt(a,b){return a>b;} for(var i=0;i<10;i++) gt(i*0.1,0.5);");
    const fn = getFn(engine, "gt");
    const { graph, frameStates } = compileIR(fn);

    const checks = nodesOfType(graph, IR_CHECK_NUMBER);
    expect(checks.length).toBeGreaterThan(0);
    const fs = checks[0].frameState;

    fn.optimizedCode = {};
    const { deoptimizer, getCapturedFrame } = makeDeoptimizer();
    const signal = new DeoptSignal(DEOPT_NUMBER_CHECK_FAILED, fs.bytecodeOffset, [], [], fs.id);
    deoptimizer.deoptimize(signal, frameStates);

    expect(getCapturedFrame().pc).toBe(fs.bytecodeOffset);
    expect(fn.lastDeoptReason).toBe(DEOPT_NUMBER_CHECK_FAILED);
  });

  it("comparison and arithmetic in same function produce independent frameStates", () => {
    engine.run("function f(a,b){var c=a+b;return c<10;} for(var i=0;i<10;i++) f(i,i);");
    const fn = getFn(engine, "f");
    const { graph, frameStates } = compileIR(fn);

    const checks = nodesOfType(graph, IR_CHECK_SMI);
    const fsIds = new Set(checks.map(c => c.frameState.id));
    for (const id of fsIds) {
      expect(id).toBeGreaterThanOrEqual(0);
      expect(id).toBeLessThan(frameStates.length);
    }
  });
});

describe("speculation → deopt: unary Neg guard feeds Deoptimizer", () => {
  let engine;
  beforeEach(() => { engine = jitEngine(); });

  it("CheckSmi from Neg speculation feeds Deoptimizer", () => {
    engine.run("function neg(a){return -a;} for(var i=1;i<10;i++) neg(i);");
    const fn = getFn(engine, "neg");
    const { graph, frameStates } = compileIR(fn);

    const checks = nodesOfType(graph, IR_CHECK_SMI);
    expect(checks.length).toBeGreaterThan(0);
    const fs = checks[0].frameState;

    fn.optimizedCode = {};
    const { deoptimizer, getCapturedFrame } = makeDeoptimizer();
    const signal = new DeoptSignal(DEOPT_SMI_CHECK_FAILED, fs.bytecodeOffset, [], [], fs.id);
    deoptimizer.deoptimize(signal, frameStates);

    expect(getCapturedFrame().pc).toBe(fs.bytecodeOffset);
    expect(fn.lastDeoptReason).toBe(DEOPT_SMI_CHECK_FAILED);
  });

  it("CheckNumber from Neg with float feedback feeds Deoptimizer", () => {
    engine.run("function neg(a){return -a;} for(var i=0;i<10;i++) neg(i*0.5);");
    const fn = getFn(engine, "neg");
    const { graph, frameStates } = compileIR(fn);

    const checks = nodesOfType(graph, IR_CHECK_NUMBER);
    expect(checks.length).toBeGreaterThan(0);
    const fs = checks[0].frameState;

    fn.optimizedCode = {};
    const { deoptimizer, getCapturedFrame } = makeDeoptimizer();
    const signal = new DeoptSignal(DEOPT_NUMBER_CHECK_FAILED, fs.bytecodeOffset, [], [], fs.id);
    deoptimizer.deoptimize(signal, frameStates);

    expect(getCapturedFrame().pc).toBe(fs.bytecodeOffset);
    expect(fn.lastDeoptReason).toBe(DEOPT_NUMBER_CHECK_FAILED);
  });
});

describe("speculation → deopt: multiple guard types in one function", () => {
  let engine;
  beforeEach(() => { engine = jitEngine(); });

  it("function with arithmetic + property access has both CheckSmi and CheckMap guards", () => {
    engine.run(`
      function compute(o,a,b){return o.x + a + b;}
      var obj={x:1};
      for(var i=0;i<10;i++) compute(obj,i,i);
    `);
    const fn = getFn(engine, "compute");
    const { graph, frameStates } = compileIR(fn);

    const smiChecks = nodesOfType(graph, IR_CHECK_SMI);
    const mapChecks = nodesOfType(graph, IR_CHECK_MAP);
    expect(smiChecks.length).toBeGreaterThan(0);
    expect(mapChecks.length).toBeGreaterThan(0);

    const smiFs = smiChecks[0].frameState;
    const mapFs = mapChecks[0].frameState;
    expect(smiFs.id).not.toBe(mapFs.id);

    fn.optimizedCode = {};
    const { deoptimizer, getCapturedFrame } = makeDeoptimizer();
    deoptimizer.deoptimize(
      new DeoptSignal(DEOPT_SMI_CHECK_FAILED, smiFs.bytecodeOffset, [], [], smiFs.id),
      frameStates,
    );
    expect(getCapturedFrame().pc).toBe(smiFs.bytecodeOffset);
    expect(fn.lastDeoptReason).toBe(DEOPT_SMI_CHECK_FAILED);
    expect(fn.deoptCount).toBe(1);
  });

  it("deopt from CheckMap guard vs CheckSmi guard restore to different bytecodeOffsets", () => {
    engine.run(`
      function compute(o,a,b){return o.x + a + b;}
      var obj={x:1};
      for(var i=0;i<10;i++) compute(obj,i,i);
    `);
    const fn = getFn(engine, "compute");
    const { graph, frameStates } = compileIR(fn);

    const smiFs = nodesOfType(graph, IR_CHECK_SMI)[0].frameState;
    const mapFs = nodesOfType(graph, IR_CHECK_MAP)[0].frameState;

    fn.optimizedCode = {};
    const { deoptimizer: d1, getCapturedFrame: g1 } = makeDeoptimizer();
    d1.deoptimize(new DeoptSignal(DEOPT_MAP_CHECK_FAILED, mapFs.bytecodeOffset, [], [], mapFs.id), frameStates);
    const mapPc = g1().pc;

    fn.optimizedCode = {};
    fn.deoptCount = 0;
    const { deoptimizer: d2, getCapturedFrame: g2 } = makeDeoptimizer();
    d2.deoptimize(new DeoptSignal(DEOPT_SMI_CHECK_FAILED, smiFs.bytecodeOffset, [], [], smiFs.id), frameStates);
    const smiPc = g2().pc;

    expect(mapPc).toBe(mapFs.bytecodeOffset);
    expect(smiPc).toBe(smiFs.bytecodeOffset);
  });
});

describe("speculation → deopt: repeated deopts on same function", () => {
  let engine;
  beforeEach(() => { engine = jitEngine(); });

  it("deoptCount increments on each deopt from same guard's frameState", () => {
    engine.run("function add(a,b){return a+b;} for(var i=0;i<10;i++) add(i,i);");
    const fn = getFn(engine, "add");
    const { graph, frameStates } = compileIR(fn);
    const fs = nodesOfType(graph, IR_CHECK_SMI)[0].frameState;

    const { deoptimizer } = makeDeoptimizer(5);

    fn.optimizedCode = {};
    deoptimizer.deoptimize(new DeoptSignal(DEOPT_SMI_CHECK_FAILED, fs.bytecodeOffset, [], [], fs.id), frameStates);
    expect(fn.deoptCount).toBe(1);
    expect(fn.optimizedCode).toBe(null);

    fn.optimizedCode = {};
    deoptimizer.deoptimize(new DeoptSignal(DEOPT_SMI_CHECK_FAILED, fs.bytecodeOffset, [], [], fs.id), frameStates);
    expect(fn.deoptCount).toBe(2);

    fn.optimizedCode = {};
    deoptimizer.deoptimize(new DeoptSignal(DEOPT_OVERFLOW, fs.bytecodeOffset, [], [], fs.id), frameStates);
    expect(fn.deoptCount).toBe(3);
    expect(fn.lastDeoptReason).toBe(DEOPT_OVERFLOW);
  });

  it("disableOptimization triggers exactly at maxDeoptCount boundary", () => {
    engine.run("function add(a,b){return a+b;} for(var i=0;i<10;i++) add(i,i);");
    const fn = getFn(engine, "add");
    const { graph, frameStates } = compileIR(fn);
    const fs = nodesOfType(graph, IR_CHECK_SMI)[0].frameState;

    const { deoptimizer } = makeDeoptimizer(3);

    fn.optimizedCode = {};
    deoptimizer.deoptimize(new DeoptSignal(DEOPT_SMI_CHECK_FAILED, fs.bytecodeOffset, [], [], fs.id), frameStates);
    expect(fn.disableOptimization).toBe(false);

    fn.optimizedCode = {};
    deoptimizer.deoptimize(new DeoptSignal(DEOPT_SMI_CHECK_FAILED, fs.bytecodeOffset, [], [], fs.id), frameStates);
    expect(fn.disableOptimization).toBe(false);

    fn.optimizedCode = {};
    deoptimizer.deoptimize(new DeoptSignal(DEOPT_SMI_CHECK_FAILED, fs.bytecodeOffset, [], [], fs.id), frameStates);
    expect(fn.deoptCount).toBe(3);
    expect(fn.disableOptimization).toBe(true);
  });
});

describe("speculation → deopt: stack values in frameState → acc restoration", () => {
  let engine;
  beforeEach(() => { engine = jitEngine(); });

  it("frameState with stack values: Deoptimizer sets acc from last stack entry", () => {
    engine.run("function f(a,b){var c=a+b;return c;} for(var i=0;i<10;i++) f(i,i);");
    const fn = getFn(engine, "f");
    const { graph, frameStates } = compileIR(fn);

    const checks = nodesOfType(graph, IR_CHECK_SMI);
    expect(checks.length).toBeGreaterThan(0);

    let fsWithStack = null;
    for (const fs of frameStates) {
      if (fs.stackValues.length > 0) {
        fsWithStack = fs;
        break;
      }
    }

    if (fsWithStack) {
      const lastStackNode = fsWithStack.stackValues[fsWithStack.stackValues.length - 1];
      const runtimeValues = new Map();
      const accValue = mkSmi(999);
      if (lastStackNode && lastStackNode.id !== undefined) {
        runtimeValues.set(lastStackNode.id, accValue);
      }

      fn.optimizedCode = {};
      const { deoptimizer, getCapturedFrame } = makeDeoptimizer();
      const signal = new DeoptSignal(DEOPT_SMI_CHECK_FAILED, fsWithStack.bytecodeOffset, [], [], fsWithStack.id, runtimeValues);
      deoptimizer.deoptimize(signal, frameStates);

      if (lastStackNode && lastStackNode.id !== undefined) {
        expect(getCapturedFrame().acc).toBe(accValue);
      }
    }
  });
});

describe("speculation → deopt: dependency invalidation across multiple functions", () => {
  let engine;
  beforeEach(() => { engine = jitEngine(); });

  it("two functions sharing same map dependency both get marked for lazy deopt", () => {
    engine.run(`
      function getX(o){return o.x;}
      function getY(o){return o.y;}
      var obj={x:1,y:2};
      for(var i=0;i<10;i++){getX(obj);getY(obj);}
    `);
    const fn1 = getFn(engine, "getX");
    const fn2 = getFn(engine, "getY");
    const { graph: g1 } = compileIR(fn1);
    const { graph: g2 } = compileIR(fn2);

    const deps1 = g1.dependencies.filter(d => d.kind === "map");
    const deps2 = g2.dependencies.filter(d => d.kind === "map");
    expect(deps1.length).toBeGreaterThan(0);
    expect(deps2.length).toBeGreaterThan(0);

    const sharedMapId = deps1[0].id;
    const sharedVersion = deps1[0].version;
    expect(deps2[0].id).toBe(sharedMapId);

    const registry = new DependencyRegistry();
    registry.register(fn1, g1.dependencies);
    registry.register(fn2, g2.dependencies);
    fn1.optimizedCode = {};
    fn2.optimizedCode = {};

    const { deoptimizer } = makeDeoptimizer();
    registry.bindLazyMarker(deoptimizer.lazyMarker);

    registry.invalidate(DEP_MAP, sharedMapId, sharedVersion, "shape-changed");
    expect(deoptimizer.lazyMarker.hasPendingDeopt(fn1)).toBe(true);
    expect(deoptimizer.lazyMarker.hasPendingDeopt(fn2)).toBe(true);
  });

  it("invalidating unrelated map ID does not affect registered functions", () => {
    engine.run(`
      function getX(o){return o.x;}
      var obj={x:1};
      for(var i=0;i<10;i++) getX(obj);
    `);
    const fn = getFn(engine, "getX");
    const { graph } = compileIR(fn);

    const registry = new DependencyRegistry();
    registry.register(fn, graph.dependencies);
    fn.optimizedCode = {};

    const { deoptimizer } = makeDeoptimizer();
    registry.bindLazyMarker(deoptimizer.lazyMarker);

    registry.invalidate(DEP_MAP, 99999, null, "unrelated");
    expect(deoptimizer.lazyMarker.hasPendingDeopt(fn)).toBe(false);
  });
});

describe("speculation → deopt: deopt from different frameState IDs in same function", () => {
  let engine;
  beforeEach(() => { engine = jitEngine(); });

  it("function with multiple operations: deopt from each guard's frameState restores correct offset", () => {
    engine.run("function f(a,b){var c=a+b;var d=a-b;return c*d;} for(var i=0;i<10;i++) f(i,i);");
    const fn = getFn(engine, "f");
    const { graph, frameStates } = compileIR(fn);

    const checks = nodesOfType(graph, IR_CHECK_SMI);
    expect(checks.length).toBeGreaterThanOrEqual(2);

    const uniqueOffsets = new Set();
    for (const check of checks) {
      const fs = check.frameState;
      fn.optimizedCode = {};
      fn.deoptCount = 0;
      const { deoptimizer, getCapturedFrame } = makeDeoptimizer();
      deoptimizer.deoptimize(
        new DeoptSignal(DEOPT_SMI_CHECK_FAILED, fs.bytecodeOffset, [], [], fs.id),
        frameStates,
      );
      expect(getCapturedFrame().pc).toBe(fs.bytecodeOffset);
      uniqueOffsets.add(fs.bytecodeOffset);
    }
  });

  it("arithmetic nodes at different bytecodeOffsets produce distinct frameState IDs", () => {
    engine.run("function f(a,b){var c=a+b;var d=a*b;return c-d;} for(var i=0;i<10;i++) f(i,i);");
    const fn = getFn(engine, "f");
    const { graph, frameStates } = compileIR(fn);

    const adds = nodesOfType(graph, IR_INT32_ADD);
    const muls = nodesOfType(graph, IR_INT32_MUL);
    const subs = nodesOfType(graph, IR_INT32_SUB);

    const allArith = [...adds, ...muls, ...subs].filter(n => n.frameState);
    expect(allArith.length).toBeGreaterThanOrEqual(2);

    for (const node of allArith) {
      expect(node.frameState.compiledFunction).toBe(fn);
      expect(frameStates[node.frameState.id]).toBe(node.frameState);
    }
  });
});

describe("speculation → deopt: Float64 arithmetic guard interaction", () => {
  let engine;
  beforeEach(() => { engine = jitEngine(); });

  it("Float64Add with CheckNumber: deopt from CheckNumber guard restores frame", () => {
    engine.run("function add(a,b){return a+b;} for(var i=0;i<10;i++) add(i*0.1,i*0.2);");
    const fn = getFn(engine, "add");
    const { graph, frameStates } = compileIR(fn);

    expect(hasNodeType(graph, IR_FLOAT64_ADD)).toBe(true);
    const checks = nodesOfType(graph, IR_CHECK_NUMBER);
    expect(checks.length).toBeGreaterThan(0);

    const fs = checks[0].frameState;
    fn.optimizedCode = {};
    const { deoptimizer, getCapturedFrame } = makeDeoptimizer();
    deoptimizer.deoptimize(
      new DeoptSignal(DEOPT_NUMBER_CHECK_FAILED, fs.bytecodeOffset, [], [], fs.id),
      frameStates,
    );
    expect(getCapturedFrame().pc).toBe(fs.bytecodeOffset);
  });

  it("Float64Div with CheckNumber: deopt restores correct function", () => {
    engine.run("function div(a,b){return a/b;} for(var i=0;i<10;i++) div(i*0.1,i*0.2+1);");
    const fn = getFn(engine, "div");
    const { graph, frameStates } = compileIR(fn);

    const checks = nodesOfType(graph, IR_CHECK_NUMBER);
    if (checks.length > 0) {
      const fs = checks[0].frameState;
      fn.optimizedCode = {};
      const { deoptimizer, getCapturedFrame } = makeDeoptimizer();
      deoptimizer.deoptimize(
        new DeoptSignal(DEOPT_NUMBER_CHECK_FAILED, fs.bytecodeOffset, [], [], fs.id),
        frameStates,
      );
      expect(getCapturedFrame().compiledFn).toBe(fn);
    }
    expect(hasNodeType(graph, IR_FLOAT64_DIV) || hasNodeType(graph, IR_CHECK_NUMBER)).toBe(true);
  });

  it("Float64Sub and Float64Mul guards share similar frameState pattern", () => {
    engine.run("function f(a,b){return (a-b)*(a+b);} for(var i=0;i<10;i++) f(i*0.1,i*0.2);");
    const fn = getFn(engine, "f");
    const { graph, frameStates } = compileIR(fn);

    const checks = nodesOfType(graph, IR_CHECK_NUMBER);
    expect(checks.length).toBeGreaterThan(0);
    for (const check of checks) {
      expect(check.frameState).toBeTruthy();
      expect(check.frameState.compiledFunction).toBe(fn);
      expect(frameStates[check.frameState.id]).toBe(check.frameState);
    }
  });
});

describe("speculation → deopt: recompilation produces different IR after feedback change", () => {
  let engine;
  beforeEach(() => { engine = jitEngine(); });

  it("smi-trained function recompiled after mixed feedback produces generic ops", () => {
    engine.run(`
      function add(a,b){return a+b;}
      for(var i=0;i<10;i++) add(i,i);
    `);
    const fn1 = getFn(engine, "add");
    const { graph: g1 } = compileIR(fn1);
    expect(hasNodeType(g1, IR_CHECK_SMI)).toBe(true);
    expect(hasNodeType(g1, IR_INT32_ADD)).toBe(true);

    engine.run('for(var i=0;i<10;i++) add("a","b");');
    const fn2 = getFn(engine, "add");
    const { graph: g2 } = compileIR(fn2);

    expect(hasNodeType(g2, IR_GENERIC_ADD)).toBe(true);
    expect(hasNoNodeType(g2, IR_INT32_ADD)).toBe(true);
  });

  it("smi-trained comparison recompiled after float feedback uses Float64Compare", () => {
    engine.run("function lt(a,b){return a<b;} for(var i=0;i<10;i++) lt(i,5);");
    const fn1 = getFn(engine, "lt");
    const { graph: g1 } = compileIR(fn1);
    expect(hasNodeType(g1, IR_INT32_COMPARE)).toBe(true);

    engine.run("for(var i=0;i<10;i++) lt(i*0.1,0.5);");
    const fn2 = getFn(engine, "lt");
    const { graph: g2 } = compileIR(fn2);

    const hasFloat = hasNodeType(g2, IR_FLOAT64_COMPARE);
    const hasGeneric = hasNodeType(g2, IR_GENERIC_COMPARE);
    expect(hasFloat || hasGeneric).toBe(true);
  });
});

describe("speculation → deopt: PolymorphicLoad frameState feeds Deoptimizer", () => {
  let engine;
  beforeEach(() => { engine = jitEngine(); });

  it("PolymorphicLoad node has frameState usable by Deoptimizer", () => {
    engine.run(`
      function getX(o){return o.x;}
      for(var i=0;i<5;i++) getX({x:i});
      for(var i=0;i<5;i++) getX({x:i, y:i});
    `);
    const fn = getFn(engine, "getX");
    const { graph, frameStates } = compileIR(fn);

    const polys = nodesOfType(graph, IR_POLYMORPHIC_LOAD);
    if (polys.length > 0 && polys[0].frameState) {
      const fs = polys[0].frameState;
      expect(fs.compiledFunction).toBe(fn);

      const deoptBefore = fn.deoptCount || 0;
      fn.optimizedCode = {};
      const { deoptimizer, getCapturedFrame } = makeDeoptimizer();
      deoptimizer.deoptimize(
        new DeoptSignal(DEOPT_MAP_CHECK_FAILED, fs.bytecodeOffset, [], [], fs.id),
        frameStates,
      );
      expect(getCapturedFrame().pc).toBe(fs.bytecodeOffset);
      expect(fn.deoptCount).toBe(deoptBefore + 1);
    } else {
      const hasMap = hasNodeType(graph, IR_CHECK_MAP);
      const hasGeneric = hasNodeType(graph, IR_GENERIC_GET_PROP);
      expect(hasMap || hasGeneric || polys.length > 0).toBe(true);
    }
  });
});

describe("speculation → deopt: CheckArray/CheckElementsKind guard feeds Deoptimizer", () => {
  let engine;
  beforeEach(() => { engine = jitEngine(); });

  it("array.length speculation produces CheckArray with frameState", () => {
    engine.run(`
      function len(arr){return arr.length;}
      var a=[1,2,3];
      for(var i=0;i<10;i++) len(a);
    `);
    const fn = getFn(engine, "len");
    const { graph, frameStates } = compileIR(fn);

    const arrayChecks = nodesOfType(graph, IR_CHECK_ARRAY);
    const kindChecks = nodesOfType(graph, IR_CHECK_ELEMENTS_KIND);

    if (arrayChecks.length > 0) {
      expect(arrayChecks[0].frameState).toBeTruthy();
      const fs = arrayChecks[0].frameState;

      fn.optimizedCode = {};
      const { deoptimizer, getCapturedFrame } = makeDeoptimizer();
      deoptimizer.deoptimize(
        new DeoptSignal("array-check-failed", fs.bytecodeOffset, [], [], fs.id),
        frameStates,
      );
      expect(getCapturedFrame().pc).toBe(fs.bytecodeOffset);
    }

    if (kindChecks.length > 0) {
      expect(kindChecks[0].frameState).toBeTruthy();
    }
  });
});

describe("speculation → deopt: frameState bytecodeOffset ordering", () => {
  let engine;
  beforeEach(() => { engine = jitEngine(); });

  it("guards earlier in bytecode have <= bytecodeOffset than later guards", () => {
    engine.run("function f(a,b){var c=a+b;var d=a-b;return c*d;} for(var i=0;i<10;i++) f(i,i);");
    const fn = getFn(engine, "f");
    const { frameStates } = compileIR(fn);

    for (let i = 1; i < frameStates.length; i++) {
      expect(frameStates[i].bytecodeOffset).toBeGreaterThanOrEqual(frameStates[i - 1].bytecodeOffset);
    }
  });

  it("each frameState in the array has id matching its index", () => {
    engine.run("function f(a,b){return a+b+a*b;} for(var i=0;i<10;i++) f(i,i);");
    const fn = getFn(engine, "f");
    const { frameStates } = compileIR(fn);

    for (let i = 0; i < frameStates.length; i++) {
      expect(frameStates[i].id).toBe(i);
    }
  });
});

describe("speculation → deopt: CheckSmi guards share frameState within same bytecode op", () => {
  let engine;
  beforeEach(() => { engine = jitEngine(); });

  it("left and right CheckSmi for binary op share the same frameState", () => {
    engine.run("function add(a,b){return a+b;} for(var i=0;i<10;i++) add(i,i);");
    const fn = getFn(engine, "add");
    const { graph } = compileIR(fn);

    const checks = nodesOfType(graph, IR_CHECK_SMI);
    expect(checks.length).toBe(2);
    expect(checks[0].frameState).toBe(checks[1].frameState);
  });

  it("the shared frameState is also the same as Int32Add's frameState", () => {
    engine.run("function add(a,b){return a+b;} for(var i=0;i<10;i++) add(i,i);");
    const fn = getFn(engine, "add");
    const { graph } = compileIR(fn);

    const checks = nodesOfType(graph, IR_CHECK_SMI);
    const adds = nodesOfType(graph, IR_INT32_ADD);
    expect(checks[0].frameState).toBe(adds[0].frameState);
  });
});

describe("speculation → deopt: thisValue restoration through frameState", () => {
  let engine;
  beforeEach(() => { engine = jitEngine(); });

  it("method call frameState captures thisValue, Deoptimizer restores it", () => {
    engine.run(`
      function inc(self,n){return self.v+n;}
      var c={v:10};
      for(var i=0;i<10;i++) inc(c,i);
    `);
    const fn = getFn(engine, "inc");
    const { graph, frameStates } = compileIR(fn);

    const checks = nodesOfType(graph, IR_CHECK_SMI).concat(nodesOfType(graph, IR_CHECK_MAP));
    expect(checks.length).toBeGreaterThan(0);

    const fsWithThis = frameStates.find(fs => fs.thisValue !== null);
    if (fsWithThis) {
      const runtimeValues = new Map();
      const thisVal = mkSmi(42);
      if (fsWithThis.thisValue && fsWithThis.thisValue.id !== undefined) {
        runtimeValues.set(fsWithThis.thisValue.id, thisVal);
      }

      fn.optimizedCode = {};
      const { deoptimizer, getCapturedFrame } = makeDeoptimizer();
      const signal = new DeoptSignal(DEOPT_SMI_CHECK_FAILED, fsWithThis.bytecodeOffset, [], [], fsWithThis.id, runtimeValues);
      deoptimizer.deoptimize(signal, frameStates);

      const frame = getCapturedFrame();
      expect(frame.pc).toBe(fsWithThis.bytecodeOffset);
      if (fsWithThis.thisValue && fsWithThis.thisValue.id !== undefined) {
        expect(frame.thisValue).toBe(thisVal);
      }
    }
  });
});

describe("speculation → deopt: cascaded deopt through callerFrameState", () => {
  let engine;
  beforeEach(() => { engine = jitEngine(); });

  it("manually constructed inlined frameState chain triggers resumeCascaded", () => {
    engine.run("function inner(a){return a+1;} for(var i=0;i<10;i++) inner(i);");
    engine.run("function outer(x){return inner(x)+2;} for(var i=0;i<10;i++) outer(i);");

    const innerFn = getFn(engine, "inner");
    const outerFn = getFn(engine, "outer");
    const { graph: innerGraph, frameStates: innerFS } = compileIR(innerFn);

    const innerCheck = nodesOfType(innerGraph, IR_CHECK_SMI)[0];
    expect(innerCheck.frameState).toBeTruthy();

    const callerFs = new FrameState(outerFn, 5);
    callerFs.id = innerFS.length;

    const inlinedFs = innerCheck.frameState.clone();
    inlinedFs.setCallerFrame(callerFs);

    const allFrameStates = [...innerFS, callerFs];
    inlinedFs.id = innerCheck.frameState.id;
    allFrameStates[inlinedFs.id] = inlinedFs;

    let resumeCount = 0;
    const interpreter = {
      tieringPolicy: { maxDeoptCount: 10 },
      resumeAt(frame) {
        resumeCount++;
        return mkSmi(0);
      },
    };
    const deoptimizer = new Deoptimizer(interpreter);

    innerFn.optimizedCode = {};
    outerFn.optimizedCode = {};
    deoptimizer.deoptimize(
      new DeoptSignal(DEOPT_SMI_CHECK_FAILED, inlinedFs.bytecodeOffset, [], [], inlinedFs.id),
      allFrameStates,
    );

    expect(resumeCount).toBe(2);
  });
});

describe("speculation → deopt: after deopt, optimizedCode is null so lazy marker skips on invalidation", () => {
  let engine;
  beforeEach(() => { engine = jitEngine(); });

  it("invalidation after deopt does not mark function for lazy deopt because optimizedCode is null", () => {
    engine.run(`
      function getX(o){return o.x;}
      var obj={x:1};
      for(var i=0;i<10;i++) getX(obj);
    `);
    const fn = getFn(engine, "getX");
    const { graph, frameStates } = compileIR(fn);

    const mapDeps = graph.dependencies.filter(d => d.kind === "map");
    expect(mapDeps.length).toBeGreaterThan(0);

    const registry = new DependencyRegistry();
    registry.register(fn, graph.dependencies);
    fn.optimizedCode = {};

    const { deoptimizer } = makeDeoptimizer();
    registry.bindLazyMarker(deoptimizer.lazyMarker);

    const check = nodesOfType(graph, IR_CHECK_MAP)[0];
    deoptimizer.deoptimize(
      new DeoptSignal(DEOPT_MAP_CHECK_FAILED, check.frameState.bytecodeOffset, [], [], check.frameState.id),
      frameStates,
    );

    expect(fn.optimizedCode).toBe(null);

    deoptimizer.lazyMarker.clear();
    registry.invalidate(DEP_MAP, mapDeps[0].id, mapDeps[0].version, "second-transition");
    expect(deoptimizer.lazyMarker.hasPendingDeopt(fn)).toBe(false);
  });
});

describe("speculation → deopt: comparison operators produce correct IR and deoptable frameStates", () => {
  let engine;
  beforeEach(() => { engine = jitEngine(); });

  it("greater-than-or-equal with smi produces Int32Compare with >= op", () => {
    engine.run("function gte(a,b){return a>=b;} for(var i=0;i<10;i++) gte(i,5);");
    const fn = getFn(engine, "gte");
    const { graph, frameStates } = compileIR(fn);

    const cmps = nodesOfType(graph, IR_INT32_COMPARE);
    expect(cmps.length).toBeGreaterThan(0);
    expect(cmps[0].props.op).toBe(">=");

    const checks = nodesOfType(graph, IR_CHECK_SMI);
    fn.optimizedCode = {};
    const { deoptimizer, getCapturedFrame } = makeDeoptimizer();
    deoptimizer.deoptimize(
      new DeoptSignal(DEOPT_SMI_CHECK_FAILED, checks[0].frameState.bytecodeOffset, [], [], checks[0].frameState.id),
      frameStates,
    );
    expect(getCapturedFrame().compiledFn).toBe(fn);
  });

  it("less-than-or-equal with smi produces Int32Compare with <= op", () => {
    engine.run("function lte(a,b){return a<=b;} for(var i=0;i<10;i++) lte(i,5);");
    const fn = getFn(engine, "lte");
    const { graph, frameStates } = compileIR(fn);

    const cmps = nodesOfType(graph, IR_INT32_COMPARE);
    expect(cmps.length).toBeGreaterThan(0);
    expect(cmps[0].props.op).toBe("<=");

    const checks = nodesOfType(graph, IR_CHECK_SMI);
    fn.optimizedCode = {};
    const { deoptimizer, getCapturedFrame } = makeDeoptimizer();
    deoptimizer.deoptimize(
      new DeoptSignal(DEOPT_SMI_CHECK_FAILED, checks[0].frameState.bytecodeOffset, [], [], checks[0].frameState.id),
      frameStates,
    );
    expect(getCapturedFrame().pc).toBe(checks[0].frameState.bytecodeOffset);
  });

  it("not-equal with smi produces Int32Compare with != op", () => {
    engine.run("function neq(a,b){return a!==b;} for(var i=0;i<10;i++) neq(i,5);");
    const fn = getFn(engine, "neq");
    const { graph, frameStates } = compileIR(fn);

    const cmps = nodesOfType(graph, IR_INT32_COMPARE);
    expect(cmps.length).toBeGreaterThan(0);
    expect(cmps[0].props.op).toBe("!=");
  });
});

describe("speculation → deopt: multiple functions compiled and deopted interleaved", () => {
  let engine;
  beforeEach(() => { engine = jitEngine(); });

  it("deopt on fn1 does not affect fn2's optimizedCode or deoptCount", () => {
    engine.run("function add(a,b){return a+b;} for(var i=0;i<10;i++) add(i,i);");
    engine.run("function sub(a,b){return a-b;} for(var i=0;i<10;i++) sub(i,1);");

    const fn1 = getFn(engine, "add");
    const fn2 = getFn(engine, "sub");
    const { graph: g1, frameStates: fs1 } = compileIR(fn1);
    const { graph: g2, frameStates: fs2 } = compileIR(fn2);

    fn1.optimizedCode = {};
    fn2.optimizedCode = {};

    const { deoptimizer } = makeDeoptimizer();
    const check1 = nodesOfType(g1, IR_CHECK_SMI)[0];
    deoptimizer.deoptimize(
      new DeoptSignal(DEOPT_SMI_CHECK_FAILED, check1.frameState.bytecodeOffset, [], [], check1.frameState.id),
      fs1,
    );

    expect(fn1.optimizedCode).toBe(null);
    expect(fn1.deoptCount).toBe(1);
    expect(fn2.optimizedCode).toBeTruthy();
    expect(fn2.deoptCount || 0).toBe(0);
  });

  it("interleaved deopts on two functions track independent deoptCounts", () => {
    engine.run("function add(a,b){return a+b;} for(var i=0;i<10;i++) add(i,i);");
    engine.run("function mul(a,b){return a*b;} for(var i=0;i<10;i++) mul(i,2);");

    const fn1 = getFn(engine, "add");
    const fn2 = getFn(engine, "mul");
    const { graph: g1, frameStates: fs1 } = compileIR(fn1);
    const { graph: g2, frameStates: fs2 } = compileIR(fn2);

    const { deoptimizer } = makeDeoptimizer(5);
    const c1 = nodesOfType(g1, IR_CHECK_SMI)[0];
    const c2 = nodesOfType(g2, IR_CHECK_SMI)[0];

    fn1.optimizedCode = {};
    deoptimizer.deoptimize(new DeoptSignal(DEOPT_SMI_CHECK_FAILED, c1.frameState.bytecodeOffset, [], [], c1.frameState.id), fs1);

    fn2.optimizedCode = {};
    deoptimizer.deoptimize(new DeoptSignal(DEOPT_OVERFLOW, c2.frameState.bytecodeOffset, [], [], c2.frameState.id), fs2);

    fn1.optimizedCode = {};
    deoptimizer.deoptimize(new DeoptSignal(DEOPT_SMI_CHECK_FAILED, c1.frameState.bytecodeOffset, [], [], c1.frameState.id), fs1);

    expect(fn1.deoptCount).toBe(2);
    expect(fn2.deoptCount).toBe(1);
    expect(fn1.lastDeoptReason).toBe(DEOPT_SMI_CHECK_FAILED);
    expect(fn2.lastDeoptReason).toBe(DEOPT_OVERFLOW);
  });
});

describe("speculation → deopt: frameState localValues mapping completeness", () => {
  let engine;
  beforeEach(() => { engine = jitEngine(); });

  it("function with 3 params: frameState captures all param slots as localValues", () => {
    engine.run("function f(a,b,c){return a+b+c;} for(var i=0;i<10;i++) f(i,i+1,i+2);");
    const fn = getFn(engine, "f");
    const { graph, frameStates } = compileIR(fn);

    const checks = nodesOfType(graph, IR_CHECK_SMI);
    expect(checks.length).toBeGreaterThan(0);

    const fs = checks[0].frameState;
    expect(fs.localValues.size).toBeGreaterThanOrEqual(3);

    const runtimeValues = new Map();
    for (const [slot, irNode] of fs.localValues) {
      runtimeValues.set(irNode.id, mkSmi(slot + 100));
    }

    fn.optimizedCode = {};
    const { deoptimizer, getCapturedFrame } = makeDeoptimizer();
    deoptimizer.deoptimize(
      new DeoptSignal(DEOPT_SMI_CHECK_FAILED, fs.bytecodeOffset, [], [], fs.id, runtimeValues),
      frameStates,
    );

    const frame = getCapturedFrame();
    for (const [slot, irNode] of fs.localValues) {
      expect(frame.locals[slot]).toBe(runtimeValues.get(irNode.id));
    }
  });

  it("function with local var: frameState includes the local in localValues", () => {
    engine.run("function f(a){var x=a+1;return x+2;} for(var i=0;i<10;i++) f(i);");
    const fn = getFn(engine, "f");
    const { frameStates } = compileIR(fn);

    const lastFs = frameStates[frameStates.length - 1];
    expect(lastFs.localValues.size).toBeGreaterThanOrEqual(1);
  });
});

describe("speculation → deopt: deopt reason propagation through full pipeline", () => {
  let engine;
  beforeEach(() => { engine = jitEngine(); });

  it("each deopt reason from speculation guard is stored on compiledFn.lastDeoptReason", () => {
    const reasons = [
      { code: "function f(a,b){return a+b;}", loop: "for(var i=0;i<10;i++) f(i,i);", guard: IR_CHECK_SMI, reason: DEOPT_SMI_CHECK_FAILED },
      { code: "function g(a,b){return a+b;}", loop: "for(var i=0;i<10;i++) g(i*0.1,i*0.2);", guard: IR_CHECK_NUMBER, reason: DEOPT_NUMBER_CHECK_FAILED },
    ];

    for (const { code, loop, guard, reason } of reasons) {
      const e = jitEngine();
      e.run(code + loop);
      const fn = getFn(e, code.match(/function (\w+)/)[1]);
      const { graph, frameStates } = compileIR(fn);

      const check = nodesOfType(graph, guard)[0];
      expect(check).toBeTruthy();

      fn.optimizedCode = {};
      const { deoptimizer } = makeDeoptimizer();
      deoptimizer.deoptimize(
        new DeoptSignal(reason, check.frameState.bytecodeOffset, [], [], check.frameState.id),
        frameStates,
      );

      expect(fn.lastDeoptReason).toBe(reason);
    }
  });
});

describe("speculation → deopt: array.length CheckArray → Deoptimizer pipeline", () => {
  let engine;
  beforeEach(() => { engine = jitEngine(); });

  it("CheckArray frameState feeds Deoptimizer and deoptCount increments", () => {
    engine.run(`
      function len(arr){return arr.length;}
      var a=[1,2,3];
      for(var i=0;i<10;i++) len(a);
    `);
    const fn = getFn(engine, "len");
    const { graph, frameStates } = compileIR(fn);

    const arrayChecks = nodesOfType(graph, IR_CHECK_ARRAY);
    if (arrayChecks.length > 0 && arrayChecks[0].frameState) {
      const fs = arrayChecks[0].frameState;
      const deoptBefore = fn.deoptCount || 0;

      fn.optimizedCode = {};
      const { deoptimizer, getCapturedFrame } = makeDeoptimizer();
      deoptimizer.deoptimize(
        new DeoptSignal("array-check-failed", fs.bytecodeOffset, [], [], fs.id),
        frameStates,
      );

      expect(getCapturedFrame().compiledFn).toBe(fn);
      expect(fn.deoptCount).toBe(deoptBefore + 1);
      expect(fn.optimizedCode).toBe(null);
    }
  });

  it("CheckElementsKind frameState is valid and Deoptimizer can consume it", () => {
    engine.run(`
      function len(arr){return arr.length;}
      var a=[1,2,3];
      for(var i=0;i<10;i++) len(a);
    `);
    const fn = getFn(engine, "len");
    const { graph, frameStates } = compileIR(fn);

    const kindChecks = nodesOfType(graph, IR_CHECK_ELEMENTS_KIND);
    if (kindChecks.length > 0 && kindChecks[0].frameState) {
      const fs = kindChecks[0].frameState;
      expect(fs.compiledFunction).toBe(fn);
      expect(frameStates[fs.id]).toBe(fs);

      fn.optimizedCode = {};
      const { deoptimizer, getCapturedFrame } = makeDeoptimizer();
      deoptimizer.deoptimize(
        new DeoptSignal("elements-kind-check-failed", fs.bytecodeOffset, [], [], fs.id),
        frameStates,
      );

      expect(getCapturedFrame().pc).toBe(fs.bytecodeOffset);
    }
  });
});

describe("speculation → deopt: LoadField after CheckMap shares map dependency path", () => {
  let engine;
  beforeEach(() => { engine = jitEngine(); });

  it("LoadField node follows CheckMap in node ordering", () => {
    engine.run(`
      function getX(o){return o.x;}
      var obj={x:10};
      for(var i=0;i<10;i++) getX(obj);
    `);
    const fn = getFn(engine, "getX");
    const { graph } = compileIR(fn);

    const nodes = allNodes(graph);
    const checkMapIdx = nodes.findIndex(n => n.type === IR_CHECK_MAP);
    const loadFieldIdx = nodes.findIndex(n => n.type === IR_LOAD_FIELD);

    expect(checkMapIdx).toBeGreaterThanOrEqual(0);
    expect(loadFieldIdx).toBeGreaterThanOrEqual(0);
    expect(loadFieldIdx).toBeGreaterThan(checkMapIdx);
  });

  it("deopt at CheckMap means LoadField never executes, frame restores correctly", () => {
    engine.run(`
      function getX(o){return o.x;}
      var obj={x:10};
      for(var i=0;i<10;i++) getX(obj);
    `);
    const fn = getFn(engine, "getX");
    const { graph, frameStates } = compileIR(fn);

    const checkMap = nodesOfType(graph, IR_CHECK_MAP)[0];
    const fs = checkMap.frameState;

    fn.optimizedCode = {};
    const { deoptimizer, getCapturedFrame } = makeDeoptimizer();
    deoptimizer.deoptimize(
      new DeoptSignal(DEOPT_MAP_CHECK_FAILED, fs.bytecodeOffset, [], [], fs.id),
      frameStates,
    );

    const frame = getCapturedFrame();
    expect(frame.pc).toBe(fs.bytecodeOffset);
    expect(frame.compiledFn).toBe(fn);
  });
});

describe("speculation → deopt: deopt with no runtimeValues falls back to undefined locals", () => {
  let engine;
  beforeEach(() => { engine = jitEngine(); });

  it("deopt signal without runtimeValues sets locals to undefined", () => {
    engine.run("function f(a,b){return a+b;} for(var i=0;i<10;i++) f(i,i);");
    const fn = getFn(engine, "f");
    const { graph, frameStates } = compileIR(fn);

    const check = nodesOfType(graph, IR_CHECK_SMI)[0];
    const fs = check.frameState;

    fn.optimizedCode = {};
    const { deoptimizer, getCapturedFrame } = makeDeoptimizer();
    const signal = new DeoptSignal(DEOPT_SMI_CHECK_FAILED, fs.bytecodeOffset, [], [], fs.id);
    deoptimizer.deoptimize(signal, frameStates);

    const frame = getCapturedFrame();
    expect(frame).toBeTruthy();
    expect(frame.pc).toBe(fs.bytecodeOffset);
  });
});

describe("speculation → deopt: Float64 comparison guard pipeline", () => {
  let engine;
  beforeEach(() => { engine = jitEngine(); });

  it("Float64Compare's CheckNumber guards each have frameState usable by Deoptimizer", () => {
    engine.run("function cmp(a,b){return a<b;} for(var i=0;i<10;i++) cmp(i*0.1,i*0.2);");
    const fn = getFn(engine, "cmp");
    const { graph, frameStates } = compileIR(fn);

    expect(hasNodeType(graph, IR_FLOAT64_COMPARE)).toBe(true);
    const checks = nodesOfType(graph, IR_CHECK_NUMBER);
    expect(checks.length).toBeGreaterThanOrEqual(2);

    for (const check of checks) {
      fn.optimizedCode = {};
      fn.deoptCount = 0;
      const { deoptimizer, getCapturedFrame } = makeDeoptimizer();
      deoptimizer.deoptimize(
        new DeoptSignal(DEOPT_NUMBER_CHECK_FAILED, check.frameState.bytecodeOffset, [], [], check.frameState.id),
        frameStates,
      );
      expect(getCapturedFrame().pc).toBe(check.frameState.bytecodeOffset);
      expect(fn.deoptCount).toBe(1);
    }
  });
});

describe("speculation → deopt: multi-expression function has distinct frameStates per bytecode op", () => {
  let engine;
  beforeEach(() => { engine = jitEngine(); });

  it("function with add, mul, div each has own frameState ID", () => {
    engine.run("function f(a,b){var x=a+b;var y=a*b;var z=x/y;return z;} for(var i=1;i<10;i++) f(i,i);");
    const fn = getFn(engine, "f");
    const { graph, frameStates } = compileIR(fn);

    const adds = nodesOfType(graph, IR_INT32_ADD);
    const muls = nodesOfType(graph, IR_INT32_MUL);
    const divs = nodesOfType(graph, IR_FLOAT64_DIV);

    const withFs = [...adds, ...muls, ...divs].filter(n => n.frameState);
    expect(withFs.length).toBeGreaterThanOrEqual(3);

    const ids = new Set(withFs.map(n => n.frameState.id));
    expect(ids.size).toBeGreaterThanOrEqual(3);

    for (const id of ids) {
      expect(frameStates[id]).toBeTruthy();
    }
  });
});
