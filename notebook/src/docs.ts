import { appendInlineCode } from './utils/format';

const INITIAL_ITEMS = 6;
const INITIAL_OPEN_SECTIONS = 4;
const MORE_ITEMS = 12;
const SEARCH_LIMIT = 80;

type CreateCell = (source?: string, options?: { focus?: boolean }) => void;

type DocsInitOptions = {
  createCell?: CreateCell;
};

type SignatureParam = {
  name?: string;
  type?: string;
  optional?: boolean;
  rest?: boolean;
};

type SignatureInfo = {
  display?: string;
  params?: SignatureParam[];
};

type BuiltinDoc = {
  name: string;
  kind?: string;
  description?: string;
  signature?: SignatureInfo;
  returns?: string | null;
  methods?: PseudoMethodDoc[];
};

type PseudoMethodDoc = {
  name: string;
  description?: string;
  isGetter?: boolean;
  signature?: SignatureInfo;
  returns?: string | null;
};

type LanguageDocsData = {
  builtins?: BuiltinDoc[];
  pseudoTypes?: Record<string, PseudoMethodDoc[]>;
  keywordGroups?: Record<string, string[]>;
};

type DocSource = 'builtin' | 'member' | 'chart' | 'keyword' | '';

type DocItemInput = {
  name: string;
  display?: string;
  tag?: string;
  desc?: string;
  kind?: string;
  owner?: string;
  callable?: boolean;
  member?: boolean;
  receiver?: string | null;
  params?: SignatureParam[];
  returns?: string | null;
  insert?: string | null;
  source?: DocSource;
};

type DocItem = Required<Omit<DocItemInput, 'returns' | 'insert' | 'receiver' | 'params'>> & {
  receiver: string | null;
  params: SignatureParam[];
  returns: string | null;
  insert: string | null;
  source: DocSource;
  order: number;
  example: string;
};

type DocsSection = {
  title: string;
  items: DocItem[];
};

type SectionNodeOptions = {
  remaining?: number;
  search?: boolean;
};

type SearchMatch = {
  section: string;
  item: DocItem;
};

const SECTION_ORDER = [
  'Tensors',
  'Models & layers',
  'DataFrame',
  'Data utilities',
  'Quant',
  'Training',
  'Tokenizer & files',
  'Runtime',
  'Charts',
  'Language basics',
];

const DATAFRAME_BUILTINS = new Set([
  'DataFrame', 'load_csv', 'col', 'lit', 'expr',
  'sum', 'avg', 'min', 'max', 'count', 'countStar',
]);
const DATA_UTILITY_BUILTINS = new Set(['TensorDataset', 'DataLoader', 'encode', 'decode', 'normalize', 'train_test_split']);
const QUANT_BUILTINS = new Set([
  'backtest', 'walk_forward',
  'momentum', 'mean_reversion', 'zscore',
  'equal_weight', 'cross_sectional', 'long_short',
  'sharpe', 'deflated_sharpe', 'pbo', 'min_track_record_length',
  'risk_parity', 'hrp', 'mean_variance',
  'quill', 'load_quill',
]);
const QUANT_ORDER = [
  'backtest', 'walk_forward',
  'momentum', 'mean_reversion', 'zscore',
  'equal_weight', 'cross_sectional', 'long_short',
  'sharpe', 'deflated_sharpe', 'pbo', 'min_track_record_length',
  'risk_parity', 'hrp', 'mean_variance',
  'quill', 'load_quill',
];
const TENSOR_BUILTINS = new Set(['cat', 'stack', 'where']);
const TRAINING_BUILTINS = new Set([
  'SGD', 'Adam', 'AdamW', 'StepLR', 'CosineAnnealingLR', 'ReduceLROnPlateau',
  'Trainer', 'log', 'optim_config',
  'EarlyStopping', 'GradientAccumulationScheduler', 'LearningRateMonitor', 'ModelCheckpoint', 'ProgressCallback', 'Timer',
  'ConsoleLogger', 'CSVLogger',
  'Accuracy', 'ConfusionMatrix', 'F1Score', 'MetricCollection', 'Precision', 'Recall',
]);
const TOKENIZER_FILE_BUILTINS = new Set(['Tokenizer', 'load_tokenizer', 'read_text', 'load_json', 'load_model']);
const RUNTIME_BUILTINS = new Set(['compile', 'graph', 'print', 'range', 'trace', 'cpu', 'gpu', 'wasm', 'webgpu']);

const EXAMPLES: Record<string, string> = {
  tensor: 'tensor([[1, 2], [3, 4]])',
  zeros: 'zeros([2, 3])',
  ones: 'ones([2, 3])',
  empty: 'empty([2, 3])',
  full: 'full([2, 3], 7)',
  randn: 'randn([2, 3])',
  arange: 'arange(0, 6, 2)',
  eye: 'eye(3)',
  linspace: 'linspace(0, 1, 5)',
  randperm: 'randperm(5)',
  zerosLike: 'x = randn([2, 3])\nzerosLike(x)',
  onesLike: 'x = randn([2, 3])\nonesLike(x)',
  emptyLike: 'x = randn([2, 3])\nemptyLike(x)',
  fullLike: 'x = randn([2, 3])\nfullLike(x, 9)',
  randnLike: 'x = zeros([2, 3])\nrandnLike(x)',
  where: 'mask = tensor([true, false, true])\na = tensor([1, 1, 1])\nb = tensor([9, 9, 9])\nwhere(mask, a, b)',
  cat: 'a = ones([2, 2])\nb = zeros([2, 2])\ncat([a, b], axis=0)',
  stack: 'a = ones([2])\nb = zeros([2])\nstack([a, b], axis=0)',

  DataFrame: 'df = DataFrame(name=["A", "B", "C"], value=[10, 20, 30])\ndf.show()',
  col: 'df = DataFrame(name=["A", "B", "C"], value=[10, 20, 30])\ndf.select(col("name"), col("value")).show()',
  lit: 'df = DataFrame(value=[1, 2, 3])\ndf.withColumn("bias", lit(1)).show()',
  expr: 'df = DataFrame(price=[10, 20, 30])\ndf.withColumn("taxed", expr("price * 1.1")).show()',
  sum: 'df = DataFrame(group=["a", "a", "b"], value=[1, 2, 3])\ndf.groupBy("group").agg(sum(col("value")).alias("total")).show()',
  avg: 'df = DataFrame(group=["a", "a", "b"], value=[1, 2, 3])\ndf.groupBy("group").agg(avg(col("value")).alias("mean")).show()',
  min: 'df = DataFrame(group=["a", "a", "b"], value=[1, 2, 3])\ndf.groupBy("group").agg(min(col("value")).alias("low")).show()',
  max: 'df = DataFrame(group=["a", "a", "b"], value=[1, 2, 3])\ndf.groupBy("group").agg(max(col("value")).alias("high")).show()',
  count: 'df = DataFrame(group=["a", "a", "b"], value=[1, 2, 3])\ndf.groupBy("group").agg(count(col("value")).alias("n")).show()',
  countStar: 'df = DataFrame(group=["a", "a", "b"], value=[1, 2, 3])\ndf.groupBy("group").agg(countStar().alias("n")).show()',
  encode: 'labels = ["cat", "dog", "cat"]\nencoded, classes = encode(labels)\nprint(classes)\nencoded',
  decode: 'labels = ["cat", "dog", "cat"]\nencoded, classes = encode(labels)\ndecode(encoded, classes)',
  normalize: 'x = tensor([[1, 2], [3, 4]])\nnormalize(x)',
  train_test_split: 'x = arange(0, 10)\ntrain_test_split(x, test_size=0.2)',

  Sequential: 'net = Sequential(Linear(2, 4), ReLU(), Linear(4, 1))\nnet(randn([3, 2]))',
  Linear: 'layer = Linear(4, 2)\nlayer(randn([3, 4]))',
  ReLU: 'act = ReLU()\nact(tensor([-1, 0, 2]))',
  GELU: 'act = GELU()\nact(tensor([-1, 0, 2]))',
  SiLU: 'act = SiLU()\nact(tensor([-1, 0, 2]))',
  Sigmoid: 'act = Sigmoid()\nact(tensor([-1, 0, 2]))',
  Tanh: 'act = Tanh()\nact(tensor([-1, 0, 2]))',
  LeakyReLU: 'act = LeakyReLU()\nact(tensor([-1, 0, 2]))',
  ELU: 'act = ELU()\nact(tensor([-1, 0, 2]))',
  Softmax: 'sm = Softmax(dim=-1)\nsm(randn([2, 4]))',
  LogSoftmax: 'sm = LogSoftmax(dim=-1)\nsm(randn([2, 4]))',
  Flatten: 'flatten = Flatten()\nflatten(randn([2, 3, 4]))',
  Dropout: 'drop = Dropout(p=0.2)\ndrop(randn([2, 3]))',
  LayerNorm: 'norm = LayerNorm([4])\nnorm(randn([2, 4]))',
  BatchNorm1d: 'bn = BatchNorm1d(4)\nbn(randn([3, 4]))',
  Conv1d: 'conv = Conv1d(2, 4, 3)\nconv(randn([1, 2, 8]))',
  Conv2d: 'conv = Conv2d(1, 4, 3)\nconv(randn([1, 1, 8, 8]))',
  MaxPool2d: 'pool = MaxPool2d(2)\npool(randn([1, 1, 8, 8]))',
  AvgPool2d: 'pool = AvgPool2d(2)\npool(randn([1, 1, 8, 8]))',
  AdaptiveAvgPool2d: 'pool = AdaptiveAvgPool2d([2, 2])\npool(randn([1, 1, 8, 8]))',
  Embedding: 'emb = Embedding(10, 4)\nemb(tensor([1, 2, 3], { dtype: i32 }))',
  MSELoss: 'loss_fn = MSELoss()\nloss_fn(tensor([1.0, 2.0]), tensor([1.5, 2.5]))',
  CrossEntropyLoss: 'loss_fn = CrossEntropyLoss()\nlogits = randn([3, 4])\ntarget = tensor([0, 1, 2], { dtype: i32 })\nloss_fn(logits, target)',
  NLLLoss: 'loss_fn = NLLLoss()\nlog_probs = randn([3, 4]).log_softmax(axis=-1)\ntarget = tensor([0, 1, 2], { dtype: i32 })\nloss_fn(log_probs, target)',
  BCELoss: 'loss_fn = BCELoss()\nloss_fn(tensor([0.2, 0.8]), tensor([0, 1]))',

  Adam: 'net = Sequential(Linear(2, 4), ReLU(), Linear(4, 1))\nAdam(net.parameters(), lr=0.001)',
  AdamW: 'net = Sequential(Linear(2, 4), ReLU(), Linear(4, 1))\nAdamW(net.parameters(), lr=0.001)',
  SGD: 'net = Sequential(Linear(2, 4), ReLU(), Linear(4, 1))\nSGD(net.parameters(), lr=0.01)',
  StepLR: 'net = Linear(2, 1)\nopt = SGD(net.parameters(), lr=0.1)\nStepLR(opt, step_size=5)',
  CosineAnnealingLR: 'net = Linear(2, 1)\nopt = Adam(net.parameters())\nCosineAnnealingLR(opt, t_max=10)',
  ReduceLROnPlateau: 'net = Linear(2, 1)\nopt = Adam(net.parameters())\nReduceLROnPlateau(opt)',
  Accuracy: 'metric = Accuracy(task="multiclass", num_classes=3)\nmetric.update(tensor([0, 1, 2]), tensor([0, 2, 2]))\nmetric.compute()',
  Precision: 'metric = Precision(task="multiclass", num_classes=3)\nmetric.update(tensor([0, 1, 2]), tensor([0, 2, 2]))\nmetric.compute()',
  Recall: 'metric = Recall(task="multiclass", num_classes=3)\nmetric.update(tensor([0, 1, 2]), tensor([0, 2, 2]))\nmetric.compute()',
  F1Score: 'metric = F1Score(task="multiclass", num_classes=3)\nmetric.update(tensor([0, 1, 2]), tensor([0, 2, 2]))\nmetric.compute()',
  ConfusionMatrix: 'metric = ConfusionMatrix(3)\nmetric.update(tensor([0, 1, 2]), tensor([0, 2, 2]))\nmetric.compute()',
  MetricCollection: 'metrics = MetricCollection(Accuracy(task="multiclass", num_classes=3))\nmetrics',
  TensorDataset: 'x = randn([8, 2])\ny = randn([8, 1])\nTensorDataset(x, y)',
  DataLoader: 'x = randn([8, 2])\ny = randn([8, 1])\nDataLoader(TensorDataset(x, y), batch_size=4)',

  backtest: 'prices = DataFrame(tech=[100, 102, 101, 105, 108, 107, 110, 113, 111, 115], bank=[50, 49, 51, 50, 48, 49, 47, 48, 46, 45], energy=[30, 31, 33, 32, 34, 36, 35, 37, 39, 38])\nresult = backtest(prices, signal="momentum", portfolio="long_short", lookback=3)\nresult.metrics',
  walk_forward: 'prices = DataFrame(tech=[100, 102, 101, 105, 108, 107, 110, 113, 111, 115, 118, 116], bank=[50, 49, 51, 50, 48, 49, 47, 48, 46, 45, 46, 44])\nwalk_forward(prices, signal="momentum", portfolio="long_short", folds=2).metrics',
  momentum: 'prices = DataFrame(a=[100, 101, 103, 102, 104, 106, 105, 108], b=[50, 49, 48, 47, 46, 45, 46, 47])\nbacktest(prices, signal=momentum(lookback=2), portfolio="equal_weight").metrics',
  mean_reversion: 'prices = DataFrame(a=[100, 101, 103, 102, 104, 106, 105, 108], b=[50, 49, 48, 47, 46, 45, 46, 47])\nbacktest(prices, signal=mean_reversion(lookback=2), portfolio="cross_sectional").metrics',
  zscore: 'prices = DataFrame(a=[100, 101, 103, 102, 104, 106, 105, 108], b=[50, 49, 48, 47, 46, 45, 46, 47])\nbacktest(prices, signal=zscore(window=3), portfolio="long_short").metrics',
  equal_weight: 'prices = DataFrame(a=[100, 101, 103, 102, 104, 106], b=[50, 49, 48, 47, 46, 45], c=[20, 21, 22, 23, 24, 25])\nbacktest(prices, signal="momentum", portfolio=equal_weight(), lookback=2).metrics',
  cross_sectional: 'prices = DataFrame(a=[100, 101, 103, 102, 104, 106], b=[50, 49, 48, 47, 46, 45], c=[20, 21, 22, 23, 24, 25])\nbacktest(prices, signal="momentum", portfolio=cross_sectional(), lookback=2).metrics',
  long_short: 'prices = DataFrame(a=[100, 101, 103, 102, 104, 106], b=[50, 49, 48, 47, 46, 45], c=[20, 21, 22, 23, 24, 25])\nbacktest(prices, signal="momentum", portfolio=long_short(fraction=0.34), lookback=2).metrics',
  sharpe: 'returns = [0.012, -0.004, 0.008, 0.015, -0.006, 0.010, 0.003, -0.002]\nsharpe(returns)',
  deflated_sharpe: 'returns = [0.012, -0.004, 0.008, 0.015, -0.006, 0.010, 0.003, -0.002]\ntrial_sharpes = [0.5, 0.8, 1.2, 0.3, 0.9]\ndeflated_sharpe(returns, trial_sharpes)',
  pbo: 'trial_returns = [[0.01, 0.02, -0.01], [0.03, -0.01, 0.02], [-0.02, 0.04, 0.01], [0.02, 0.0, 0.03], [0.01, 0.02, -0.02], [0.0, 0.03, 0.01], [0.02, 0.01, 0.0], [0.01, -0.01, 0.02]]\npbo(trial_returns, partitions=4)',
  min_track_record_length: 'returns = [0.012, -0.004, 0.008, 0.015, -0.006, 0.010, 0.003, -0.002]\nmin_track_record_length(returns, target_sharpe=0.5)',
  risk_parity: 'cov = [[0.04, 0.01, 0.0], [0.01, 0.09, 0.02], [0.0, 0.02, 0.16]]\nrisk_parity(cov)',
  hrp: 'cov = [[0.04, 0.01, 0.0], [0.01, 0.09, 0.02], [0.0, 0.02, 0.16]]\nhrp(cov)',
  mean_variance: 'mu = [0.10, 0.06, 0.03]\ncov = [[0.04, 0.01, 0.0], [0.01, 0.09, 0.02], [0.0, 0.02, 0.16]]\nmean_variance(mu, cov)',
  quill: 'call = quill("product Call { underlying S model gbm param strike = 100 event T = 1.0 { pay max(S(T) - strike, 0) at T } }")\ncall.price(spot=100, rate=0.03, vol=0.2, paths=20000, seed=1, greeks="price-only")',
  load_quill: 'put = quill("product Put { underlying S model gbm param strike = 100 event T = 1.0 { pay max(strike - S(T), 0) at T } }")\nput.price(spot=100, rate=0.03, vol=0.2, paths=20000, seed=1, greeks="first-order")',
};

const KEYWORD_EXAMPLES: Record<string, string> = {
  fn: 'fn square(x: Tensor) -> Tensor:\n  return x * x\n\nsquare(tensor([1, 2, 3]))',
  if: 'x = 7\nif x > 5:\n  print("large")\nelse:\n  print("small")',
  for: 'total = 0\nfor i in range(1, 6):\n  total = total + i\n\ntotal',
  while: 'i = 0\nwhile i < 3:\n  print(i)\n  i = i + 1',
  model: 'model Tiny(input: int, output: int):\n  fc = Linear(input, output)\n\n  forward (x: Tensor) -> Tensor:\n    return fc(x)\n\nnet = Tiny(2, 1)\nnet(randn([4, 2]))',
  return: 'fn add_one(x: int) -> int:\n  return x + 1\n\nadd_one(2)',
  true: 'true',
  false: 'false',
  null: 'null',
};

let createCellFn: CreateCell | null = null;
let inputEl: HTMLInputElement | null = null;
let listEl: HTMLElement | null = null;
let docsSections: DocsSection[] = [];
let expanded = new Map<string, number>();
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let currentQuery = '';

export function initNotebookDocs({ createCell }: DocsInitOptions = {}): void {
  createCellFn = createCell || null;
  inputEl = document.getElementById('docs-search') as HTMLInputElement | null;
  listEl = document.getElementById('docs-list');
  render();
  if (inputEl) {
    const docsInput = inputEl;
    docsInput.addEventListener('input', () => {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        currentQuery = docsInput.value;
        render();
      }, 120);
    });
  }
}

export function updateNotebookDocs(languageData: LanguageDocsData): void {
  docsSections = buildDocsSections(languageData || {});
  expanded = new Map(docsSections.map((section, index) => {
    return [section.title, index < INITIAL_OPEN_SECTIONS ? INITIAL_ITEMS : 0];
  }));
  render();
}

export function setNotebookDocsError(message?: string): void {
  if (!listEl) return;
  listEl.innerHTML = '';
  listEl.append(emptyState(message || 'Tera docs unavailable.'));
}

function buildDocsSections(data: LanguageDocsData): DocsSection[] {
  const sections: DocsSection[] = [];

  for (const builtin of data.builtins || []) {
    if (isHiddenDocBuiltin(builtin)) continue;
    addDocsSection(sections, sectionForBuiltin(builtin), [docItem({
      name: builtin.name,
      display: builtin.signature?.display || builtin.name,
      tag: tagForBuiltin(builtin),
      desc: builtin.description,
      kind: builtin.kind || 'builtin',
      callable: hasCallableParams(builtin.signature),
      params: builtin.signature?.params || [],
      returns: builtin.returns,
      source: 'builtin',
    })]);
  }

  for (const [typeName, methods] of Object.entries(data.pseudoTypes || {})) {
    addDocsSection(sections, sectionForType(typeName), methods.map((method) => docItem({
        name: method.name,
        display: `${typeName}.${method.signature?.display || method.name}`,
        tag: `${typeName} ${method.isGetter ? 'property' : 'method'}`,
        desc: method.description,
        owner: typeName,
        callable: !method.isGetter,
        member: true,
        receiver: sampleReceiver(typeName),
        params: method.signature?.params || [],
        returns: method.returns,
        source: 'member',
      })).sort(byDocOrder));
  }

  const chartBuiltin = (data.builtins || []).find((builtin) => builtin.name === 'chart');
  const chartItems = (chartBuiltin?.methods || []).map((method) => docItem({
    name: `chart.${method.name}`,
    display: method.signature?.display || method.name,
    tag: 'chart',
    desc: method.description,
    callable: true,
    params: method.signature?.params || [],
    returns: method.returns,
    insert: chartExample(method.name),
    source: 'chart',
  }));
  if (chartItems.length) addDocsSection(sections, 'Charts', chartItems);

  for (const [group, names] of Object.entries(data.keywordGroups || {})) {
    if (!names.length) continue;
    addDocsSection(sections, 'Language basics', names.map((name) => docItem({
        name,
        display: name,
        tag: `${group} keyword`,
        desc: `${group} keyword`,
        source: 'keyword',
      })));
  }

  return sortSections(sections);
}

function addDocsSection(sections: DocsSection[], title: string, items: DocItem[]): void {
  const existing = sections.find((section) => section.title === title);
  if (existing) existing.items.push(...items);
  else sections.push({ title, items });
  const target = existing || sections[sections.length - 1];
  target.items.sort(byDocOrder);
}

function sortSections(sections: DocsSection[]): DocsSection[] {
  const order = new Map(SECTION_ORDER.map((title, index) => [title, index]));
  return sections.sort((a, b) => {
    const ai = order.get(a.title) ?? SECTION_ORDER.length;
    const bi = order.get(b.title) ?? SECTION_ORDER.length;
    return ai - bi || a.title.localeCompare(b.title);
  });
}

function sectionForBuiltin(builtin: BuiltinDoc): string {
  const name = builtin.name;
  const kind = builtin.kind || '';
  if (kind === 'factory' || kind === 'dtype' || TENSOR_BUILTINS.has(name)) return 'Tensors';
  if (kind === 'module' || kind === 'sequential') return 'Models & layers';
  if (DATAFRAME_BUILTINS.has(name)) return 'DataFrame';
  if (DATA_UTILITY_BUILTINS.has(name)) return 'Data utilities';
  if (kind === 'quant' || QUANT_BUILTINS.has(name)) return 'Quant';
  if (TRAINING_BUILTINS.has(name) || ['optimizer', 'scheduler', 'trainer', 'callback', 'logger', 'metric', 'step'].includes(kind)) return 'Training';
  if (TOKENIZER_FILE_BUILTINS.has(name)) return 'Tokenizer & files';
  if (RUNTIME_BUILTINS.has(name) || kind === 'device' || kind === 'utility') return 'Runtime';
  return 'Language basics';
}

function sectionForType(typeName: string): string {
  if (typeName === 'Tensor') return 'Tensors';
  if (typeName === 'Model') return 'Models & layers';
  if (typeName === 'DataFrame' || typeName === 'GroupedData' || typeName === 'Column') return 'DataFrame';
  return 'Language basics';
}

function tagForBuiltin(builtin: BuiltinDoc): string {
  const name = builtin.name;
  const kind = builtin.kind || 'builtin';
  if (kind === 'function' && DATAFRAME_BUILTINS.has(name)) return 'DataFrame helper';
  if (kind === 'data' && DATAFRAME_BUILTINS.has(name)) return 'DataFrame';
  if (kind === 'data') return 'data utility';
  if (kind === 'other' && TENSOR_BUILTINS.has(name)) return 'tensor op';
  if (kind === 'other' && TOKENIZER_FILE_BUILTINS.has(name)) return 'file/text';
  return kind;
}

function isHiddenDocBuiltin(builtin: BuiltinDoc): boolean {
  if (builtin.name !== 'name') return false;
  return !builtin.signature && /Description\./.test(builtin.description || '');
}

function docItem(item: DocItemInput): DocItem {
  const normalized: DocItem = {
    name: item.name,
    display: item.display || item.name,
    tag: item.tag || '',
    desc: item.desc || '',
    kind: item.kind || '',
    owner: item.owner || '',
    callable: !!item.callable,
    member: !!item.member,
    receiver: item.receiver || null,
    params: item.params || [],
    returns: item.returns || null,
    insert: item.insert || null,
    source: item.source || '',
    order: 0,
    example: '',
  };
  normalized.order = docOrder(normalized);
  normalized.example = exampleForDoc(normalized);
  return normalized;
}

function byDocOrder(a: DocItem, b: DocItem): number {
  return a.order - b.order || a.name.localeCompare(b.name);
}

function docOrder(item: DocItem): number {
  if (item.source === 'keyword') return 900;
  if (item.source === 'chart') return 100;
  if (item.source === 'member') return memberOrder(item);
  if (item.kind === 'factory') return 10;
  if (item.kind === 'dtype') return 20;
  if (TENSOR_BUILTINS.has(item.name)) return 30;
  if (item.name === 'DataFrame') return 10;
  if (DATAFRAME_BUILTINS.has(item.name) && item.name !== 'load_csv') return 20;
  if (item.name === 'load_csv') return 80;
  if (QUANT_BUILTINS.has(item.name)) return QUANT_ORDER.indexOf(item.name);
  if (item.kind === 'sequential') return 10;
  if (item.kind === 'module') return 20;
  if (item.kind === 'trainer') return 10;
  if (item.kind === 'optimizer') return 20;
  if (item.kind === 'scheduler') return 30;
  if (item.kind === 'metric') return 40;
  if (item.kind === 'callback') return 50;
  if (item.kind === 'logger') return 60;
  if (item.kind === 'step') return 70;
  if (item.kind === 'device') return 20;
  if (item.kind === 'utility') return 30;
  return 100;
}

function memberOrder(item: DocItem): number {
  if (item.owner === 'Tensor') return 100;
  if (item.owner === 'Model') return 100;
  if (item.owner === 'DataFrame') return 100;
  if (item.owner === 'GroupedData') return 200;
  if (item.owner === 'Column') return 300;
  if (item.owner === 'List') return 100;
  if (item.owner === 'String') return 200;
  if (item.owner === 'Dict') return 300;
  return 500;
}

function hasCallableParams(signature?: SignatureInfo): boolean {
  return !!(signature && Array.isArray(signature.params));
}

function render(): void {
  if (!listEl) return;
  const query = currentQuery.trim().toLowerCase();
  listEl.innerHTML = '';

  if (!docsSections.length) {
    listEl.append(emptyState('Loading Tera docs...'));
    return;
  }

  if (query) renderSearch(query);
  else renderSections();
}

function renderSections(): void {
  if (!listEl) return;
  for (const section of docsSections) {
    const visibleLimit = expanded.get(section.title) ?? INITIAL_ITEMS;
    listEl.append(sectionNode(section, section.items.slice(0, visibleLimit), {
      remaining: Math.max(0, section.items.length - visibleLimit),
    }));
  }
}

function renderSearch(query: string): void {
  if (!listEl) return;
  const matches: SearchMatch[] = [];
  for (const section of docsSections) {
    for (const item of section.items) {
      if (haystack(item, section.title).includes(query)) matches.push({ section: section.title, item });
      if (matches.length >= SEARCH_LIMIT) break;
    }
    if (matches.length >= SEARCH_LIMIT) break;
  }

  if (!matches.length) {
    listEl.append(emptyState('No matching Tera docs.'));
    return;
  }

  const grouped = new Map<string, DocItem[]>();
  for (const match of matches) {
    const group = grouped.get(match.section) ?? [];
    group.push(match.item);
    grouped.set(match.section, group);
  }

  for (const [title, items] of grouped) {
    listEl.append(sectionNode({ title, items }, items, { search: true }));
  }
}

function sectionNode(section: DocsSection, items: DocItem[], opts: SectionNodeOptions = {}): HTMLElement {
  const sectionEl = document.createElement('section');
  sectionEl.className = 'docs-section';

  const title = document.createElement('h3');
  title.className = 'docs-section-title';
  title.textContent = section.title;
  sectionEl.append(title);

  const itemsEl = document.createElement('div');
  itemsEl.className = 'docs-items';
  for (const item of items) itemsEl.append(cardNode(item));
  sectionEl.append(itemsEl);

  if (opts.remaining && !opts.search) {
    const current = expanded.get(section.title) ?? INITIAL_ITEMS;
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'docs-more';
    more.textContent = current > 0 ? `Show ${Math.min(MORE_ITEMS, opts.remaining)} more` : `Open ${section.title}`;
    more.addEventListener('click', () => {
      expanded.set(section.title, current + MORE_ITEMS);
      render();
    });
    sectionEl.append(more);
  }

  return sectionEl;
}

function cardNode(item: DocItem): HTMLElement {
  const card = document.createElement('article');
  card.className = 'docs-item';

  const head = document.createElement('div');
  head.className = 'docs-item-title';
  const name = document.createElement('span');
  name.className = 'docs-item-name';
  name.textContent = item.name;
  const tag = document.createElement('span');
  tag.className = 'docs-item-tag';
  tag.textContent = item.tag;
  head.append(name, tag);

  const desc = document.createElement('p');
  desc.className = 'docs-item-desc';
  appendInlineCode(desc, item.desc || 'No description available.');

  const signature = document.createElement('code');
  signature.className = 'docs-signature';
  signature.textContent = cleanDisplay(item.display);

  const example = document.createElement('button');
  example.type = 'button';
  example.className = 'docs-snippet';
  example.title = 'Insert example as a new cell';
  example.textContent = item.example;
  example.addEventListener('click', () => {
    if (createCellFn) createCellFn(item.example, { focus: true });
  });

  card.append(head, desc, signature, example);
  return card;
}

function emptyState(text: string): HTMLElement {
  const empty = document.createElement('div');
  empty.className = 'docs-empty';
  empty.textContent = text;
  return empty;
}

function haystack(item: DocItem, sectionTitle: string): string {
  return [sectionTitle, item.name, item.display, item.tag, item.desc, item.example]
    .join(' ')
    .toLowerCase();
}

function cleanDisplay(display: string): string {
  return String(display || '').replace(/\s*->\s*.+$/, '');
}

function exampleForDoc(item: DocItem): string {
  if (EXAMPLES[item.name]) return EXAMPLES[item.name];
  if (item.insert) return item.insert;
  if (item.source === 'keyword') return KEYWORD_EXAMPLES[item.name] || item.name;
  if (item.member) {
    return memberExample(item);
  }
  if (item.tag === 'device' || item.tag === 'dtype') return item.name;
  if (item.callable) return `${item.name}(${sampleArgs(item.params).join(', ')})`;
  return item.name;
}

function chartExample(name: string): string {
  if (name === 'line') {
    return 'data = DataFrame(epoch=[1, 2, 3, 4, 5, 6, 7, 8], loss=[1.0, 0.72, 0.55, 0.43, 0.34, 0.29, 0.25, 0.22])\nchart.line(data, x="epoch", y="loss", title="Training loss", animate=true, easing="cubic", loop=true, speed=2)';
  }
  if (name === 'bar') {
    return 'data = DataFrame(region=["APAC", "EU", "US"], revenue=[120, 80, 95])\nchart.bar(data, x="region", y="revenue", title="Revenue")';
  }
  if (name === 'scatter') {
    return 'data = DataFrame(year=[2000, 2000, 2010, 2010, 2020, 2020], gdp=[5, 9, 12, 15, 20, 24], life=[60, 72, 66, 76, 71, 80], country=["A", "B", "A", "B", "A", "B"])\nchart.scatter(data, x="gdp", y="life", color="country", frame="year", key="country", title="GDP vs life expectancy", easing="ease-in-out", loop=true)';
  }
  if (name === 'hexbin') {
    return 'data = DataFrame(x=[1, 2, 3, 4, 5], y=[1.2, 1.8, 3.1, 3.8, 5.2])\nchart.hexbin(data, x="x", y="y", title="Points")';
  }
  if (name === 'histogram' || name === 'density' || name === 'box' || name === 'violin') {
    return `data = DataFrame(score=[2, 3, 3, 4, 4, 4, 5, 5, 6, 6, 7, 8])\nchart.${name}(data, x="score", title="Scores")`;
  }
  if (name === 'area') {
    return 'data = DataFrame(day=[1, 2, 3, 4], visits=[10, 18, 15, 24])\nchart.area(data, x="day", y="visits", title="Visits")';
  }
  if (name === 'correlation') {
    return 'data = DataFrame(a=[1, 2, 3, 4], b=[2, 4, 6, 8], c=[4, 3, 2, 1])\nchart.correlation(data, columns=["a", "b", "c"], title="Correlation")';
  }
  if (name === 'heatmap') {
    return 'data = DataFrame(day=["Mon", "Mon", "Tue", "Tue"], segment=["A", "B", "A", "B"], value=[12, 18, 9, 24])\nchart.heatmap(data, x="day", y="segment", value="value", title="Heatmap")';
  }
  if (name === 'regression') {
    return 'data = DataFrame(x=[1, 2, 3, 4, 5], y=[1.2, 2.1, 2.8, 4.2, 5.1])\nchart.regression(data, x="x", y="y", title="Linear fit")';
  }
  if (name === 'ecdf') {
    return 'data = DataFrame(score=[2, 3, 3, 4, 4, 5, 6, 8])\nchart.ecdf(data, x="score", title="ECDF")';
  }
  if (name === 'bubble') {
    return 'data = DataFrame(cpc=[0.4, 0.8, 1.2, 1.6], roas=[4.8, 3.5, 2.6, 1.9], spend=[1200, 3000, 5200, 7800], channel=["A", "B", "C", "D"])\nchart.bubble(data, x="cpc", y="roas", size="spend", color="channel", title="Spend vs ROAS")';
  }
  if (name === 'funnel') {
    return 'data = DataFrame(step=["Impressions", "Clicks", "Leads", "Sales"], value=[120000, 8200, 940, 180])\nchart.funnel(data, step="step", value="value", title="Acquisition funnel")';
  }
  if (name === 'waterfall') {
    return 'data = DataFrame(step=["Base", "Search", "Social", "Email", "Returns"], value=[50000, 18000, 12000, 7000, -4000])\nchart.waterfall(data, step="step", value="value", title="Revenue contribution")';
  }
  if (name === 'figure') {
    return 'data = DataFrame(month=["Jan", "Feb", "Mar"], revenue=[120, 150, 170], growth=[8, 12, 9])\nchart.figure(data, title="Revenue & growth").encode(x="month").bar(y="revenue").line(y="growth", axis="right")';
  }
  return `data = DataFrame(x=[1, 2, 3], y=[1, 4, 9])\nchart.${name}(data)`;
}

function memberExample(item: DocItem): string {
  if (item.name === 'shape') return 'x = randn([2, 3])\nx.shape';
  if (item.name === 'dtype') return 'x = randn([2, 3])\nx.dtype';
  if (item.name === 'grad') return 'x = tensor([1, 2, 3], { grad: true })\ny = x.sum()\ny.backward()\nx.grad';
  if (item.name === 'length') return 'items = [1, 2, 3]\nitems.length';

  if (item.receiver === 'x') {
    return tensorMemberExample(item);
  }
  if (item.receiver === 'df') {
    return dataframeMemberExample(item);
  }
  if (item.receiver === 'model') {
    return `model = Sequential(Linear(2, 4), ReLU(), Linear(4, 1))\nmodel.${item.name}(${sampleArgs(item.params).join(', ')})`;
  }
  if (item.receiver === 'col("value")') {
    return columnMemberExample(item);
  }
  if (item.receiver === 'items') {
    return listMemberExample(item);
  }
  if (item.receiver === '"text"') {
    return stringMemberExample(item);
  }
  if (item.receiver === 'record') {
    return dictMemberExample(item);
  }

  if (!item.callable) return `${item.receiver}.${item.name}`;
  return `${item.receiver}.${item.name}(${sampleArgs(item.params).join(', ')})`;
}

function tensorMemberExample(item: DocItem): string {
  const name = item.name;
  if (name === 'reshape') return 'x = randn([2, 3])\nx.reshape([3, 2])';
  if (name === 'transpose') return 'x = randn([2, 3])\nx.transpose(0, 1)';
  if (name === 'permute') return 'x = randn([2, 3, 4])\nx.permute([1, 0, 2])';
  if (name === 'expand') return 'x = randn([1, 3])\nx.expand([2, 3])';
  if (name === 'slice') return 'x = randn([4, 3])\nx.slice(0, 1, 3)';
  if (name === 'unsqueeze') return 'x = randn([2, 3])\nx.unsqueeze(0)';
  if (name === 'squeeze') return 'x = randn([1, 2, 3])\nx.squeeze(0)';
  if (name === 'narrow') return 'x = randn([4, 3])\nx.narrow(0, 1, 2)';
  if (name === 'select') return 'x = randn([4, 3])\nx.select(0, 1)';
  if (name === 'backward') return 'x = tensor([1, 2, 3], { grad: true })\ny = (x * x).sum()\ny.backward()\nx.grad';
  if (name === 'requires_grad') return 'x = randn([2, 3])\nx.requires_grad(true)';
  if (['add', 'sub', 'mul', 'div', 'remainder', 'maximum', 'minimum', 'eq', 'ne', 'lt', 'le', 'gt', 'ge', 'matmul', 'dot'].includes(name)) {
    if (name === 'matmul') return 'x = randn([2, 3])\ny = randn([3, 2])\nx.matmul(y)';
    if (name === 'dot') return 'x = randn([3])\ny = randn([3])\nx.dot(y)';
    return `x = tensor([1, 2, 3])\ny = tensor([3, 2, 1])\nx.${name}(y)`;
  }
  if (name === 'pow') return 'x = tensor([1, 2, 3])\nx.pow(2)';
  if (['sum', 'mean', 'max', 'min', 'argmax', 'argmin', 'prod'].includes(name)) return `x = randn([2, 3])\nx.${name}(axis=1)`;
  if (name === 'softmax' || name === 'log_softmax') return `x = randn([2, 3])\nx.${name}(axis=-1)`;
  return `x = randn([2, 3])\nx.${name}()`;
}

function dataframeMemberExample(item: DocItem): string {
  const base = 'df = DataFrame(name=["A", "B", "C"], value=[10, 20, 30], group=["x", "x", "y"])';
  const name = item.name;
  const map: Record<string, string> = {
    columns: `${base}\ndf.columns()`,
    schema: `${base}\ndf.schema()`,
    explain: `${base}\ndf.filter(col("value").gt(10)).explain()`,
    select: `${base}\ndf.select("name", "value").show()`,
    filter: `${base}\ndf.filter(col("value").gt(10)).show()`,
    where: `${base}\ndf.where(col("value").gt(10)).show()`,
    withColumn: `${base}\ndf.withColumn("double", col("value").mul(2)).show()`,
    drop: `${base}\ndf.drop("group").show()`,
    groupBy: `${base}\ndf.groupBy("group").agg(sum(col("value")).alias("total")).show()`,
    orderBy: `${base}\ndf.orderBy("value").show()`,
    sort: `${base}\ndf.sort("value").show()`,
    limit: `${base}\ndf.limit(2).show()`,
    head: `${base}\ndf.head(2).show()`,
    distinct: 'df = DataFrame(value=[1, 1, 2])\ndf.distinct().show()',
    union: 'a = DataFrame(value=[1, 2])\nb = DataFrame(value=[3, 4])\na.union(b).show()',
    unionAll: 'a = DataFrame(value=[1, 2])\nb = DataFrame(value=[2, 3])\na.unionAll(b).show()',
    join: 'left = DataFrame(id=[1, 2], a=["x", "y"])\nright = DataFrame(id=[1, 2], b=[10, 20])\nleft.join(right, on="id").show()',
    collect: `${base}\ndf.collect()`,
    toArray: `${base}\ndf.toArray()`,
    count: `${base}\ndf.count()`,
    show: `${base}\ndf.show()`,
    to_tensor: `${base}\ndf.to_tensor("value")`,
    to_array: `${base}\ndf.to_array()`,
    encode: `${base}\ndf.encode("name")`,
  };
  return map[name] || `${base}\ndf.${name}()`;
}

function columnMemberExample(item: DocItem): string {
  const base = 'df = DataFrame(value=[1, 2, 3])';
  const name = item.name;
  if (name === 'alias' || name === 'as') return `${base}\ndf.select(col("value").${name}("renamed")).show()`;
  if (['add', 'sub', 'mul', 'div', 'eq', 'ne', 'lt', 'le', 'gt', 'ge'].includes(name)) return `${base}\ndf.filter(col("value").${name}(2)).show()`;
  if (name === 'and' || name === 'or') return `${base}\ndf.filter(col("value").gt(1).${name}(col("value").lt(3))).show()`;
  if (name === 'not') return `${base}\ndf.filter(col("value").gt(2).not()).show()`;
  if (name === 'isNull' || name === 'isNotNull') return 'df = DataFrame(value=[1, null, 3])\ndf.filter(col("value").' + name + '()).show()';
  if (name === 'like') return 'df = DataFrame(name=["ann", "bob", "amy"])\ndf.filter(col("name").like("a%")).show()';
  if (name === 'between') return `${base}\ndf.filter(col("value").between(1, 2)).show()`;
  if (name === 'isin') return `${base}\ndf.filter(col("value").isin(1, 3)).show()`;
  if (name === 'cast') return `${base}\ndf.select(col("value").cast("float")).show()`;
  return `${base}\ndf.select(col("value").${name}()).show()`;
}

function listMemberExample(item: DocItem): string {
  const name = item.name;
  const mutating: Record<string, string> = {
    append: 'items = [1, 2]\nitems.append(3)\nitems',
    extend: 'items = [1]\nitems.extend([2, 3])\nitems',
    insert: 'items = [1, 3]\nitems.insert(1, 2)\nitems',
    remove: 'items = [1, 2, 2]\nitems.remove(2)\nitems',
    reverse: 'items = [1, 2, 3]\nitems.reverse()\nitems',
    clear: 'items = [1, 2, 3]\nitems.clear()\nitems',
  };
  if (mutating[name]) return mutating[name];
  if (name === 'pop') return 'items = [1, 2, 3]\nitems.pop()';
  if (name === 'index') return 'items = [1, 2, 3]\nitems.index(2)';
  if (name === 'count') return 'items = [1, 2, 2]\nitems.count(2)';
  if (name === 'contains') return 'items = [1, 2, 3]\nitems.contains(2)';
  if (name === 'copy') return 'items = [1, 2, 3]\nitems.copy()';
  return `items = [1, 2, 3]\nitems.${name}()`;
}

function stringMemberExample(item: DocItem): string {
  const name = item.name;
  const map: Record<string, string> = {
    upper: '"hello".upper()',
    lower: '"HELLO".lower()',
    strip: '"  hello  ".strip()',
    lstrip: '"  hello".lstrip()',
    rstrip: '"hello  ".rstrip()',
    split: '"a,b,c".split(",")',
    join: '", ".join(["a", "b", "c"])',
    replace: '"hello".replace("l", "x")',
    starts_with: '"hello".starts_with("he")',
    ends_with: '"hello".ends_with("lo")',
    find: '"hello".find("ll")',
    contains: '"hello".contains("ell")',
  };
  return map[name] || `"text".${name}()`;
}

function dictMemberExample(item: DocItem): string {
  const name = item.name;
  const map: Record<string, string> = {
    keys: 'record = {"name": "Ada", "score": 10}\nrecord.keys()',
    values: 'record = {"name": "Ada", "score": 10}\nrecord.values()',
    items: 'record = {"name": "Ada", "score": 10}\nrecord.items()',
    get: 'record = {"name": "Ada", "score": 10}\nrecord.get("score")',
    has: 'record = {"name": "Ada", "score": 10}\nrecord.has("score")',
    remove: 'record = {"name": "Ada", "score": 10}\nrecord.remove("score")\nrecord',
  };
  return map[name] || `record = {"name": "Ada", "score": 10}\nrecord.${name}()`;
}

function sampleReceiver(typeName: string): string {
  const map: Record<string, string> = {
    Tensor: 'x',
    Model: 'model',
    DataFrame: 'df',
    GroupedData: 'grouped',
    Column: 'col("value")',
    List: 'items',
    String: '"text"',
    Dict: 'record',
  };
  return map[typeName] || typeName.toLowerCase();
}

function sampleArgs(params: SignatureParam[]): string[] {
  const required = params.filter((param) => {
    return !param.optional && !param.rest && param.name !== 'self' && /^[A-Za-z_]\w*$/.test(param.name || '');
  });
  return required.map(sampleArg).filter(Boolean);
}

function sampleArg(param: SignatureParam): string {
  const name = param.name || '';
  const type = param.type || '';
  if (param.rest) return '';
  if (name === 'columns') return 'value=[1, 2, 3]';
  if (name === 'params') return 'model.parameters()';
  if (name === 'data') return '[1, 2, 3]';
  if (name === 'shape' || type === 'int[]') return '[2, 3]';
  if (name === 'path') return '"data.csv"';
  if (name === 'column' || name === 'condition') return 'col("value")';
  if (name === 'tensors' || type === 'Tensor[]') return '[x, y]';
  if (name === 'dataset') return 'dataset';
  if (name === 'loader') return 'loader';
  if (name === 'model') return 'model';
  if (name === 'optimizer') return 'optimizer';
  if (name === 'text' || name === 'sql' || type === 'string') return '"text"';
  if (name === 'input') return '4';
  if (name === 'hidden') return '8';
  if (name === 'output') return '2';
  if (name === 'in') return '4';
  if (name === 'out') return '2';
  if (name === 'n' || name === 'num' || type === 'int') return '3';
  if (type === 'float') return '1.0';
  if (type === 'boolean') return 'true';
  if (type === 'Tensor') return 'x';
  return name || '';
}
