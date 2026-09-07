# 28. What the program calls: builtins, the host bridge, and four other compilers   ⟨I · B · J · N⟩

> **Status:** outline

**Thesis.** Exactly one implementation of each builtin serves three tiers, the fourth mirrors
it by name only, and that asymmetry is where AOT/interpreter divergences are born.

**What arrived.** A frame inside `runFrame` at a `CallMethod` or `Call` opcode whose callee is
*not* a `RegisterCompiledFunction`. [Ch 25 § member-lookups] has already answered
`this.mean().to_fixed` by walking `MEMBER_LOOKUPS[codeOf(receiver)]` into
`interpreter.builtinPrototypes.numberPrototype`, and handed back a `FunctionValue` whose
payload has a `call` but no `compiled`. [Ch 27] has established that this callee cannot pin
the caller to tier zero — no builtin is in `INTERPRETER_ONLY_OPS`.

**What leaves.** Three things chapter 29 asks who is allowed to add to:

1. A `GlobalCellMap` populated by one loop — every key of `builtins`
   (`src/runtime/builtins/index.ts:277`, itself spread over `createDomainBuiltins()`) written
   as a `TaggedValue` by `installBuiltinEntries`.
2. Nine `JSObject` prototypes on `interpreter.builtinPrototypes`, every property name of which
   has been through `camelToSnake`.
3. `taggedToNative` / `nativeToTagged` — the only two doors between a tera value and the
   JavaScript that four sibling packages are written in.

**New ideas.** *Builtin* vs *intrinsic* (the same method under two names: a `call` the
interpreter invokes, versus a row in a compiler table); *registry*; *single source of truth /
derived table* (`data/tera-language-spec.ts` feeding both); *foreign function interface* and
*marshalling* (the host bridge is one, and it copies); *named arguments* as a calling
convention. *Declared effects* and *purity* are named here on
`builtinMethodCallMetadata` and opened properly in [Ch 43 § effects].

**Length.** 12 pages

## Anchors

- `src/runtime/builtins/index.ts` (1,255 lines) — `BuiltinRegistryEntry` (91): the three-way
  union `RuntimeFunctionPayload | BuiltinNamespace | { globalConst: () => TaggedValue }`, and
  the three predicates that discriminate it — `isRuntimeFunctionPayload` (109),
  `hasGlobalConst` (120), everything else a namespace. `namespaceValue` (130), `spellOut`
  (141), `functionValue` (148), `builtinValue` (165), `installBuiltinEntries` (180-184) —
  four lines, one `globalCells.write` per entry. `ERROR_CONSTRUCTOR_NAMES` (230). The
  registry itself at 277, opening with `...createDomainBuiltins()`; its namespaces at
  `Number` 354, `Math` 551, `Array` 649, `Object` 754, `Reflect` 933, `JSON` 1032, `String`
  1107. `BuiltinRegistry = typeof builtins` (1164) — the registry's type is *derived from* the
  object literal, not declared ahead of it.
- `src/runtime/intrinsics/prototypes.ts` (55 lines, the whole file quotable) —
  `populatePrototype` (22-28), whose one load-bearing line is
  `proto.setProperty(camelToSnake(name), mkFunction(method))`; `createBuiltinPrototypes`
  (30-55) returning exactly nine objects, and the two `setSymbolProperty` calls that alias
  `Symbol.iterator` onto `Map.entries` and `Set.values`.
- `src/runtime/intrinsics/string-methods.ts:327-331` — `STRING_METHODS.toUpperCase`, three
  lines, `mkString(unwrapString(thisValue).toUpperCase())`. Full Unicode, because the host
  does it.
- `src/runtime/intrinsics/builtin-methods.ts` (28 lines) — `OWNERS` (13-17), a three-entry map
  keyed `"string" | "int" | "float"` with an `accepts` predicate each;
  `builtinMethodImplementation` (19-28), which runs `snakeToCamel` in the *opposite*
  direction to `populatePrototype` and is the JIT's door back into the same table.
- `src/runtime/intrinsics/method-metadata.ts` (23 lines) — `SPEC_METHODS` (7) built once from
  `TERA_PSEUDO_TYPES`; `methodsWithMetadata` (10-22) spreading `{ ...payload, metadata }` onto
  every method the spec describes, `WeakMap`-cached by table identity.
- `src/utils/naming.ts` (16 lines) — `snakeToCamel`, `camelToSnake`, and `spellings`, whose
  `CAMEL_MEMBER` / `CAMEL_BOUNDARY` pair is why namespaces get two names and prototype methods
  get one.
- `src/runtime/named-arguments.ts` (80 lines) — `NATIVE_NAMED_ARGUMENTS` (4) as a
  `Symbol.for` marker, `markNamedArguments` / `isNamedArguments` (15-22), `PARAM_SYNONYMS`
  (24-27) — two entries, `axis`↔`dim` — `positionalSlots` (32-51) with its `WeakMap` slot
  cache, `acceptsNamedOptions` (53-57), `bindNamedSlots` (59-80).
- `src/runtime/domain/host.ts` (333 lines) — `captureHostReentry` (78-81),
  `thenableToTagged` (87-104), `taggedToPromise` (124-140), `taggedToNative` (142-181),
  `registerHostType` (185) and `methodsOf` (189), `hostMethod` (209), `hostSetter` (232),
  `wrapHostObject` (242-280), `nativeToTagged` (282-315), `hostBuiltin` (317-328).
- `src/runtime/domain/builtins.ts` (38 lines) — `createDomainBuiltins` (28-38): seven
  `install*` calls, one per sibling package, plus `installCoreBuiltins` which is where `range`
  lives.
- `src/runtime/domain/common.ts` — `camelOptions` (29-36), `splitOptions` (44), `register`;
  `OPTION_ALIASES` (14-16) is a one-entry table (`grad` → `requiresGrad`).
- `src/optimizing/baseline/runtime.ts:338` — `memberLookupValue(obj, propName, this.interp)`.
  The baseline reaches the same nine prototypes through the same table; it does not have its
  own builtins.
- `src/optimizing/backends/wasm/runtime-support.ts:105, 460-483` — `callBuiltinMethod`, which
  calls `builtinMethodImplementation(intrinsic.owner, intrinsic.name, receiver)` at 472 and
  falls back to `executeRuntimeCall` when it answers `null`. This is the JIT calling the
  *interpreter's* implementation.
- `src/optimizing/metadata/builtin-methods.ts` (344 lines) — the fourth compiler's own table.
  `BUILTIN_METHOD_DECLARATIONS` (35-89): nineteen rows, snake_case names, each with a `pure`
  flag. `GLOBAL_BUILTIN_DECLARATIONS` (138-147) — eight entries, all `pure: false`.
  `NAMESPACE_FUNCTION_DECLARATIONS` (194-204) — nine `Math` functions, `random` the only
  impure one. `buildRegistry` (256-283), which reads arity and types back out of the language
  spec via `builtinOwnerMember`. `builtinMethodCallMetadata` (329-344), which stamps
  `declaredEffects: ["immutable-read"]` and `readonly: true` on the pure ones.
- `src/optimizing/analyses/wide-text.ts:169-175, 195-198, 208-214` — `MAPS_UNICODE`,
  `mapsUnicode`, `unicodeTableReason`. The guard that stops the fourth compiler's ASCII
  `to_upper_case` from being wrong.
- `src/optimizing/backends/c/emit.ts:946` and `src/optimizing/backends/x64/lowering.ts:347` —
  the two places `qualifiedMethodName("string", "to_upper_case")` is bound to native code
  (`tera_string_upper`, `X64_RUNTIME_SYMBOLS.stringUpper`).
- `src/bytecode/register/interpreter/index.ts:685-689` — the install order:
  `installBuiltinEntries` → `installPromiseBuiltin` → `_wireWellKnownSymbols` →
  `createBuiltinPrototypes` → `_wirePrototypes`.

## Worked example

`STRING_METHODS.toUpperCase` reached three ways, then the same method name compiled by a
fourth implementation that shares nothing with it.

```bash
printf 'fn shout(s: string) -> string:\n  return s.to_upper_case()\nprint(shout("tera"))\n' > /tmp/up.tera
node dist/cli.js /tmp/up.tera
node dist/cli.js compile /tmp/up.tera -o /tmp/up.c --emit source --target c
grep -n 'tera_string_upper' /tmp/up.c/up.c
```

The interpreter path is `memberLookupValue` → `stringPrototype` →
`camelToSnake("toUpperCase")` → the payload's `call`. The baseline path is the same call at
`baseline/runtime.ts:338`. The JIT path is `callBuiltinMethod` →
`snakeToCamel("to_upper_case")` → *the same payload object*. The native path is
`tera_string_upper` in the emitted C — thirteen lines that subtract 32 from bytes in
`'a'..'z'` and know nothing about Unicode.

Then the divergence, and the thing that catches it:

```bash
printf 'fn shout(s: string) -> string:\n  return s.to_upper_case()\nprint(shout("café"))\n' > /tmp/up2.tera
node dist/cli.js /tmp/up2.tera
node dist/cli.js compile /tmp/up2.tera -o /tmp/up2.exe --target c
```

The interpreter prints `CAFÉ`. The compiler does not print `CAFé`; it refuses, verbatim:

```
tera compile: note: 'shout' is not in the binary, and nothing the program runs calls it
  (C backend cannot emit: string.to_upper_case maps characters the way Unicode says, and this
  text holds some outside ASCII; the compiled runtime carries no case or whitespace tables,
  so keep this part interpreted)
```

## Outline

- [ ] **One shape for everything callable.** `RuntimeFunctionPayload`
      (`src/core/value/index.ts:186-212`) is a bag of optional fields. A tera function fills
      `compiled` and `closure`; a builtin fills `call`; a class constructor fills
      `prototypeObj` and `constructorOf`; a namespace fills only `name` and `properties`.
      Establish: `interpretCall` never asks *what kind* of callee it has, it asks which field
      is present — which is why a builtin needs no opcode of its own, and why a builtin can be
      passed to `values.map`.
- [ ] **The registry is three kinds in one union.** Walk `BuiltinRegistryEntry` (91) and its
      three consumers in `builtinValue` (165): `globalConst` is evaluated *now* (`NaN`,
      `Infinity`, `undefined` are cells, not literals); a payload becomes a function value with
      its non-`call` fields lifted into `properties`; anything else is a namespace object whose
      members are converted one by one by `namespaceValue`. Establish: the type
      `BuiltinRegistry = typeof builtins` (1164) is derived *from* the literal, so adding a key
      cannot forget to declare it.
- [ ] **Installation is four lines.** `installBuiltinEntries` (180-184) iterates
      `Object.entries` and calls `globalCells.write(name, builtinValue(name, entry))`.
      Establish: builtins are not a lookup fallback and not a scope — they are ordinary global
      cells, so [Ch 24]'s global-cell IC caches them, `LdaGlobal` finds them by the same path
      as a user global, and shadowing one is a checker-level refusal
      (`Cannot redeclare built-in 'x'`), not a runtime one. Forward to [Ch 16].
- [ ] **Nine prototypes and one rename.** `createBuiltinPrototypes` (30-55) builds
      `string / array / number / boolean / regex / error / map / set / weakMap`. Every name goes
      through `camelToSnake` on the way in. Establish the consequence bluntly: `"x".toUpperCase`
      is not a name in this language, and calling it produces `undefined is not a function` —
      the *runtime's* message, not a spelling hint.
- [ ] **Two spellings for a namespace, one for a method.** `spellings` returns two names only
      for a camelCase source name, and `spellOut` (141) writes both. Namespace members are
      therefore reachable as `Array.isArray` *and* `Array.is_array`, `String.fromCharCode`
      *and* `String.from_char_code` — while `Number.is_integer`, already snake in the literal,
      has exactly one spelling and `Number.isInteger` does not exist. Establish: the
      asymmetry is not a policy, it is a regex; a namespace member written in snake case in the
      registry silently loses its camel alias.
- [ ] **The JIT converts back.** `builtinMethodImplementation` (19-28) takes the *snake*
      name the compiler carries, runs `snakeToCamel`, and looks it up in the *same*
      `STRING_METHODS` / `NUMBER_METHODS` objects — guarded by an `accepts` predicate so a
      non-string receiver falls back to the generic path. Establish the invariant: **three
      tiers, one implementation object.** Enforcement: `runtime-support.ts:472`'s `null`
      fallback to `executeRuntimeCall`, so a missing entry degrades instead of miscompiling.
      Test: `tests/runtime/intrinsics/builtin-methods.test.ts > "resolves to the same
      implementation on every lookup"`.
- [ ] **Metadata is lifted, not written twice.** `methodsWithMetadata` (10-22) reads
      `data/tera-language-spec.ts` through `methodMetadataFromSpec` and spreads a `metadata`
      field onto each payload. That metadata is what `positionalSlots` reads to bind
      `chart.line(points, x=0, y=1)` onto a positional call. Establish: named arguments work
      for builtins and host functions *because* the spec is a table, and the same table feeds
      the checker, the REPL completer and the editor grammar. Name `PARAM_SYNONYMS` as the
      one hand-written exception (`axis` ↔ `dim`, two entries, for the ML siblings).
- [ ] **Where tera deliberately is not JavaScript.** `ARRAY_METHODS.find` (182-188) and
      `findLast` return `mkNull()`, not `undefined`; `MAP_METHODS.get` (38-45) and
      `WEAKMAP_METHODS.get` do the same. Establish: this is a *type-system* decision, not an
      oversight — `T | null` is a lattice type the checker can narrow ([Ch 10]) and the AOT can
      represent ([Ch 62 § two-absence-values]), while `undefined` is the absence AOT
      *declines* for references. Pin both, and pin that the fourth compiler mirrors the
      divergence deliberately.
- [ ] **"Why the obvious design fails": one table per tier.** Stage the design a reader would
      reach for — let each backend own its own list of string methods. `BUILTIN_METHOD_DECLARATIONS`
      (35-89) *is* that second list, and the tree pays for it in three ways: `buildRegistry`
      (256-283) has to re-derive arity from `builtinOwnerMember` so the two lists cannot
      disagree about argument counts; four unit tests exist purely to hold the lists in step;
      and the C backend's `tera_string_upper` still diverges on Unicode, which needs a whole
      analysis (`wide-text.ts`) to contain. Establish: the second table buys the compiler
      `pure`, `defaults` and a declared signature — facts the runtime payload cannot express —
      and its price is a permanent consistency obligation.
- [ ] **What the second table buys.** `builtinMethodCallMetadata` (329-344) stamps
      `declaredEffects: ["immutable-read"]` and `readonly: true` on the nineteen `pure` rows,
      and `defaults` (`slice` → `[0, STRING_TO_END]`, `pad_start` → `[0, " "]`) let the
      compiler materialise arguments the caller omitted. Establish: purity here is *declared*,
      not inferred; nothing verifies that `STRING_METHODS.slice` is actually side-effect free.
      Forward to [Ch 29 § intrinsic-effects], where a plug-in declares the same thing about
      its own function.
- [ ] **The host bridge copies.** `taggedToNative` (142-181) and `nativeToTagged` (282-315)
      are a mutual recursion over the tag codes of [Ch 22]. Walk the cases in order and name
      the four that are not simple: a promise becomes a real `Promise` via `taggedToPromise`; a
      function becomes a JS closure that re-enters the interpreter; an object with `_hostValue`
      unwraps to the original host object (identity preserved) while a plain object is
      *rebuilt* field by field (identity lost); a `Map` payload becomes a real `Map`.
      Establish: this is marshalling, it is O(size of the graph), and it is the same cost
      [Ch 46 § marshalling-decline] measured on the JIT road.
- [ ] **Re-entrancy is a captured function.** `captureHostReentry` (78-81) returns
      `hostAsync?.run` or the identity function, and every callback the bridge hands to host
      code is wrapped in it. `thenableToTagged` (87-104) uses it twice, then calls
      `binding.drain()` so a host promise settling outside the interpreter still pumps the
      microtask queue. Establish the invariant: **host code never resumes the interpreter
      directly**; it resumes it inside `run`. Hand `drain()` and the queue to [Ch 30].
- [ ] **Wrapping a host object.** `wrapHostObject` (242-280) walks the prototype chain,
      renames every own name with `camelToSnake`, exposes functions as `hostMethod` payloads
      and data properties as `AccessorPair`s so a write reaches the real object. `methodsOf`
      (189) finds spec metadata through `registerHostType`, walking the constructor chain so a
      *subclass* still gets its parent's declared parameter names. Establish: a DataFrame from
      the sibling `query_engine` acquires tera spelling and tera named arguments without
      `query_engine` knowing tera exists.
- [ ] **Four other compilers, described only by interface.** `createDomainBuiltins` (28-38)
      installs tensor, DataFrame, ML, numeric, quant and chart surfaces plus `range`. Establish
      the boundary set by [Conventions § 19]: what crosses is exactly what `nativeToTagged`
      accepts and `taggedToNative` produces, plus `markNamedArguments` on an options bag. Name
      the four packages, state that none of them appears again in this book, and note that
      `range` — the one core builtin in this file — is a plain JS array builder, which is why
      [Ch 31 § range-scavenge] had a use-after-free.
- [ ] **What the running example actually calls.** `stats.tera` reaches exactly two builtins:
      `to_fixed` off `numberPrototype` (visible as `LdaNamedProperty r1 [3] (to_fixed) r4` in
      the disassembly) and `print` out of a global cell. Establish the limit honestly: the
      spine touches neither the host bridge nor a domain builtin, so this chapter's later
      sections use purpose-built probes and say so.

## Honesty items

- > **Unenforced.** Nothing checks that `BUILTIN_METHOD_DECLARATIONS`
  (`src/optimizing/metadata/builtin-methods.ts:35-89`) and the runtime method tables *agree on
  results*. `tests/optimizing/metadata/builtin-methods.test.ts > "backs every declared method
  with a runtime implementation"` proves an implementation exists for every declaration; no
  test feeds the same receiver to both and compares. The C backend's `tera_string_upper`
  (emitted at `src/optimizing/backends/c/emit.ts:946`) is ASCII-only and
  `STRING_METHODS.toUpperCase` is not, and the only thing standing between them is
  `mapsUnicode` in `src/optimizing/analyses/wide-text.ts:195`. A differential harness over
  `RECEIVER_SAMPLES` would close it; the shape already exists in
  `tests/e2e/language/intrinsic-arguments.test.ts`, which does exactly this against the *host*.
- > **Unenforced.** The two-spelling rule is a regex, not a policy. `spellings`
  (`src/utils/naming.ts:12-15`) yields a camel alias only when the registry key is already
  camelCase, so `Array.isArray` has two names and `Number.is_integer`
  (`src/runtime/builtins/index.ts:369`) has one. Nothing asserts a consistent convention
  across the fourteen namespaces, and nothing warns when a new snake-cased key silently
  loses its alias.
- > **Unfinished.** A namespace is a function value that cannot be called. `builtinValue`
  (`src/runtime/builtins/index.ts:172-179`) returns `mkFunction({ name, properties })` with no
  `call`, so `typeof(Math)` answers `"function"` (JavaScript answers `"object"`) and `Math(1)`
  fails at run time with `Cannot call function: Math`. Making namespaces objects means giving
  them a hidden class and a prototype, which is why they are functions today.
- > **Broken.** `tests/runtime/intrinsics/collection-methods.test.ts > "get returns undefined
  for missing key"` asserts `toBe(mkNull())`. The title says the opposite of the assertion. In
  a codebase where a test title is the design document ([Conventions § 8]) this one is
  actively misleading; the fix is a rename.
- > **Unenforced.** `taggedToNative` (`src/runtime/domain/host.ts:148-156`) returns the raw
  `TaggedValue` — a JavaScript *number* — when a function crosses out and `hostAsync` is not
  bound. Host code receives a plain `number` where it asked for a callable, with no
  diagnostic. Every production path binds `hostAsync` first, so this is unreachable in the CLI;
  nothing enforces it.
- > **Never runs.** `bindModelBridge` / `modelBridge` (`src/runtime/domain/host.ts:58, 74-76,
  160-162`) is only consulted for an object carrying `MODEL_MARKER`; no test in `tests/`
  exercises the `null` bridge path, so a model value crossing out with no bridge bound falls
  through to the generic property walk rather than being reported. `[unpinned]`

## Verify it yourself

```bash
node dist/cli.js --print-bytecode --filter label docs/example/stats.tera | head -26
printf 'print("tera".toUpperCase())\n' > /tmp/camel.tera && node dist/cli.js /tmp/camel.tera
printf 'print(Array.isArray([1]))\nprint(Array.is_array([1]))\nprint(String.fromCharCode(65))\nprint(String.from_char_code(65))\n' > /tmp/dual.tera && node dist/cli.js /tmp/dual.tera
printf 'print([1,2,3].find(x => x > 9))\n' > /tmp/find.tera && node dist/cli.js /tmp/find.tera
printf 'fn shout(s: string) -> string:\n  return s.to_upper_case()\nprint(shout("café"))\n' > /tmp/up2.tera && node dist/cli.js /tmp/up2.tera && node dist/cli.js compile /tmp/up2.tera -o /tmp/up2.exe --target c
npx vitest run --project unit tests/optimizing/metadata/builtin-methods.test.ts tests/runtime/intrinsics/builtin-methods.test.ts
```

Expected, in order: `LdaNamedProperty r1 [3] (to_fixed) r4`; `undefined is not a function`;
`true / true / A / A`; `null`; `CAFÉ` followed by three `tera compile:` refusal lines; 34
passing tests in 2 files.

## Tests that pin this

- `tests/runtime/intrinsics/builtin-methods.test.ts > "maps a snake_case Tera name onto the
  camelCase runtime method"` — the JIT's reverse conversion.
- `tests/runtime/intrinsics/builtin-methods.test.ts > "carries the parameter names the language
  spec declares for the method"` — metadata is lifted from the spec, not written twice.
- `tests/runtime/intrinsics/builtin-methods.test.ts > "refuses a receiver that is not a
  string"`, `> "returns null for an owner it does not know"`, `> "returns null for a method the
  owner does not have"`, `> "does not expose inherited object properties as methods"` — the
  four ways the JIT falls back to the generic call instead of guessing.
- `tests/runtime/intrinsics/builtin-methods.test.ts > "resolves to the same implementation on
  every lookup"` — one implementation object, three tiers.
- `tests/optimizing/metadata/builtin-methods.test.ts > "backs every declaration with a member
  the language spec declares"` and `> "takes the arity and the types from the language spec"` —
  the fourth compiler's table is *derived*, not independent.
- `tests/optimizing/metadata/builtin-methods.test.ts > "backs every declared method with a
  runtime implementation"` — every AOT declaration has an interpreter twin. (It does not check
  they agree; see Honesty items.)
- `tests/optimizing/metadata/builtin-methods.test.ts > "takes the getter flag from the spec
  instead of the declaration"` — `length` is a getter and gets no arguments.
- `tests/optimizing/metadata/builtin-methods.test.ts > "marks a pure intrinsic as a readonly
  read"` and `> "copies the signature so a graph cannot mutate the registry"` — declared
  effects, and the defensive copy.
- `tests/e2e/language/collections.test.ts > "uses snake_case intrinsic methods"` — asserts
  `"tera".to_upper_case()` and `[1,2,3].find_index(...)` from source.
- `tests/e2e/language/intrinsic-arguments.test.ts > "coerces a fractional slice start"` (and
  the sixteen sibling cases, each titled `coerces <case>`) — every intrinsic's integer
  coercion is checked *against the host's own method*, by rewriting the snake name back to
  camel with `snakeToCamel`.
- `tests/runtime/intrinsics/array-methods.test.ts > "find returns null when nothing matches"` —
  the divergence from JavaScript, in the interpreter.
- `tests/e2e/optimizing/aot/array-methods.test.ts > "compiles find, whose miss answers null"`
  and `tests/e2e/optimizing/aot/collections.test.ts > "answers null for a key the map never
  held"` — the same divergence, mirrored by the fourth compiler.
- `tests/runtime/named-arguments.test.ts > "places a named argument in the slot its parameter
  declares"`, `> "accepts the camelCase spelling of a snake_case parameter"`, `> "binds through
  the axis/dim synonym"`, `> "never overwrites an argument the caller already passed
  positionally"`, `> "leaves an unknown name for the callee to read as an option"` — the
  binding rules.
- `tests/runtime/domain/host-methods.test.ts > "matches a camelCase host method to its
  snake_case spec name"` and `> "resolves the owner through a subclass"` — `wrapHostObject`
  and `methodsOf`.
- `tests/runtime/domain/host.test.ts > "canonicalizes the result of a host builtin"` and
  `> "tags an integral number beyond smi range as a double"` — `nativeToTagged` produces
  canonical values, not `mkDouble` for everything ([Ch 22 § canonical-numbers]).
- `tests/runtime/builtins/builtins.test.ts > "isArray distinguishes arrays from non-arrays"`,
  `> "Symbol.for returns same symbol for same key"`, `> "uses spec ToString for numbers and
  booleans"` — the namespace entries reached through `builtinValue`.
- `tests/cli/repl.test.ts > "completes members of an inferred string value"` — asserts the
  completer offers `to_upper_case`, the same spec table feeding a fourth consumer.
- Nothing pins `typeof(Math) == "function"` or the `Cannot call function: Math` diagnostic.
  `[unpinned]`
