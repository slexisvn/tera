# Tera Built-in Reference

Prose source of truth for the language server: `scripts/generate.ts` merges this file
with the runtime metadata in `src/runtime/domain` to produce `language-data.json`.

The runtime owns which built-ins exist, their `kind`, and their return type. This file
owns descriptions, parameter lists, and methods. `npm run generate` fails if the two
disagree, so every built-in below must exist in the runtime, and every runtime built-in
must appear here. The one exception is the `chart` namespace, whose methods are
documented in `notebook/src/chart/docs.ts` and pulled in by the generator.

Each entry is a signature followed by a description:

```
## name(param1, param2=default, opt?, ...rest)
Description.
```

Constants (devices/dtypes) omit the parameter list:

```
## name
Description.
```

Methods hang off their built-in with `###`, and may declare a return type. A `###`
heading with no parameter list is a property rather than a method:

```
## Trainer(max_epochs: int = 20)
Description.

### fit(model, data) -> Object
Description.
```

`{kind}` overrides the kind the runtime reports and is only required for entries the
runtime does not define — `{global}` for interpreter globals, `{step}` for names that
only resolve inside a model step. Where both are present they must agree.

`## @kind/<kind>` blocks define methods injected into every built-in of that kind; an
entry's own `###` methods win. `## $Type` blocks document the methods of a value type
(`Tensor`, `DataFrame`, …) that is never constructed by name.

---

## tensor(data, opts?)
Construct a tensor from a literal value, array, or nested array. Accepts `dtype`, `device`, `grad` options.

## zeros(shape: int[], opts?: Record)
Create a tensor of the given shape filled with `0`.

## ones(shape: int[], opts?: Record)
Create a tensor of the given shape filled with `1`.

## empty(shape: int[], opts?: Record)
Allocate a tensor of the given shape without initializing its contents.

## full(shape: int[], value: float, opts?: Record)
Create a tensor of the given shape filled with the provided scalar `value`.

## randn(shape: int[], opts?: Record)
Sample a tensor of the given shape from the standard normal distribution.

## arange(start: int, end?: int, step?: int, opts?: Record)
Half-open integer range tensor `[start, end)` with optional `step`.

## eye(n: int, m?: int, opts?: Record)
Identity matrix of size `n × m` (or `n × n` if `m` omitted).

## linspace(start: float, end: float, steps: int, opts?: Record)
Evenly spaced values between `start` and `end`, inclusive, with `steps` points.

## randperm(n: int, opts?: Record)
Random permutation of integers `0..n-1`.

## zerosLike(tensor)
Zero tensor with the same shape, dtype, and device as the input.

## onesLike(tensor)
Tensor of ones with the same shape, dtype, and device as the input.

## emptyLike(tensor)
Uninitialized tensor with the same shape, dtype, and device as the input.

## fullLike(tensor: Tensor, value: float)
Constant-filled tensor matching the shape, dtype, and device of the input.

## randnLike(tensor)
Standard-normal sample with the same shape, dtype, and device as the input.

## where(condition: Tensor, a: Tensor, b: Tensor)
Element-wise conditional selection: pick from `a` where `condition` is true, else from `b`.

## cat(tensors: Tensor[], axis: int = 0)
Concatenate tensors along an existing dimension.

## stack(tensors: Tensor[], axis: int = 0)
Stack tensors along a new dimension.

## sum(column) {function}
Aggregate `Column` computing the sum of a column within a `groupBy(...).agg(...)`.

## max(column) {function}
Aggregate `Column` computing the maximum of a column within a `groupBy(...).agg(...)`.

## min(column) {function}
Aggregate `Column` computing the minimum of a column within a `groupBy(...).agg(...)`.

## range(start: int, stop?: int, step?: int)
Integer range: returns an array `[start..stop)` with optional `step`.

## print(...values) {global}
Print one or more values to the runtime output, separated by a space.

## compile(model, input?, target=cpu, fusion?, scheduling?, debug?)
Compile a model or function to a backend (`cpu`/`gpu`/`wasm`/`webgpu`). `input` provides an example for shape inference and tuning.

## Sequential(...modules)
Compose modules into a feed-forward pipeline. The output of each module is fed to the next.

## Linear(in: int, out: int, bias: boolean = true)
Fully-connected layer `y = x @ Wᵀ + b`. Set `bias=false` to disable the bias term.

## ReLU()
Rectified Linear Unit activation module: `max(0, x)`.

## GELU()
Gaussian Error Linear Unit activation module — commonly used in Transformers.

## SiLU()
SiLU/Swish activation module: `x * sigmoid(x)`.

## Sigmoid()
Logistic sigmoid activation module.

## Tanh()
Hyperbolic tangent activation module.

## LeakyReLU(negative_slope: float = 0.01)
Leaky ReLU activation; negative inputs are scaled by `negative_slope` instead of zeroed.

## ELU(alpha: float = 1.0)
Exponential Linear Unit activation. Smooth alternative to ReLU for negative values.

## Softmax(dim: int = -1)
Softmax module over the specified dimension.

## LogSoftmax(dim: int = -1)
LogSoftmax module — numerically stable log of softmax.

## Flatten(start_dim: int = 1, end_dim: int = -1)
Flatten a contiguous range of dimensions into one. Typical use: between conv blocks and a Linear head.

## Dropout(p: float = 0.5)
Randomly zero elements with probability `p` during training. Inactive at eval time.

## LayerNorm(shape: int[], eps: float = 1e-5)
Layer normalization over the given trailing shape. Stabilizes activations independent of batch.

## BatchNorm1d(features: int, eps: float = 1e-5, momentum: float = 0.1)
Batch normalization for 2-D `(N, C)` or 3-D `(N, C, L)` inputs.

## BatchNorm2d(features: int, eps: float = 1e-5, momentum: float = 0.1)
Batch normalization for 4-D `(N, C, H, W)` image-like inputs.

## Conv1d(in: int, out: int, kernel: int, stride: int = 1, padding: int = 0)
1-D convolution over an input with `in` channels, producing `out` channels.

## Conv2d(in: int, out: int, kernel: int, stride: int = 1, padding: int = 0)
2-D convolution. Use `padding` to preserve spatial dimensions.

## MaxPool2d(kernel: int, stride?: int, padding: int = 0)
2-D max pooling. Downsamples spatial dimensions taking the per-window max.

## AvgPool2d(kernel: int, stride?: int, padding: int = 0)
2-D average pooling. Downsamples spatial dimensions averaging per window.

## AdaptiveAvgPool2d(output_size: int[])
2-D adaptive average pooling to a target output spatial shape, independent of input size.

## Embedding(num: int, dim: int, padding_idx?: int)
Lookup table mapping integer ids to dense vectors of size `dim`.

## GRU(input: int, hidden: int, num_layers: int = 1, batch_first: boolean = false, bias: boolean = true)
Multi-layer Gated Recurrent Unit. Call `out, h_n = gru(x, h0?)` — returns the output sequence and the final hidden state. Set `batch_first=true` for `(N, T, input)` inputs.

## GRUCell(input: int, hidden: int, bias: boolean = true)
Single GRU time-step. `h_next = cell(x, h)` — apply manually to step a sequence one element at a time.

## LSTM(input: int, hidden: int, num_layers: int = 1, batch_first: boolean = false, bias: boolean = true)
Multi-layer Long Short-Term Memory. Call `out, state = lstm(x, [h0, c0]?)` — returns the output sequence and `state = [h_n, c_n]` (final hidden and cell states). Set `batch_first=true` for `(N, T, input)` inputs.

## LSTMCell(input: int, hidden: int, bias: boolean = true)
Single LSTM time-step. `h_next, c_next = cell(x, [h, c])` — carries both hidden and cell state for O(T) autoregressive stepping.

## CrossEntropyLoss(reduction: string = "mean", ignore_index?: int)
Combined LogSoftmax + NLL loss — standard for multiclass classification. Pass `ignore_index` (e.g. a padding id) to exclude those target positions from the loss — useful for seq2seq with padded sequences.

## MSELoss()
Mean squared error loss — standard for regression.

## NLLLoss()
Negative log-likelihood loss. Pair with LogSoftmax outputs.

## BCELoss()
Binary cross-entropy loss for sigmoid-activated outputs.

## SGD(params: Tensor[], lr: float = 0.01, momentum: float = 0, weight_decay: float = 0)
Stochastic gradient descent with optional `momentum` and `weight_decay`.

## Adam(params: Tensor[], lr: float = 0.001, betas: float[] = [0.9, 0.999], weight_decay: float = 0)
Adaptive moment estimation optimizer. Standard default for deep learning.

## AdamW(params: Tensor[], lr: float = 0.001, betas: float[] = [0.9, 0.999], weight_decay: float = 0.01)
Adam variant with decoupled weight decay — preferred for transformer-style models.

## StepLR(optimizer: Optimizer, step_size: int, gamma: float = 0.1)
Decay the learning rate by `gamma` every `step_size` epochs.

## CosineAnnealingLR(optimizer: Optimizer, t_max: int, eta_min: float = 0)
Cosine schedule decaying the learning rate to `eta_min` over `t_max` epochs.

## ReduceLROnPlateau(optimizer: Optimizer, mode: string = "min", patience: int = 10, factor: float = 0.1)
Reduce learning rate when a monitored metric stops improving.

## Trainer(max_epochs: int = 20, accelerator: string = "cpu", logger: boolean = true, enable_checkpointing: boolean = false, enable_progress: boolean = true, callbacks?: Callback[], fast_dev_run: boolean = false, gradient_clip_val?: float, log_every_n_steps: int = 50)
Drives the training loop: epochs, validation, callbacks, logging, checkpointing.

### fit(model: Module, train_loader: DataLoader, val_loader?: DataLoader)
Run the training loop. Iterates `max_epochs` over `train_loader`, optionally validating on `val_loader` each epoch.

### validate(model: Module, loader: DataLoader)
Run validation only (no gradient updates). Returns logged metrics.

### test(model: Module, loader: DataLoader)
Run the model in eval mode over `loader`. Returns logged metrics.

### predict(model: Module, loader: DataLoader)
Run the model in eval mode and collect outputs into an array.

## log(name: string, value: Tensor, on_step?: boolean, on_epoch?: boolean, prog_bar: boolean = false, reduce_fx: string = "mean") {step}
Log a metric value. Only callable inside a `train`/`validate` block — calling it elsewhere is an error. Calls `.compute()` automatically on Metric instances.

## optim_config(optimizer: Optimizer, lr_scheduler?: Scheduler)
Wrap an optimizer (and optionally an LR scheduler) for return from an `optimizer:` block.

## TensorDataset(...tensors: Tensor)
In-memory dataset zipping one or more tensors along their first dimension.

## DataLoader(dataset: Dataset, batch_size: int = 32, shuffle: boolean = true, drop_last: boolean = false)
Iterate over a dataset in mini-batches with optional shuffling and `drop_last`.

### length
Number of batches per epoch.

## load_csv(path: string, separator: string = ",")
Load a CSV file into a `DataFrame`. Numeric fields are parsed as numbers; use
the `DataFrame` API (`select`, `filter`, `groupBy`, `to_tensor`, `encode`, …)
to analyse it.

## read_text(path: string)
Read a text file and return its contents as a string.

## load_json(path: string)
Read a JSON file and return it as nested dicts/lists.

## load_model(model: Module, path: string)
Load weights from a checkpoint `path` into an existing `model` (in place) and return it. Save the model first with `model.save(path)`, rebuild it with the same architecture, then `load_model(model, path)`.

## load_tokenizer(path: string)
Load a tokenizer artifact saved with `tok.save(path)`. Returns a `Tokenizer`.

## Tokenizer(mode: string = "word", vocab_size?: int, lowercase: boolean = false, num_merges: int = 1000, special_tokens?: string[])
Build a text tokenizer. `mode` is `"word"`, `"char"`, or `"bpe"` (trainable subword). `fit(texts)` on a corpus first, then `encode`/`decode`/`encodeBatch`. Reserves special tokens (`<pad> <unk> <bos> <eos>`) at low ids exposed as `padId`/`unkId`/`bosId`/`eosId`.

### fit(texts: string[]) -> Tokenizer
Learn the vocabulary (and BPE merges) from a list of strings. Returns the tokenizer.

### save(path: string) -> none
Save the fitted tokenizer as a compact artifact. Reload it with the global `load_tokenizer(path)`.

### encode(text: string, add_bos?: boolean, add_eos?: boolean) -> int[]
Tokenize `text` to a list of integer ids. Optionally wrap with begin/end-of-sequence tokens.

### decode(ids: int[], skip_special?: boolean) -> string
Turn a list of ids back into a string (special tokens skipped by default).

### encodeBatch(texts: string[], max_len?: int, pad_id?: int, add_bos?: boolean, add_eos?: boolean) -> Tensor
Encode a list of strings into a padded `[N, maxLen]` i32 tensor, ready for a model.

### vocabSize -> int
Number of tokens in the learned vocabulary (property).

### padId -> int
Reserved id of the `<pad>` token.

### unkId -> int
Reserved id of the `<unk>` (unknown) token.

### bosId -> int
Reserved id of the `<bos>` (begin-of-sequence) token.

### eosId -> int
Reserved id of the `<eos>` (end-of-sequence) token.

## DataFrame(columns) {data}
Build a lazy `DataFrame` from named column arrays, one named argument per
column: `DataFrame(name=["a", "b"], age=[30, 40])`. Column types are inferred
from the values. The frame records a query plan and is only executed when
materialized with `collect`, `toArray`, `count`, `show`, or `chunks`.

## col(column) {function}
Reference a column by name in a `DataFrame` expression, returning a `Column`
that can be transformed and compared. Use a dotted name (`"t.id"`) to qualify a
table alias.

## lit(value) {function}
Wrap a constant value as a `Column` literal so it can be combined with other
columns in expressions.

## expr(sql) {function}
Parse a scalar SQL string into a `Column`, e.g. `expr("price * 1.1")`. Bound
against the frame's schema at build time.

## avg(column) {function}
Aggregate `Column` computing the mean of a column within a `groupBy(...).agg(...)`.

## count(column) {function}
Aggregate `Column` counting non-null values of a column within `agg(...)`.

## countStar() {function}
Aggregate `Column` counting all rows (`COUNT(*)`) within `agg(...)`.

## register_columns_table(columns)
Register named column arrays as a SQL-addressable table and return its generated
table name, one named argument per column: `register_columns_table(name=["a"], age=[30])`.
Use the returned name inside `expr("... FROM <name>")`.

## backtest(prices: DataFrame, signal: string = "momentum", portfolio: string = "long_short", lookback?: int, fraction?: float, cost?: float) {quant}
Run a vectorized cross-sectional backtest over a price `DataFrame` shaped time × asset (numeric columns are the assets; a date/index column is dropped automatically). `signal` selects a trading signal (`"momentum"`, `"mean_reversion"`, `"zscore"`) and `portfolio` a position rule (`"equal_weight"`, `"cross_sectional"`, `"long_short"`); either may instead be a handle from `momentum(...)`, `long_short(...)`, etc. Returns a record with `.metrics` (a map of `sharpe`, `sortino`, `maxDrawdown`, `calmar`, `hitRate`, `turnover`), `.equity` and `.port_returns` (DataFrames), and `.weights`.

## walk_forward(prices: DataFrame, signal: string = "momentum", portfolio: string = "long_short", folds: int = 4, min_train_fraction: float = 0.5, cost?: float) {quant}
Walk-forward (out-of-sample) backtest: split the series into `folds` segments after an initial `min_train_fraction` training window and stitch the per-fold out-of-sample returns. Same arguments and result shape as `backtest`.

## momentum(lookback: int = 20) {quant}
Build a momentum signal handle (trailing return over `lookback` periods) to pass to `backtest`/`walk_forward` as `signal=`.

## mean_reversion(lookback: int = 20) {quant}
Build a mean-reversion signal handle (the negated `lookback` momentum) for use as `signal=`.

## zscore(window: int = 20) {quant}
Build a z-score signal handle (rolling standardized price over `window`) for use as `signal=`.

## equal_weight() {quant}
Portfolio handle weighting every active asset equally by sign, for use as `portfolio=`.

## cross_sectional() {quant}
Portfolio handle that demeans the signal across assets and scales to unit gross exposure, for use as `portfolio=`.

## long_short(fraction: float = 0.2) {quant}
Portfolio handle going long the top `fraction` and short the bottom `fraction` of ranked assets, for use as `portfolio=`.

## sharpe(returns, periods_per_year: int = 252) {quant}
Annualized Sharpe ratio of a returns array or a single-column returns `DataFrame`.

## deflated_sharpe(returns, trial_sharpes: float[]) {quant}
Deflated Sharpe ratio — the probability the strategy's Sharpe is real after accounting for the number and dispersion of `trial_sharpes` searched over (guards against selection bias).

## pbo(trial_returns, partitions: int = 10) {quant}
Probability of Backtest Overfitting via combinatorially symmetric cross-validation over a time × trial matrix (rows of returns, one column per candidate strategy). Accepts a matrix or a `DataFrame`.

## min_track_record_length(returns, target_sharpe: float = 0, confidence: float = 0.95) {quant}
Minimum number of observations needed before the observed Sharpe exceeds `target_sharpe` at the given `confidence`.

## risk_parity(covariance) {quant}
Equal-risk-contribution portfolio weights for a covariance matrix. Passing a returns `DataFrame` estimates the sample covariance first. Returns a weight array.

## hrp(covariance) {quant}
Hierarchical Risk Parity weights — cluster assets by correlation and allocate by recursive bisection. Accepts a covariance matrix or a returns `DataFrame`.

## mean_variance(mu: float[], cov) {quant}
Mean-variance optimal weights for expected returns `mu` and covariance `cov` (a matrix or a returns `DataFrame`), normalized to unit gross exposure.

## quill(source: string) {quant}
Parse and type-check a Quill product definition from a source string and return a product handle. Call `.price(rate=..., spot=..., vol=..., paths?=..., seed?=..., greeks?=...)` on it to run the Monte-Carlo pricer; the result has `.price`, `.standard_error`, and a `.greeks` map (`delta`, `vega`, `rho`, …). `greeks` is `"price-only"`, `"first-order"`, or `"full"`.

## load_quill(path: string) {quant}
Like `quill`, but read the Quill product definition from a file `path`. Returns the same product handle with a `.price(...)` method and a `.name` field.

## adf_test(series, lags: int = 0, trend: string = "constant") {quant}
Augmented Dickey-Fuller unit-root test. Returns a record with `statistic`, `criticalValues`, and `stationary` (true when the statistic is below the critical value).

## kpss_test(series, trend: string = "constant", lags?: int) {quant}
KPSS stationarity test (null hypothesis: the series is stationary). Returns `statistic`, `criticalValues`, `stationary`. Complements `adf_test`.

## hurst_exponent(series, min_window: int = 10, max_window?: int, growth: float = 1.5) {quant}
Hurst exponent from rescaled-range analysis. `< 0.5` mean-reverting, `~0.5` random walk, `> 0.5` trending.

## half_life(series) {quant}
Ornstein-Uhlenbeck mean-reversion half-life (in periods) estimated by regressing the change on the lagged level.

## engle_granger(dependent, regressors, lags: int = 0) {quant}
Engle-Granger two-step cointegration test: regress `dependent` on `regressors`, then ADF-test the residual. Returns `statistic`, `criticalValues`, `cointegrated`, `hedgeRatio`, and `spread`.

## johansen(levels, lags: int = 1) {quant}
Johansen cointegration test on a matrix of price levels. Returns `eigenvalues`, `traceStatistics`, `maxEigenStatistics`, and the estimated cointegration `rank`.

## cusum_events(series, threshold, drift: float = 0) {quant}
Symmetric CUSUM filter — returns the indices where the cumulative deviation exceeds `threshold`, used to sample structural-shift events.

## sadf(series, min_window: int = 20, lags: int = 0, trend: string = "constant") {quant}
Supremum ADF statistic — the max ADF over expanding windows, a test for explosive (bubble) behavior.

## bsadf(series, min_window: int = 20, lags: int = 0, trend: string = "constant") {quant}
Backward-SADF series — the running SADF at each point, for dating the start/end of explosive regimes.

## kalman_filter(observations, observation_vectors, spec) {quant}
Linear Kalman filter over a state-space `spec` (transition, observation, process/measurement noise). Returns filtered `states`, `covariances`, and one-step innovations.

## kalman_smoother(observations, observation_vectors, spec) {quant}
Rauch-Tung-Striebel smoother — the full-sample smoothed state matrix for the same state-space `spec` as `kalman_filter`.

## dynamic_beta(dependent, regressors, config?) {quant}
Time-varying hedge ratio / beta via a Kalman filter (random-walk coefficients). Returns the per-period `states` (betas) — the workhorse for dynamic pairs trading.

## fit_garch(returns, options?) {quant}
Fit a GARCH(1,1) volatility model by maximum likelihood. Returns a record with `params` (`omega`, `alpha`, `beta`), `log_likelihood`, and fitted `variances`.

## garch_forecast(returns, params, horizon: int, initial_variance?: float) {quant}
Forecast conditional variance `horizon` steps ahead from GARCH `params` (as returned by `fit_garch`).

## garch_volatility(returns, params, initial_variance?: float) {quant}
In-sample conditional volatility path (standard deviation per period) for the given GARCH `params`.

## tick_bars(ticks, ticks_per_bar: int) {quant}
Aggregate a `ticks` DataFrame (`price`, `volume`) into OHLC bars of fixed tick count. Returns a bar `DataFrame`.

## volume_bars(ticks, volume_per_bar: float) {quant}
Information-driven bars sampled every fixed traded `volume_per_bar`. Returns a bar `DataFrame`.

## dollar_bars(ticks, dollar_per_bar: float) {quant}
Bars sampled every fixed traded dollar value — the most sample-stationary bar type. Returns a bar `DataFrame`.

## tick_rule(prices) {quant}
Lee-Ready tick rule — signs each trade `+1`/`-1` by price change to infer aggressor side.

## roll_spread(prices) {quant}
Roll's implied effective bid-ask spread from the serial covariance of price changes.

## amihud(returns, dollar_volumes) {quant}
Amihud illiquidity — average of `|return| / dollar_volume`, a price-impact-per-dollar measure.

## kyle_lambda(prices, volumes) {quant}
Kyle's lambda — price impact per signed volume, estimated by regressing price changes on signed order flow.

## vpin(ticks, bucket_volume, window: int = 50) {quant}
Volume-synchronized Probability of Informed Trading — order-flow-toxicity series over volume buckets.

## EarlyStopping(monitor, patience=3, mode="min")
Stop training when a monitored metric stops improving for `patience` evaluations.

## ModelCheckpoint(monitor, save_top_k=1, mode="min")
Save the best model(s) according to a monitored metric.

## ProgressCallback()
Lightweight progress bar callback for the Trainer.

## LearningRateMonitor()
Log the current learning rate at each step.

## Timer()
Measure and log wall-clock time per epoch and total.

## GradientAccumulationScheduler(scheduling)
Accumulate gradients across multiple steps before updating, on a per-epoch schedule.

## ConsoleLogger()
Send log records to stdout.

## CSVLogger(save_dir="logs", name="experiment")
Append log records to a CSV file under `save_dir/name`.

## Accuracy(task="binary", num_classes?, top_k=1)
Classification accuracy metric. Configure with `task` (`binary`/`multiclass`/`multilabel`).

## Precision(task="binary", num_classes?, average="macro")
Precision metric — fraction of positive predictions that are correct.

## Recall(task="binary", num_classes?, average="macro")
Recall metric — fraction of actual positives that are predicted positive.

## F1Score(task="binary", num_classes?, average="macro")
Harmonic mean of precision and recall.

## ConfusionMatrix(num_classes)
Cumulative confusion matrix over `num_classes`.

## MetricCollection(...metrics)
Group multiple metrics into one callable for convenience.

## cpu
CPU execution backend.

## gpu
Native GPU execution backend (CUDA-like).

## wasm
WebAssembly execution backend.

## webgpu
WebGPU execution backend (browser-friendly).

## f16
Half-precision floating-point dtype (16-bit).

## f32
Single-precision floating-point dtype (32-bit). Default for most models.

## f64
Double-precision floating-point dtype (64-bit).

## i32
32-bit signed integer dtype.

## i64
64-bit signed integer dtype.

## bool
Boolean dtype.

---

# Kind templates

These `## @kind/<kind>` entries define methods auto-injected into every builtin
of the matching kind. A builtin's own `###` methods take precedence; templates
add the rest.

## @kind/module

### forward(x)
Run the module's forward pass. Calling the module directly (`module(x)`) is equivalent to `module.forward(x)`.

### parameters() -> Tensor[]
Return an array of the module's learnable parameter tensors.

### train()
Set the module to training mode (enables Dropout, updates BatchNorm running stats).

### eval()
Set the module to evaluation mode (disables Dropout, freezes BatchNorm stats).

### to(device: string) -> Module
Move the module's parameters to a device (`"cpu"`, `"gpu"`, `"webgpu"`) and return it.

## @kind/sequential

### forward(x)
Run inputs sequentially through each contained module.

### parameters()
Return parameters of all contained modules concatenated.

### train()
Switch all submodules to training mode.

### eval()
Switch all submodules to evaluation mode.

## @kind/optimizer

### step()
Apply one optimizer update step using the current gradients.

### zero_grad()
Zero out gradients of all tracked parameters before the next backward pass.

### param_groups()
Return the list of parameter groups (each with its own learning rate, weight decay, etc.).

## @kind/scheduler

### step(metric?)
Advance the scheduler by one step. Some schedulers (`ReduceLROnPlateau`) require a monitored metric.

### get_last_lr()
Return the most recently computed learning rate(s).

## @kind/metric

### update(preds, target)
Update internal state with a new batch of predictions and ground-truth labels.

### compute()
Compute the current metric value across all accumulated updates.

### reset()
Clear accumulated state so the next epoch starts fresh.

## @kind/callback

### on_train_start(trainer, model)
Hook fired at the start of training.

### on_train_end(trainer, model)
Hook fired at the end of training.

### on_epoch_start(trainer, model)
Hook fired at the start of each epoch.

### on_epoch_end(trainer, model)
Hook fired at the end of each epoch.

## @kind/logger

### log(name, value, step?)
Record a scalar metric value.

### flush()
Flush buffered records to the underlying sink.

## @kind/trainer

### fit(model: Module, train_loader: DataLoader, val_loader?: DataLoader)
Run the full training loop.

### validate(model: Module, loader: DataLoader)
Run validation only.

### test(model: Module, loader: DataLoader)
Run the model in eval mode and report logged metrics.

### predict(model: Module, loader: DataLoader)
Run the model in eval mode and return collected outputs.

# Pseudo-types

These don't correspond to a builtin call but capture the type of common results.

## $Tensor

### shape
Return the shape (size-per-dimension array) of the tensor.

### dtype
Return the dtype string of the tensor.

### reshape(shape) -> Tensor
Return a view with the given shape; total element count must match.

### transpose(dim0, dim1) -> Tensor
Swap two dimensions.

### permute(dims) -> Tensor
Reorder all dimensions per the permutation list.

### expand(shape) -> Tensor
Broadcast to a larger shape without copying memory.

### slice(dim, start, end, step=1) -> Tensor
View a contiguous slice along the given dimension.

### unsqueeze(dim) -> Tensor
Insert a size-1 dimension at the given position.

### squeeze(dim) -> Tensor
Remove a size-1 dimension at the given position.

### narrow(dim, start, length) -> Tensor
Take `length` elements starting at `start` along `dim`.

### select(dim, index) -> Tensor
Select a single index along `dim`, removing that dimension.

### contiguous() -> Tensor
Return a row-major contiguous copy of the tensor.

### detach() -> Tensor
Return a copy detached from the autograd graph.

### backward(gradient?) -> Tensor
Propagate gradients backward from this tensor.

### requires_grad(flag=true) -> Tensor
Enable or disable gradient tracking on this tensor.

### grad
Read the accumulated gradient of this leaf tensor.

### length
Total number of elements (numel).

### neg() -> Tensor
Element-wise unary negation.

### exp() -> Tensor
Element-wise natural exponential `e^x`.

### log() -> Tensor
Element-wise natural logarithm.

### sqrt() -> Tensor
Element-wise square root.

### rsqrt() -> Tensor
Element-wise reciprocal square root `1/√x`.

### abs() -> Tensor
Element-wise absolute value.

### sin() -> Tensor
Element-wise sine.

### cos() -> Tensor
Element-wise cosine.

### tanh() -> Tensor
Element-wise hyperbolic tangent.

### sigmoid() -> Tensor
Element-wise logistic sigmoid `1/(1+e^-x)`.

### relu() -> Tensor
Element-wise ReLU activation.

### gelu() -> Tensor
Gaussian Error Linear Unit activation.

### silu() -> Tensor
SiLU/Swish activation: `x * sigmoid(x)`.

### sign() -> Tensor
Element-wise sign: `-1`, `0`, or `+1`.

### floor() -> Tensor
Element-wise floor (round toward `-∞`).

### ceil() -> Tensor
Element-wise ceiling (round toward `+∞`).

### clone() -> Tensor
Return a deep copy of the tensor (separate storage).

### add(other) -> Tensor
Element-wise addition; scalars are auto-promoted.

### sub(other) -> Tensor
Element-wise subtraction; scalars are auto-promoted.

### mul(other) -> Tensor
Element-wise multiplication; scalars are auto-promoted.

### div(other) -> Tensor
Element-wise division; scalars are auto-promoted.

### pow(exponent) -> Tensor
Element-wise power `x ** exponent`.

### remainder(other) -> Tensor
Element-wise floored remainder (sign follows divisor).

### maximum(other) -> Tensor
Element-wise maximum of two tensors.

### minimum(other) -> Tensor
Element-wise minimum of two tensors.

### eq(other) -> Tensor
Element-wise equality comparison. Returns a boolean tensor.

### ne(other) -> Tensor
Element-wise inequality comparison.

### lt(other) -> Tensor
Element-wise less-than comparison.

### le(other) -> Tensor
Element-wise less-than-or-equal comparison.

### gt(other) -> Tensor
Element-wise greater-than comparison.

### ge(other) -> Tensor
Element-wise greater-than-or-equal comparison.

### matmul(other) -> Tensor
Matrix multiplication; broadcasts on leading batch dimensions.

### dot(other) -> Tensor
Inner (dot) product of two 1-D tensors.

### sum(axis?, keep?) -> Tensor
Sum over `axis` (or the whole tensor); `keep` retains reduced dims.

### mean(axis?, keep?) -> Tensor
Arithmetic mean over `axis` (or the whole tensor); `keep` retains reduced dims.

### max(axis?, keep?) -> Tensor
Maximum over `axis` (or the whole tensor); `keep` retains reduced dims.

### min(axis?, keep?) -> Tensor
Minimum over `axis` (or the whole tensor); `keep` retains reduced dims.

### argmax(axis?, keep?) -> Tensor
Index of the maximum along `axis`; `keep` retains reduced dims.

### argmin(axis?, keep?) -> Tensor
Index of the minimum along `axis`; `keep` retains reduced dims.

### prod(axis?, keep?) -> Tensor
Product of elements over `axis` (or the whole tensor); `keep` retains reduced dims.

### softmax(axis=-1) -> Tensor
Softmax along `axis`, normalizing to a probability distribution.

### log_softmax(axis=-1) -> Tensor
Logarithm of softmax along `axis`, numerically stable.

## $Model

### parameters() -> Tensor[]
Return the model's learnable parameter tensors.

### forward(*args)
Run the model's forward block. Calling the model directly is equivalent.

### train() -> Model
Set training mode.

### eval() -> Model
Set evaluation mode.

### to(device: string) -> Model
Move the model's parameters to a device (`"cpu"`, `"gpu"`, `"webgpu"`) and return it.

### state_dict()
Return a serializable dict of parameter tensors.

### load_state_dict(state)
Load parameter tensors from a previously saved dict.

### save(path: string) -> none
Save the model's weights to `path` (compact binary checkpoint). Reload into a same-architecture model with `load_model(model, path)`.

## $DataFrame

### columns()
Return the column names as an array of strings.

### schema()
Return the frame's schema (fields with names and data types).

### explain()
Return the logical query plan as a human-readable string.

### select(...columns) -> DataFrame
Project a new frame from the given columns or `Column` expressions.

### filter(condition) -> DataFrame
Keep only rows matching a boolean `Column` (or SQL string) condition.

### where(condition) -> DataFrame
Alias for `filter`.

### withColumn(name, column) -> DataFrame
Return a new frame with an added or replaced column computed from `column`.

### drop(...columns) -> DataFrame
Return a new frame without the named columns.

### groupBy(...columns) -> GroupedData
Group rows by the given columns, returning a `GroupedData` for aggregation.

### orderBy(...specs) -> DataFrame
Sort rows. Each spec is a column name/`Column`, or `{ col, desc }` for ordering.

### sort(...specs) -> DataFrame
Alias for `orderBy`.

### limit(count, offset=0) -> DataFrame
Return at most `count` rows, skipping the first `offset` rows.

### head(n=5) -> DataFrame
Return the first `n` rows as a new frame (pandas-style preview).

### distinct() -> DataFrame
Return a frame with duplicate rows removed.

### union(other) -> DataFrame
Concatenate the rows of another frame with matching column types.

### unionAll(other) -> DataFrame
Concatenate rows of another frame, keeping duplicates.

### join(other, on, how="INNER") -> DataFrame
Join with another frame on one or more key columns. `how` is one of
`INNER`, `LEFT`, `RIGHT`, or `FULL`.

### collect()
Execute the plan and return all rows as an array of objects.

### toArray()
Alias for `collect`.

### count()
Execute the plan and return the number of rows.

### show(n=20)
Execute and print the first `n` rows as a formatted table; returns the text.

### chunks()
Execute and stream results as an async iterator of data chunks.

### to_tensor(...columns)
Materialize the (optionally selected) numeric columns into a 2-D tensor of
shape `[rows, columns]`. Non-numeric columns raise — encode them first.

### to_array()
Alias for `collect` — execute and return rows as an array of objects.

### encode(column, classes?)
Encode a categorical column to integer ids, returning `[encoded_tensor,
classes_array]`. Pass `classes=` to reuse ids fitted on another frame.

## $GroupedData

### agg(...columns) -> DataFrame
Apply aggregate `Column` expressions (e.g. `sum`, `avg`, `count`) over each
group, returning a `DataFrame` of group keys and aggregates.

## $Column

### alias(name) -> Column
Rename the column's output to `name`.

### as(name) -> Column
Alias for `alias`.

### add(other) -> Column
Arithmetic addition with another column or value.

### sub(other) -> Column
Arithmetic subtraction with another column or value.

### mul(other) -> Column
Arithmetic multiplication with another column or value.

### div(other) -> Column
Arithmetic division with another column or value.

### eq(other) -> Column
Equality comparison, producing a boolean column.

### ne(other) -> Column
Inequality comparison, producing a boolean column.

### lt(other) -> Column
Less-than comparison, producing a boolean column.

### le(other) -> Column
Less-than-or-equal comparison, producing a boolean column.

### gt(other) -> Column
Greater-than comparison, producing a boolean column.

### ge(other) -> Column
Greater-than-or-equal comparison, producing a boolean column.

### and(other) -> Column
Logical AND of two boolean columns.

### or(other) -> Column
Logical OR of two boolean columns.

### not() -> Column
Logical negation of a boolean column.

### isNull() -> Column
True where the column value is null.

### isNotNull() -> Column
True where the column value is not null.

### like(pattern) -> Column
SQL `LIKE` match against a string pattern.

### between(low, high) -> Column
True where the value lies in the inclusive range `[low, high]`.

### isin(...values) -> Column
True where the value is one of the given values.

### cast(targetType) -> Column
Cast the column to another data type.

## $List

### append(x) -> none
Add `x` to the end of the list, growing it in place.

### extend(other) -> none
Append every element of list `other` to the end of this list, in place.

### insert(i, x) -> none
Insert `x` at index `i`, shifting later elements right. Negative `i` counts from
the end; out-of-range `i` is clamped to the nearest end.

### pop(i?) -> any
Remove and return the element at index `i` (the last element when `i` is omitted).
Errors on an empty list.

### remove(x) -> none
Remove the first element equal to `x`. Does nothing if no element matches.

### index(x) -> int
Return the position of the first element equal to `x`, or `-1` if absent.

### count(x) -> int
Return how many elements are equal to `x`.

### contains(x) -> boolean
True when the list holds an element equal to `x`.

### reverse() -> none
Reverse the order of the elements in place.

### clear() -> none
Remove all elements, leaving an empty list.

### copy() -> list
Return a shallow copy of the list.

## $String

### upper() -> string
Return the string with every character upper-cased.

### lower() -> string
Return the string with every character lower-cased.

### strip() -> string
Return the string with leading and trailing whitespace removed.

### lstrip() -> string
Return the string with leading whitespace removed.

### rstrip() -> string
Return the string with trailing whitespace removed.

### split(sep?) -> string[]
Split the string on `sep`. With no `sep`, split on runs of whitespace and drop
empty pieces.

### join(parts) -> string
Join `parts` into one string using this string as the separator, e.g.
`", ".join(words)`.

### replace(old, new) -> string
Return a copy with every occurrence of `old` replaced by `new`.

### starts_with(prefix) -> boolean
True when the string begins with `prefix`.

### ends_with(suffix) -> boolean
True when the string ends with `suffix`.

### find(sub) -> int
Return the index of the first occurrence of `sub`, or `-1` if absent.

### contains(sub) -> boolean
True when `sub` occurs anywhere in the string.

## $Dict

### keys() -> list
Return a list of the dictionary's keys.

### values() -> list
Return a list of the dictionary's values.

### items() -> list
Return a list of `[key, value]` pairs.

### get(key, default?) -> any
Return the value for `key`, or `default` (or `null` when omitted) if the key is absent.

### has(key) -> boolean
True when `key` is present in the dictionary.

### remove(key) -> none
Remove `key` and its value from the dictionary. Does nothing if absent.

## @kind/ml_model

### fit(X: Tensor, y: Tensor) -> Model
Fit the estimator to training features `X` and targets `y`. Returns the fitted model.

### predict(X: Tensor) -> Tensor
Predict targets/labels for the rows of `X`.

### score(X: Tensor, y: Tensor) -> float
Return the model's default score (R² for regressors, accuracy for classifiers).

## @kind/ml_transform

### fit(X: Tensor) -> Transformer
Learn the transform parameters from `X`.

### transform(X: Tensor) -> Tensor
Apply the learned transform to `X`.

### fit_transform(X: Tensor) -> Tensor
Fit then transform `X` in one call.

### inverse_transform(X: Tensor) -> Tensor
Map transformed data back to the original space (where supported).

## LinearRegression(fit_intercept: boolean = true) {ml_model}
Ordinary least-squares linear regression (solved via `lstsq`).

## Ridge(alpha: float = 1.0, fit_intercept: boolean = true) {ml_model}
L2-regularized linear regression, closed-form via `solve`.

## Lasso(alpha: float = 1.0, fit_intercept: boolean = true, max_iter: int = 1000) {ml_model}
L1-regularized linear regression via coordinate descent (sparse coefficients).

## ElasticNet(alpha: float = 1.0, l1_ratio: float = 0.5, fit_intercept: boolean = true, max_iter: int = 1000) {ml_model}
Combined L1/L2 linear regression via coordinate descent.

## LogisticRegression(C: float = 1.0, lr: float = 0.5, max_iter: int = 1000) {ml_model}
Multinomial logistic regression (softmax) trained by gradient descent. Also exposes `predict_proba(X) -> Tensor`.

## KNeighborsClassifier(n_neighbors: int = 5) {ml_model}
k-nearest-neighbors classifier (majority vote over Euclidean neighbors).

## KNeighborsRegressor(n_neighbors: int = 5) {ml_model}
k-nearest-neighbors regressor (mean of neighbor targets).

## GaussianNB() {ml_model}
Gaussian Naive Bayes classifier.

## DecisionTreeClassifier(max_depth?: int, min_samples_split: int = 2, min_samples_leaf: int = 1, max_features: int = 0, random_state: int = 0) {ml_model}
CART decision-tree classifier (Gini impurity).

## DecisionTreeRegressor(max_depth?: int, min_samples_split: int = 2, min_samples_leaf: int = 1, max_features: int = 0, random_state: int = 0) {ml_model}
CART decision-tree regressor (variance reduction).

## RandomForestClassifier(n_estimators: int = 100, max_depth?: int, max_features: int = 0, random_state: int = 0) {ml_model}
Bagged ensemble of decision trees (majority vote).

## RandomForestRegressor(n_estimators: int = 100, max_depth?: int, max_features: int = 0, random_state: int = 0) {ml_model}
Bagged ensemble of decision trees (mean prediction).

## GradientBoostingClassifier(n_estimators: int = 100, learning_rate: float = 0.1, max_depth: int = 3, random_state: int = 0) {ml_model}
Stage-wise gradient boosting for classification (multinomial deviance).

## GradientBoostingRegressor(n_estimators: int = 100, learning_rate: float = 0.1, max_depth: int = 3, random_state: int = 0) {ml_model}
Stage-wise gradient boosting for regression (squared-error residuals).

## StandardScaler(with_mean: boolean = true, with_std: boolean = true) {ml_transform}
Standardize features to zero mean and unit variance per column.

## MinMaxScaler(feature_range: float[] = [0, 1]) {ml_transform}
Scale features to a given range per column.

## LabelEncoder() {ml_transform}
Encode categorical labels to integer ids. `inverse_transform` returns the original labels.

## OneHotEncoder() {ml_transform}
Encode categorical labels to one-hot rows.

## PCA(n_components?: int) {ml_transform}
Principal component analysis (via `svd`). Exposes `components_`, `explainedVariance_`, `explainedVarianceRatio_`.

## KMeans(n_clusters: int = 8, max_iter: int = 300, n_init: int = 10, random_state: int = 0) {ml_cluster}
k-means clustering (k-means++ init). Exposes `clusterCenters_`, `labels_`, `inertia_`.

### fit(X: Tensor) -> KMeans
Compute cluster centers from `X`.

### predict(X: Tensor) -> Tensor
Assign each row of `X` to its nearest cluster.

### fit_predict(X: Tensor) -> Tensor
Fit then return the training labels.

## KFold(n_splits: int = 5, shuffle: boolean = false, random_state: int = 0) {ml_split}
K-fold cross-validation splitter.

### split(n: int) -> Record[]
Return `n_splits` `{train, test}` index partitions for `n` samples.

## TimeSeriesSplit(n_splits: int = 5) {ml_split}
Expanding-window splitter for time-ordered data.

### split(n: int) -> Record[]
Return forward-chaining `{train, test}` index partitions.

## GridSearchCV(estimator, param_grid: Record, cv: int = 5) {grid_search}
Exhaustive hyperparameter search with cross-validation. Pass an estimator constructor and a grid of parameter lists.

### fit(X: Tensor, y: Tensor) -> GridSearchCV
Search all parameter combinations and refit the best on the full data. Sets `bestParams_`, `bestScore_`, `bestEstimator_`.

### predict(X: Tensor) -> Tensor
Predict using the best found estimator.

## train_test_split(X: Tensor, y?: Tensor, test_size: float = 0.25, random_state: int = 0) {ml_function}
Split data into train/test partitions. With `y`, returns `[X_train, X_test, y_train, y_test]`; with only `X`, returns `[X_train, X_test]`.

## cross_val_score(estimator, X: Tensor, y: Tensor, cv: int = 5) {ml_function}
Cross-validated scores for an estimator constructor over `cv` folds.

## r2_score(y_true: Tensor, y_pred: Tensor) {ml_metric}
Coefficient of determination (R²).

## mean_squared_error(y_true: Tensor, y_pred: Tensor) {ml_metric}
Mean squared error.

## mean_absolute_error(y_true: Tensor, y_pred: Tensor) {ml_metric}
Mean absolute error.

## accuracy_score(y_true: Tensor, y_pred: Tensor) {ml_metric}
Classification accuracy.

## confusion_matrix(y_true: Tensor, y_pred: Tensor) {ml_metric}
Confusion matrix as a nested array.

## svd(input: Tensor) {linalg}
Reduced singular value decomposition. Returns `{U, S, V}` with `input ≈ U diag(S) Vᵀ`.

## eigh(input: Tensor) {linalg}
Symmetric eigendecomposition. Returns `{values, vectors}` (ascending eigenvalues).

## cholesky(input: Tensor) {linalg}
Cholesky factor `L` (lower-triangular) of a symmetric positive-definite matrix.

## solve(a: Tensor, b: Tensor) {linalg}
Solve the linear system `a @ x = b` for `x`.

## lstsq(a: Tensor, b: Tensor) {linalg}
Least-squares solution to `a @ x ≈ b` (via pseudo-inverse).

## inv(input: Tensor) {linalg}
Matrix inverse.

## pinv(input: Tensor) {linalg}
Moore-Penrose pseudo-inverse.

## det(input: Tensor) {linalg}
Determinant (scalar).

## cov(input: Tensor) {linalg}
Covariance matrix of the columns of `input`.

## normal_cdf(x: Tensor, loc: float = 0, scale: float = 1) {numeric_dist}
Normal distribution cumulative distribution function, applied elementwise.

## normal_ppf(p: Tensor, loc: float = 0, scale: float = 1) {numeric_dist}
Normal distribution quantile function (inverse CDF), applied elementwise.

## normal_pdf(x: Tensor, loc: float = 0, scale: float = 1) {numeric_dist}
Normal distribution probability density function, applied elementwise.

## t_cdf(x: Tensor, df: float) {numeric_dist}
Student's t cumulative distribution function with `df` degrees of freedom, applied elementwise.

## t_ppf(p: Tensor, df: float) {numeric_dist}
Student's t quantile function (inverse CDF) with `df` degrees of freedom, applied elementwise.

## t_pdf(x: Tensor, df: float) {numeric_dist}
Student's t probability density function with `df` degrees of freedom, applied elementwise.

## chi2_cdf(x: Tensor, df: float) {numeric_dist}
Chi-squared cumulative distribution function with `df` degrees of freedom, applied elementwise.

## chi2_ppf(p: Tensor, df: float) {numeric_dist}
Chi-squared quantile function (inverse CDF) with `df` degrees of freedom, applied elementwise.

## chi2_pdf(x: Tensor, df: float) {numeric_dist}
Chi-squared probability density function with `df` degrees of freedom, applied elementwise.

## f_cdf(x: Tensor, d1: float, d2: float) {numeric_dist}
F distribution cumulative distribution function with `d1` and `d2` degrees of freedom, applied elementwise.

## f_ppf(p: Tensor, d1: float, d2: float) {numeric_dist}
F distribution quantile function (inverse CDF) with `d1` and `d2` degrees of freedom, applied elementwise.

## f_pdf(x: Tensor, d1: float, d2: float) {numeric_dist}
F distribution probability density function with `d1` and `d2` degrees of freedom, applied elementwise.

## erf(input: Tensor) {numeric_func}
Error function, applied elementwise.

## erfc(input: Tensor) {numeric_func}
Complementary error function, applied elementwise.

## lgamma(input: Tensor) {numeric_func}
Natural logarithm of the absolute value of the gamma function, applied elementwise.

## gamma(input: Tensor) {numeric_func}
Gamma function, applied elementwise.

## fft(input: Tensor) {numeric_transform}
Discrete Fourier transform of a 1-D real or `[n, 2]` complex signal. Returns an `[n, 2]` Tensor of real/imaginary pairs.

## ifft(input: Tensor) {numeric_transform}
Inverse discrete Fourier transform of a 1-D real or `[n, 2]` complex signal. Returns an `[n, 2]` Tensor of real/imaginary pairs.

## qr(input: Tensor) {numeric_transform}
QR decomposition. Returns `{Q, R}` with `input = Q @ R`.

## linear_interp(xs: float[], ys: float[], xq) {numeric_func}
Piecewise-linear interpolation of the points `(xs, ys)` evaluated at `xq` (a number or a list of numbers).

## cubic_spline(xs: float[], ys: float[]) {numeric_func}
Natural cubic spline interpolant through the points `(xs, ys)`.

### evaluate(xq) -> float
Evaluate the spline at a query point or a list of query points.

## t_test_1samp(x: Tensor, popmean: float = 0) {numeric_stats_test}
One-sample t-test of the mean of `x` against `popmean`. Returns a record with `statistic`, `pvalue`, `df`.

## t_test_ind(x: Tensor, y: Tensor, equal_var: boolean = true) {numeric_stats_test}
Two-sample independent t-test. `equal_var=true` pools variances; `equal_var=false` uses the Welch unequal-variance form. Returns a record with `statistic`, `pvalue`, `df`.

## t_test_paired(x: Tensor, y: Tensor) {numeric_stats_test}
Paired t-test on matched samples `x` and `y`. Returns a record with `statistic`, `pvalue`, `df`.

## chi2_gof(observed: Tensor, expected?: Tensor, ddof: int = 0) {numeric_stats_test}
Chi-square goodness-of-fit test of `observed` counts against `expected` counts (uniform when omitted). Returns a record with `statistic`, `pvalue`, `df`.

## chi2_independence(table: Tensor) {numeric_stats_test}
Chi-square test of independence on a 2-D contingency `table`. Returns a record with `statistic`, `pvalue`, `df`.

## ks_test_1samp(x: Tensor, cdf?, loc: float = 0, scale: float = 1) {numeric_stats_test}
One-sample Kolmogorov-Smirnov test of `x` against a reference CDF (normal with `loc`/`scale` by default). Returns a record with `statistic`, `pvalue`.

## ks_test_2samp(x: Tensor, y: Tensor) {numeric_stats_test}
Two-sample Kolmogorov-Smirnov test comparing the empirical distributions of `x` and `y`. Returns a record with `statistic`, `pvalue`.

## jarque_bera(x: Tensor) {numeric_stats_test}
Jarque-Bera normality test built from sample skewness and kurtosis. Returns a record with `statistic`, `pvalue`, `df`.

## dagostino_k2(x: Tensor) {numeric_stats_test}
D'Agostino K-squared normality test combining skewness and kurtosis z-scores. Returns a record with `statistic`, `pvalue`, `df`.

## anderson_darling(x: Tensor) {numeric_stats_test}
Anderson-Darling normality test with the small-sample corrected p-value. Returns a record with `statistic`, `pvalue`.

## mann_whitney_u(x: Tensor, y: Tensor) {numeric_stats_test}
Mann-Whitney U rank-sum test with normal approximation, tie correction, and continuity correction. Returns a record with `statistic`, `pvalue`.

## acf(x: Tensor, nlags?: int) {numeric_timeseries}
Sample autocorrelation function of `x` up to `nlags` (FFT-based). Returns a Tensor of length `nlags + 1` with lag 0 equal to 1.

## pacf(x: Tensor, nlags?: int) {numeric_timeseries}
Partial autocorrelation function of `x` via Levinson-Durbin recursion. Returns a Tensor of length `nlags + 1` with lag 0 equal to 1.

## ljung_box(x: Tensor, lags?: int, model_df: int = 0) {numeric_timeseries}
Ljung-Box test for autocorrelation up to `lags`. Returns a record with `statistic`, `pvalue`, `df`.

## durbin_watson(x: Tensor) {numeric_timeseries}
Durbin-Watson statistic of a residual series; values near 2 indicate no first-order autocorrelation.

## periodogram(x: Tensor, detrend: boolean = true) {numeric_timeseries}
Power spectrum of `x` at frequencies `k / n` for `k = 0..n/2`. Returns a Tensor of length `n/2 + 1`.

## convolve(a: Tensor, b: Tensor, mode: string = "full") {numeric_array_op}
FFT-based linear convolution of two 1-D signals. `mode` is `"full"`, `"same"`, or `"valid"`.

## correlate(a: Tensor, b: Tensor, mode: string = "full") {numeric_array_op}
FFT-based cross-correlation of two 1-D signals. `mode` is `"full"`, `"same"`, or `"valid"`.

## rolling_mean(x: Tensor, window: int) {numeric_array_op}
Rolling mean over each length-`window` slice of `x`. Returns a Tensor of length `n - window + 1`.

## rolling_std(x: Tensor, window: int, ddof: int = 1) {numeric_array_op}
Rolling standard deviation over each length-`window` slice of `x`. Returns a Tensor of length `n - window + 1`.

## rolling_sum(x: Tensor, window: int) {numeric_array_op}
Rolling sum over each length-`window` slice of `x`. Returns a Tensor of length `n - window + 1`.

## rolling_min(x: Tensor, window: int) {numeric_array_op}
Rolling minimum over each length-`window` slice of `x`. Returns a Tensor of length `n - window + 1`.

## rolling_max(x: Tensor, window: int) {numeric_array_op}
Rolling maximum over each length-`window` slice of `x`. Returns a Tensor of length `n - window + 1`.

## polyfit(x: Tensor, y: Tensor, deg: int) {numeric_array_op}
Least-squares polynomial fit of degree `deg` to the points `(x, y)`. Returns coefficients ordered from the highest degree down.

## polyval(coeffs: Tensor, x) {numeric_array_op}
Evaluate a polynomial with coefficients ordered from the highest degree down at `x` (a number, list, or Tensor).

## polyroots(coeffs: Tensor) {numeric_array_op}
All complex roots of a polynomial via Durand-Kerner iteration. Returns a `[deg, 2]` Tensor of real/imaginary pairs.

## random_uniform(shape: int[], low: float = 0, high: float = 1, seed?: int) {numeric_random}
Seeded uniform samples on `[low, high)` with the given shape.

## random_normal(shape: int[], loc: float = 0, scale: float = 1, seed?: int) {numeric_random}
Seeded normal samples with mean `loc` and standard deviation `scale`.

## random_t(shape: int[], df: float, seed?: int) {numeric_random}
Seeded Student t samples with `df` degrees of freedom.

## random_chi2(shape: int[], df: float, seed?: int) {numeric_random}
Seeded chi-square samples with `df` degrees of freedom.

## random_exponential(shape: int[], scale: float = 1, seed?: int) {numeric_random}
Seeded exponential samples with the given `scale` (mean).

## multivariate_normal(mean: float[], cov: Tensor, n: int = 1, seed?: int) {numeric_random}
Seeded multivariate normal samples via the Cholesky factor of `cov`. Returns an `[n, d]` Tensor.
