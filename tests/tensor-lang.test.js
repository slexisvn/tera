import { describe, expect, it } from 'vitest';
import { TeraRuntime } from '../src/runtime.js';
import { formatValue } from '../src/format.js';
import { CsvStreamParser } from '../src/csv.js';

describe('Tera', () => {
  it('evaluates tensor expressions including matmul', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    const result = await runtime.execute(`
      x = tensor([[1, 2]])
      w = tensor([[3], [4]])
      x @ w
    `);
    expect(result.shape).toEqual([1, 1]);
    expect(result.item()).toBe(11);
  });

  it('promotes scalars in tensor operators and function calls', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    expect((await runtime.execute('tensor([1, 2]) * 2 + 1')).toArray()).toEqual([3, 5]);
    expect((await runtime.execute('tensor([1, 2]).mul(3)')).toArray()).toEqual([3, 6]);
  });

  it('formats scalar and CPU tensors for the CLI', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    const scalar = await runtime.execute('tensor(2, device=cpu)');
    const vector = await runtime.execute('tensor([1, 2], device=cpu)');

    expect(formatValue(scalar)).toBe('Tensor(2, dtype=f32)');
    expect(formatValue(vector)).toBe('Tensor(shape=[2], dtype=f32)\n[1,2]');
  });

  it('defines and runs a custom model', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    const result = await runtime.execute(`
      model MLP(input, hidden, output):
        fc1 = Linear(input, hidden)
        fc2 = Linear(hidden, output)

        forward x:
          x = fc1(x).relu()
          return fc2(x)

      model = MLP(4, 3, 2)
      x = randn([5, 4])
      model(x)
    `);
    expect(result.shape).toEqual([5, 2]);
  });

  it('compiles a model and records trace events', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    const result = await runtime.execute(`
      model = Sequential(Linear(4, 3), ReLU(), Linear(3, 2))
      x = randn([5, 4])
      compile(model, input=x, debug=true)
    `);
    expect(result._isCompiled).toBe(true);
    expect(result._compiledView.events.length).toBeGreaterThan(0);
    expect(result._compiledView.result.listKernels().length).toBeGreaterThan(0);
  });

  it('compiles tensor operators inside custom forward', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    const result = await runtime.execute(`
      model Residual:
        forward x:
          return (x + x).relu()
      net = Residual()
      x = randn([2, 4])
      compile(net, input=x)
    `);
    expect(result._compiledView.result.listKernels().length).toBeGreaterThan(0);
  });

  it('compiles scalar tensor operators inside custom forward', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    const result = await runtime.execute(`
      model Scale:
        forward x:
          return x.mul(2) + 1
      net = Scale()
      x = randn([2, 4])
      compile(net, input=x)
    `);
    expect(result._compiledView.result.listKernels().length).toBeGreaterThan(0);
  });

  it('executes compiled model and returns tensor', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    const result = await runtime.execute(`
      model = Sequential(Linear(4, 2))
      x = randn([3, 4])
      compiled = compile(model, input=x)
      compiled(x)
    `);
    expect(result.shape).toEqual([3, 2]);
    expect(result.dtype).toBe('f32');
  });

  it('supports lazy compile without input', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    const result = await runtime.execute(`
      model = Sequential(Linear(4, 2))
      compiled = compile(model)
      x = randn([3, 4])
      compiled(x)
    `);
    expect(result.shape).toEqual([3, 2]);
  });

  it('compiled output matches eager forward', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    await runtime.execute(`
      model = Sequential(Linear(3, 2))
      x = tensor([[1, 2, 3]])
      eager = model(x)
      compiled = compile(model, input=x)
      comp = compiled(x)
    `);
    const eager = runtime.getVariable('eager');
    const comp = runtime.getVariable('comp');
    expect(comp.shape).toEqual(eager.shape);
    const eagerData = eager.data;
    const compData = comp.data;
    for (let i = 0; i < eagerData.length; i++) {
      expect(compData[i]).toBeCloseTo(eagerData[i], 4);
    }
  });

  it('indexes and slices tensors', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    expect((await runtime.execute('tensor([[1, 2, 3], [4, 5, 6]])[1]')).toArray()).toEqual([4, 5, 6]);
    expect((await runtime.execute('tensor([[1, 2, 3], [4, 5, 6]])[:, 1]')).toArray()).toEqual([2, 5]);
    expect((await runtime.execute('tensor([0, 1, 2, 3, 4])[1:5:2]')).toArray()).toEqual([1, 3]);
    expect(await runtime.execute('tensor([1, 2, 3])[-1]')).toBe(3);
  });

  it('exposes view and like-operation builtins', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    const result = await runtime.execute('onesLike(tensor([1, 2, 3, 4])).reshape([2, 2]).transpose(0, 1)');
    expect(result.shape).toEqual([2, 2]);
    expect(result.toArray()).toEqual([[1, 1], [1, 1]]);
  });

  it('passes named convolution options as an options object', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    const conv = await runtime.execute('Conv2d(3, 8, 3, padding=1, bias=false)');
    expect(conv.padding).toBe(1);
    expect(conv.bias).toBeNull();
  });

  it('accesses model properties via dot notation in Tera', async () => {
    const runtime = new TeraRuntime({ output: () => {} });

    await runtime.execute('layer = Linear(4, 2)');
    const weight = await runtime.execute('layer.weight');
    expect(weight.shape).toEqual([2, 4]);
    expect(weight.isParameter).toBe(true);

    const bias = await runtime.execute('layer.bias');
    expect(bias.shape).toEqual([2]);
    expect(bias.isParameter).toBe(true);

    await runtime.execute('layer2 = Linear(4, 2, bias=false)');
    const noBias = await runtime.execute('layer2.bias');
    expect(noBias).toBeNull();

    const layer = await runtime.execute('layer');
    const params = [...layer.parameters()];
    expect(params).toHaveLength(2);
  });

  it('accesses custom model sub-module properties', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    await runtime.execute(`model MLP(h):
  fc1 = Linear(2, h)
  fc2 = Linear(h, 1)
  forward x:
    return fc2(fc1(x).relu())`);
    await runtime.execute('net = MLP(4)');

    const fc1 = await runtime.execute('net.fc1');
    expect(fc1).toBeDefined();
    expect(fc1.weight.shape).toEqual([4, 2]);

    const fc1Weight = await runtime.execute('net.fc1.weight');
    expect(fc1Weight.shape).toEqual([4, 2]);
    expect(fc1Weight.isParameter).toBe(true);

    const fc1Bias = await runtime.execute('net.fc1.bias');
    expect(fc1Bias.shape).toEqual([4]);

    const net = await runtime.execute('net');
    const allParams = [...net.parameters()];
    expect(allParams).toHaveLength(4); // fc1.weight, fc1.bias, fc2.weight, fc2.bias
  });

  it('reports runtime errors at the source expression', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    expect(() => runtime.execute('x = tensor([1])\nmissing(x)'))
      .toThrow(/Unknown name 'missing' at 2:1/);
  });

  it('supports basic autograd builtins', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    const result = await runtime.execute(`
      x = tensor([2], grad=true)
      y = (x * x).sum()
      y.backward()
      x.grad
    `);
    expect(result.toArray()).toEqual([4]);
  });

  it('evaluates scalar logical operators', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    expect(await runtime.execute('true and false')).toBe(false);
    expect(await runtime.execute('true and true')).toBe(true);
    expect(await runtime.execute('true or false')).toBe(true);
    expect(await runtime.execute('false or false')).toBe(false);
    expect(await runtime.execute('not true')).toBe(false);
    expect(await runtime.execute('not false')).toBe(true);
  });

  it('short-circuits and/or for scalars', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    expect(await runtime.execute('false and undefined_var')).toBe(false);
    expect(await runtime.execute('true or undefined_var')).toBe(true);
  });

  it('applies logical operators element-wise on tensors', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    const andResult = await runtime.execute('tensor([1, 0, 1]) and tensor([1, 1, 0])');
    expect(andResult.toArray()).toEqual([1, 0, 0]);
    const orResult = await runtime.execute('tensor([1, 0, 0]) or tensor([0, 0, 1])');
    expect(orResult.toArray()).toEqual([1, 0, 1]);
    const notResult = await runtime.execute('not tensor([1, 0, 1])');
    expect(notResult.toArray()).toEqual([0, 1, 0]);
  });

  it('evaluates compound assignment on scalars', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    expect(await runtime.execute('x = 10\nx += 5')).toBe(15);
    expect(await runtime.execute('x = 10\nx -= 3')).toBe(7);
    expect(await runtime.execute('x = 10\nx *= 2')).toBe(20);
    expect(await runtime.execute('x = 10\nx /= 4')).toBe(2.5);
    expect(await runtime.execute('x = 2\nx **= 3')).toBe(8);
  });

  it('evaluates compound assignment on tensors', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    const result = await runtime.execute('x = tensor([1, 2, 3])\nx += 1');
    expect(result.toArray()).toEqual([2, 3, 4]);
  });

  it('rejects compound assignment on undefined variable', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    expect(() => runtime.execute('x += 1')).toThrow(/Unknown name 'x'/);
  });

  it('defines and calls user functions', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    expect(await runtime.execute(`
      fn add(a, b): return a + b
      add(3, 4)
    `)).toBe(7);
  });

  it('supports closures in user functions', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    expect(await runtime.execute(`
      scale = 10
      fn scaled(x): return x * scale
      scaled(5)
    `)).toBe(50);
  });

  it('supports recursion in user functions', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    expect(await runtime.execute(`
      fn sum_to(n):
        return n + sum_to(n - 1)
    `)).toBeTypeOf('function');
  });

  it('applies user functions to tensors', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    const result = await runtime.execute(`
      fn double(x): return x * 2
      double(tensor([1, 2, 3]))
    `);
    expect(result.toArray()).toEqual([2, 4, 6]);
  });

  it('returns last expression when no explicit return', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    expect(await runtime.execute(`
      fn square(x): x * x
      square(5)
    `)).toBe(25);
  });

  it('evaluates if/else if/else', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    expect(await runtime.execute('if true: 1')).toBe(1);
    expect(await runtime.execute(`if false: 1
else: 2`)).toBe(2);
    expect(await runtime.execute(`if false: 1
else if true: 2
else: 3`)).toBe(2);
    expect(await runtime.execute(`if false: 1
else if false: 2
else: 3`)).toBe(3);
  });

  it('evaluates for...in loops', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    expect(await runtime.execute(`
      total = 0
      for i in [1, 2, 3]: total += i
      total
    `)).toBe(6);
  });

  it('evaluates for...in with range()', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    expect(await runtime.execute(`
      total = 0
      for i in range(5): total += i
      total
    `)).toBe(10);
  });

  it('evaluates while loops', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    expect(await runtime.execute(`
      x = 10
      while x > 0: x -= 1
      x
    `)).toBe(0);
  });

  it('supports break in loops', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    expect(await runtime.execute(`
      total = 0
      for i in range(100):
        if i >= 5: break
        total += i
      total
    `)).toBe(10);
  });

  it('supports continue in loops', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    expect(await runtime.execute(`
      total = 0
      for i in range(6):
        if i == 3: continue
        total += i
      total
    `)).toBe(12);
  });

  it('propagates return from inside loops', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    expect(await runtime.execute(`
      fn find_first(items):
        for x in items:
          if x > 3: return x
        return null
      find_first([1, 2, 5, 8])
    `)).toBe(5);
  });

  it('supports nested control flow', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    expect(await runtime.execute(`
      total = 0
      for i in range(3):
        for j in range(3):
          if i == j: continue
          total += 1
      total
    `)).toBe(6);
  });

  it('sequences auto-awaited DataFrame materializers inside control flow', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    expect(await runtime.executeAsync(`
      data = load_csv("tests/fixtures/iris_sample.csv")
      total = 0
      for i in range(3):
        total += data.limit(i + 1).count()
      if total == 6:
        total += data.limit(1).count()
      while total < 9:
        total += data.limit(1).count()
      total
    `)).toBe(9);
  });

  it('rejects invalid indexing forms', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    expect(() => runtime.execute('tensor([1])[]')).toThrow(/Expected index expression/);
    expect(() => runtime.execute('tensor([1, 2])[::0]')).toThrow(/Slice step must be a positive integer/);
  });

  it('streams a CSV into row batches', async () => {
    const csv = 'id,city,age\n1,HN,20\n2,"Da Nang",35\n3,HN,42\n';
    const parser = new CsvStreamParser(',');
    for (let i = 0; i < csv.length; i += 5) parser.feed(csv.slice(i, i + 5));
    const { headers, rowCount } = parser.finish();
    const rows = parser.drain();
    expect(headers).toEqual(['id', 'city', 'age']);
    expect(rowCount).toBe(3);
    expect(rows).toEqual([
      { id: 1, city: 'HN', age: 20 },
      { id: 2, city: 'Da Nang', age: 35 },
      { id: 3, city: 'HN', age: 42 },
    ]);
  });

  it('ingests an uploaded CSV incrementally via the builder, queryable by load_csv', async () => {
    const parser = new CsvStreamParser(',');
    parser.feed('city,amount\nHN,100\nSG,250\nHN,80\n');
    parser.finish();
    const rows = parser.drain();

    const runtime = new TeraRuntime({ output: () => {} });
    const handle = runtime.beginUploadedCsv('sales.csv');
    handle.appendRows(rows.slice(0, 2)); // append in two batches
    handle.appendRows(rows.slice(2));
    handle.finish();

    // Repeated load_csv calls reuse the one registered relation.
    expect(await runtime.executeAsync('load_csv("sales.csv").count()')).toBe(3);
    expect(await runtime.executeAsync('load_csv("sales.csv").groupBy("city").agg(sum("amount")).orderBy("city").collect()'))
      .toEqual([{ city: 'HN', sum: 180 }, { city: 'SG', sum: 250 }]);

    runtime.removeUploadedCsv('sales.csv');
    expect(() => runtime.execute('load_csv("sales.csv")')).toThrow();
  });
});
