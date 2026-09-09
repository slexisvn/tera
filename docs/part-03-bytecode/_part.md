# Part III — The tree becomes bytecode   ⟨I · B · J · N⟩

> **Status:** written

## What this part is

- The last stage that all four machines share. `RegisterCompiledFunction` is not "the
  interpreter's format": it is the input to the interpreter's dispatch loop, to the
  baseline compiler's generated JavaScript, to the SSA builder that both the WebAssembly
  JIT and the native compiler stand on.
- Verified: `src/api/engine.ts:1211` builds a `RegisterBytecodeCompiler` for a script,
  `:1254` for each module record in a graph, and `:1097` hands the result to
  `compileModule` for the native backend by way of `Optimizer.compileStatic`
  (`src/api/engine.ts:1148 compileAotUnit`). One artifact, four consumers.
- So every decision in this part is a four-way commitment, and the honesty markers here
  are proportionally expensive: an opcode nobody can lower pins a function to tier zero
  ([Ch 27]), and a jump nobody patches is a hang rather than a compile error, because
  nothing in this tier checks that a jump was patched ([Ch 19]).

## What arrived

- From [Ch 14] and [Ch 15]: an AST that has been parsed (Part I), checked (Part II), and
  then walked twice more before this part sees it —
  `this.runCompilerPasses("ast", …)` then `analyzeEffects(parsed)` then
  `runCompilerPasses("semantic", …)` (`src/api/engine.ts:1209-1210`).
- What survives of the checker is deliberately small. Types reach the bytecode as **text**:
  `RegisterCompiledFunction.localTypes` (strings) and
  `declaredSignature` (`params`, `names`, `defaults`, `variadic`, `rest`, `returns` —
  all `string | null`), built by `declaredSignatureOf` in
  `src/bytecode/register/compiler/functions.ts:165`. Nothing else from Part II crosses.
- The one semantic annotation that does cross as a flag is `node.implicitAwait`, read at
  `src/bytecode/register/compiler/expressions.ts:243`, which appends `ROP_AWAIT` after a
  call. [Ch 14 § one-flag-one-byte] earned it; this part spends it.

## What leaves

- A `RegisterCompiledFunction`: a numbered instruction list, a constant pool, a local-name
  table, a register count, a feedback-slot count, a source map, an upvalue descriptor
  list, and — nested inside the constant pool — one more `RegisterCompiledFunction` per
  inner function, class method, and static-field initializer.
- Plus the tiering state that lives on the same object and is empty at this point:
  `invocationCount`, `baselineCode`, `optimizedCode`, `osrCache`, `deoptCount`,
  `optimizationCooldownUntil`, `version`, `codeAge`. Part V fills these in.

## The chapters

| # | Title | Lands |
| --- | --- | --- |
| 17 | Why a register machine, and which one | the 90-opcode contract, and `register-effects.ts` as its only machine-readable description |
| 18 | Compiling expressions: the accumulator protocol | one distinguished value, four shuffle instructions per binary operator, and a 25-line register allocator |
| 19 | The Jump Nobody Patched | backpatching, absolute targets, and why an unpatched jump is a valid instruction |
| 20 | Scopes, closures, and classes in bytecode | a language with no binding keywords, upvalue cells, and the largest single lowering in the compiler |

## Which tiers this part constrains

- **⟨I⟩ interpreter** — every opcode needs a `case` in
  `src/bytecode/register/interpreter/index.ts`. Measured: 89 of the 90 declared opcodes
  have one; `ROP_TEST_FEEDBACK` does not, and reaching it raises
  `Unknown register opcode 0x55 (TestFeedback)` from the `default:` at line 2449.
- **⟨B⟩ baseline** — `src/optimizing/baseline/compiler.ts` turns each instruction index
  into a `case` of a generated `switch(pc)` (`generateBody`, line 134). Measured: 71 of
  90 opcodes have an `emitOp` case; the other 19 return `null`, which makes
  `generateBody` return `null`, which declines the whole function. [Ch 27] names them.
- **⟨J⟩ JIT and ⟨N⟩ native** — both enter through one `buildIR`
  (`src/optimizing/builder/ir-builder.ts:304`), reached from
  `src/optimizing/optimizer.ts:157`. Measured: 75 of 90 opcodes have a case there.
- The badge on each chapter marks which of the four a given section actually binds; the
  opcode set itself binds all four, which is the whole point of the part.

## Where the running example cannot reach

- `docs/example/*.tera` contains no class inheritance, no static fields, no `interface`
  implementation, no generator and no `switch`. So `ROP_SET_PROTO`,
  `ROP_ASSERT_CLASS_CONTRACTS`, `ROP_YIELD` and the static-field initializer lowering are
  described from source and from `tests/e2e/language/classes.test.ts`, not from a listing
  of the spine. [Ch 20 § what-the-example-cannot-reach] states this once.

## Verify it yourself

```bash
node dist/cli.js --print-bytecode --filter mean docs/example/stats.tera
node dist/cli.js --print-bytecode --filter '<script>' docs/example/stats.tera
node dist/cli.js --print-bytecode --filter Series docs/example/stats.tera
npx vitest run --project unit tests/bytecode/register
```
