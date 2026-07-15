import { TeraRuntime, formatValue, memfs } from './dist/mlfw.esm.js';
import { createChartApi, isChartSpec } from './chart/index.js';

let runtime = null;
let prints = [];
let dataframeId = 0;
const dataframes = new Map();

function makeRuntime() {
  prints = [];
  dataframes.clear();
  dataframeId = 0;
  runtime = new TeraRuntime({ output: text => prints.push(String(text)) });
  runtime.registerGlobal('chart', createChartApi());
}

makeRuntime();

self.onmessage = async event => {
  const { id, type, payload } = event.data || {};
  try {
    let result;
    if (type === 'execute') result = await execute(payload.source);
    else if (type === 'restart') result = restart();
    else if (type === 'completionNames') result = completionNames();
    else if (type === 'beginCsv') result = beginCsv(payload.name);
    else if (type === 'appendCsvRows') result = appendCsvRows(payload.name, payload.rows);
    else if (type === 'finishCsv') result = finishCsv(payload.name);
    else if (type === 'writeFile') result = writeFile(payload);
    else if (type === 'removeFile') result = removeFile(payload.name, payload.kind);
    else if (type === 'dataframePage') result = await dataframePage(payload.id, payload.offset, payload.limit);
    else throw new Error(`Unknown kernel message '${type}'`);
    self.postMessage({ id, ok: true, result });
  } catch (error) {
    self.postMessage({ id, ok: false, error: error?.message || String(error) });
  }
};

async function execute(source) {
  prints = [];
  const value = await runtime.execute(source);
  return {
    prints: prints.slice(),
    value: await serializeValue(value),
    completionNames: completionNames(),
  };
}

function restart() {
  makeRuntime();
  return { completionNames: completionNames() };
}

function completionNames() {
  return runtime.getCompletionNames();
}

const csvBuilders = new Map();

function beginCsv(name) {
  csvBuilders.set(name, runtime.beginUploadedCsv(name));
  return true;
}

function appendCsvRows(name, rows) {
  const builder = csvBuilders.get(name);
  if (!builder) throw new Error(`CSV upload not started: ${name}`);
  builder.appendRows(rows);
  return true;
}

function finishCsv(name) {
  const builder = csvBuilders.get(name);
  if (!builder) throw new Error(`CSV upload not started: ${name}`);
  builder.finish();
  csvBuilders.delete(name);
  return true;
}

function writeFile({ name, data, binary }) {
  if (binary) memfs.writeBinary(name, new Uint8Array(data));
  else memfs.writeFile(name, data);
  return true;
}

function removeFile(name, kind) {
  if (kind === 'csv') runtime.removeUploadedCsv(name);
  else memfs.remove(name);
  return true;
}

async function serializeValue(value) {
  if (value === undefined) return { kind: 'empty' };
  if (value && value.__isFigureBuilder) value = await value.build();
  if (isChartSpec(value)) return { kind: 'chart', spec: value };
  if (isDataFrame(value)) {
    const id = `df-${++dataframeId}`;
    dataframes.set(id, value);
    const columns = await value.columns();
    const total = await value.count();
    return { kind: 'dataframe', id, columns, total };
  }
  return { kind: 'text', text: formatValue(value) };
}

async function dataframePage(id, offset = 0, limit = 25) {
  const df = dataframes.get(id);
  if (!df) throw new Error('DataFrame result expired');
  const rows = await df.limit(limit, offset).collect();
  return { rows };
}

function isDataFrame(value) {
  return value && typeof value.limit === 'function' && typeof value.collect === 'function' && typeof value.count === 'function';
}
