export const project = {
  name: 'tera',
  repository: 'https://github.com/slexisvn/tera',
  install: 'npm install -g @slexisvn/tera',
  mark: `${import.meta.env.BASE_URL}tera-mark.svg`,
};

const source = (path: string) => `${project.repository}/tree/main/${path}`;
const app = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\/+/, '')}`;
const marketplace = (id: string) => `https://marketplace.visualstudio.com/items?itemName=${id}`;

export const links = {
  docs: source('docs'),
  notebook: app('notebook/'),
  extension: marketplace('slexisvn.tera-language'),
  cli: source('src/cli'),
  visualizer: app('visualizer/'),
  examples: source('examples'),
};

export const navigation = [
  { label: 'Language', href: '#language' },
  { label: 'Tooling', href: '#tooling' },
  { label: 'Under the hood', href: '#engine' },
];

export const ui = {
  skip: 'Skip to content',
  menu: 'Toggle navigation',
  github: 'GitHub',
  docs: 'Documentation',
  copy: 'Copy code',
  copied: 'Copied',
  copyFailed: 'Could not copy. Select and copy the text.',
  install: 'Copy install command',
  output: 'Example output',
  examples: 'Language examples',
  source: 'View source',
};

export const hero = {
  badge: 'The Tera programming language',
  title: 'Tera',
  subtitle: 'Ideas into programs.',
  description: 'A readable language for everyday code, data, and models. From your first notebook cell to a native executable.',
  primary: 'Explore the language',
  secondary: 'Read the docs',
  footnote: 'DataFrames. Tensors. Models. Built in.',
};

export type Example = {
  id: string;
  label: string;
  filename: string;
  code: string;
  output: string;
  outputLabel?: string;
  title: string;
  description: string;
};

export const examples: Example[] = [
  {
    id: 'dataframes', label: 'DataFrames', filename: 'sales.tera',
    title: 'A little code. A clearer picture.',
    description: 'Group, aggregate, and explore. Your data is already part of the language.',
    code: `sales = DataFrame(
  region=["North", "South", "North", "West"],
  revenue=[1200, 840, 960, 650]
)

summary = sales.group_by("region").agg(
  sum("revenue").alias("total")
)

summary.order_by("region").show()`,
    output: 'region | total\n-------+------\nNorth  | 2160\nSouth  | 840\nWest   | 650',
  },
  {
    id: 'tensors', label: 'Tensors', filename: 'algebra.tera',
    title: 'Math that reads like math.',
    description: 'Native operators, multidimensional slices, and automatic differentiation.',
    code: `a = tensor([[1.0, 2.0], [3.0, 4.0]])
b = tensor([[2.0, 0.0], [0.0, 2.0]])

product = a @ b
column = product[:, 0]

print(product.to_array())
print(column.to_array())
print(product.sum().item())`,
    output: '[[2, 4], [6, 8]]\n[2, 6]\n20',
  },
  {
    id: 'models', label: 'Models', filename: 'network.tera',
    title: 'Give your model a shape.',
    description: 'Declare layers and forward passes together. Add training hooks when you need them.',
    code: `model IrisNet(num_classes: int):
  net = Sequential(
    Linear(4, 32),
    ReLU(),
    Linear(32, num_classes)
  )

  forward (x: Tensor) -> Tensor:
    return net(x)

net = IrisNet(3)`,
    output: 'IrisNet\n  Linear     4 → 32\n  ReLU\n  Linear    32 → 3',
    outputLabel: 'Model architecture',
  },
  {
    id: 'language', label: 'Everyday code', filename: 'hello.tera',
    title: 'Familiar ideas. Room to build.',
    description: 'Functions, types, classes, modules, and async. A language beyond the notebook.',
    code: `fn total(values: int[]) -> int:
  result = 0
  for value of values:
    result += value
  return result

orders = [12, 8, 15]
print(total(orders))
print("Hello, Tera.")`,
    output: '35\nHello, Tera.',
  },
];

export const language = {
  eyebrow: '01 / THE LANGUAGE',
  title: 'Small syntax.\nA lot of possibility.',
  description: 'Everything you expect from a programming language, with the tools for data work already at hand.',
  core: {
    title: 'Less ceremony. More clarity.',
    description: 'Readable indentation, inferred types, and explicit annotations where they matter.',
    code: `fn greet(name: string) -> string:
  return "Hello, " + name

message = greet("world")
print(message)`,
    features: ['Functions & closures', 'Classes & interfaces', 'Modules & imports', 'Async / await', 'Error handling', 'Type inference'],
  },
  dataframe: {
    title: 'Meet your data.',
    description: 'Load, filter, join, and aggregate. Turn your next question into a DataFrame.',
    label: 'DataFrame',
    columns: ['region', 'orders', 'revenue'],
    rows: [['North', '24', '2,160'], ['South', '18', '840'], ['West', '12', '650']],
    caption: '3 rows × 3 columns',
  },
  tensor: {
    title: 'Think in dimensions.',
    description: 'Tensor algebra, slicing, broadcasting, and autograd. Written the way you think.',
    label: 'Tensor',
    matrix: [[1, 2, 3], [4, 5, 6], [7, 8, 9]],
    operation: 'a @ b',
    caption: 'shape [3, 3]',
  },
  model: {
    title: 'From layers to learning.',
    description: 'Model blocks bring layers, training hooks, optimizers, and checkpoints together.',
    label: 'Model',
    layers: [{ name: 'Input', size: '4' }, { name: 'Linear + ReLU', size: '32' }, { name: 'Output', size: '3' }],
  },
  chart: {
    title: 'See what the numbers say.',
    description: 'Lines, scatter plots, histograms, and heatmaps. Visual output belongs in the workflow.',
    label: 'Charts',
    caption: 'Revenue by region',
    values: [{ label: 'North', value: 2160 }, { label: 'South', value: 840 }, { label: 'West', value: 650 }],
  },
};

export const tooling = {
  eyebrow: '02 / YOUR WORKSPACE',
  title: 'One language.\nWherever you work.',
  description: 'Explore in a notebook, stay in your editor, or go straight to the terminal.',
  notebook: {
    title: 'Tera Notebook',
    description: 'A place to think out loud. Run cells, inspect DataFrames, and keep code and charts in the same conversation.',
    action: 'Explore the notebook',
    filename: 'exploration.tenb',
    cell: 'summary.order_by("region").show()',
    label: 'Notebook preview',
  },
  extension: {
    title: 'At home in VS Code.',
    label: 'VS CODE EXTENSION',
    description: 'Completions, diagnostics, go-to-definition, and debugging. All in your existing workspace.',
    action: 'Explore the extension',
    filename: 'main.tera',
    code: `fn greet(name: string) -> string:
  return "Hello, " + name`,
    annotations: { greet: 'fn greet(name: string) -> string' },
  },
  cli: {
    title: 'The terminal is yours.',
    label: 'TERA CLI',
    description: 'Run scripts, open a REPL, type-check, debug, and compile. One command away.',
    action: 'Explore the CLI',
    commands: ['tera hello.tera', 'tera check hello.tera', 'tera compile hello.tera -o hello'],
  },
};

export const engine = {
  eyebrow: '03 / UNDER THE HOOD',
  title: 'Readable on the surface.\nSerious underneath.',
  description: 'An interpreter, tiered JIT, and ahead-of-time compiler share the same language pipeline.',
  stages: [
    { name: 'Interpreter', tag: 'START IMMEDIATELY', text: 'Run a script or notebook cell directly. Inspect, iterate, and debug.' },
    { name: 'JIT', tag: 'OPTIMIZE AS YOU GO', text: 'Hot code moves through a JavaScript baseline and an optimizing WebAssembly tier.' },
    { name: 'Native AOT', tag: 'COMPILE AHEAD', text: 'Compile supported programs to native executables, object files, or C source.' },
  ],
  command: 'tera compile hello.tera -o hello',
  note: 'AOT checks supported patterns strictly and reports what it cannot compile.',
  visualizer: 'Follow the compiler',
  visualizerDescription: 'Explore tokens, bytecode, IR, and optimization passes in the compiler visualizer.',
};

export const closing = {
  eyebrow: 'YOUR NEXT IDEA STARTS HERE',
  title: 'Make something with Tera.',
  description: 'A small script. A new model. Whatever comes next.',
  examples: 'Browse examples',
  footer: 'A language for ideas in motion.',
  top: 'Back to top',
};
