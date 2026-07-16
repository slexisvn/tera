import { describe, it, expect } from 'vitest';
import { TeraRuntime } from '../src/runtime.js';

function run(source) {
  return new TeraRuntime({ output: () => {} }).execute(source);
}

describe('Tera dict / map', () => {
  it('literal, get, set, missing-key, .size', async () => {
    const r = await run(`
d = {"a": 1, "b": 2}
d["c"] = 3
d["a"] = 10
[d["a"], d["b"], d["c"], d["missing"], d.size]
`);
    expect(r).toEqual([10, 2, 3, null, 3]);
  });

  it('empty dict literal and dynamic keys', async () => {
    const r = await run(`
d = {}
k = "x"
d[k] = 5
[d.size, d["x"]]
`);
    expect(r).toEqual([1, 5]);
  });

  it('for-in iterates map keys', async () => {
    const r = await run(`
d = {"x": 10, "y": 20}
ks = []
for k in d:
  ks[ks.length] = k
ks
`);
    expect(r).toEqual(['x', 'y']);
  });
});

describe('Tera index assignment', () => {
  it('overwrites and appends (grow) on lists', async () => {
    const r = await run(`
xs = [0, 0, 0]
xs[1] = 9
xs[3] = 7
xs
`);
    expect(r).toEqual([0, 9, 0, 7]);
  });

  it('compound index assignment', async () => {
    const r = await run(`
xs = [5, 5]
xs[0] += 3
xs
`);
    expect(r).toEqual([8, 5]);
  });

  it('append-via-index builds a list in O(1) steps', async () => {
    const r = await run(`
out = []
for i in range(4):
  out[out.length] = i * i
out
`);
    expect(r).toEqual([0, 1, 4, 9]);
  });
});

describe('Tera string indexing', () => {
  it('char index, negative index, slice, .length', async () => {
    const r = await run(`
s = "hello"
[s[0], s[-1], s[1:4], s.length]
`);
    expect(r).toEqual(['h', 'o', 'ell', 5]);
  });
});

describe('Tera list comprehension', () => {
  it('maps over a range', async () => {
    expect(await run('[x * 2 for x in range(4)]')).toEqual([0, 2, 4, 6]);
  });

  it('filters with if', async () => {
    expect(await run('[x for x in range(6) if x > 3]')).toEqual([4, 5]);
  });

  it('iterates a list', async () => {
    expect(await run('[w for w in "a b c".split(" ")]')).toEqual(['a', 'b', 'c']);
  });
});

describe('Tera array concat and .length', () => {
  it('concatenates lists with +', async () => {
    expect(await run('[1, 2] + [3, 4]')).toEqual([1, 2, 3, 4]);
  });

  it('.length works on list and string', async () => {
    expect(await run('[[1, 2, 3].length, "abcd".length]')).toEqual([3, 4]);
  });
});

describe('Tera existing assignment forms still work', () => {
  it('simple, compound, and destructuring assignment', async () => {
    const r = await run(`
x = 5
x += 2
a, b = [10, 20]
[x, a, b]
`);
    expect(r).toEqual([7, 10, 20]);
  });
});

describe('Tera modulo operator', () => {
  it('computes remainder with correct precedence and sign', async () => {
    expect(await run('[7 % 3, 10 % 2, 2 + 7 % 3, 8 % 5 % 2]')).toEqual([1, 0, 3, 1]);
  });

  it('negative operands follow truncated semantics', async () => {
    expect(await run('[-7 % 3, 7 % -3]')).toEqual([-1, 1]);
  });

  it('%= compound assignment', async () => {
    const r = await run(`
x = 17
x %= 5
x
`);
    expect(r).toBe(2);
  });

  it('modulo in a list comprehension', async () => {
    expect(await run('[x % 3 for x in range(6)]')).toEqual([0, 1, 2, 0, 1, 2]);
  });
});

describe('Tera list methods', () => {
  it('append / extend / insert / pop / remove mutate in place', async () => {
    const r = await run(`
xs = [1, 2]
xs.append(3)
xs.extend([4, 5])
xs.insert(0, 0)
last = xs.pop()
xs.remove(4)
[xs, last]
`);
    expect(r).toEqual([[0, 1, 2, 3], 5]);
  });

  it('index / count / contains / reverse / clear / copy', async () => {
    const r = await run(`
xs = [3, 1, 3, 2]
i = xs.index(3)
miss = xs.index(9)
c = xs.count(3)
cp = xs.copy()
xs.reverse()
cp.clear()
[i, miss, c, xs.contains(2), xs.contains(9), xs, cp]
`);
    expect(r).toEqual([0, -1, 2, true, false, [2, 3, 1, 3], []]);
  });

  it('pop accepts an explicit and negative index', async () => {
    const r = await run(`
xs = [10, 20, 30]
a = xs.pop(0)
b = xs.pop(-1)
[a, b, xs]
`);
    expect(r).toEqual([10, 30, [20]]);
  });

  it('pop on an empty list throws', async () => {
    expect(() => run('xs = []\nxs.pop()')).toThrow();
  });
});

describe('Tera string methods', () => {
  it('case, search, and replace', async () => {
    const r = await run(`
s = "Hello World"
[s.upper(), s.lower(), s.contains("World"), s.starts_with("He"), s.ends_with("ld"), s.find("o"), s.find("z"), s.replace("o", "0")]
`);
    expect(r).toEqual(['HELLO WORLD', 'hello world', true, true, true, 4, -1, 'Hell0 W0rld']);
  });

  it('strip variants and split / join', async () => {
    const r = await run(`
parts = "a,b,c".split(",")
joined = "-".join(["x", "y", "z"])
ws = "  a   b  c ".split()
["  hi  ".strip(), "  hi  ".lstrip(), "  hi  ".rstrip(), parts, joined, ws]
`);
    expect(r).toEqual(['hi', 'hi  ', '  hi', ['a', 'b', 'c'], 'x-y-z', ['a', 'b', 'c']]);
  });
});

describe('Tera dict methods', () => {
  it('keys / values / get / has / remove / items', async () => {
    const r = await run(`
d = {"a": 1, "b": 2}
d["c"] = 3
k = d.keys()
v = d.values()
g1 = d.get("b")
g2 = d.get("z")
g3 = d.get("z", 99)
d.remove("a")
[k, v, d.has("a"), d.has("b"), g1, g2, g3, d.items()]
`);
    expect(r).toEqual([['a', 'b', 'c'], [1, 2, 3], false, true, 2, null, 99, [['b', 2], ['c', 3]]]);
  });
});
