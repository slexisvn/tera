import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSource } from '../src/check.js';
import { buildMethodReturns } from '../src/method_returns.js';
import { parse } from '../src/parser.js';
import { TeraRuntime } from '../src/runtime.js';

const diagnose = source => checkSource(source).diagnostics;
const LANGUAGE_DATA = JSON.parse(fs.readFileSync(new URL('../vscode-ext/language-data.json', import.meta.url), 'utf8'));
const METHOD_RETURNS = buildMethodReturns(LANGUAGE_DATA);
const diagnoseWithMethods = source => checkSource(source, { methodReturns: METHOD_RETURNS }).diagnostics;
const rejected = source => {
  try {
    return diagnose(source).length > 0;
  } catch {
    return true;
  }
};

describe('Tera type checker', () => {
  describe('accepts well-typed programs', () => {
    const cases = [
      'fn square(n: int) -> int:\n  return n * n',
      'fn f(x: int, y: Tensor) -> Tensor:\n  return y',
      'x: int = 5',
      'b: boolean = true',
      'x: int[] = [1, 2, 3]',
      'x: int[][] = [[1], [2]]',
      'names: string[] = ["a", "b"]',
      'm: Record<string, int> = {"a": 1}',
      'r: Record<string, int[]> = {"a": [1, 2]}',
      'x: int = 5\ny: float = 0.5',
      'a: float = 1',
      'fn r(p: int, q: int) -> float:\n  return p / q',
      'fn g(s: string) -> string:\n  return s + "!"',
      'fn h(x: int | string) -> int:\n  return 1\nh(1)\nh("a")',
      'x = tensor([1, 2])\ny = x.shape',
      'fn add(a: int, b: int) -> int:\n  return a + b\nz = add(1, 2)',
      'fn add(a: int, b: int) -> int:\n  return a + b\nz = add(a=1, b=2)',
      'fn make(b: int) -> fn(int) -> int:\n  fn add(x: int) -> int:\n    return b + x\n  return add\ncall = make(1)\nr = call(2)',
      'fn first(xs: int[]) -> int:\n  for x in xs:\n    return x\n  return 0',
      'fn grade(n: int) -> string:\n  if n > 0:\n    return "p"\n  else:\n    return "f"',
      'fn maybe(n: int) -> int | none:\n  if n > 0:\n    return n',
      'xs: int[] = [1]\nxs[0] = 2',
    ];
    for (const source of cases) {
      it(JSON.stringify(source), () => expect(diagnose(source)).toEqual([]));
    }
  });

  describe('reports provable mismatches with locations', () => {
    it('flags arithmetic between number and string', () => {
      const [error] = diagnose('z = 1 * "a"');
      expect(error).toMatchObject({ name: 'TypeError', line: 1, column: 7 });
      expect(error.message).toContain("operator '*'");
    });

    it('flags a return value that violates the declared return type', () => {
      const [error] = diagnose('fn f() -> Tensor:\n  return "hi"');
      expect(error).toMatchObject({ name: 'TypeError', line: 2 });
      expect(error.message).toContain('not assignable');
    });

    it('flags a variable assignment that violates its annotation', () => {
      const [error] = diagnose('x: int = "s"');
      expect(error).toMatchObject({ name: 'TypeError', line: 1, column: 1 });
    });

    it('flags wrong argument count against a known function', () => {
      const [error] = diagnose('fn add(a: int, b: int) -> int:\n  return a + b\nadd(1)');
      expect(error.message).toContain('expected 2 argument(s), got 1');
    });

    it('flags undefined names', () => {
      const [error] = diagnose('missing(1)');
      expect(error).toMatchObject({ name: 'TypeError', line: 1, column: 1 });
      expect(error.message).toContain("undefined name 'missing'");
    });

    it('requires param and return annotations (strict)', () => {
      expect(diagnose('fn f(x):\n  return x').length).toBeGreaterThanOrEqual(2);
    });

    it('accumulates multiple diagnostics in one pass', () => {
      expect(diagnose('a = nope\nb = 1 * "x"').length).toBeGreaterThanOrEqual(2);
    });

    it('does not support `any` as a type escape hatch', () => {
      expect(diagnose('v: any = 5').length).toBeGreaterThan(0);
    });
  });

  describe('hardening', () => {
    it('flags an index assignment that violates the element type', () => {
      const [error] = diagnose('xs: int[] = [1]\nxs[0] = "s"');
      expect(error).toMatchObject({ name: 'TypeError', line: 2 });
      expect(error.message).toContain('cannot assign');
    });

    it('flags unary minus on a non-number', () => {
      const [error] = diagnose('z = -"a"');
      expect(error.message).toContain("operator '-'");
    });

    it('flags calling a non-callable value', () => {
      const [error] = diagnose('x = 5\nx()');
      expect(error.message).toContain('not callable');
    });

    it('flags a non-number index into a list', () => {
      const [error] = diagnose('xs: int[] = [1]\ny = xs["k"]');
      expect(error.message).toContain('index must be a number');
    });

    it('flags a named argument with the wrong type', () => {
      const [error] = diagnose('fn f(a: int) -> int:\n  return a\nf(a="x")');
      expect(error.message).toContain("argument 'a'");
    });

    it('flags an unknown named argument', () => {
      const [error] = diagnose('fn f(a: int) -> int:\n  return a\nf(b=1)');
      expect(error.message).toContain("unknown argument 'b'");
    });

    it('flags a function that does not return on all paths', () => {
      const [error] = diagnose('fn f() -> int:\n  if true:\n    return 1');
      expect(error.message).toContain('all paths');
    });

    it('flags destructuring a non-list value', () => {
      const [error] = diagnose('a, b = 5');
      expect(error.message).toContain('destructure');
    });
  });

  describe('forbids shadowing built-in names', () => {
    const cases = [
      ['variable assignment', 'tensor = 5'],
      ['annotated variable', 'print: int = 5'],
      ['compound assignment', 'count += 1'],
      ['for-loop variable', 'for range in [1, 2]:\n  print(range)'],
      ['destructuring target', 'zeros, ones = [1, 2]'],
      ['comprehension variable', 'xs = [tensor for tensor in [1, 2]]'],
      ['function name', 'fn print(x: int) -> int:\n  return x'],
      ['function parameter', 'fn f(count: int) -> int:\n  return count'],
      ['model name', 'model Linear():\n  forward (x: Tensor) -> Tensor:\n    return x'],
    ];
    for (const [label, source] of cases) {
      it(label, () => {
        expect(diagnose(source).some(e => e.message.includes('built-in'))).toBe(true);
      });
    }

    it('still allows ordinary names', () => {
      expect(diagnose('total = 5\nfn helper(n: int) -> int:\n  return n')).toEqual([]);
    });
  });

  describe('inferred type map (powers notebook/editor hover)', () => {
    it('exposes parameter and local types via analyzeSource', async () => {
      const { analyzeSource } = await import('../src/check.js');
      const { types } = analyzeSource('fn f(values: int[], n: int) -> int:\n  total = n\n  return total');
      const byName = new Map([...types].map(([k, v]) => [k.slice(0, k.lastIndexOf(':')), v]));
      expect(byName.get('values')).toBe('int[]');
      expect(byName.get('n')).toBe('int');
      expect(byName.get('total')).toBe('int');
    });
  });

  describe('builtin method-return inference (CLI matches editor)', () => {
    it('accepts well-typed DataFrame/Tensor method chains', () => {
      const source = 'sessions = load_csv("x.csv")\nlabeled = sessions.withColumn("s", expr("x"))\nimg = randn([4, 4])\np = img.softmax(axis=1)';
      expect(diagnoseWithMethods(source)).toEqual([]);
    });

    it('flags assigning a method result to an incompatible annotation', () => {
      const [error] = diagnoseWithMethods('df = load_csv("x.csv")\nn: int = df.withColumn("s", expr("x"))');
      expect(error?.message ?? '').toContain('cannot assign');
    });

    it('infers load_tokenizer as a tokenizer', () => {
      expect(diagnoseWithMethods('tok = load_tokenizer("tokenizer.json")\nids: int[] = tok.encode("hi")')).toEqual([]);
    });
  });

  describe('list / string / dict method-return inference', () => {
    it('accepts well-typed list method results', () => {
      const source = [
        'xs: int[] = [1, 2, 3]',
        'xs.append(4)',
        'i: int = xs.index(2)',
        'n: int = xs.count(2)',
        'found: boolean = xs.contains(2)',
        'last: int = xs.pop()',
        'cp: int[] = xs.copy()',
      ].join('\n');
      expect(diagnose(source)).toEqual([]);
    });

    it('accepts well-typed string method results', () => {
      const source = [
        's: string = "Hello"',
        'u: string = s.upper()',
        'parts: string[] = s.split("l")',
        'pre: boolean = s.starts_with("He")',
        'at: int = s.find("l")',
      ].join('\n');
      expect(diagnose(source)).toEqual([]);
    });

    it('accepts well-typed dict method results', () => {
      const source = [
        'd: Record<string, int> = {"a": 1}',
        'ks: string[] = d.keys()',
        'vs: int[] = d.values()',
        'v: int = d.get("a")',
        'present: boolean = d.has("a")',
      ].join('\n');
      expect(diagnose(source)).toEqual([]);
    });

    it('flags assigning a list method result to an incompatible annotation', () => {
      const [error] = diagnose('xs: int[] = [1]\nbad: string = xs.index(1)');
      expect(error?.message ?? '').toContain('cannot assign');
    });

    it('flags assigning a string method result to an incompatible annotation', () => {
      const [error] = diagnose('s: string = "a"\nbad: int = s.upper()');
      expect(error?.message ?? '').toContain('cannot assign');
    });
  });

  describe('rejects the old (pre-clean-break) syntax', () => {
    const removed = [
      'x: list[int] = [1]',
      'm: dict[str, int] = {"a": 1}',
      's: str = "a"',
      'b: bool = true',
      'xs: list[Tensor] = []',
      'n: number = 1',
      'n: num = 1',
    ];
    for (const source of removed) {
      it(JSON.stringify(source), () => expect(rejected(source)).toBe(true));
    }
  });

  describe('parser keeps annotations additive', () => {
    it('exposes paramTypes and returnType without changing params', () => {
      const fn = parse('fn f(x: int, y: Tensor) -> Tensor:\n  return y').body[0];
      expect(fn.params).toEqual(['x', 'y']);
      expect(fn.paramTypes).toHaveLength(2);
      expect(fn.returnType).toMatchObject({ kind: 'NameType', name: 'Tensor' });
    });

    it('parses array annotations', () => {
      const assign = parse('xs: int[] = [1]').body[0];
      expect(assign.annotation).toMatchObject({ kind: 'ArrayType' });
      expect(assign.annotation.element).toMatchObject({ kind: 'NameType', name: 'int' });
    });

    it('parses nested array annotations', () => {
      const assign = parse('xs: int[][] = [[1]]').body[0];
      expect(assign.annotation).toMatchObject({ kind: 'ArrayType' });
      expect(assign.annotation.element).toMatchObject({ kind: 'ArrayType' });
    });

    it('parses Record generic annotations', () => {
      const assign = parse('m: Record<string, int> = {"a": 1}').body[0];
      expect(assign.annotation).toMatchObject({ kind: 'GenericType', name: 'Record' });
      expect(assign.annotation.args).toHaveLength(2);
    });

    it('parses union annotations on variables', () => {
      const assign = parse('x: int | string = 1').body[0];
      expect(assign).toMatchObject({ type: 'Assign', name: 'x' });
      expect(assign.annotation).toMatchObject({ kind: 'UnionType' });
    });

    it('parses function-type annotations', () => {
      const fn = parse('fn make() -> fn(int) -> int:\n  return make').body[0];
      expect(fn.returnType).toMatchObject({ kind: 'FunctionType' });
      expect(fn.returnType.params).toHaveLength(1);
    });

    it('still parses untyped declarations unchanged', () => {
      const fn = parse('fn square(n):\n  return n * n').body[0];
      expect(fn.params).toEqual(['n']);
      expect(fn.paramTypes).toEqual([null]);
      expect(fn.returnType).toBeNull();
    });
  });

  describe('runtime ignores type annotations', () => {
    it('executes annotated assignments unchanged', async () => {
      const result = await new TeraRuntime({ output: () => {} }).execute('x: int = 41\nx + 1');
      expect(result).toBe(42);
    });

    it('saves and loads a tokenizer from Tera', async () => {
      const dir = fs.mkdtempSync(join(tmpdir(), 'mlfw-tera-tokenizer-'));
      try {
        const path = join(dir, 'tokenizer.json').replace(/\\/g, '/');
        const source = [
          'tok = Tokenizer(mode="bpe", lowercase=true, num_merges=40)',
          'tok.fit(["hello world", "hello there", "world hello"])',
          `tok.save("${path}")`,
          `tok2 = load_tokenizer("${path}")`,
          'ids = tok2.encode("hello world")',
          'tok2.decode(ids)',
        ].join('\n');
        const result = await new TeraRuntime({ output: () => {} }).execute(source);
        expect(result).toBe('hello world');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('backward compatibility', () => {
    it('still parses every bundled example', () => {
      const dir = new URL('../examples/', import.meta.url);
      const files = fs.readdirSync(dir).filter(name => name.endsWith('.tera'));
      expect(files.length).toBeGreaterThan(0);
      for (const name of files) {
        expect(() => parse(fs.readFileSync(new URL(name, dir), 'utf8'))).not.toThrow();
      }
    });
  });
});
