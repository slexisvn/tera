import { describe, expect, it } from 'vitest';
import { parse } from '../../src/cli/parser.js';
import { TeraRuntime } from '../../src/cli/runtime.js';
import { LightningModule } from '../../src/lightning/core/module.js';
import { Module } from '../../src/nn/module.js';
import { Tensor } from '../../src/tensor/core/tensor.js';

describe('Parser — training syntax', () => {
  it('parses destructuring assignment', () => {
    const program = parse('x, y = batch');
    expect(program.body[0]).toMatchObject({
      type: 'DestructureAssign',
      names: ['x', 'y'],
    });
  });

  it('parses three-element destructuring', () => {
    const program = parse('a, b, c = items');
    expect(program.body[0]).toMatchObject({
      type: 'DestructureAssign',
      names: ['a', 'b', 'c'],
    });
  });

  it('parses train block inside model', () => {
    const program = parse(`
model Net():
  fc = Linear(2, 1)
  forward x:
    return fc(x)
  train batch:
    x, y = batch
    return fc(x)
`);
    const model = program.body[0];
    expect(model.type).toBe('ModelDeclaration');
    const trainBlock = model.body.find(n => n.type === 'TrainDeclaration');
    expect(trainBlock).toBeDefined();
    expect(trainBlock.params).toEqual(['batch']);
  });

  it('parses validate block inside model', () => {
    const program = parse(`
model Net():
  fc = Linear(2, 1)
  forward x:
    return fc(x)
  validate batch:
    return 0
`);
    const model = program.body[0];
    const valBlock = model.body.find(n => n.type === 'ValidateDeclaration');
    expect(valBlock).toBeDefined();
    expect(valBlock.params).toEqual(['batch']);
  });

  it('parses optimizer block inside model', () => {
    const program = parse(`
model Net():
  fc = Linear(2, 1)
  forward x:
    return fc(x)
  optimizer:
    return SGD(Net.parameters(), lr=0.01)
`);
    const model = program.body[0];
    const optBlock = model.body.find(n => n.type === 'OptimizerDeclaration');
    expect(optBlock).toBeDefined();
    expect(optBlock.body.length).toBeGreaterThan(0);
  });

  it('does not break train as variable name', () => {
    const program = parse('train = 42');
    expect(program.body[0]).toMatchObject({ type: 'Assign', name: 'train' });
  });
});

describe('Runtime — destructuring', () => {
  it('destructures array values', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    await runtime.execute('items = [10, 20, 30]');
    await runtime.execute('a, b, c = items');
    expect(runtime.getVariable('a')).toBe(10);
    expect(runtime.getVariable('b')).toBe(20);
    expect(runtime.getVariable('c')).toBe(30);
  });

  it('throws on non-array destructure', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    await expect(runtime.execute('a, b = 42')).rejects.toThrow(/array/i);
  });

  it('throws on too few values', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    await expect(runtime.execute('a, b, c = [1, 2]')).rejects.toThrow(/Not enough/);
  });
});

describe('Runtime — model classification', () => {
  it('model without train/validate extends Module', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    const factory = await runtime.execute(`
model Plain():
  fc = Linear(2, 1)
  forward x:
    return fc(x)
`);
    const instance = await factory();
    expect(instance instanceof Module).toBe(true);
    expect(instance instanceof LightningModule).toBe(false);
  });

  it('model with train block extends LightningModule', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    const factory = await runtime.execute(`
model LitNet():
  fc = Linear(2, 1)
  loss_fn = MSELoss()

  forward x:
    return fc(x)

  train batch:
    x, y = batch
    pred = LitNet(x)
    return loss_fn(pred, y)

  optimizer:
    return Adam(LitNet.parameters(), lr=0.01)
`);
    const instance = await factory();
    expect(instance instanceof LightningModule).toBe(true);
    expect(typeof instance.trainingStep).toBe('function');
    expect(typeof instance.configureOptimizers).toBe('function');
  });
});

describe('Runtime — train/validate/optimizer outside model', () => {
  it('train outside model throws', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    await expect(runtime.execute(`
train batch:
  return 0
`)).rejects.toThrow(/model/);
  });

  it('validate outside model throws', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    await expect(runtime.execute(`
validate batch:
  return 0
`)).rejects.toThrow(/model/);
  });

  it('optimizer outside model throws', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    await expect(runtime.execute(`
optimizer:
  return 0
`)).rejects.toThrow(/model/);
  });
});

describe('Runtime — model name as self-reference', () => {
  it('model name calls forward inside train', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    await runtime.execute(`
model Regressor():
  fc = Linear(2, 1)
  loss_fn = MSELoss()

  forward x:
    return fc(x)

  train batch:
    x, y = batch
    pred = Regressor(x)
    loss = loss_fn(pred, y)
    return loss

  optimizer:
    return Adam(Regressor.parameters(), lr=0.01)
`);
    const factory = runtime.getVariable('Regressor');
    const instance = await factory();
    const x = runtime.getVariable('tensor')([1, 2], { shape: [1, 2] });
    const y = runtime.getVariable('tensor')([1], { shape: [1, 1] });
    const loss = await instance.trainingStep([x, y], 0);
    expect(loss instanceof Tensor).toBe(true);
  });
});

describe('Builtins — training infrastructure', () => {
  it('TensorDataset is available', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    const result = await runtime.execute(`
x = tensor([[1, 2], [3, 4], [5, 6]])
y = tensor([0, 1, 0])
ds = TensorDataset(x, y)
ds.length
`);
    expect(result).toBe(3);
  });

  it('DataLoader with snake_case args', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    const result = await runtime.execute(`
x = tensor([[1, 2], [3, 4]])
y = tensor([0, 1])
ds = TensorDataset(x, y)
dl = DataLoader(ds, batch_size=2)
dl.length
`);
    expect(result).toBe(1);
  });

  it('Trainer with snake_case args', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    const result = await runtime.execute(`
trainer = Trainer(max_epochs=5, logger=false, enable_checkpointing=false, enable_progress=false)
trainer
`);
    expect(result.state.maxEpochs).toBe(5);
  });

  it('SGD optimizer builtin', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    await runtime.execute(`
model Net():
  fc = Linear(2, 1)
  forward x:
    return fc(x)
net = Net()
opt = SGD(net.parameters(), lr=0.1, momentum=0.9)
`);
    const opt = runtime.getVariable('opt');
    expect(opt.defaults.lr).toBe(0.1);
    expect(opt.defaults.momentum).toBe(0.9);
  });

  it('Adam optimizer builtin', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    await runtime.execute(`
model Net():
  fc = Linear(2, 1)
  forward x:
    return fc(x)
net = Net()
opt = Adam(net.parameters(), lr=0.001)
`);
    const opt = runtime.getVariable('opt');
    expect(opt.defaults.lr).toBe(0.001);
  });

  it('EarlyStopping callback builtin', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    const result = await runtime.execute(`
EarlyStopping(monitor="val_loss", patience=5, mode="min")
`);
    expect(result._monitor).toBe('val_loss');
    expect(result._patience).toBe(5);
  });

  it('Accuracy metric builtin', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    const result = await runtime.execute(`
acc = Accuracy(task="multiclass", num_classes=10)
acc
`);
    expect(result._task).toBe('multiclass');
    expect(result._numClasses).toBe(10);
  });

  it('optim_config helper', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    await runtime.execute(`
model Net():
  fc = Linear(2, 1)
  forward x:
    return fc(x)
net = Net()
opt = Adam(net.parameters(), lr=0.001)
sched = StepLR(opt, step_size=5)
config = optim_config(opt, lr_scheduler=sched)
`);
    const config = runtime.getVariable('config');
    expect(config.optimizer).toBeDefined();
    expect(config.lrScheduler).toBeDefined();
  });

  it('CosineAnnealingLR scheduler builtin', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    await runtime.execute(`
model Net():
  fc = Linear(2, 1)
  forward x:
    return fc(x)
net = Net()
opt = Adam(net.parameters(), lr=0.01)
sched = CosineAnnealingLR(opt, t_max=10)
`);
    const sched = runtime.getVariable('sched');
    expect(sched._tMax).toBe(10);
  });
});

describe('Builtins — data utilities', () => {
  it('load_csv loads and parses CSV', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    await runtime.execute(`
data = load_csv("tests/cli/fixtures/iris_sample.csv")
`);
    const data = runtime.getVariable('data');
    expect(await data.count()).toBe(20);
    expect(data.columns().length).toBe(5);
    expect(data.columns()).toContain('species');
    expect(data.columns()).toContain('sepal_length');
  });

  it('DataFrame.select and drop', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    await runtime.execute(`
data = load_csv("tests/cli/fixtures/iris_sample.csv")
subset = data.select("sepal_length", "sepal_width")
dropped = data.drop("species")
`);
    const subset = runtime.getVariable('subset');
    expect(subset.columns()).toEqual(['sepal_length', 'sepal_width']);
    const dropped = runtime.getVariable('dropped');
    expect(dropped.columns().length).toBe(4);
    expect(dropped.columns()).not.toContain('species');
  });

  it('DataFrame.to_tensor converts numeric columns', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    const result = await runtime.execute(`
data = load_csv("tests/cli/fixtures/iris_sample.csv")
data.drop("species").to_tensor()
`);
    expect(result instanceof Tensor).toBe(true);
    expect(result.shape).toEqual([20, 4]);
  });

  it('DataFrame.to_tensor rejects string columns', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    await expect(runtime.execute(`
data = load_csv("tests/cli/fixtures/iris_sample.csv")
data.to_tensor()
`)).rejects.toThrow(/non-numeric/);
  });

  it('encode converts string labels to tensor', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    await runtime.execute(`
data = load_csv("tests/cli/fixtures/iris_sample.csv")
y, classes = data.select("species").encode("species")
`);
    const y = runtime.getVariable('y');
    const classes = runtime.getVariable('classes');
    expect(y instanceof Tensor).toBe(true);
    expect(y.shape).toEqual([20]);
    expect(classes).toEqual(['setosa', 'versicolor', 'virginica']);
  });

  it('LabelEncoder encodes label tensors', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    await runtime.execute(`
labels = tensor([2, 5, 2, 9, 5])
le = LabelEncoder()
y = le.fit_transform(labels)
classes = le.classes_
`);
    const y = runtime.getVariable('y');
    const classes = runtime.getVariable('classes');
    expect(y.toArray()).toEqual([0, 1, 0, 2, 1]);
    expect(classes).toEqual([2, 5, 9]);
  });

  it('StandardScaler standardizes tensor', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    const result = await runtime.execute(`
x = tensor([[1.0, 100.0], [2.0, 200.0], [3.0, 300.0]])
StandardScaler().fit_transform(x)
`);
    expect(result.shape).toEqual([3, 2]);
    const col0 = [result.toArray()[0][0], result.toArray()[1][0], result.toArray()[2][0]];
    const meanCol0 = col0.reduce((a, b) => a + b) / 3;
    expect(Math.abs(meanCol0)).toBeLessThan(0.01);
  });

  it('train_test_split splits a tensor', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    await runtime.execute(`
x = randn([20, 3])
train_data, test_data = train_test_split(x, test_size=0.3)
`);
    const train = runtime.getVariable('train_data');
    const test = runtime.getVariable('test_data');
    expect(train.shape[0] + test.shape[0]).toBe(20);
    expect(test.shape[0]).toBe(6);
    expect(train.shape[0]).toBe(14);
  });

  it('encodes a subset with fitted classes', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    await runtime.execute(`
data = load_csv("tests/cli/fixtures/iris_sample.csv")
y, classes = data.select("species").encode("species")
head = data.limit(3).select("species")
y_split, _ = head.encode("species", classes=classes)
`);
    const classes = runtime.getVariable('classes');
    const ySplit = runtime.getVariable('y_split').toArray();
    expect(classes).toEqual(['setosa', 'versicolor', 'virginica']);
    expect(ySplit).toEqual([0, 0, 1]);
  });
});

describe('End-to-end — DSL training', () => {
  it('trains a model via DSL and Trainer', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    await runtime.execute(`
model Classifier():
  fc = Linear(2, 1)
  loss_fn = MSELoss()

  forward x:
    return fc(x)

  train batch:
    x, y = batch
    pred = Classifier(x)
    loss = loss_fn(pred, y)
    log("train_loss", loss, prog_bar=true)
    return loss

  optimizer:
    return Adam(Classifier.parameters(), lr=0.01)

x = tensor([[1, 0], [0, 1], [1, 1], [0, 0]])
y = tensor([[1], [1], [2], [0]])
train_loader = DataLoader(TensorDataset(x, y), batch_size=2)

net = Classifier()
trainer = Trainer(max_epochs=10, logger=false, enable_checkpointing=false, enable_progress=false)
trainer.fit(net, train_loader)
`);
    const trainer = runtime.getVariable('trainer');
    expect(trainer.globalStep).toBeGreaterThan(0);
    expect(trainer.state.epoch).toBe(9);
  });

  it('trains with validation and early stopping', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    await runtime.execute(`
model Net():
  fc = Linear(2, 1)
  loss_fn = MSELoss()

  forward x:
    return fc(x)

  train batch:
    x, y = batch
    pred = Net(x)
    loss = loss_fn(pred, y)
    return loss

  validate batch:
    x, y = batch
    pred = Net(x)
    loss = loss_fn(pred, y)
    log("val_loss", loss)

  optimizer:
    return Adam(Net.parameters(), lr=0.01)

x = tensor([[1, 0], [0, 1], [1, 1], [0, 0]])
y = tensor([[1], [1], [2], [0]])
loader = DataLoader(TensorDataset(x, y), batch_size=4)

net = Net()
trainer = Trainer(
  max_epochs=50,
  logger=false,
  enable_checkpointing=false,
  enable_progress=false,
  callbacks=[EarlyStopping(monitor="val_loss", patience=5)]
)
trainer.fit(net, loader, loader)
`);
    const trainer = runtime.getVariable('trainer');
    expect(trainer.globalStep).toBeGreaterThan(0);
  });

  it('trains with optim_config and scheduler', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    await runtime.execute(`
model Net():
  fc = Linear(2, 1)
  loss_fn = MSELoss()

  forward x:
    return fc(x)

  train batch:
    x, y = batch
    return loss_fn(Net(x), y)

  optimizer:
    opt = Adam(Net.parameters(), lr=0.01)
    sched = StepLR(opt, step_size=3)
    return optim_config(opt, lr_scheduler=sched)

x = tensor([[1, 0], [0, 1], [1, 1], [0, 0]])
y = tensor([[1], [1], [2], [0]])
loader = DataLoader(TensorDataset(x, y), batch_size=4)

net = Net()
trainer = Trainer(max_epochs=5, logger=false, enable_checkpointing=false, enable_progress=false)
trainer.fit(net, loader)
`);
    const trainer = runtime.getVariable('trainer');
    expect(trainer.globalStep).toBe(5);
  });

  it('load_csv → train classification end-to-end', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    await runtime.execute(`
data = load_csv("tests/cli/fixtures/iris_sample.csv")
x = StandardScaler().fit_transform(data.drop("species").to_tensor())
y, classes = data.select("species").encode("species")
loader = DataLoader(TensorDataset(x, y), batch_size=10)

model Net():
  fc1 = Linear(4, 8)
  fc2 = Linear(8, 3)
  loss_fn = CrossEntropyLoss()

  forward x:
    return fc2(fc1(x).relu())

  train batch:
    x, y = batch
    return loss_fn(Net(x), y)

  optimizer:
    return Adam(Net.parameters(), lr=0.01)

net = Net()
trainer = Trainer(max_epochs=30, logger=false, enable_checkpointing=false, enable_progress=false)
trainer.fit(net, loader)
`);
    const trainer = runtime.getVariable('trainer');
    expect(trainer.globalStep).toBe(60);
  });
});
