# 28. What the program calls: builtins, the host bridge, and four other compilers   ⟨I · B · J · N⟩

`"tera".to_upper_case()` is answered by one line of JavaScript at
`src/runtime/intrinsics/string-methods.ts:330`. The interpreter reaches it through a
prototype object. The baseline compiler reaches the same line through the same
prototype object. The optimizing JIT reaches the same line by converting the
snake_case name in its IR back to camelCase and indexing the same JavaScript object
literal. One implementation, three tiers, and no possibility of a disagreement — because
there is nowhere for a second answer to live.

The fourth tier reaches a twelve-line C function called `tera_string_case` that subtracts
32 from every byte between `'a'` and `'z'`. It shares the *name* `to_upper_case`, the
notion of a `string` owner, and an arity read out of the same specification table. It
shares no line of code. `"café"` is where that stops being a curiosity: the interpreter
prints `CAFÉ` and the C backend has no case table at all. What happens next is the whole
argument of this chapter, and it is not a miscompile — the compiler notices, and refuses
the function.

That asymmetry is where every AOT/interpreter divergence in Part IX is born, and it is not
an accident either. The second table buys the compiler three things the runtime payload
cannot express — a `pure` flag, a declared signature, and default arguments — and its price
is a permanent obligation to keep two lists saying the same thing about the same twenty
names. Between them sits `data/tera-language-spec.ts`, 8,251 lines, which both tables read
their arities and parameter names out of, and which this book cites and never reproduces
(`docs/README.md:144-146`).

`docs/example/stats.tera` reaches exactly two builtins: `to_fixed` off the number
prototype, and `print` out of a global cell. It touches no host object, no named argument
and none of the domain surfaces. Per [Conventions § 2] this chapter says so up front and
uses short purpose-built probes for everything past the spine's reach; each one is printed
in full below.

**What arrived.** From [Ch 27 § what-leaves]: a frame inside `runFrame` at a `Call` or
`CallMethod` opcode whose callee is *not* a `RegisterCompiledFunction`, and the tier
verdict that says this call cannot pin its caller to tier zero — no builtin is in
`INTERPRETER_ONLY_OPS`, which is why `stats.tera` stays optimizable while calling both of
its builtins. [Ch 25 § memberlookups-a-jump-table] has already resolved
`this.mean().to_fixed` by indexing `MEMBER_LOOKUPS` with the receiver's tag code, walking
`interpreter.builtinPrototypes.numberPrototype`, and handing back a `FunctionValue` whose
`RuntimeFunctionPayload` has a `call` and no `compiled`. This chapter is what happens when
that payload is invoked.

## What the program calls: one shape for everything callable

There is one record type for everything in this engine that can be called, and it is a bag
of optional fields. `RuntimeFunctionPayload` (`src/core/value/index.ts:186-213`) has
twenty-six of them, and no two kinds of callee fill the same set:

| callee | fills |
| --- | --- |
| a tera function | `compiled`, `closure`, `name`, `paramCount` |
| a builtin | `call`, `name`, sometimes `metadata` and `properties` |
| a class constructor | `prototypeObj`, `constructorOf`, the six class fields of [Ch 26 § classes-at-run-time-are-four-fields-and-a-name] |
| a namespace | `name` and `properties`, and nothing else |
| a host function | `call`, `name`, `metadata` |

`callFunctionValue` never asks which of those it has. It asks which field is present:

```ts
    const fn = getPayload(callee);
    if (fn.call) return fn.call(args, thisValue, this);
    if (fn.construct) {
      assertConstructorAccess(fn, this);
      return fn.construct(args, this);
    }
    if (fn.compiled && (fn.prototypeObj || fn.compiled.simpleConstructorInfo || fn.constructorOf) && isUndefined(thisValue)) {
      return this.constructFunctionValue(callee, args);
    }
```
— `src/bytecode/register/interpreter/index.ts:1135-1143`

Two consequences follow, and both matter more than they look.

First, **a builtin needs no opcode of its own.** There is no `CallBuiltin` in the bytecode.
`print(...)` compiles to `LdaGlobal` followed by `Call`, exactly like a user function; you
can see it in the running example's own disassembly, where `print`, `report`, `latency` and
`Series` are four `LdaGlobal`s that differ only in constant index.

Second, **a builtin is a first-class value.** Because the payload is the same shape, a
builtin can be stored, passed and returned like any other function:

```
$ node dist/cli.js mp.tera
[1, 2, 3]
```

The probe is one line: `print([1.5, 2.5, 3.7].map(Math.floor))`. `Math.floor` is a payload
with a `call`, `map` invokes it through `callFunctionValue`, and nothing along that path
knows or cares that the callee came from a registry rather than from source.

> **New idea. Builtin versus intrinsic.** The same method appears under two names in this
> tree, and they are not synonyms. A **builtin** is a *value*: a `RuntimeFunctionPayload`
> with a `call`, sitting in a global cell or on a prototype, which the interpreter invokes.
> An **intrinsic** is a *row in a compiler table*: a record saying that `string.to_upper_case`
> takes zero arguments beyond its receiver, returns a `string`, and is pure — a fact a
> compiler can reason about without running anything. `to_upper_case` is both. The rest of
> this chapter is largely about what happens when the two descriptions of one method are
> maintained in two places.

## Builtins are three kinds in one union

The registry is one object literal, `builtins`, opening at
`src/runtime/builtins/index.ts:277` with `...createDomainBuiltins()` and running to
`:1162`. It writes twenty-eight keys of its own — `NaN`, `Infinity`, `undefined`, `print`,
`input`, `console`, `typeof`, `parse_int`, `parse_float`, `is_nan`, `is_finite`, `Number`,
`Boolean`, `RegExp`, `Symbol`, `Proxy`, `Map`, `Set`, `WeakMap`, `Math`, `Array`, `Object`,
`Reflect`, `JSON`, `String`, `clock`, `sleep`, `gc` — plus the seven error constructors
spread in at `:476` and everything the domain builtins supply.

Its entry type is a three-way union:

```ts
export type BuiltinRegistryEntry = RuntimeFunctionPayload | BuiltinNamespace | { globalConst: () => TaggedValue };
```
— `src/runtime/builtins/index.ts:91`

and `builtinValue` discriminates it with two predicates and a fall-through:

```ts
export function builtinValue(name: string, entry: BuiltinRegistryEntry): TaggedValue {
  if (hasGlobalConst(entry)) return entry.globalConst();
  if (isRuntimeFunctionPayload(entry)) return functionValue(entry);

  const nsProperties: Record<string, TaggedValue> = {};
  const namespace = entry as BuiltinNamespace;
  for (const [methodName, method] of Object.entries(namespace)) {
    if (methodName === "name") continue;
    const value = namespaceValue(method);
    if (value === null) continue;
    spellOut(nsProperties, methodName, value);
  }
  return mkFunction({ name, properties: nsProperties });
}
```
— `src/runtime/builtins/index.ts:165-178`

The first branch is why `NaN`, `Infinity` and `undefined` are *cells* rather than literals:
each is `{ globalConst: () => ... }`, evaluated once at install time, so the value in the
cell is a real `TaggedValue` produced by the engine's own constructors rather than a
parser-level constant. The second branch, `functionValue` (`:149-163`), takes a payload and
lifts its non-`call` fields into `properties` — which is how `String.from_char_code` can
hang off a callable `String`. The third builds a namespace object member by member,
converting each with `namespaceValue` (`:131-139`) and skipping anything that is neither a
payload, a finite number, a string, a boolean, `null` nor `undefined`.

The two predicates are structural, not nominal. `isRuntimeFunctionPayload` (`:109-118`)
tests for a `call` or a `construct` function; `hasGlobalConst` (`:120-129`) tests for a
`globalConst` function. Neither asks about a class or a brand — the same structural-probe
technique [Ch 25 § why-the-obvious-design-fails] met on the interpreter parameter.

One line at the bottom of the file is worth more than the rest of this section:

```ts
export type BuiltinRegistry = typeof builtins;
```
— `src/runtime/builtins/index.ts:1164`

> **New idea. A derived table.** Two tables that must agree can be maintained in two ways.
> You can write both and check them against each other — which is a test, run sometimes,
> catching drift after it happens. Or you can *derive* one from the other, so the second
> cannot be written at all without the first. `BuiltinRegistry` is the derived kind: the
> type is computed from the literal with `typeof`, so adding a key to `builtins` adds it to
> the type in the same keystroke and there is no declaration to forget. The pattern recurs
> throughout this chapter — and its absence, in the fourth compiler's table, is the
> chapter's central problem.

## Install is one loop and one write

Builtins are not a fallback, not a scope, and not a special case in name resolution:

```ts
export function installBuiltinEntries(globalCells: BuiltinGlobalCells, entries: BuiltinRegistryMap): void {
  for (const [name, entry] of Object.entries(entries)) {
    globalCells.write(name, builtinValue(name, entry));
  }
}
```
— `src/runtime/builtins/index.ts:180-184`

One loop, one `globalCells.write` per entry. After it runs, `print` is a global cell with a
`TaggedValue` in it and nothing distinguishes it from a cell holding a user's function. The
running example proves it by accident:

```
    46  LdaGlobal [20] (print)
    47  Star r0
    48  LdaGlobal [1] (report)
```
— `node dist/cli.js --print-bytecode docs/example/stats.tera`

`print` and `report` are the same instruction with different constant indices. Three
consequences:

- The global-cell inline cache of [Ch 24 § lda-prop-the-sequence-in-order] caches a builtin exactly as it caches
  a user global, so a hot `print` costs one cache hit, not a registry lookup.
- Shadowing a builtin is a *checker*-level question, not a runtime one, and the answer is
  conditional. `reportBuiltinRedeclaration`
  (`src/frontend/checker/type-checker.ts:1274-1280`) fires only when the program still
  *calls* the shadowed name as a builtin — `this.called.has(name)`. So `sum = 5` followed
  by `print(sum([1, 2]))` is refused with `1:1 Cannot redeclare built-in 'sum'`
  [t: `tests/frontend/checker/type-checker.test.ts` > "refuses a top-level name the program still calls as a built-in"],
  while `sum = 5` followed by `print(sum)` runs and prints `5`
  [t: `tests/frontend/checker/type-checker.test.ts` > "lets a top-level name shadow a built-in nothing calls"].
  [Ch 16 § severity-is-policy] is where that diagnostic became fatal on the AOT road.
- Anything else that can write a global cell can install a builtin. That is
  [Ch 29 § six-slots]'s subject, and `installBuiltinEntries` is the function it calls.

The install order at engine construction is fixed and five lines long — entries, the
promise builtin, the well-known symbols, the prototypes, and then the wiring that hangs
each prototype off its constructor:

```ts
    installBuiltinEntries(this.globalCells, builtins);
    installPromiseBuiltin(this);
    this._wireWellKnownSymbols();
    this.builtinPrototypes = createBuiltinPrototypes();
    this._wirePrototypes();
```
— `src/bytecode/register/interpreter/index.ts:685-689`

The order is load-bearing in one place: `_wireWellKnownSymbols` (`:692-704`) reads the
`Symbol` global out of the cell map, so it has to run after `installBuiltinEntries` and
before `createBuiltinPrototypes`, which asks `getWellKnownSymbols()` for the iterator symbol
it aliases onto `Map.entries` and `Set.values`.

## Nine prototypes and one rename

`src/runtime/intrinsics/prototypes.ts` is fifty-five lines and builds every prototype in
the engine. Its load-bearing line is one:

```ts
function populatePrototype(owner: string, methods: Record<string, BuiltinMethod>): JSObject {
  const proto = createJSObject();
  for (const [name, method] of Object.entries(methodsWithMetadata(owner, methods))) {
    proto.setProperty(camelToSnake(name), mkFunction(method as BuiltinMethod));
  }
  return proto;
}
```
— `src/runtime/intrinsics/prototypes.ts:22-28`

`createBuiltinPrototypes` (`:30-55`) calls it nine times: `stringPrototype`,
`arrayPrototype`, `numberPrototype`, `booleanPrototype`, `regexPrototype`,
`errorPrototype`, `mapPrototype`, `setPrototype`, `weakMapPrototype`. Five of those nine
are the closed union `BuiltinPrototypeName` that [Ch 25 § declining-when-no-prototype-is-available]
described; the other four are reached the other way, because their receivers are `JSObject`s
with hidden classes and travel [Ch 24 § lda-prop-the-sequence-in-order]'s path instead. `_wirePrototypes`
(`src/bytecode/register/interpreter/index.ts:706-726`) hangs each one off the matching
global constructor's `prototype`, and gives all seven names in `ERROR_CONSTRUCTOR_NAMES`
(`src/runtime/builtins/index.ts:230-238`) the *same* `errorPrototype` object.

The rename is the part with a user-visible consequence. Every method goes onto the
prototype under `camelToSnake(name)`. The implementation objects are written in camelCase
because they are JavaScript — `STRING_METHODS.toUpperCase` at
`src/runtime/intrinsics/string-methods.ts:327-332` — and the property that exists on
`stringPrototype` afterwards is spelled `to_upper_case`. There is no alias.

So `toUpperCase` is not a name in this language, and the failure is not a spelling hint:

```
$ node dist/cli.js camel.tera
undefined is not a function
$ echo $?
1
```

with `camel.tera` containing `print("tera".toUpperCase())`. The lookup succeeded — it
found nothing, answered `mkUndefined()` per [Ch 25 § the-three-answer-contract], and the
call opcode then reported what it was handed. That is the runtime's message about a value,
not the checker's message about a name, and it names neither the method nor the receiver.

## Two spellings for a namespace, one for a method

Namespace members do get two spellings, and prototype methods do not, and the reason is not
a policy anyone wrote down. It is a regex:

```ts
const CAMEL_MEMBER = /^[a-z][A-Za-z0-9]*$/;
const CAMEL_BOUNDARY = /[a-z0-9][A-Z]/;

export function spellings(name: string): readonly string[] {
  const camel = CAMEL_MEMBER.test(name) && CAMEL_BOUNDARY.test(name);
  return camel ? [name, camelToSnake(name)] : [name];
}
```
— `src/utils/naming.ts:9-15`

`spellings` yields two names only when the registry key is *already* camelCase — starts
lowercase, contains a lower-to-upper boundary. `spellOut` (`src/runtime/builtins/index.ts:141-147`)
writes every yielded name into the namespace's `properties`. So:

```
$ node dist/cli.js dual.tera
true
true
A
A
```

with `dual.tera` calling `Array.isArray`, `Array.is_array`, `String.fromCharCode` and
`String.from_char_code` in that order. All four resolve, because the registry keys are
`isArray` and `fromCharCode` and each got both spellings.

Now the same file's `Number` namespace, whose key at `:369` is written `is_integer`:

```
$ node dist/cli.js ni.tera
true
$ node dist/cli.js ni2.tera
undefined is not a function
```

`Number.is_integer(1)` works and `Number.isInteger(1)` does not exist. `is_integer` is not
camelCase, so `spellings` returned one name, and the camel alias was never written.

> **Unenforced.** The two-spelling rule is a regex, not a policy. `spellings`
> (`src/utils/naming.ts:12-15`) yields a camel alias only when the registry key is already
> camelCase, so `Array.isArray` has two names and `Number.is_integer`
> (`src/runtime/builtins/index.ts:369`) has one. Nothing asserts a consistent convention
> across the registry's namespaces, nothing warns when a new snake-cased key silently loses
> its alias, and nothing prevents the reverse — a camelCase key acquiring a snake alias
> nobody intended. Closing it costs a `satisfies` constraint over the namespace literals, or
> a test that walks `builtins` and asserts every namespace member's key matches one
> convention. Neither exists.

There is a second oddity in the same code, and it is the reason `builtinValue`'s third
branch has no `call` to give:

> **Unfinished.** A namespace is a function value that cannot be called. `builtinValue`
> (`src/runtime/builtins/index.ts:169-177`) ends with `mkFunction({ name, properties })` —
> a payload with `properties` and no `call` and no `construct`. So `typeof(Math)`,
> `typeof(JSON)` and `typeof(console)` all answer `"function"` where JavaScript answers
> `"object"`, and `Math(1)` fails at run time with `Cannot call function: Math`, thrown from
> the fall-through at `src/bytecode/register/interpreter/index.ts:1190` (the message also
> appears at `:574` and `:1219`). Making namespaces objects means giving them a hidden class,
> a prototype and a `CODE_OBJECT` tag, which would take them out of the payload path
> `functionValue` and `spellOut` share with real callables — which is why they are functions
> today. Nothing pins either behaviour. `[unpinned]`

## The JIT converts back

The optimizing JIT carries the *snake* name, because that is what the source said and what
the IR node's `name` prop holds. To reach the implementation it converts in the opposite
direction from `populatePrototype`:

```ts
const OWNERS = new Map<string, BuiltinMethodOwner>([
  ["string", { methods: methodsWithMetadata("String", STRING_METHODS), accepts: isString }],
  ["int", { methods: methodsWithMetadata("Number", NUMBER_METHODS), accepts: isSmi }],
  ["float", { methods: methodsWithMetadata("Number", NUMBER_METHODS), accepts: isNumber }],
]);

export function builtinMethodImplementation(
  owner: string,
  name: string,
  receiver: TaggedValue,
): RuntimeFunctionPayload | null {
  const entry = OWNERS.get(owner);
  if (entry === undefined || !entry.accepts(receiver)) return null;
  const method = snakeToCamel(name);
  return Object.hasOwn(entry.methods, method) ? entry.methods[method]! : null;
}
```
— `src/runtime/intrinsics/builtin-methods.ts:13-28`

Twenty-eight lines is the whole file. Three owners; `int` and `float` share
`NUMBER_METHODS` and differ only in their `accepts` predicate. The `accepts` check runs
*before* the name lookup, so a compiled site that speculated on a string receiver and got
something else declines rather than calling a string method on a number
[t: `tests/runtime/intrinsics/builtin-methods.test.ts` > "refuses a receiver that is not a string"].
`Object.hasOwn` rather than `in` is what stops `constructor` and `__proto__` from resolving
as methods
[t: `tests/runtime/intrinsics/builtin-methods.test.ts` > "does not expose inherited object properties as methods"].

The invariant this establishes is the chapter's first: **three tiers, one implementation
object.** Not one algorithm written three times — one object. The test that pins it does
not compare behaviour, it compares identity:

`[t: tests/runtime/intrinsics/builtin-methods.test.ts > "maps a snake_case Tera name onto the camelCase runtime method"]`
asserts `builtinMethodImplementation("string", "char_code_at", "hello").call`
**is** `STRING_METHODS.charCodeAt.call` — `toBe`, reference equality, not `toEqual`. And
`[t: tests/runtime/intrinsics/builtin-methods.test.ts > "resolves to the same implementation on every lookup"]`
asserts two successive lookups return the same object, which holds because
`methodsWithMetadata` is `WeakMap`-cached by table identity.

The enforcement is a fall-through, not an assertion. The wasm runtime's call site:

```ts
  const method = builtinMethodImplementation(intrinsic.owner, intrinsic.name, receiver);
  if (method?.call) return method.call(callArgs, receiver, runtime.interpreter);
  return executeRuntimeCall(
    member(),
```
— `src/optimizing/backends/wasm/runtime-support.ts:472-475`

A `null` from the table sends the call to `executeRuntimeCall` with the value
`getRuntimeProperty` found — that is, back through [Ch 25]'s member table and out to
whatever the interpreter would have done. A missing entry therefore degrades to the generic
path instead of miscompiling. The baseline needs none of this: it calls
`memberLookupValue(obj, propName, this.interp)` at
`src/optimizing/baseline/runtime.ts:338` and gets the payload directly.

## Method metadata is lifted, not written twice

`STRING_METHODS.slice` has no idea what its parameters are called. The payload is a `name`
and a `call`. Parameter names, arities and getter flags live in
`data/tera-language-spec.ts`, and they are spread onto the payloads on the way past:

```ts
const SPEC_METHODS = methodMetadataFromSpec(TERA_PSEUDO_TYPES);
const described = new WeakMap<MethodTable, MethodTable>();

export function methodsWithMetadata(owner: string, methods: MethodTable): MethodTable {
  const cached = described.get(methods);
  if (cached) return cached;

  const specs = SPEC_METHODS[owner];
  const out: Record<string, RuntimeFunctionPayload> = {};
  for (const [name, payload] of Object.entries(methods)) {
    const metadata = specs?.get(name);
    out[name] = metadata === undefined ? payload : { ...payload, metadata };
  }
  described.set(methods, out);
  return out;
}
```
— `src/runtime/intrinsics/method-metadata.ts:7-22`

Twenty-two lines, built once from the spec, cached by table identity so both
`populatePrototype` and `OWNERS` get the same objects
[t: `tests/runtime/intrinsics/builtin-methods.test.ts` > "carries the parameter names the language spec declares for the method"].

That `metadata` field is what makes named arguments work for builtins and host functions,
which they otherwise could not: a JavaScript closure has no parameter names a runtime can
read.

> **New idea. Named arguments as a calling convention.** A positional call says "the third
> argument is the axis". A named call says `axis=1` and leaves the runtime to work out that
> the axis is third. Doing that requires a *table*, mapping each parameter name to a slot —
> and the table has to come from somewhere the callee can supply. For a tera function it
> comes from the source. For a builtin it comes from the specification file, through
> `metadata`. Where there is no table, the names cannot be bound at all, and the engine has
> to decide whether that is an error or an options bag.

`positionalSlots` builds that table, with a `WeakMap` cache keyed on the parameter list:

```ts
  const slots = new Map<string, number>();
  let index = 0;
  for (const param of params) {
    if (param.named || param.rest) continue;
    const synonym = PARAM_SYNONYMS[param.name];
    slots.set(param.name, index);
    slots.set(snakeToCamel(param.name), index);
    if (synonym) slots.set(synonym, index);
    index++;
  }
```
— `src/runtime/named-arguments.ts:39-48`

Each parameter is registered under its declared name *and* its camelCase spelling
[t: `tests/runtime/named-arguments.test.ts` > "accepts the camelCase spelling of a snake_case parameter"],
so the two-spellings rule of the previous section reappears here as an explicit two-line
write rather than a regex. `PARAM_SYNONYMS` (`:24-27`) is the one hand-written exception in
the file — two entries, `axis` ↔ `dim`, because the machine-learning surface and the array
surface disagree about what to call the same thing
[t: `tests/runtime/named-arguments.test.ts` > "binds through the axis/dim synonym"].

`bindNamedSlots` (`:59-80`) then places each named argument, and its two refusals are the
interesting part. A name whose slot is already filled positionally is *not* overwritten —
it goes into `rest`
[t: `tests/runtime/named-arguments.test.ts` > "never overwrites an argument the caller already passed positionally"] —
and a name the table does not know also goes into `rest`
[t: `tests/runtime/named-arguments.test.ts` > "leaves an unknown name for the callee to read as an option"].
`callFunctionValueNamed` (`src/bytecode/register/interpreter/index.ts:1193-1220`) is the
single chokepoint where all of this is applied: if `rest` is non-empty and
`acceptsNamedOptions` is false, it throws `Unknown named argument '<name>'`; otherwise it
appends the leftovers as an options object.

The same spec table feeds four consumers. The checker types the call. This runtime binds
its named arguments. The REPL's completer offers the member names
[t: `tests/cli/repl.test.ts` > "completes members of an inferred string value"]. And the
fourth compiler reads arity out of it, which is the next section but one.

## Where tera deliberately is not JavaScript

`Array.prototype.find` in JavaScript answers `undefined` when nothing matches. tera's does
not:

```ts
  find: callbackMethod("Array.prototype.find", ({ arr, at, invoke }) => {
    for (let i = 0; i < arr.getLength(); i++) {
      const elem = at(i);
      if (toBool(invoke(elem, mkSmi(i)))) return elem;
    }
    return mkNull();
  }),
```
— `src/runtime/intrinsics/array-methods.ts:182-188`

```
$ node dist/cli.js find.tera
null
```

with `find.tera` containing `print([1,2,3].find(x => x > 9))`. `findLast` does the same, and
so do `MAP_METHODS.get` (`src/runtime/intrinsics/map-methods.ts:38-46`) and
`WEAKMAP_METHODS.get` (`src/runtime/intrinsics/weakmap-methods.ts:34-42`), both of which
end `return val !== undefined ? val : mkNull()`.

This is a type-system decision, not an oversight. `T | null` is a union the checker can
narrow with an ordinary test ([Ch 10 § a-lattice]) and the native compiler can represent
as a reference-shaped absence; `undefined` is the absence the AOT road *declines* for
references ([Ch 56 § two-absence-values]). Choosing `null` at the point of production means
the AOT backend never has to represent the other one for these methods, and the choice is
mirrored deliberately rather than papered over: the same miss answers `null` inside a real
native binary
[t: `tests/e2e/optimizing/aot/array-methods.test.ts` > "compiles find, whose miss answers null"]
[t: `tests/e2e/optimizing/aot/collections.test.ts` > "answers null for a key the map never held"],
and in the interpreter
[t: `tests/runtime/intrinsics/array-methods.test.ts` > "find returns null when nothing matches"].

One of the tests over that surface says the opposite of what it asserts:

> **Broken.** `tests/runtime/intrinsics/collection-methods.test.ts:249-253` is titled
> `"get returns undefined for missing key"` and its body is
> `expect(WEAKMAP_METHODS.get.call([key], wm)).toBe(mkNull())`. The assertion is right and
> the title is wrong. In a codebase with 26 comment lines in 120,822, where [Conventions § 8]
> makes a test title the design document, a title that contradicts its own assertion is
> actively misleading — a reader grepping `tests/` for what a missing key answers finds the
> word "undefined" attached to the code that proves it is `null`. The fix is a rename, and
> it costs one line. [Ch 26 § weakmaps-ephemeronhashtable-is-not-an-ephemeron-table] cites the same test for what it does pin.

## Why the obvious design fails — one table per tier

*(Why the obvious design fails.)*

The design a reader reaches for is: let each backend own its own list of string methods.
The C backend knows which ones it can emit; the x64 backend knows its own; the interpreter
has its objects. Each list is short, each is local to the code that uses it, and nobody has
to coordinate.

That design is not hypothetical here. It is what the tree has, and
`BUILTIN_METHOD_DECLARATIONS` is the second list:

```ts
export const BUILTIN_METHOD_DECLARATIONS: readonly BuiltinMethodDeclaration[] = [
  { owner: "string", name: "char_code_at", pure: true },
  { owner: "string", name: "char_at", pure: true },
  { owner: "string", name: "length", pure: true },
  { owner: "int", name: "to_string", pure: true },
  { owner: "float", name: "to_string", pure: true },
  { owner: "string", name: "to_upper_case", pure: true, params: [], returns: "string" },
  { owner: "string", name: "to_lower_case", pure: true, params: [], returns: "string" },
  { owner: "string", name: "trim", pure: true, params: [], returns: "string" },
```
— `src/optimizing/metadata/builtin-methods.ts:35-43`

Twenty rows in all (`:35-89`), every one of them `pure: true`: eighteen owned by `string`,
one by `int`, one by `float`. Alongside them, `GLOBAL_BUILTIN_DECLARATIONS` (`:138-147`) is
eight globals — `print`, `input`, `throw`, `parse_int`, `parse_float`, `clock`, `wait` and
the character-from-code builtin — which `buildGlobalRegistry` stamps `pure: false` at
`:158` because the declaration type has no purity field at all. And
`NAMESPACE_FUNCTION_DECLARATIONS` (`:194-204`) is nine `Math` functions, defaulted to
`pure: declaration.pure ?? true` at `:229`, with `random` the only one that opts out.

The tree pays for the second list in three visible ways.

**It has to re-derive the parts it must not disagree about.** `buildRegistry` (`:256-283`)
does not take the declaration's word for anything it can look up:

- `builtinOwnerMember(declaration.owner, declaration.name)` (`:259`) reads the spec. If the
  spec has no such member the declaration is *skipped* (`:260`), so a typo produces a
  missing intrinsic rather than a wrong one.
- `member.requiredCount` supplies the parameter list when the declaration does not
  (`:262-263`).
- `member.getter` overrides the declaration entirely: a getter gets an empty parameter list
  no matter what the row says (`:263`, `:270`, `:279`).
- `member.signature.returns` supplies the return type when the row omits it (`:274`).

Four unit tests exist purely to hold the two lists in step:
`[t: tests/optimizing/metadata/builtin-methods.test.ts > "backs every declaration with a member the language spec declares"]`,
`[t: tests/optimizing/metadata/builtin-methods.test.ts > "takes the arity and the types from the language spec"]`,
`[t: tests/optimizing/metadata/builtin-methods.test.ts > "takes the getter flag from the spec instead of the declaration"]`,
`[t: tests/optimizing/metadata/builtin-methods.test.ts > "backs every declared method with a runtime implementation"]`.

**It has to be bound to native code, twice.** `qualifiedMethodName("string", "to_upper_case")`
appears at exactly two places in the backends: `src/optimizing/backends/c/emit.ts:946`,
which maps it to a helper named `tera_string_upper` and carries that helper's C source as a
template string, and `src/optimizing/backends/x64/lowering.ts:347`, which maps it to
`X64_RUNTIME_SYMBOLS.stringUpper`.

**And the two implementations diverge.** Compile the probe to C source and read what comes
out:

```
static inline tera_char *tera_string_case(tera_char *dst, int32_t cap, const tera_char *src, int32_t upper) {
  int32_t at = 0;
  if (cap <= 0) return dst;
  while (src[at] != 0 && at + 1 < cap) {
    tera_char value = src[at];
    if (upper) dst[at] = (value >= 'a' && value <= 'z') ? (tera_char)(value - 32) : value;
    else dst[at] = (value >= 'A' && value <= 'Z') ? (tera_char)(value + 32) : value;
    at++;
  }
  dst[at] = 0;
  return dst;
}
```
— emitted at `up_c/up.c:845-856` by `node dist/cli.js compile up.tera -o up_c --emit source --target c`

`tera_string_upper` (`:1001-1003`) is a three-line wrapper that passes `upper = 1`.
`STRING_METHODS.toUpperCase` is `mkString(unwrapString(thisValue).toUpperCase())` — the
host's own method, and therefore full Unicode. Twelve lines of ASCII arithmetic against one
line of delegation. For `"tera"` they agree; for `"café"` they do not.

The thing standing between them is an analysis. `MAPS_UNICODE`
(`src/optimizing/analyses/wide-text.ts:170-176`) names five string members whose answer
depends on Unicode tables — `to_upper_case`, `to_lower_case`, `trim`, `trim_start`,
`trim_end` — `mapsUnicode` (`:195-198`) tests an IR node against it, and
`unicodeTableReason` (`:208-213`) builds the sentence. Run the probe:

```
$ node dist/cli.js up2.tera
CAFÉ
$ node dist/cli.js compile up2.tera -o up2.exe --target c
tera compile: note: 'shout' is not in the binary, and nothing the program runs calls it (C backend cannot emit: string.to_upper_case maps characters the way Unicode says, and this text holds some outside ASCII; the compiled runtime carries no case or whitespace tables, so keep this part interpreted)
tera compile: note: 'tera_program' is not in the binary, and nothing the program runs calls it (calls unavailable function shout)
tera compile: entry function tera_program could not be lowered to native code: it calls shout, skipped because C backend cannot emit: string.to_upper_case maps characters the way Unicode says, and this text holds some outside ASCII; the compiled runtime carries no case or whitespace tables, so keep this part interpreted
$ echo $?
1
```

Three lines, each one line long, refusing at the grain [Ch 1 § the-hinge] described: the
function is declined, the decline propagates to its callers, and the compile fails only
because the entry point depended on it. `"tera"` compiles; `"café"` does not. The two
implementations are allowed to disagree because a third thing knows where they disagree and
stops the program before the binary exists.

That is the case *for* the second table, stated honestly. It is not free, and the price is
paid in a bespoke analysis per divergence.

> **Unenforced.** Nothing checks that `BUILTIN_METHOD_DECLARATIONS` and the runtime method
> tables **agree on results**.
> `[t: tests/optimizing/metadata/builtin-methods.test.ts > "backs every declared method with a runtime implementation"]`
> proves an implementation *exists* for every declaration; no test feeds the same receiver
> to both and compares what comes back. The Unicode case is caught by `mapsUnicode`, and
> nothing generalises that: the next divergence between a hand-written C helper and a
> host-delegating intrinsic will be found by whoever hits it. The shape of the fix already
> exists in the tree —
> `tests/e2e/language/intrinsic-arguments.test.ts` runs seventeen intrinsic expressions
> through the interpreter and through the *host's own* method, rewriting the snake name back
> to camel with `snakeToCamel`, and demands equality
> [t: `tests/e2e/language/intrinsic-arguments.test.ts` > "coerces a fractional slice start"].
> The same harness pointed at a compiled binary, over a `RECEIVER_SAMPLES` list, would close
> this. It costs a test file, not a design change.

## Builtin metadata: what the second table buys

Two things the runtime payload cannot express, and one it could but does not.

**Purity.** `builtinMethodCallMetadata` stamps it onto the IR node:

```ts
export function builtinMethodCallMetadata(intrinsic: BuiltinIntrinsic): ir.IRMetadata {
  const props: ir.IRMetadata = {
    builtin: true,
    target: {
      declaredSignature: {
        params: [...intrinsic.signature.params],
        returns: intrinsic.signature.returns,
      },
    },
  };
  if (intrinsic.pure) {
    props.declaredEffects = ["immutable-read"];
    props.readonly = true;
  }
  return props;
}
```
— `src/optimizing/metadata/builtin-methods.ts:329-344`

`declaredEffects: ["immutable-read"]` is what the alias and code-motion machinery reads to
answer "may this node move across that one" ([Ch 43 § effects]); `readonly` is what lets
dead-code elimination delete a call nobody uses. Neither has any meaning inside the
interpreter, which is why `STRING_METHODS` has no place to put them
[t: `tests/optimizing/metadata/builtin-methods.test.ts` > "marks a pure intrinsic as a readonly read"].
This is the same pair of props a third-party plug-in sets on its own intrinsics, through a
different function and the same two field names — [Ch 29 § intrinsic-effects] is where a
plug-in turns eight calls into fewer than eight by setting them.

Note the `[...intrinsic.signature.params]` spread. The registry is a module-level `Map` and
the metadata is handed to a graph that will be rewritten; copying the array is what stops a
pass from mutating the registry every later compile reads
[t: `tests/optimizing/metadata/builtin-methods.test.ts` > "copies the signature so a graph cannot mutate the registry"].

**Defaults.** `slice` declares `defaults: [0, STRING_TO_END]` and `pad_start` declares
`[0, " "]` (`:52`, `:61`). A compiler that sees `s.slice(2)` needs a second argument to
emit; the interpreter never does, because the JavaScript method has its own defaults
already. `requiredArgCount` (`:270`) is `params.length - defaults.length`, plus one for the
receiver, so
the arity check knows which arguments may be absent.

And the thing that is *declared* rather than checked:

> **Unenforced.** `pure` is a hand-written boolean on twenty rows. Nothing verifies that
> `STRING_METHODS.slice` is actually side-effect free — no analysis reads the JavaScript, and
> the interpreter's payload carries no effect information to compare against. A row marked
> `pure: true` whose implementation mutates its receiver would let global value numbering
> collapse two calls into one and dead-code elimination delete a call whose only purpose was
> the mutation, with no diagnostic anywhere. Today every one of the twenty is genuinely pure;
> nothing keeps the twenty-first honest. Enforcing it would need effect annotations on the
> runtime payloads, which is exactly the extension surface [Ch 29 § intrinsic-effects]
> already gives third parties and the engine's own builtins do not use.

## Host bridge: `taggedToNative` and `nativeToTagged`

Everything so far has been tera calling code written for tera. The other direction is two
functions in `src/runtime/domain/host.ts`, and they are the *only* doors between a
`TaggedValue` and the JavaScript that four sibling packages are written in.

> **New idea. Foreign function interface, and marshalling.** Two languages that want to call
> each other have to agree on how a value looks. A **foreign function interface** is that
> agreement. When the two representations differ — and here they differ completely, because
> a tera value is a tagged JavaScript *number* indexing a side heap while a JavaScript value
> is the object itself — the values cannot simply be passed; they have to be **marshalled**,
> which means *converted*, which in practice means *copied*. Marshalling is the cost nobody
> budgets for: it is proportional to the size of the value graph, not to the size of the
> call, and it happens on every crossing in both directions.

`taggedToNative` (`:142-181`) and `nativeToTagged` (`:282-315`) are a mutual recursion over
the tag codes of [Ch 22 § tagged-values]. Most cases are one line each: `undefined`, `null`,
the four primitives through `getPayload`, an array through `.map`. Four are not.

**A promise becomes a real `Promise`.** `taggedToPromise` (`:124-140`) reads the promise
record's state; a settled one is resolved immediately, a pending one gets a reaction
registered that resolves the JavaScript promise when it settles.

**A function becomes a JavaScript closure that re-enters the interpreter** (`:148-156`).
The returned closure marshals its arguments inward with `nativeToTagged`, calls
`callFunctionValue`, and marshals the result back out.

**An object may or may not keep its identity.** This is the case worth reading in full:

```ts
  if (isObject(value)) {
    const object = getPayload(value) as HostObject;
    if (object._hostValue !== undefined) return object._hostValue;
    if (modelBridge && hostAsync && object.hiddenClass.properties.some(([key]) => key === MODEL_MARKER)) {
      return modelBridge(value, hostAsync.interpreter);
    }
    if (object._mapData) {
      const out = new Map<unknown, unknown>();
      for (const [key, inner] of object._mapData.iterateEntries()) out.set(taggedToNative(key), taggedToNative(inner));
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const [key, desc] of object.hiddenClass.properties) {
      const raw = desc.offset < object.slots.length ? object.slots[desc.offset] : object.overflowProperties?.get(key);
      if (raw !== undefined && !(raw instanceof AccessorPair)) out[key] = taggedToNative(raw);
    }
```
— `src/runtime/domain/host.ts:157-172`

An object that came *from* the host carries `_hostValue`, and that field is handed straight
back: identity preserved, no copy, `===` still works on the far side. A plain tera object
has no such field, so it is **rebuilt** — a fresh JavaScript object, field by field,
recursively. Identity is lost. Two crossings of the same tera object produce two different
JavaScript objects. And a `Map` payload ([Ch 26 § collections-opt-out-by-a-side-field]) becomes a real `Map`, keys
and values marshalled one by one.

The last line of the object branch is a small piece of protocol: `return isNamedArguments(object)
? markNamedArguments(out) : out` (`:178`). The `NATIVE_NAMED_ARGUMENTS` symbol
(`src/runtime/named-arguments.ts:4`) survives the crossing, so a host function can tell an
options bag from a positional object argument.

## Marshalling costs a copy

The cost is not hidden but it is easy to miss: `taggedToNative` on an object is O(size of
the reachable graph), and `nativeToTagged` coming back is the same. A DataFrame handed
across, mutated, and handed back is two full copies unless it carries `_hostValue`, which
is exactly why `wrapHostObject` exists.

This is the same cost the JIT road pays at its own boundary ([Ch 53 § allocatetagged]),
where an object has to be copied into wasm linear memory on the way in and copied back on
the way out, and where the tiering policy declines some object-heavy functions outright
rather than compile them — [Ch 53 § allocatetagged] counts those declines and says what
each one measures. The two situations are not analogous, they
are the same mechanism: a value representation that is a bare number inside one world and
has to be rewritten to leave it.

One thing `nativeToTagged` does not do is take a shortcut on numbers. It calls `mkNumber`
(`:286`), not `mkDouble`, so an integer that fits in Smi range comes back as a Smi and the
canonical-number invariant of [Ch 22 § canonical-numbers] survives the crossing
[t: `tests/runtime/domain/host.test.ts` > "canonicalizes the result of a host builtin"]
[t: `tests/runtime/domain/host.test.ts` > "tags an integral number beyond smi range as a double"].

There is one hole in the outward door:

> **Unenforced.** `taggedToNative` (`src/runtime/domain/host.ts:148-150`) returns the raw
> `TaggedValue` — a JavaScript *number* — when a function value crosses out and `hostAsync`
> is not bound. Host code that asked for a callable receives an integer, with no diagnostic.
> Every CLI path binds it: `Engine.runInRuntime` (`src/api/engine.ts:822-835`) wraps every
> public method and passes `bindHost = true` by default, and the only two call sites that
> pass `false` (`:785` `installNativeModules` and `:1357` `resetModuleCells`) never marshal a
> function outward. So the branch is unreachable today and nothing says so — no assertion, no
> type, no test. A one-line `throw` would cost nothing and would document the precondition.

And one branch that has become unreachable for a different reason:

> **Dead.** The `modelBridge &&` conjunct at `src/runtime/domain/host.ts:160`.
> `src/runtime/domain/model-builtins.ts:263` calls `bindModelBridge(modelBridge)` at module
> evaluation time, and `createDomainBuiltins` (`src/runtime/domain/builtins.ts:29`) imports
> that module, which `src/runtime/builtins/index.ts:64` imports in turn. So in any process
> that has a builtin registry at all — which is every process that has an `Engine` — the
> module-level `modelBridge` variable is non-null before the first line of user code runs,
> and the guard's false branch cannot be taken. Removing it costs one identifier; leaving it
> costs a reader the assumption that the bridge is optional.

## Host reentry is a captured function

Host code settles a promise on the host's own timeline — a `setTimeout`, a network reply, a
worker message. When it does, the callback that resumes the interpreter runs *outside* any
of the six ambient registries [Ch 29 § six-registries] describes. The value heap, the
hidden-class registry and the id allocators are all module-level variables swapped by
`with*` wrappers, and by the time a host callback fires, those wrappers have long returned.

The answer is four lines:

```ts
export function captureHostReentry(): HostReentry {
  const run = hostAsync?.run;
  return run ?? (<T>(fn: () => T) => fn());
}
```
— `src/runtime/domain/host.ts:78-81`

`hostAsync.run` is `Engine.runInRuntime` closed over `this` (`src/api/engine.ts:818`).
Capturing it *now*, while the registries are still bound, produces a function that will
re-establish all of them later. If there is no binding, the identity function is returned
and the caller behaves as before.

Every callback the bridge hands to host code goes through it. `thenableToTagged` uses it
twice:

```ts
function thenableToTagged(value: PromiseLike<unknown>): TaggedValue {
  const binding = hostAsync!;
  const reenter = captureHostReentry();
  const { capability, value: promise } = mkPromiseCapability(binding.queue);
  value.then(
    (settled) =>
      reenter(() => {
        capability.resolve(nativeToTagged(settled));
        binding.drain();
      }),
    (reason) =>
      reenter(() => {
        capability.reject(nativeToTagged(reason));
        binding.drain();
      }),
  );
  return promise;
}
```
— `src/runtime/domain/host.ts:87-104`

The invariant is: **host code never resumes the interpreter directly; it resumes it inside
`run`.** And `binding.drain()` inside the same wrapper is the second half — settling a
promise enqueues microtasks, and nothing else is going to pump them, because the host's
event loop is not the interpreter's. [Ch 30 § two-phases-one-budget-one-guard] receives `drain()` and
the queue it drains.

## Wrapping a host object

An object coming the *other* way — a DataFrame, a tensor, a chart — is not rebuilt. It is
wrapped:

```ts
function wrapHostObject(value: object): TaggedValue {
  const object = createJSObject() as HostObject;
  object._hostValue = value;
  object.toString = () => typeof value.toString === "function" ? value.toString() : `[Host ${value.constructor?.name || "Object"}]`;
  object._display = (compact: boolean) => formatHostValue(value, compact) ?? object.toString();
  installHostIndexing(object, value, nativeToTagged);
  const specMethods = methodsOf(value);
  const native = new Set(methodNames(value));
```
— `src/runtime/domain/host.ts:242-249`

`_hostValue` is the identity ticket that makes the return trip free. `installHostIndexing`
is what installs the `_indexND` hook of [Ch 26 § multi-dimensional-means-left-to-right-not-per-axis].
Then the walk: `methodNames` (`:197-207`) collects every own name up the prototype chain,
and for each one `ownDescriptor` (`:222-230`) decides what it is. A function becomes a
`hostMethod` payload (`:209-220`) whose `call` marshals arguments in and the result out. A
data property becomes an `AccessorPair` — `hostMethod` as the getter, `hostSetter`
(`:232-240`) as the setter when the descriptor is writable — so a write from tera reaches
the real object rather than a copy.

Every exposed name goes through `camelToSnake` (`:253`, `:258`). A host class whose method
is `groupBy` becomes `group_by` in tera, with no cooperation from the host class at all.

The named-argument half comes from `methodsOf`:

```ts
function methodsOf(value: object): MethodMetadataTable | undefined {
  for (let current = value; current !== null; current = Object.getPrototypeOf(current)) {
    const owner = hostTypeOwners.get(current.constructor);
    if (owner !== undefined) return SPEC_METHODS[owner];
  }
  return undefined;
}
```
— `src/runtime/domain/host.ts:189-195`

`registerHostType(constructor, owner)` (`:185-187`) is how a host type declares which spec
entry describes it, and the loop walks the *constructor chain*, so a subclass inherits its
parent's declared parameter names
[t: `tests/runtime/domain/host-methods.test.ts` > "resolves the owner through a subclass"]
[t: `tests/runtime/domain/host-methods.test.ts` > "matches a camelCase host method to its snake_case spec name"].

The result: an object from a sibling package acquires tera spelling and tera named arguments
without the sibling package knowing tera exists.

## Four other compilers, described only by interface

`createDomainBuiltins` is the seam:

```ts
export function createDomainBuiltins(): BuiltinMap {
  const map: BuiltinMap = { ...createModelBuiltins() };
  installTensorBuiltins(map, domainBuiltins);
  installDataFrameBuiltins(map, domainBuiltins);
  installMlBuiltins(map, domainBuiltins);
  installNumericBuiltins(map, domainBuiltins);
  installQuantBuiltins(map, domainBuiltins);
  installChartBuiltins(map, chartBuiltins);
  installCoreBuiltins(map);
  return map;
}
```
— `src/runtime/domain/builtins.ts:28-38`

Behind those seven calls are four sibling repositories: `mlfw`, tera's machine-learning
compiler, behind the tensor, model and ML surfaces; `query_engine`, behind DataFrame;
`quantc`, behind the quant surface; and `reactive`, reached through the extension mechanism
of [Ch 29 § the-full-surface-slexisvnreactive] rather than through this file. The chart
surface's statistics are excluded from this book by name (`docs/README.md:138-139`), and so
is a builtin-by-builtin reference (`:144-146`).

[Conventions § 19] draws the boundary and this chapter states exactly where it is. **What
crosses is what `nativeToTagged` accepts and what `taggedToNative` produces, plus
`markNamedArguments` on an options bag, plus a `registerHostType` registration and the
spec's parameter names.** Nothing else. A sibling package sees `unknown` arguments and
returns `unknown`; the entire tera-facing surface of any of them is `hostBuiltin`
(`src/runtime/domain/host.ts:317-328`), which is twelve lines and does nothing but marshal
in both directions.

`installCoreBuiltins` is the one entry in this file that is not a sibling package. It
installs `range`, and `range` is a plain JavaScript array builder:

```ts
  register(map, "range", (...args) => {
    const start = args.length === 1 ? 0 : Number(args[0] ?? 0);
    const stop = Number(args.length === 1 ? args[0] : args[1]);
    const step = Number(args[2] ?? 1);
    if (step === 0) throw new Error("range() step cannot be zero");
    const out: number[] = [];
    if (step > 0) for (let value = start; value < stop; value += step) out.push(value);
    else for (let value = start; value > stop; value += step) out.push(value);
    return out;
  }, domainBuiltins.range);
```
— `src/runtime/domain/builtins.ts:16-25`

It returns `number[]`, which `nativeToTagged` then converts into a real `JSArray` — and the
elements are allocated on the value heap during that conversion, which is where
[Ch 31 § the-scavenge] found `range()`'s use-after-free: the array under construction was
reachable only from a JavaScript closure, and a scavenge that ran mid-conversion had no root
for it.

The last thing to say about the domain surface is what a `camelOptions` call does
(`src/runtime/domain/common.ts:29-37`): it runs `snakeToCamel` over every key of an options
object on the way out, and consults a one-entry `OPTION_ALIASES` table (`:14-16`, `grad` →
`requiresGrad`). That is the last spelling conversion in the chain, and it exists because
the sibling packages were written in JavaScript for JavaScript callers.

## What the running example actually calls

Two builtins, and both are visible in one disassembly:

```
Constants:
  [0] "name"
  [1] " mean="
  [2] "mean"
  [3] "to_fixed"
  [4] 2
...
    16  LdaNamedProperty r1 [3] (to_fixed) r4
```
— `node dist/cli.js --print-bytecode --filter label docs/example/stats.tera`

`to_fixed` is a constant-pool string put there by the parser, loaded as a named property of
`r1` — which holds the `float` that `mean()` returned. Tag code `CODE_DOUBLE`, table entry
`numberMember`, prototype `numberPrototype`, property `to_fixed`, put there by
`camelToSnake("toFixed")` at engine startup. Every arrow in this chapter's first four
sections, in one instruction.

`print` is the other, and it is `LdaGlobal [20] (print)` in the script's own body — a
global cell, indistinguishable from `report`.

That is the whole of the spine's reach. `stats.tera` builds no host object, passes no named
argument, touches no domain surface and calls no method whose C twin can disagree with it.
Everything from § the-jit-converts-back onward in this chapter was demonstrated on probes,
and the chapter says so rather than implying the spine covers it.

## What leaves

Three artifacts, and [Ch 29] asks who else is allowed to add to each.

**A `GlobalCellMap`**, populated by one loop over every key of `builtins` — the
twenty-eight written literally at `src/runtime/builtins/index.ts:277-1162`, the seven error
constructors spread in at `:476`, and everything `createDomainBuiltins()` supplies —
each converted by `builtinValue` and written by `installBuiltinEntries` (`:180-184`). That
loop is the only writer of the cell map at startup, and the cells are ordinary globals: the
same `LdaGlobal`, the same inline cache, the same shadowing rules as a user's name.

**Nine `JSObject` prototypes** on `interpreter.builtinPrototypes`, every property name of
which has been through `camelToSnake` on the way in, five of them reachable through
[Ch 25]'s tag-code table and four through [Ch 24]'s hidden-class path. The camel spelling
does not exist; `"x".toUpperCase` is `undefined`, and calling it reports a value, not a
name.

**`taggedToNative` / `nativeToTagged`**, the only two doors between a tera value and the
JavaScript four sibling packages are written in. They copy, they preserve identity only for
values carrying `_hostValue`, they canonicalise numbers on the way in, and every callback
they hand outward is wrapped in `captureHostReentry()` so the interpreter is only ever
resumed inside `Engine.runInRuntime`.

And one fact that is not an artifact but shapes Part IX: **three tiers share one
implementation object and the fourth shares only a name.** `builtinMethodImplementation`
makes disagreement between the interpreter, the baseline and the JIT unrepresentable.
Between those three and the native backends, agreement is a property of two independently
written lists that happen to read their arities from the same specification — held together
by four unit tests and, where they genuinely differ, by a bespoke analysis like
`mapsUnicode` that refuses the function rather than emitting the wrong answer.

[Ch 29 § six-registries] receives all three artifacts and asks the question this chapter
deliberately left alone: the engine installs its own builtins with `installBuiltinEntries`,
and marshals its own values with `taggedToNative` — so what does a third party have to do to
get the same treatment, and what can it add that a name alone cannot express?

## Verify it yourself

Every probe below is two to four lines. Write them with an editor, outside the repository.

```bash
# The spine's two builtins: a prototype method and a global cell.
node dist/cli.js --print-bytecode --filter label docs/example/stats.tera | head -8
node dist/cli.js --print-bytecode docs/example/stats.tera | grep -n "LdaGlobal \[20\]"
```

```
=== label (params=0, locals=0, registers=5, constants=5) ===
Constants:
  [0] "name"
  [1] " mean="
  [2] "mean"
  [3] "to_fixed"
  [4] 2
Instructions:
71:    46  LdaGlobal [20] (print)
80:    55  LdaGlobal [20] (print)
```

`camel.tera` — the rename has no alias:

```
print("tera".toUpperCase())
```

```bash
node dist/cli.js camel.tera; echo "exit=$?"
```

```
undefined is not a function
exit=1
```

`dual.tera` and `ni.tera` / `ni2.tera` — two spellings, or one, decided by a regex:

```
print(Array.isArray([1]))
print(Array.is_array([1]))
print(String.fromCharCode(65))
print(String.from_char_code(65))
```

```bash
node dist/cli.js dual.tera
printf 'print(Number.is_integer(1))\n'  > ni.tera  && node dist/cli.js ni.tera
printf 'print(Number.isInteger(1))\n'   > ni2.tera && node dist/cli.js ni2.tera; echo "exit=$?"
```

```
true
true
A
A
true
undefined is not a function
exit=1
```

`find.tera`, `tm.tera` and `mc.tera` — the deliberate divergence, and the namespace that is
a function:

```bash
printf 'print([1,2,3].find(x => x > 9))\n' > find.tera && node dist/cli.js find.tera
printf 'print(typeof(Math))\n' > tm.tera && node dist/cli.js tm.tera
printf 'print(Math(1))\n' > mc.tera && node dist/cli.js mc.tera; echo "exit=$?"
```

```
null
function
Cannot call function: Math
exit=1
```

`mp.tera` — a builtin is an ordinary function value:

```bash
printf 'print([1.5, 2.5, 3.7].map(Math.floor))\n' > mp.tera && node dist/cli.js mp.tera
```

```
[1, 2, 3]
```

`up.tera` — the same method, four implementations, and the emitted C:

```
fn shout(s: string) -> string:
  return s.to_upper_case()

print(shout("tera"))
```

```bash
node dist/cli.js up.tera
node dist/cli.js compile up.tera -o up_c --emit source --target c
grep -n "tera_string_case" -A 11 up_c/up.c | head -13
```

```
TERA
tera compile: wrote up_c
```

`up2.tera` — the divergence, and the analysis that catches it. Change `"tera"` to `"café"`:

```bash
node dist/cli.js up2.tera
node dist/cli.js compile up2.tera -o up2.exe --target c; echo "exit=$?"
```

```
CAFÉ
tera compile: note: 'shout' is not in the binary, and nothing the program runs calls it (C backend cannot emit: string.to_upper_case maps characters the way Unicode says, and this text holds some outside ASCII; the compiled runtime carries no case or whitespace tables, so keep this part interpreted)
tera compile: note: 'tera_program' is not in the binary, and nothing the program runs calls it (calls unavailable function shout)
tera compile: entry function tera_program could not be lowered to native code: it calls shout, skipped because C backend cannot emit: string.to_upper_case maps characters the way Unicode says, and this text holds some outside ASCII; the compiled runtime carries no case or whitespace tables, so keep this part interpreted
exit=1
```

`rd3.tera` / `rd4.tera` — shadowing is refused only if you still call it:

```bash
printf 'sum = 5\nprint(sum([1, 2]))\n' > rd3.tera && node dist/cli.js --typecheck strict rd3.tera; echo "exit=$?"
printf 'sum = 5\nprint(sum)\n'         > rd4.tera && node dist/cli.js --typecheck strict rd4.tera; echo "exit=$?"
```

```
1:1 Cannot redeclare built-in 'sum'
exit=1
5
exit=0
```

```bash
# The two tables, and the JIT's door back into the first (34 tests).
npx vitest run --project unit tests/optimizing/metadata/builtin-methods.test.ts tests/runtime/intrinsics/builtin-methods.test.ts
```

```
 Test Files  2 passed (2)
      Tests  34 passed (34)
```

```bash
# The two places the C and x64 backends bind to_upper_case, and the analysis between them.
grep -rn 'qualifiedMethodName("string", "to_upper_case")' src/
grep -n "MAPS_UNICODE" -A 6 src/optimizing/analyses/wide-text.ts | head -8
```

```
src/optimizing/backends/c/emit.ts:946:    qualifiedMethodName("string", "to_upper_case"),
src/optimizing/backends/x64/lowering.ts:347:  [qualifiedMethodName("string", "to_upper_case"), X64_RUNTIME_SYMBOLS.stringUpper],
```

## Tests that pin this

- `tests/runtime/intrinsics/builtin-methods.test.ts` >
  `"maps a snake_case Tera name onto the camelCase runtime method"` — the JIT's reverse
  conversion, asserted as reference equality against `STRING_METHODS.charCodeAt.call`. This
  is the "one implementation object" claim in its strongest available form.
- `tests/runtime/intrinsics/builtin-methods.test.ts` >
  `"carries the parameter names the language spec declares for the method"` — metadata is
  lifted from `data/tera-language-spec.ts`, not written twice.
- `tests/runtime/intrinsics/builtin-methods.test.ts` > `"refuses a receiver that is not a string"`,
  `"returns null for an owner it does not know"`,
  `"returns null for a method the owner does not have"`,
  `"does not expose inherited object properties as methods"` — the four ways the table
  declines instead of guessing, each of which sends the JIT to `executeRuntimeCall`.
- `tests/runtime/intrinsics/builtin-methods.test.ts` >
  `"resolves to the same implementation on every lookup"` — the `WeakMap` cache in
  `methodsWithMetadata`, observed as object identity.
- `tests/optimizing/metadata/builtin-methods.test.ts` >
  `"backs every declaration with a member the language spec declares"` and
  `"takes the arity and the types from the language spec"` — the fourth compiler's table is
  *derived*, not independent.
- `tests/optimizing/metadata/builtin-methods.test.ts` >
  `"backs every declared method with a runtime implementation"` — every AOT declaration has
  an interpreter twin. It does not check that the twins agree; see § why-the-obvious-design-fails.
- `tests/optimizing/metadata/builtin-methods.test.ts` >
  `"takes the getter flag from the spec instead of the declaration"` and
  `"gives a getter no arguments beyond its receiver"` — `length` is a getter, and the
  declaration cannot override that.
- `tests/optimizing/metadata/builtin-methods.test.ts` > `"marks a pure intrinsic as a readonly read"`
  and `"copies the signature so a graph cannot mutate the registry"` — the declared effects,
  and the defensive copy that keeps a pass from editing a module-level `Map`.
- `tests/e2e/language/collections.test.ts` > `"uses snake_case intrinsic methods"` — asserts
  `"tera".to_upper_case()` and `[1,2,3].find_index(...)` from source, which is the rename
  observed from the language rather than from the prototype builder.
- `tests/e2e/language/intrinsic-arguments.test.ts` >
  `"intrinsic integer arguments agree with the host"` > `"coerces a fractional slice start"`
  and sixteen sibling cases generated from the same list, each titled `coerces <case>` — every
  intrinsic's integer coercion checked against the *host's own* method, reached by rewriting
  the snake name back to camel with `snakeToCamel`. This is the differential harness the
  chapter's first `> **Unenforced.**` says should be pointed at the fourth compiler too.
- `tests/runtime/intrinsics/array-methods.test.ts` > `"find returns null when nothing matches"` —
  the divergence from JavaScript, in the interpreter.
- `tests/e2e/optimizing/aot/array-methods.test.ts` > `"compiles find, whose miss answers null"`
  and `tests/e2e/optimizing/aot/collections.test.ts` >
  `"answers null for a key the map never held"` — the same divergence, mirrored by the fourth
  compiler inside a real binary.
- `tests/runtime/named-arguments.test.ts` >
  `"places a named argument in the slot its parameter declares"`,
  `"accepts the camelCase spelling of a snake_case parameter"`,
  `"binds through the axis/dim synonym"`,
  `"never overwrites an argument the caller already passed positionally"`,
  `"leaves an unknown name for the callee to read as an option"` — the five binding rules.
- `tests/runtime/domain/host-methods.test.ts` >
  `"matches a camelCase host method to its snake_case spec name"` and
  `"resolves the owner through a subclass"` — `wrapHostObject`'s rename, and `methodsOf`
  walking the constructor chain.
- `tests/runtime/domain/host.test.ts` > `"canonicalizes the result of a host builtin"` and
  `"tags an integral number beyond smi range as a double"` — `nativeToTagged` produces
  canonical values rather than `mkDouble` for everything.
- `tests/runtime/builtins/builtins.test.ts` > `"isArray distinguishes arrays from non-arrays"`,
  `"Symbol.for returns same symbol for same key"`,
  `"uses spec ToString for numbers and booleans"` — namespace entries reached through
  `builtinValue`'s third branch.
- `tests/frontend/checker/type-checker.test.ts` >
  `"refuses a top-level name the program still calls as a built-in"` and
  `"lets a top-level name shadow a built-in nothing calls"` — both halves of the
  `Cannot redeclare built-in` rule.
- `tests/cli/repl.test.ts` > `"completes members of an inferred string value"` — the same
  spec table feeding a fourth consumer, the completer.
- `tests/runtime/intrinsics/collection-methods.test.ts` > `"get returns undefined for missing key"`
  — cited here only because its title is wrong; the assertion is `toBe(mkNull())`.
- Nothing pins `typeof(Math) == "function"`, the `Cannot call function: Math` diagnostic, the
  namespace two-spelling asymmetry, or that the fourth compiler's implementations *agree*
  with the interpreter's on any receiver. All four are `[unpinned]`.
