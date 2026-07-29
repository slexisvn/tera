import { clone, getPath, renderProgram, setPath, shapeOf, subExprs, walkProgram } from "./ir.mjs";

const LITERAL_KINDS = new Set(["num", "str", "bool", "nul", "undef", "ident"]);
const PROTECTED_FUNCS = new Set(["run", "driver"]);

const REPLACEMENTS = [
  { k: "num", v: 0 },
  { k: "num", v: 1 },
  { k: "str", v: "" },
  { k: "bool", v: false },
  { k: "nul" },
];

export const size = (program) => renderProgram(program).length;

function numberLadder(value) {
  if (!Number.isFinite(value)) return [0, 1];
  const out = [];
  if (Math.abs(value) > 1) {
    const halved = Math.trunc(value / 2);
    if (halved !== value) out.push(halved);
  }
  if (value !== 0) out.push(0);
  if (value !== 1 && Math.abs(value) > 1) out.push(1);
  return out;
}

function comparePaths(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    if (typeof a[i] === "number" && typeof b[i] === "number") return a[i] - b[i];
    return String(a[i]) < String(b[i]) ? -1 : 1;
  }
  return a.length - b.length;
}

function collect(program, kind) {
  const paths = [];
  walkProgram(program, (site) => {
    if (site.kind === kind) paths.push(site.path);
  });
  return paths.sort(comparePaths).reverse();
}

function sweep(program, paths, attempt, context) {
  let best = program;
  for (const path of paths) {
    if (context.shouldStop()) return best;
    const improved = attempt(best, path, context);
    if (improved !== null) best = improved;
  }
  return best;
}

function offer(best, mutate, context) {
  const candidate = clone(best);
  if (mutate(candidate) === false) return null;
  if (size(candidate) >= size(best)) return null;
  if (!context.test(candidate)) return null;
  context.accept(candidate);
  return candidate;
}

const dropStatements = (program, context) =>
  sweep(program, collect(program, "stmt"), (best, path) =>
    offer(best, (copy) => {
      getPath(copy, path.slice(0, -1)).splice(path[path.length - 1], 1);
    }, context), context);

const promoteBlocks = (program, context) =>
  sweep(program, collect(program, "stmt"), (best, path) => {
    const node = getPath(best, path);
    for (const slot of shapeOf(node).stmtLists ?? []) {
      if (node[slot] == null) continue;
      const improved = offer(best, (copy) => {
        const stmt = getPath(copy, path);
        getPath(copy, path.slice(0, -1)).splice(path[path.length - 1], 1, ...stmt[slot]);
      }, context);
      if (improved !== null) return improved;
    }
    return null;
  }, context);

function dropFunctions(program, context) {
  let best = program;
  for (let i = program.funcs.length - 1; i >= 0; i--) {
    if (context.shouldStop()) return best;
    const target = best.funcs[i];
    if (target === undefined || PROTECTED_FUNCS.has(target.name)) continue;
    const improved = offer(best, (copy) => {
      copy.funcs.splice(i, 1);
      const replacements = [];
      walkProgram(copy, (site) => {
        if (site.kind === "expr" && site.node.k === "call" && site.node.callee === target.name) {
          replacements.push(site.path);
        }
      });
      for (const path of replacements.sort(comparePaths).reverse()) {
        setPath(copy, path, { k: "num", v: 0 });
      }
    }, context);
    if (improved !== null) best = improved;
  }
  return best;
}

function dropGlobals(program, context) {
  let best = program;
  for (let i = program.globals.length - 1; i >= 0; i--) {
    if (context.shouldStop()) return best;
    const improved = offer(best, (copy) => {
      if (i >= copy.globals.length) return false;
      copy.globals.splice(i, 1);
    }, context);
    if (improved !== null) best = improved;
  }
  return best;
}

const dropElements = (program, context) =>
  sweep(program, collect(program, "expr"), (best, path) => {
    let current = best;
    for (const [slot, isPair] of listSlots(getPath(current, path))) {
      for (let i = getPath(current, path)[slot].length - 1; i >= 0; i--) {
        if (context.shouldStop()) return current === best ? null : current;
        const improved = offer(current, (copy) => {
          const list = getPath(copy, path)[slot];
          if (i >= list.length) return false;
          list.splice(i, 1);
        }, context);
        if (improved !== null) current = improved;
      }
      void isPair;
    }
    return current === best ? null : current;
  }, context);

function listSlots(node) {
  const shape = shapeOf(node);
  const out = [];
  for (const slot of shape.exprLists ?? []) if (node[slot] != null) out.push([slot, false]);
  for (const slot of shape.pairLists ?? []) if (node[slot] != null) out.push([slot, true]);
  return out;
}

const hoistSubExpressions = (program, context) =>
  sweep(program, collect(program, "expr"), (best, path) => {
    for (const child of subExprs(getPath(best, path))) {
      const replacement = clone(child);
      const improved = offer(best, (copy) => setPath(copy, path, replacement), context);
      if (improved !== null) return improved;
    }
    return null;
  }, context);

const simplifyExpressions = (program, context) =>
  sweep(program, collect(program, "expr"), (best, path) => {
    if (LITERAL_KINDS.has(getPath(best, path).k)) return null;
    for (const replacement of REPLACEMENTS) {
      const improved = offer(best, (copy) => setPath(copy, path, clone(replacement)), context);
      if (improved !== null) return improved;
    }
    return null;
  }, context);

const shrinkNumbers = (program, context) =>
  sweep(program, collect(program, "expr"), (best, path) => {
    let current = best;
    for (;;) {
      const node = getPath(current, path);
      if (node.k !== "num") return current === best ? null : current;
      let stepped = false;
      for (const value of numberLadder(node.v)) {
        const improved = offer(current, (copy) => setPath(copy, path, { k: "num", v: value }), context);
        if (improved === null) continue;
        current = improved;
        stepped = true;
        break;
      }
      if (!stepped) return current === best ? null : current;
    }
  }, context);

const PASSES = [
  dropFunctions,
  dropStatements,
  promoteBlocks,
  dropGlobals,
  dropElements,
  hoistSubExpressions,
  simplifyExpressions,
  shrinkNumbers,
];

export function reduce(program, context) {
  let best = program;
  for (;;) {
    const before = size(best);
    for (const pass of PASSES) {
      best = pass(best, context);
      if (context.shouldStop()) return best;
    }
    if (size(best) >= before) return best;
  }
}
