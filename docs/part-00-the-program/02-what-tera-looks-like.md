# 2. What tera looks like   ⟨I · B · J · N⟩

> **Status:** outline

**Thesis.** You cannot follow a program through a compiler you cannot read, and every
deviation from JavaScript that bites a later chapter starts here, in the surface syntax.

**What arrived.** From `[Ch 1 § what-leaves]`: `queue.tera`, the four-tier map, and the
instruments. The reader knows the book's stakes and nothing about the language.

**What leaves.** Enough tera to read every listing in the remaining 81 chapters, plus the
eight example files named with the chapter each one serves. Chapter 3 can then show
`stats.tera` in fourteen forms without pausing to explain the source.

**New ideas.** *Offside rule* (indentation is syntax; the lexer manufactures the
structure tokens). *Contextual keyword* (a word reserved in one position and an ordinary
identifier in every other). *Structural typing* (a class is a shape, not a name — stated
here, paid off in `[Ch 12 § classes-without-nominality]`). *Annotation as text*
(a declared type is a string the checker interprets, not a term it constructs — paid off
in `[Ch 9 § types-are-text]`).

## Anchors

- `src/frontend/lexer/index.ts` — 529 lines and the whole surface's first authority.
  `TokenType` includes `Newline`, `Indent` and `Dedent`: three token kinds with no
  characters behind them, manufactured by `class Lexer` from column positions.
  `RESERVED_KEYWORDS = new Set(["let", "const", "var"])` — three words that exist only to
  be rejected. `KEYWORDS` spreads `RESERVED_KEYWORDS` and adds 44 more, including
  `CLASS_VISIBILITIES` and `CLASS_ABSTRACT_MODIFIER` from `src/core/class-visibility.ts`,
  and including `fn`, `model`, `and`, `or`, `not`. It does **not** include `interface`,
  `type`, `implements`, `static`, `get`, `set`, `signal`, `effect` or `as`.
- `src/frontend/parser/index.ts` — `isReservedKeyword(tok)` and `rejectReservedKeyword(tok)`,
  which raise the one diagnostic every JavaScript programmer meets first:
  `'let' is not a tera keyword; declare a variable as 'name: type = value' or 'name = value'`.
  `"@": 10` in the binary precedence table is the matmul operator's binding power.
- `data/tera-language-spec.ts` — 8,251 lines, one source of truth feeding the checker, the
  REPL, the editor and the syntax grammar (taught as a mechanism in
  `[Ch 28 § what-the-program-calls]`, never reproduced). `TERA_KEYWORD_GROUPS` is a
  `satisfies Record<TeraKeywordGroup, string[]>` over five groups — declaration, control,
  operator, constant, variable. `TERA_OPERATORS` splits punctuators into `threeChar`,
  `twoChar`, `oneChar` so maximal munch is a table, not a rule.
  `TERA_PRIMITIVE_TYPES` lists 34 names, of which `int`, `float`, `string`, `bool` are the
  four `stats.tera` uses. `TERA_ASYNC_DOMAIN_TYPES = ["DataFrame", "Trainer"]` is the seed
  set for implicit await. `TERA_PRIMITIVE_PSEUDO_TYPES` maps `int`/`float` → `Number`,
  which is how `15.7.to_fixed(2)` finds a method.
- `examples/control_flow.tera` — 53 lines. `fn square(n: int) -> int:`,
  `for i of range(1, n + 1)`, a nested `fn adder(base: int) -> fn(int) -> int` returning an
  inner function, `-> int | null`, `else if` chains, `a, b, c = [10, 20, 30]` array
  destructuring, and `continue` without a label.
- `examples/classes.tera` — 73 lines. `class Circle extends Shape`, `super(name="circle")`
  (a named argument in a super call), `public get summary`, `public set fahrenheit(f: float)`,
  method chaining through `return this`, `throw "insufficient funds"`, and template
  literals: `` `${this.name} with area ${this.area()}` ``.
- `examples/design-pattern/16_iterator.tera` — 22 lines, and the densest surface sample in
  the tree: `type IteratorStep = { done: bool, value: int | null }`,
  `interface IntIterator:` with a bare `next() -> IteratorStep` signature,
  `class RangeIterator implements IntIterator`, a literal-string subscript
  `this["@@iterator"] = () => this`, and `for value of RangeIterator(1, 4)`.
- `src/core/class-visibility.ts` — 24 lines, and the only place a class modifier is named.
  `CLASS_VISIBILITIES = ["public", "private", "protected"]`,
  `DEFAULT_CLASS_VISIBILITY = "public"` (so an unmarked member is public, and the parser
  records `explicitVisibility` separately), and
  `CLASS_MEMBER_MODIFIERS = [static, abstract, async]`. The lexer spreads the first list
  and `CLASS_ABSTRACT_MODIFIER` into `KEYWORDS` and leaves `static` out — which is why
  `static = 9` is a legal declaration and `public = 9` is not.

## Worked example

`docs/example/stats.tera`, all 24 lines, read once from the top. Everything the chapter
teaches is in it or is one line away from it.

```
class Series:
  public constructor(name: string, values: float[]):
    this.name = name
    this.values = values

  public mean() -> float:
    total = 0.0
    i = 0
    while i < this.values.length:
      total += this.values[i]
      i += 1
    return total / this.values.length

  public label() -> string:
    return this.name + " mean=" + this.mean().to_fixed(2)

fn report(s: Series) -> string:
  return s.label()

latency = Series("latency", [12.5, 9.0, 31.25, 7.75, 18.0])
throughput = Series("throughput", [880.0, 913.5, 902.25, 897.0])

print(report(latency))
print(report(throughput))
```
— `docs/example/stats.tera:1-24`

```
$ node dist/cli.js docs/example/stats.tera
latency mean=15.70
throughput mean=898.19
```

Every construct in those 24 lines: a class with a constructor and two public methods, a
declared `string` field and a declared `float[]` field, an undeclared local (`total`) whose
type comes from its initializer, a counted `while`, a `.length` read, an index read, a
compound assignment, a method call on a method's result, a builtin method on a `float`,
string concatenation, a free function taking a class-typed parameter, two module-level
bindings, and `print`.

## Outline

- [ ] **§ blocks-are-indentation** — A colon opens a block and indentation closes it.
      `> **New idea.**` the offside rule: there are no braces and no semicolons, and the
      lexer manufactures `Indent`, `Dedent` and `Newline` tokens that no character in the
      file produced. Establish that this is a *lexer* decision, and point at
      `[Ch 5 § the-program-that-indents-but-does-not-nest]` for what it costs.
- [ ] **§ declaring-a-name** — `name: type = value` and bare `name = value`. There is no
      binding keyword. Show the rejection for `let`, verbatim, and establish the reasoning:
      the three words are in `KEYWORDS` *so that* the parser can give advice instead of
      "unexpected identifier". Establish the reassignment rule the same way
      `examples/control_flow.tera` uses it (`acc *= i`, `i += 1`).
- [ ] **§ functions** — `fn f(n: int) -> int:`. The arrow is part of the declaration, not
      a type expression. Untyped parameters are legal in the interpreter and are the single
      most common reason a program will not compile ahead of time — forward-reference
      `[Ch 56 § legality-and-the-art-of-refusing-well]`. Nested `fn` declarations and
      `fn(int) -> int` as a *parameter* type, both from `examples/control_flow.tera`.
      Arrow functions take an expression body only.
- [ ] **§ classes** — `class C:` with `public` / `private` / `protected` / `static` /
      `abstract` and `extends` / `implements`. `this.x = x` in the constructor is what
      declares a field. `public get summary` and `public set fahrenheit(f: float)`.
      Establish that visibility is checked, not decorative: accessing a `private` member
      from outside is an error, quoted verbatim. `> **New idea.**` structural typing —
      a class in tera is a *shape*, so `implements` checks members rather than recording a
      name; defer the consequences to `[Ch 12 § classes-without-nominality]` and
      `[Ch 57 § objects-without-a-runtime-type]`.
- [ ] **§ contextual-keywords** — The word list in `data/tera-language-spec.ts`
      (`TERA_KEYWORD_GROUPS`) and the word list in `src/frontend/lexer/index.ts`
      (`KEYWORDS`) disagree, on purpose. Measured on this tree: `static`, `get`, `set`,
      `implements` and `signal` are ordinary identifiers everywhere; `type` and `interface`
      are ordinary identifiers as parameter names and object keys but start a declaration
      at statement position. `> **New idea.**` contextual keyword. The code's names win
      (`docs/CONVENTIONS.md` rule 4): the book calls all of these keywords and says where
      each one binds.
- [ ] **§ interface-and-type** — `interface IntIterator:` with bare signatures, and
      `type IteratorStep = { done: bool, value: int | null }`. Union types with `|`,
      array types with `[]`, `null` and `undefined` as distinct type names (paid off in
      `[Ch 22 § values-four-bits-inside-a-double]` and in AOT's two absence values).
      Establish that annotations are **text** the checker interprets — forward-reference
      `[Ch 9 § types-are-text]`.
- [ ] **§ calls-and-named-arguments** — Positional calls, default parameters, rest
      parameters, spread, and named arguments (`box(h=2.0, w=3.0)`, `super(name="circle")`).
      Establish that named arguments are a *call convention* recorded in the bytecode, not
      sugar the parser erases — `ROP_CALL_NAMED` and `ROP_CALL_METHOD_NAMED` exist, and
      `[Ch 18 § compiling-expressions]` pays it off.
- [ ] **§ loops-and-iteration** — `while`, C-style `for (;;)`, `for x of xs` (values) and
      `for k in obj` (keys). `for ... of` over a user class that answers `next()` works
      (`examples/design-pattern/16_iterator.tera`); the iterator protocol is reached
      through `this["@@iterator"]`. Labels exist and `break outer` works —
      and `continue outer` does not (see honesty items).
- [ ] **§ indexing-slices-and-matmul** — `xs[i]`, negative indices, `xs[1:4]`,
      `xs[::2]`, `a[i, j]`, `matrix[:, 0]`. A slice parses to an `IndexExpression` with one
      `IndexElement` per subscript, not to a `MemberExpression` — a structural difference
      the reader will meet again in the bytecode. `@` is matmul, one character, precedence
      10, and it is the only operator in `TERA_OPERATORS.oneChar` that JavaScript has no
      spelling for.
- [ ] **§ async** — `async fn` and `await`, as `docs/example/stats-async.tera` uses them.
      Then the deviation: for the two *domain* types in `TERA_ASYNC_DOMAIN_TYPES`, an
      effect analysis marks the caller async and inserts the await for you, transitively
      through parameters and mutual recursion. State the boundary precisely — a
      user-declared `async fn` still needs an explicit `await` at its call site — and
      defer the analysis to `[Ch 14 § async-and-the-await-you-never-wrote]`.
- [ ] **§ strings-and-templates** — Double, single and backtick quotes;
      `` `${expr}` `` interpolation; `+` concatenation with automatic coercion of a
      number; and `.to_fixed(2)`, which is a method on a `float` because
      `TERA_PRIMITIVE_PSEUDO_TYPES` maps `float` → `Number`. Every one of these has a
      chapter in Part IX because none of them is free in a native binary
      (`[Ch 59 § strings-without-a-runtime-tag]`).
- [ ] **§ stats-tera-line-by-line** — Walk all 24 lines against the sections above, naming
      for each line the chapter that will compile it.
- [ ] **§ the-eight-files** — The example set and the chapter each variation serves:
      `stats.tera` (the spine, everywhere); `stats-poly.tera` → 12, 34, 57;
      `stats-async.tera` → 14, 30, 58, 63; `stats-closure.tera` → 20, 50, 58;
      `stats-deopt.tera` → 33, 34, 54; `stats-refused.tera` → 56, 81; `queue.tera` → 1, 13;
      `labeled.tera` → 19, 82. Establish the rule that keeps them honest: a test enumerates
      the directory, so a ninth file cannot be added without an expected output.

## Honesty items

- Historical, not current: labeled `continue`. `docs/example/labeled.tera` used to print
  `1 2 1 2 …` forever, because `continue outer` re-entered the inner loop instead of the
  outer one; `break outer` was correct throughout. It now prints `1 2 3 5 6 7` and exits.
  A labelled statement no longer patches its own continue jumps — it registers the label
  in `_pendingLoopLabels` (`src/bytecode/register/compiler/helpers.ts:128`) and the next
  `enterLoop` (`:131`) claims it, so the loop that owns the latch does the patching. The
  chapter should still teach labels with the fixed behaviour and send the reader to
  `[Ch 19 § the-jump-nobody-patched]` for the arc; the file is safe to run unbounded.
- `> **Unenforced.**` — nothing in the tree checks that `TERA_KEYWORD_GROUPS` in
  `data/tera-language-spec.ts` and `KEYWORDS` in `src/frontend/lexer/index.ts` describe
  the same language. The spec file lists `interface`, `type`, `implements`, `static`,
  `get`, `set`, `signal`, `effect` and `as` as keywords; the lexer does not tokenize any of
  them as one. Two consumers read the spec list (the editor's syntax grammar and the REPL's
  completion), so the two lists disagreeing is *visible to users* — a word can be
  highlighted as a keyword and used as a variable in the same file. A `satisfies`
  constraint or one derived table would close it; the cost is deciding which list is the
  authority.
- `> **Unfinished.**` — the surface is wider than any tier supports. `TERA_PRIMITIVE_TYPES`
  names 34 types including `Tensor`, `DataFrame`, `Trainer`, `Dataset` and `MLModel`, none
  of which is implemented in this repository — they are the interfaces of the sibling
  compilers (`docs/CONVENTIONS.md` rule 19). The chapter teaches the four types
  `stats.tera` uses and names the rest as a boundary, so a reader does not go looking for a
  tensor chapter that does not exist.
- The chapter must **not** claim that tera has implicit await in general. Measured on this
  tree: a user `async fn` called without `await` yields `[Promise fulfilled]`, not a
  number. Implicit await is seeded by `TERA_ASYNC_DOMAIN_TYPES` — two names — and
  propagated from there.

## Verify it yourself

```bash
# the spine, and the two lines every later chapter is chasing
node dist/cli.js docs/example/stats.tera

# there is no binding keyword, and the parser says what to write instead
node dist/cli.js -e 'let x = 1'

# classes: inheritance, named super arguments, accessors, template literals
node dist/cli.js examples/classes.tera

# interface, type alias, implements, and for-of over a user iterator
node dist/cli.js examples/design-pattern/16_iterator.tera

# the shape of what the parser built, before anything interprets it
node dist/cli.js --print-ast docs/example/stats.tera | head -40

# the three rejected words, in every position they can appear
npx vitest run --project unit tests/frontend/parser/language.test.ts -t "reserved"
```

## Tests that pin this

- `tests/frontend/lexer.test.ts` > `"emits layout tokens for indentation blocks"` — the
  offside rule produces `Indent`, `Dedent` and `Newline`, and produces no `{`, `}` or `;`.
- `tests/frontend/lexer.test.ts` > `"keywords"` and > `"treats void as a type identifier, not an operator keyword"`.
- `tests/frontend/lexer.test.ts` > `"tokenizes tensor matmul"` — `a @ b` is three tokens.
- `tests/frontend/lexer.test.ts` > `"simple template"`, > `"template with multiple expressions"`,
  > `"template with nested braces"`, > `"unterminated template throws"`.
- `tests/frontend/parser/language.test.ts` > `"rejects 'let' at statement position"`,
  > `"rejects 'let' inside a function body"`, > `"rejects 'let' in a for initializer"`,
  > `"rejects 'let' in expression position"`, > `"reports where 'let' appears"` — the same
  five for `const` and `var`.
- `tests/frontend/parser/language.test.ts` > `"leaves an identifier that merely starts with a reserved word alone"`
  — `lets: int = 4` is a declaration, not a rejection.
- `tests/frontend/parser/language.test.ts` > `"rejects method shorthand with a brace body (blocks are offside-only)"`,
  > `"rejects object getter/setter with a brace body"`, > `"rejects a brace block body (arrows take an expression body)"`
  — three places where the offside rule refuses a JavaScript spelling.
- `tests/frontend/parser/language.test.ts` > `"parses visibility modifiers and class fields"`,
  > `"marks fields declared without a visibility keyword as not explicit"`,
  > `"rejects duplicate and conflicting class member modifiers"`,
  > `"parses abstract classes and abstract member signatures"`.
- `tests/frontend/parser/language.test.ts` > `"getter and setter"`,
  > `"accepts a return type annotation on a class getter"`,
  > `"accepts a typed parameter on a class setter"`.
- `tests/frontend/parser/language.test.ts` > `"for in"` and > `"for of"` — keys versus
  values, two node types.
- `tests/frontend/parser/language.test.ts` > `"lowers a slice to an index expression with one slice dimension"`,
  > `"records absent slice bounds as null"`,
  > `"lowers a multi-dimensional index to one dimension per subscript"`,
  > `"mixes index and slice dimensions in order"`, > `"rejects assignment to a slice"`.
- `tests/frontend/parser/language.test.ts` > `"reads every keyword a program might want as a field name"`
  and > `"keeps a keyword key apart from the statement it spells"` — why `{ type: 2 }` parses.
- `tests/frontend/operators.test.ts` > `"orders multi-character punctuators longest first so maximal munch holds"`,
  > `"never lists a punctuator after one it is a prefix of"`,
  > `"keeps word-shaped binary operators out of the punctuator table"`.
- `tests/frontend/checker/symbols.test.ts` > `"hides a private member from outside the class"`
  and > `"offers a private member inside its own class"` — visibility is checked.
- `tests/frontend/effects.test.ts` > `"marks a function that awaits a domain method as async"`,
  > `"propagates async to a direct caller and awaits the call"`,
  > `"leaves a purely synchronous function alone"` — the exact boundary of implicit await.
- `tests/e2e/language/functions.test.ts` > `"binds named arguments with Python-style rules"`
  and > `"mixes spread positional arguments with named arguments"`.
- `tests/e2e/docs/book-examples.test.ts` > `"stats.tera prints what the book says it prints"`
  — and one such title per example file.
