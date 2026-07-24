const SHAPES = {
  num: {},
  str: {},
  bool: {},
  nul: {},
  undef: {},
  ident: {},
  var: {},
  bin: { exprs: ["l", "r"] },
  un: { exprs: ["e"] },
  cond: { exprs: ["c", "a", "b"] },
  call: { exprLists: ["args"] },
  calldyn: { exprs: ["callee"], exprLists: ["args"] },
  obj: { pairLists: ["fields"] },
  arr: { exprLists: ["items"] },
  prop: { exprs: ["obj"] },
  index: { exprs: ["obj", "index"] },
  method: { exprs: ["obj"], exprLists: ["args"] },
  tof: { exprs: ["e"] },
  lambda: { exprs: ["body"] },
  let: { exprs: ["value"] },
  setprop: { exprs: ["obj", "value"] },
  setindex: { exprs: ["obj", "index", "value"] },
  if: { exprs: ["cond"], stmtLists: ["then", "alt"] },
  while: { exprs: ["cond"], stmtLists: ["body"] },
  forof: { exprs: ["iter"], stmtLists: ["body"] },
  ret: { exprs: ["value"] },
  brk: {},
  cont: {},
  exprstmt: { exprs: ["value"] },
  nested: { fnSlot: "fn" },
};

export const shapeOf = (node) => SHAPES[node.k] ?? {};

export const STMT_KINDS = new Set([
  "let",
  "setprop",
  "setindex",
  "if",
  "while",
  "forof",
  "ret",
  "brk",
  "cont",
  "exprstmt",
  "nested",
]);

export function subExprs(node) {
  const shape = shapeOf(node);
  const out = [];
  for (const slot of shape.exprs ?? []) {
    if (node[slot] != null) out.push(node[slot]);
  }
  for (const slot of shape.exprLists ?? []) {
    for (const item of node[slot] ?? []) out.push(item);
  }
  for (const slot of shape.pairLists ?? []) {
    for (const pair of node[slot] ?? []) out.push(pair[1]);
  }
  return out;
}

export function subStmtLists(node) {
  const shape = shapeOf(node);
  const out = [];
  for (const slot of shape.stmtLists ?? []) {
    if (node[slot] != null) out.push({ owner: node, slot, list: node[slot] });
  }
  if (shape.fnSlot !== undefined) {
    out.push({ owner: node[shape.fnSlot], slot: "body", list: node[shape.fnSlot].body });
  }
  return out;
}

export function getPath(root, path) {
  let node = root;
  for (const key of path) node = node[key];
  return node;
}

export function setPath(root, path, value) {
  const parent = getPath(root, path.slice(0, -1));
  parent[path[path.length - 1]] = value;
}

function walkExpr(node, path, visit) {
  visit({ kind: "expr", node, path });
  const shape = shapeOf(node);
  for (const slot of shape.exprs ?? []) {
    if (node[slot] != null) walkExpr(node[slot], [...path, slot], visit);
  }
  for (const slot of shape.exprLists ?? []) {
    (node[slot] ?? []).forEach((item, i) => walkExpr(item, [...path, slot, i], visit));
  }
  for (const slot of shape.pairLists ?? []) {
    (node[slot] ?? []).forEach((pair, i) => walkExpr(pair[1], [...path, slot, i, 1], visit));
  }
}

function walkStmts(list, path, visit) {
  visit({ kind: "stmtList", node: list, path });
  list.forEach((stmt, i) => {
    const stmtPath = [...path, i];
    visit({ kind: "stmt", node: stmt, path: stmtPath });
    const shape = shapeOf(stmt);
    for (const slot of shape.exprs ?? []) {
      if (stmt[slot] != null) walkExpr(stmt[slot], [...stmtPath, slot], visit);
    }
    for (const slot of shape.stmtLists ?? []) {
      if (stmt[slot] != null) walkStmts(stmt[slot], [...stmtPath, slot], visit);
    }
    if (shape.fnSlot !== undefined) walkStmts(stmt[shape.fnSlot].body, [...stmtPath, shape.fnSlot, "body"], visit);
  });
}

export function walkProgram(program, visit) {
  program.globals.forEach((global, i) => walkExpr(global.init, ["globals", i, "init"], visit));
  program.funcs.forEach((fn, i) => walkStmts(fn.body, ["funcs", i, "body"], visit));
  walkStmts(program.top, ["top"], visit);
}

export function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value === null || typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value)) out[key] = clone(value[key]);
  return out;
}

const numberLiteral = (v) => {
  if (Object.is(v, -0)) return "(-(0.0))";
  if (Number.isNaN(v)) return "NaN";
  if (v === Infinity) return "Infinity";
  if (v === -Infinity) return "(-(Infinity))";
  return String(v);
};

const stringLiteral = (v) => `"${v}"`;

export function renderExpr(node) {
  switch (node.k) {
    case "num":
      return numberLiteral(node.v);
    case "str":
      return stringLiteral(node.v);
    case "bool":
      return node.v ? "true" : "false";
    case "nul":
      return "null";
    case "undef":
      return "undefined";
    case "ident":
    case "var":
      return node.name;
    case "bin": {
      const left = renderExpr(node.l);
      const right = renderExpr(node.r);
      if (node.op === ">" && right.startsWith("(")) return `(${right} < ${left})`;
      return `(${left} ${node.op} ${right})`;
    }
    case "un":
      return `(${node.op} ${renderExpr(node.e)})`;
    case "cond":
      return `(${renderExpr(node.c)} ? ${renderExpr(node.a)} : ${renderExpr(node.b)})`;
    case "call":
      return `${node.callee}(${node.args.map(renderExpr).join(", ")})`;
    case "calldyn":
      return `(${renderExpr(node.callee)})(${node.args.map(renderExpr).join(", ")})`;
    case "obj":
      return `{${node.fields.map(([key, value]) => `${key}: ${renderExpr(value)}`).join(", ")}}`;
    case "arr":
      return `[${node.items.map(renderExpr).join(", ")}]`;
    case "prop":
      return `(${renderExpr(node.obj)})${node.opt ? "?." : "."}${node.name}`;
    case "index":
      return `(${renderExpr(node.obj)})${node.opt ? "?.[" : "["}${renderExpr(node.index)}]`;
    case "method":
      return `(${renderExpr(node.obj)}).${node.name}(${node.args.map(renderExpr).join(", ")})`;
    case "tof":
      return `(typeof ${renderExpr(node.e)})`;
    case "lambda":
      return `(${node.params.join(", ")}) => (${renderExpr(node.body)})`;
    default:
      throw new Error(`unrenderable expression ${node.k}`);
  }
}

function renderStmt(node, pad, out) {
  switch (node.k) {
    case "let":
      out.push(`${pad}${node.name} ${node.op} ${renderExpr(node.value)}`);
      return;
    case "setprop":
      out.push(`${pad}(${renderExpr(node.obj)}).${node.name} ${node.op} ${renderExpr(node.value)}`);
      return;
    case "setindex":
      out.push(
        `${pad}(${renderExpr(node.obj)})[${renderExpr(node.index)}] ${node.op} ${renderExpr(node.value)}`,
      );
      return;
    case "if":
      out.push(`${pad}if ${renderExpr(node.cond)}:`);
      renderBody(node.then, pad, out);
      if (node.alt !== null && node.alt !== undefined) {
        out.push(`${pad}else:`);
        renderBody(node.alt, pad, out);
      }
      return;
    case "while":
      out.push(`${pad}while ${renderExpr(node.cond)}:`);
      renderBody(node.body, pad, out);
      return;
    case "forof":
      out.push(`${pad}for ${node.name} of ${renderExpr(node.iter)}:`);
      renderBody(node.body, pad, out);
      return;
    case "ret":
      out.push(node.value === null ? `${pad}return` : `${pad}return ${renderExpr(node.value)}`);
      return;
    case "brk":
      out.push(`${pad}break`);
      return;
    case "cont":
      out.push(`${pad}continue`);
      return;
    case "exprstmt":
      out.push(`${pad}${renderExpr(node.value)}`);
      return;
    case "nested":
      out.push(`${pad}fn ${node.fn.name}(${node.fn.params.join(", ")}):`);
      renderBody(node.fn.body, pad, out);
      return;
    default:
      throw new Error(`unrenderable statement ${node.k}`);
  }
}

function renderBody(stmts, pad, out) {
  const inner = `${pad}  `;
  if (stmts.length === 0) {
    out.push(`${inner}0`);
    return;
  }
  for (const stmt of stmts) renderStmt(stmt, inner, out);
}

export function renderProgram(program) {
  const out = [];
  for (const global of program.globals) {
    out.push(`${global.name} = ${renderExpr(global.init)}`);
  }
  for (const fn of program.funcs) {
    out.push(`fn ${fn.name}(${fn.params.join(", ")}):`);
    renderBody(fn.body, "", out);
  }
  for (const stmt of program.top) renderStmt(stmt, "", out);
  return out.join("\n");
}
