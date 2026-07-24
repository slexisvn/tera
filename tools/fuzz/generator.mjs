import { makeRng } from "./rng.mjs";
import { renderProgram } from "./ir.mjs";

const BOUNDARY_NUMBERS = [
  0, -0, 1, -1, 2, 3, 7, 8, 31, 32, 63, 64, 65,
  1023, 1024, 1025, 2048,
  49151, 49152, 49153, 49215, 49216,
  65535, 65536,
  2147483646, 2147483647, 2147483648, -2147483647, -2147483648, -2147483649,
  4294967295, 4294967296,
  9007199254740991, 9007199254740992,
  0.5, -0.5, 0.1, 1.5, -1.5, 0.3333333333333333,
  1e-308, 1e308, NaN, Infinity, -Infinity,
];

const SMALL_NUMBERS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 16, 31, 32, -1, -2, 0.5, 1.5];

const ARITH_OPS = ["+", "-", "*", "/", "%", "**"];
const BIT_OPS = ["|", "&", "^", "<<", ">>", ">>>"];
const CMP_OPS = ["<", "<=", ">", ">=", "==", "!=", "===", "!=="];
const LOGIC_OPS = ["and", "or"];
const NUM_COMPOUND_OPS = ["+=", "-=", "*=", "|=", "&=", "^="];
const FIELD_NAMES = ["a", "b", "c", "d", "x", "y", "z"];
const STRING_ATOMS = ["", "a", "ab", "abc", "q", "0", "1", "1024", "true", "null", "xyz"];
const TYPEOF_NAMES = ["number", "string", "boolean", "object", "undefined", "function"];
const METHOD_FIELD = "m";
const PUSH_LIMIT = 16;
const RESULT_TEXT_LIMIT = 32;

const HINTS = ["num", "str", "bool", "obj", "arr", "any"];
const SCALAR_HINTS = ["num", "str", "bool", "nullish"];
const GLOBAL_HINTS = ["num", "str", "bool", "obj", "arr"];
const ACC_SEEDS = [0, 1, 1024, 49152, 2147483647];
const ITERATION_COUNTS = [600, 1200, 2400, 3000];

const num = (v) => ({ k: "num", v });
const str = (v) => ({ k: "str", v });
const ident = (name) => ({ k: "ident", name });
const bin = (op, l, r) => ({ k: "bin", op, l, r });
const un = (op, e) => ({ k: "un", op, e });
const cond = (c, a, b) => ({ k: "cond", c, a, b });
const call = (callee, args) => ({ k: "call", callee, args });
const method = (obj, name, args) => ({ k: "method", obj, name, args });
const prop = (obj, name) => ({ k: "prop", obj, name, opt: true });
const rawProp = (obj, name) => ({ k: "prop", obj, name, opt: false });
const index = (obj, key) => ({ k: "index", obj, index: key, opt: true });
const text = (e) => bin("+", str(""), e);
const typeOf = (e) => ({ k: "tof", e });
const objlit = (fields) => ({ k: "obj", fields });
const arrlit = (items) => ({ k: "arr", items });
const assign = (name, op, value) => ({ k: "let", name, op, value });
const ret = (value) => ({ k: "ret", value });

const FOLD_MODES = [
  (acc, value) => bin("%", bin("+", bin("*", acc, num(31)), value), num(1000003)),
  (acc, value) => bin("^", acc, value),
  (acc, value) => bin("+", acc, value),
  (acc, value) => bin("%", bin("+", acc, value), num(2147483647)),
  (acc, value) => bin("|", bin("+", bin("<<", acc, num(1)), value), num(0)),
  (acc, value) => bin("-", acc, value),
  (acc, value) => bin("*", acc, bin("|", value, num(1))),
];

const ACCUMULATOR = "acc";
const SECONDARY = "sec";
const TEXT = "txt";
const COUNTER = "i";
const CURRENT = "cur";
const WITNESS = "wit";
const ITERATIONS = "n";
const DRIVER_COUNTS = [200, 400, 800];
const DRIVER_INNER = [3, 5, 8, 12];

class Generator {
  constructor(seed) {
    this.rng = makeRng(seed);
    this.uid = 0;
    this.funcs = [];
    this.globals = [];
    this.closures = [];
  }

  fresh(prefix) {
    this.uid += 1;
    return `${prefix}${this.uid}`;
  }

  varOf(scope, hint) {
    const matching = scope.filter((v) => v.hint === hint);
    const pool = matching.length > 0 && this.rng.chance(0.75)
      ? matching
      : scope.filter((v) => v.hint !== "fn");
    if (pool.length === 0) return null;
    return ident(this.rng.pick(pool).name);
  }

  varsWith(ctx, hint) {
    return ctx.scope.filter((v) => v.hint === hint);
  }

  numberAtom() {
    return num(this.rng.chance(0.45) ? this.rng.pick(BOUNDARY_NUMBERS) : this.rng.pick(SMALL_NUMBERS));
  }

  genCall(ctx, depth) {
    const options = this.funcs.filter((fn) => fn.order < ctx.order);
    if (options.length === 0) return null;
    const target = this.rng.pick(options);
    const args = target.params.map((_, position) =>
      target.recursive && position === 0
        ? num(this.rng.range(2, 6))
        : this.genExpr(ctx, this.rng.pick(HINTS), depth - 1));
    return call(target.name, args);
  }

  genClosureCall(ctx, depth) {
    const closures = this.varsWith(ctx, "fn");
    if (closures.length === 0) return null;
    const target = this.rng.pick(closures);
    const args = Array.from({ length: target.arity }, () =>
      this.genExpr(ctx, this.rng.pick(HINTS), depth - 1));
    return { k: "calldyn", callee: ident(target.name), args };
  }

  genMethodCall(ctx, depth) {
    const objs = this.varsWith(ctx, "obj");
    if (objs.length === 0) return null;
    const receiver = ident(this.rng.pick(objs).name);
    return cond(
      bin("===", typeOf(prop(receiver, METHOD_FIELD)), str("function")),
      method(receiver, METHOD_FIELD, [receiver]),
      this.genExpr(ctx, "num", depth - 1),
    );
  }

  genNum(ctx, depth) {
    if (depth <= 0) return this.varOf(ctx.scope, "num") ?? this.numberAtom();
    return this.rng.weighted([
      [16, () => this.numberAtom()],
      [18, () => this.varOf(ctx.scope, "num") ?? this.numberAtom()],
      [18, () => bin(this.rng.pick(ARITH_OPS), this.genExpr(ctx, "num", depth - 1), this.genRhs(ctx, depth - 1))],
      [14, () => bin(this.rng.pick(BIT_OPS), this.genExpr(ctx, "num", depth - 1), this.genShiftAmount(ctx, depth - 1))],
      [6, () => un("-", this.genExpr(ctx, "num", depth - 1))],
      [4, () => un("~", this.genExpr(ctx, "num", depth - 1))],
      [7, () => cond(this.genExpr(ctx, "bool", depth - 1), this.genExpr(ctx, "num", depth - 1), this.genExpr(ctx, "num", depth - 1))],
      [10, () => this.genCall(ctx, depth) ?? this.numberAtom()],
      [5, () => this.genClosureCall(ctx, depth) ?? this.numberAtom()],
      [5, () => this.genMethodCall(ctx, depth) ?? this.numberAtom()],
      [9, () => prop(this.genExpr(ctx, "obj", depth - 1), this.rng.pick(FIELD_NAMES))],
      [9, () => index(this.genExpr(ctx, "arr", depth - 1), this.genIndex(ctx, depth - 1))],
      [5, () => prop(this.genExpr(ctx, this.rng.pick(["arr", "str"]), depth - 1), "length")],
    ])();
  }

  genRhs(ctx, depth) {
    return this.rng.chance(0.25) ? num(this.rng.range(0, 4)) : this.genExpr(ctx, "num", depth);
  }

  genShiftAmount(ctx, depth) {
    return this.rng.chance(0.5) ? num(this.rng.range(0, 34)) : this.genExpr(ctx, "num", depth);
  }

  genIndex(ctx, depth) {
    return this.rng.weighted([
      [4, () => num(this.rng.range(-2, 5))],
      [2, () => this.numberAtom()],
      [3, () => this.genExpr(ctx, "num", depth)],
      [2, () => this.genExpr(ctx, "str", depth)],
    ])();
  }

  genStr(ctx, depth) {
    if (depth <= 0) return str(this.rng.pick(STRING_ATOMS));
    return this.rng.weighted([
      [14, () => str(this.rng.pick(STRING_ATOMS))],
      [12, () => this.varOf(ctx.scope, "str") ?? str(this.rng.pick(STRING_ATOMS))],
      [16, () => bin("+", this.genExpr(ctx, "str", depth - 1), this.genExpr(ctx, this.rng.pick(HINTS), depth - 1))],
      [10, () => typeOf(this.genExpr(ctx, this.rng.pick(HINTS), depth - 1))],
      [8, () => method(text(this.genExpr(ctx, "str", depth - 1)), "substring", [num(this.rng.range(0, 2)), num(this.rng.range(1, 6))])],
      [6, () => cond(this.genExpr(ctx, "bool", depth - 1), this.genExpr(ctx, "str", depth - 1), this.genExpr(ctx, "str", depth - 1))],
      [6, () => index(this.genExpr(ctx, "str", depth - 1), this.genIndex(ctx, depth - 1))],
      [5, () => this.genCall(ctx, depth) ?? str(this.rng.pick(STRING_ATOMS))],
    ])();
  }

  genBool(ctx, depth) {
    if (depth <= 0) return { k: "bool", v: this.rng.chance(0.5) };
    return this.rng.weighted([
      [8, () => ({ k: "bool", v: this.rng.chance(0.5) })],
      [8, () => this.varOf(ctx.scope, "bool") ?? { k: "bool", v: true }],
      [26, () => bin(
        this.rng.pick(CMP_OPS),
        this.genExpr(ctx, this.rng.pick(HINTS), depth - 1),
        this.genExpr(ctx, this.rng.pick(HINTS), depth - 1),
      )],
      [12, () => bin(this.rng.pick(LOGIC_OPS), this.genExpr(ctx, "bool", depth - 1), this.genExpr(ctx, "bool", depth - 1))],
      [8, () => un("not", this.genExpr(ctx, "bool", depth - 1))],
      [10, () => bin(
        this.rng.pick(["==", "!=", "===", "!=="]),
        typeOf(this.genExpr(ctx, this.rng.pick(HINTS), depth - 1)),
        str(this.rng.pick(TYPEOF_NAMES)),
      )],
      [6, () => this.genCall(ctx, depth) ?? { k: "bool", v: false }],
    ])();
  }

  genObjLit(ctx, depth) {
    const fields = this.rng.sample(FIELD_NAMES, this.rng.range(1, 3)).map((name) => [
      name,
      this.genExpr(ctx, this.rng.pick(HINTS), depth - 1),
    ]);
    if (this.rng.chance(0.25)) {
      fields.push([METHOD_FIELD, { k: "lambda", params: ["s"], body: this.genLambdaBody(ctx, depth - 1) }]);
    }
    return objlit(fields);
  }

  genLambdaBody(ctx, depth) {
    const inner = { ...ctx, scope: [...ctx.scope, { name: "s", hint: "obj" }] };
    return this.genExpr(inner, this.rng.pick(HINTS), Math.max(1, depth));
  }

  genObj(ctx, depth) {
    if (depth <= 0) return this.varOf(ctx.scope, "obj") ?? objlit([["a", num(1)]]);
    return this.rng.weighted([
      [26, () => this.genObjLit(ctx, depth)],
      [16, () => this.varOf(ctx.scope, "obj") ?? objlit([["a", num(1)]])],
      [8, () => prop(this.genExpr(ctx, "obj", depth - 1), this.rng.pick(FIELD_NAMES))],
      [6, () => cond(this.genExpr(ctx, "bool", depth - 1), this.genExpr(ctx, "obj", depth - 1), this.genExpr(ctx, "obj", depth - 1))],
      [6, () => this.genCall(ctx, depth) ?? objlit([["a", num(1)]])],
      [5, () => index(this.genExpr(ctx, "arr", depth - 1), this.genIndex(ctx, depth - 1))],
    ])();
  }

  genArr(ctx, depth) {
    if (depth <= 0) return this.varOf(ctx.scope, "arr") ?? arrlit([num(1), num(2)]);
    return this.rng.weighted([
      [24, () => arrlit(Array.from({ length: this.rng.range(0, 4) }, () => this.genExpr(ctx, this.rng.pick(HINTS), depth - 1)))],
      [16, () => this.varOf(ctx.scope, "arr") ?? arrlit([num(1)])],
      [6, () => cond(this.genExpr(ctx, "bool", depth - 1), this.genExpr(ctx, "arr", depth - 1), this.genExpr(ctx, "arr", depth - 1))],
      [6, () => index(this.genExpr(ctx, "arr", depth - 1), this.genIndex(ctx, depth - 1))],
      [5, () => this.genCall(ctx, depth) ?? arrlit([num(1)])],
      [5, () => prop(this.genExpr(ctx, "obj", depth - 1), this.rng.pick(FIELD_NAMES))],
    ])();
  }

  genExpr(ctx, hint, depth) {
    switch (hint) {
      case "num":
        return this.genNum(ctx, depth);
      case "str":
        return this.genStr(ctx, depth);
      case "bool":
        return this.genBool(ctx, depth);
      case "obj":
        return this.genObj(ctx, depth);
      case "arr":
        return this.genArr(ctx, depth);
      case "nullish":
        return this.rng.chance(0.5) ? { k: "nul" } : { k: "undef" };
      default:
        return this.genExpr(ctx, this.rng.weighted([
          [30, "num"],
          [14, "str"],
          [14, "bool"],
          [12, "obj"],
          [12, "arr"],
          [6, "nullish"],
        ]), depth);
    }
  }

  genScalar(ctx, depth) {
    return this.genExpr(ctx, this.rng.pick(SCALAR_HINTS), depth);
  }

  boundedStr(expr) {
    return method(text(expr), "substring", [num(0), num(12)]);
  }

  isObjectGuard(name) {
    return bin("and", bin("===", typeOf(ident(name)), str("object")), bin("!==", ident(name), { k: "nul" }));
  }

  guardedWrite(name, stmt) {
    return { k: "if", cond: this.isObjectGuard(name), then: [stmt], alt: null };
  }

  valueFor(ctx, hint, depth) {
    return hint === "str" ? this.boundedStr(this.genExpr(ctx, "str", depth)) : this.genExpr(ctx, hint, depth);
  }

  genAssign(ctx, depth) {
    const targets = ctx.scope.filter((v) => v.writable);
    if (targets.length === 0) return null;
    const target = this.rng.pick(targets);
    if (target.hint === "num" && this.rng.chance(0.35)) {
      return assign(target.name, this.rng.pick(NUM_COMPOUND_OPS), this.genExpr(ctx, "num", depth));
    }
    const hint = target.hint === "any" ? this.rng.pick(HINTS) : target.hint;
    return assign(target.name, "=", this.valueFor(ctx, hint, depth));
  }

  genDeclare(ctx, depth) {
    const hint = this.rng.weighted([
      [26, "num"],
      [12, "str"],
      [12, "bool"],
      [16, "obj"],
      [16, "arr"],
      [10, "any"],
    ]);
    const name = this.fresh("v");
    const value = this.valueFor(ctx, hint === "any" ? this.rng.pick(HINTS) : hint, depth);
    ctx.scope.push({ name, hint, writable: true });
    return assign(name, "=", value);
  }

  genPropWrite(ctx, depth) {
    const objs = this.varsWith(ctx, "obj");
    if (objs.length === 0) return null;
    const name = this.rng.pick(objs).name;
    return this.guardedWrite(name, {
      k: "setprop",
      obj: ident(name),
      name: this.rng.pick(FIELD_NAMES),
      op: "=",
      value: this.genExpr(ctx, this.rng.pick(HINTS), depth),
    });
  }

  genIndexWrite(ctx, depth) {
    const arrs = this.varsWith(ctx, "arr");
    if (arrs.length === 0) return null;
    const name = this.rng.pick(arrs).name;
    return this.guardedWrite(name, {
      k: "setindex",
      obj: ident(name),
      index: bin("%", this.genExpr(ctx, "num", depth), num(this.rng.range(2, 8))),
      op: "=",
      value: this.genScalar(ctx, depth),
    });
  }

  genPush(ctx, depth) {
    const arrs = this.varsWith(ctx, "arr");
    if (arrs.length === 0) return null;
    const receiver = ident(this.rng.pick(arrs).name);
    return {
      k: "exprstmt",
      value: cond(
        bin(
          "and",
          bin("===", typeOf(prop(receiver, "push")), str("function")),
          bin("<", prop(receiver, "length"), num(PUSH_LIMIT)),
        ),
        method(receiver, "push", [this.genScalar(ctx, depth)]),
        num(0),
      ),
    };
  }

  genGlobalWrite(ctx, depth) {
    if (this.globals.length === 0) return null;
    const target = this.rng.pick(this.globals);
    return assign(target.name, "=", this.valueFor(ctx, target.hint, depth));
  }

  genIf(ctx, depth, budget) {
    return {
      k: "if",
      cond: this.genExpr(ctx, "bool", depth),
      then: this.genBody(ctx, depth, budget - 1),
      alt: this.rng.chance(0.5) ? this.genBody(ctx, depth, budget - 1) : null,
    };
  }

  genWhile(ctx, depth, budget) {
    const counter = this.fresh("w");
    const inner = {
      ...ctx,
      scope: [...ctx.scope, { name: counter, hint: "num", writable: false }],
      inLoop: true,
    };
    return [
      assign(counter, "=", num(0)),
      {
        k: "while",
        cond: bin("<", ident(counter), num(this.rng.range(1, 4))),
        body: [assign(counter, "=", bin("+", ident(counter), num(1))), ...this.genBody(inner, depth, budget - 1)],
      },
    ];
  }

  genForOf(ctx, depth, budget) {
    const name = this.fresh("e");
    const iter = this.rng.chance(0.5)
      ? call("range", [num(0), num(this.rng.range(1, 4))])
      : arrlit(Array.from({ length: this.rng.range(1, 3) }, () => this.genScalar(ctx, depth - 1)));
    const inner = {
      ...ctx,
      scope: [...ctx.scope, { name, hint: "any", writable: false }],
      inLoop: true,
    };
    return { k: "forof", name, iter, body: this.genBody(inner, depth, budget - 1) };
  }

  genDelete(ctx) {
    const objs = this.varsWith(ctx, "obj");
    if (objs.length === 0) return null;
    const name = this.rng.pick(objs).name;
    return this.guardedWrite(name, {
      k: "exprstmt",
      value: un("delete", rawProp(ident(name), this.rng.pick(FIELD_NAMES))),
    });
  }

  genStmt(ctx, depth, budget) {
    const table = [
      [26, () => this.genAssign(ctx, depth)],
      [14, () => this.genDeclare(ctx, depth)],
      [10, () => this.genPropWrite(ctx, depth)],
      [8, () => this.genIndexWrite(ctx, depth)],
      [6, () => this.genPush(ctx, depth)],
      [6, () => this.genGlobalWrite(ctx, depth)],
      [4, () => this.genDelete(ctx)],
      [4, () => ({ k: "exprstmt", value: this.genCall(ctx, depth) ?? this.numberAtom() })],
    ];
    if (budget > 1) {
      table.push([16, () => this.genIf(ctx, depth, budget)]);
      table.push([8, () => this.genWhile(ctx, depth, budget)]);
      table.push([6, () => this.genForOf(ctx, depth, budget)]);
    }
    if (ctx.inLoop) {
      table.push([6, () => ({
        k: "if",
        cond: this.genExpr(ctx, "bool", depth),
        then: [this.rng.chance(0.5) ? { k: "brk" } : { k: "cont" }],
        alt: null,
      })]);
    }
    if (ctx.canReturn) table.push([5, () => ret(this.genExpr(ctx, ctx.returnHint, depth))]);
    return this.rng.weighted(table)() ?? this.genDeclare(ctx, depth);
  }

  genBody(ctx, depth, budget) {
    const safeBudget = Math.max(1, budget);
    const count = this.rng.range(1, Math.min(4, safeBudget));
    const out = [];
    for (let i = 0; i < count; i++) {
      const produced = this.genStmt(ctx, depth, safeBudget - 1);
      if (Array.isArray(produced)) out.push(...produced);
      else out.push(produced);
    }
    return out;
  }

  globalScope() {
    return this.globals.map((g) => ({ name: g.name, hint: g.hint, writable: true }));
  }

  closureScope() {
    return this.closures.map((c) => ({ name: `${c.name}_c`, hint: "fn", arity: c.arity, writable: false }));
  }

  genPlainFunc(order) {
    const name = `f${order}`;
    const params = Array.from({ length: this.rng.range(1, 3) }, (_, i) => `p${i}`);
    this.funcs.push({ name, order, params, recursive: false });
    const returnHint = this.rng.pick(HINTS);
    const ctx = {
      scope: [...params.map((p) => ({ name: p, hint: "any", writable: true })), ...this.globalScope()],
      order,
      inLoop: false,
      canReturn: true,
      returnHint,
    };
    const depth = this.rng.range(2, 4);
    const body = this.genBody(ctx, depth, this.rng.range(2, 5));
    body.push(ret(this.genExpr(ctx, returnHint, depth)));
    return { name, params, body };
  }

  genRecursiveFunc(order) {
    const name = `f${order}`;
    const params = ["p0", "p1"];
    this.funcs.push({ name, order, params, recursive: true });
    const ctx = {
      scope: [
        { name: "p0", hint: "num", writable: false },
        { name: "p1", hint: "any", writable: true },
        ...this.globalScope(),
      ],
      order,
      inLoop: false,
      canReturn: false,
      returnHint: "num",
    };
    const depth = this.rng.range(1, 3);
    const selfCall = call(name, [bin("-", ident("p0"), num(1)), this.genExpr(ctx, this.rng.pick(HINTS), depth)]);
    return {
      name,
      params,
      body: [
        {
          k: "if",
          cond: bin("<=", ident("p0"), num(0)),
          then: [ret(this.genExpr(ctx, this.rng.pick(HINTS), depth))],
          alt: null,
        },
        ...this.genBody(ctx, depth, this.rng.range(1, 3)),
        ret(bin(this.rng.pick(["+", "-", "*", "^"]), selfCall, this.genExpr(ctx, "num", depth))),
      ],
    };
  }

  genClosureFunc(order) {
    const name = `f${order}`;
    const params = ["p0"];
    this.funcs.push({ name, order, params, recursive: false });
    this.closures.push({ name, arity: 1 });
    const outerScope = [{ name: "p0", hint: "any", writable: true }, ...this.globalScope()];
    const innerName = `k${order}`;
    const innerCtx = {
      scope: [...outerScope, { name: "q0", hint: "any", writable: true }],
      order,
      inLoop: false,
      canReturn: true,
      returnHint: "num",
    };
    const depth = this.rng.range(1, 3);
    const innerBody = this.genBody(innerCtx, depth, this.rng.range(1, 3));
    innerBody.push(ret(this.genExpr(innerCtx, this.rng.pick(HINTS), depth)));
    return {
      name,
      params,
      body: [
        { k: "nested", fn: { name: innerName, params: ["q0"], body: innerBody } },
        ret(ident(innerName)),
      ],
    };
  }

  genGlobals() {
    const ctx = { scope: [], order: 0, inLoop: false, canReturn: false, returnHint: "num" };
    const out = [];
    for (let i = 0; i < this.rng.range(0, 3); i++) {
      const name = `g${i}`;
      const hint = this.rng.pick(GLOBAL_HINTS);
      this.globals.push({ name, hint });
      out.push({ name, init: this.valueFor(ctx, hint, 1) });
    }
    return out;
  }

  genRunner() {
    const scope = [
      { name: ACCUMULATOR, hint: "num", writable: false },
      { name: SECONDARY, hint: "any", writable: true },
      { name: COUNTER, hint: "num", writable: false },
      { name: ITERATIONS, hint: "num", writable: false },
      ...this.globalScope(),
      ...this.closureScope(),
    ];
    const order = this.funcs.length;
    const ctx = { scope, order, inLoop: true, canReturn: false, returnHint: "num" };
    const depth = this.rng.range(2, 4);
    const fold = this.rng.pick(FOLD_MODES);
    const modeExpr = cond(
      bin("<", ident(COUNTER), num(this.rng.range(2, 40) * 25)),
      this.genExpr(ctx, this.rng.pick(HINTS), depth),
      this.genExpr(ctx, this.rng.pick(HINTS), depth),
    );
    const bodyCtx = {
      ...ctx,
      scope: [
        ...scope,
        { name: CURRENT, hint: "any", writable: true },
        { name: WITNESS, hint: "any", writable: true },
      ],
    };
    const callExpr = this.genCall(ctx, depth) ?? this.genClosureCall(ctx, depth) ?? this.genExpr(ctx, "any", depth);
    const body = [
      assign(COUNTER, "=", bin("+", ident(COUNTER), num(1))),
      assign(CURRENT, "=", modeExpr),
      assign(WITNESS, "=", callExpr),
      ...this.genBody(bodyCtx, depth, this.rng.range(2, 5)),
      assign(ACCUMULATOR, "=", fold(ident(ACCUMULATOR), bin("+", this.genExpr(bodyCtx, "num", depth), ident(COUNTER)))),
      assign(SECONDARY, "=", this.rng.chance(0.5) ? ident(WITNESS) : this.genScalar(bodyCtx, depth)),
      assign(TEXT, "=", method(
        bin("+", text(this.rng.chance(0.6) ? ident(WITNESS) : this.genExpr(bodyCtx, this.rng.pick(HINTS), 1)), ident(TEXT)),
        "substring",
        [num(0), num(16)],
      )),
    ];
    const reported = cond(
      bin("===", typeOf(ident(SECONDARY)), str("function")),
      str("fn"),
      ident(SECONDARY),
    );
    const result = this.rng.weighted([
      [3, () => arrlit([ident(ACCUMULATOR), reported, ident(TEXT)])],
      [3, () => objlit([["a", ident(ACCUMULATOR)], ["b", reported], ["c", ident(TEXT)]])],
      [2, () => ident(ACCUMULATOR)],
      [2, () => method(bin("+", bin("+", str(""), ident(ACCUMULATOR)), reported), "substring", [num(0), num(RESULT_TEXT_LIMIT)])],
    ])();
    const prologue = this.closures.map((c) => assign(`${c.name}_c`, "=", call(c.name, [num(this.rng.range(0, 4))])));
    return {
      name: "run",
      params: [ITERATIONS],
      body: [
        assign(ACCUMULATOR, "=", num(this.rng.pick(ACC_SEEDS))),
        assign(SECONDARY, "=", num(0)),
        assign(TEXT, "=", str("")),
        ...prologue,
        assign(COUNTER, "=", num(0)),
        { k: "while", cond: bin("<", ident(COUNTER), ident(ITERATIONS)), body },
        ret(result),
      ],
    };
  }

  genDriver() {
    const inner = this.rng.pick(DRIVER_INNER);
    return {
      name: "driver",
      params: ["m"],
      body: [
        assign("k", "=", num(0)),
        assign("t", "=", num(0)),
        {
          k: "while",
          cond: bin("<", ident("k"), ident("m")),
          body: [
            assign("k", "=", bin("+", ident("k"), num(1))),
            assign("t", "=", call("run", [num(inner)])),
          ],
        },
        ret(ident("t")),
      ],
    };
  }

  build() {
    const globals = this.genGlobals();
    const funcs = [];
    for (let order = 0; order < this.rng.range(1, 5); order++) {
      const kind = this.rng.weighted([[7, "plain"], [2, "recursive"], [2, "closure"]]);
      if (kind === "recursive") funcs.push(this.genRecursiveFunc(order));
      else if (kind === "closure") funcs.push(this.genClosureFunc(order));
      else funcs.push(this.genPlainFunc(order));
    }
    funcs.push(this.genRunner());
    funcs.push(this.genDriver());
    const iterations = this.rng.pick(ITERATION_COUNTS);
    return {
      globals,
      funcs,
      top: [
        assign("r0", "=", call("run", [num(iterations)])),
        assign("r1", "=", call("driver", [num(this.rng.pick(DRIVER_COUNTS))])),
        assign("r2", "=", call("run", [num(iterations)])),
        assign("r3", "=", call("run", [num(this.rng.range(3, 40))])),
        { k: "exprstmt", value: arrlit([ident("r0"), ident("r1"), ident("r2"), ident("r3")]) },
      ],
    };
  }
}

export function generate(seed) {
  const program = new Generator(seed).build();
  return { seed, program, source: renderProgram(program) };
}
