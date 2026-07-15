import * as fw from '../index.js';
import {
  createEngine, DataFrame, Col, InMemoryRelation,
  col as qcol, lit as qlit, expr as qexpr,
  sum as qsum, avg as qavg, min as qmin, max as qmax, count as qcount, countStar as qcountStar,
} from '@slexisvn/query-engine';
import { loadCsvRows } from './csv.js';
import { takeNamed } from './named_args.js';

export { DataFrame, Col };

let _engine = null;
function engine() {
  return _engine ?? (_engine = createEngine());
}

export function createDataFrame(rows) {
  return engine().createDataFrame(rows);
}

let _uploadTableId = 0;
function registerColumnsAsTable(columns) {
  const eng = engine();
  const relation = InMemoryRelation.fromColumns(columns);
  const name = `__upload${_uploadTableId++}`;
  eng.catalog.registerTable(name, relation.getSchema());
  eng.catalog.registerTableStorage(name, relation);
  return name;
}

function dropTable(name) {
  const eng = engine();
  const key = name.toUpperCase();
  eng.catalog.tables?.delete(key);
  eng.catalog.tableStorage?.delete(key);
}

export function createDataFrameFromColumns(columns) {
  return engine().sql(`SELECT * FROM ${registerColumnsAsTable(columns)}`);
}

const _uploadedCsv = new Map();
export function setUploadedCsv(name, columns) { _uploadedCsv.set(name, registerColumnsAsTable(columns)); }

export function beginUploadedCsv(name) {
  const builder = InMemoryRelation.builder();
  return {
    appendRows(rows) { if (rows && rows.length) builder.appendRows(rows); },
    finish() {
      const relation = builder.finish();
      const eng = engine();
      const table = `__upload${_uploadTableId++}`;
      eng.catalog.registerTable(table, relation.getSchema());
      eng.catalog.registerTableStorage(table, relation);
      const old = _uploadedCsv.get(name);
      if (old) dropTable(old);
      _uploadedCsv.set(name, table);
    },
  };
}
export function removeUploadedCsv(name) {
  const table = _uploadedCsv.get(name);
  if (table) dropTable(table);
  _uploadedCsv.delete(name);
}

export const COLUMN_AGGREGATES = ['sum', 'min', 'max'];
const AGG_FNS = { sum: qsum, min: qmin, max: qmax };

function isColumnArg(value) {
  return typeof value === 'string' || value instanceof Col;
}

DataFrame.prototype.toString = function () {
  return `DataFrame(${this.columns().join(', ')})`;
};

DataFrame.prototype.head = function (n = 5) {
  return this.limit(n);
};

async function dfToTensor(df, cols) {
  const frame = cols.length > 0 ? df.select(...cols) : df;
  const names = frame.columns();
  const rows = await frame.collect();
  const k = names.length;
  const n = rows.length;
  const flat = new Float32Array(n * k);
  let idx = 0;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < k; c++) {
      const v = rows[r][names[c]];
      if (typeof v !== 'number') {
        throw new Error(`Column '${names[c]}' contains non-numeric value '${v}' at row ${r}. Use encode() for categorical columns.`);
      }
      flat[idx++] = v;
    }
  }
  return fw.tensor(flat, { shape: [n, k] });
}

async function dfEncode(df, column, knownClasses) {
  const name = column ?? df.columns()[0];
  const rows = await df.collect();
  const classMap = new Map();
  const classes = knownClasses ? [...knownClasses] : [];
  for (let i = 0; i < classes.length; i++) classMap.set(String(classes[i]), i);
  const encoded = new Float32Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const key = String(rows[i][name]);
    let idx = classMap.get(key);
    if (idx === undefined) {
      if (knownClasses) throw new Error(`Unknown class '${rows[i][name]}' not present in fitted classes`);
      idx = classes.length;
      classMap.set(key, idx);
      classes.push(rows[i][name]);
    }
    encoded[i] = idx;
  }
  return [fw.tensor(encoded, { shape: [encoded.length] }), classes];
}

DataFrame.prototype.toTensor = function (...cols) { return dfToTensor(this, cols); };
DataFrame.prototype.to_tensor = DataFrame.prototype.toTensor;
DataFrame.prototype.to_array = function () { return this.toArray(); };
DataFrame.prototype.encode = function (column, ...rest) {
  const named = takeNamed(rest);
  const knownClasses = named.classes ?? rest[0] ?? null;
  return dfEncode(this, column, knownClasses);
};

export function installQueryBuiltins(define) {
  for (const name of COLUMN_AGGREGATES) {
    define(name, input => {
      if (!isColumnArg(input)) throw new Error(`${name}() expects a DataFrame column; call tensor.${name}() for tensors`);
      return AGG_FNS[name](input);
    });
  }

  define('DataFrame', (...args) => {
    const named = takeNamed(args);
    delete named.__named;
    const colNames = Object.keys(named);
    if (colNames.length === 0) {
      throw new Error('DataFrame() requires named column arrays, e.g. DataFrame(name=[...], age=[...])');
    }
    const n = named[colNames[0]].length;
    const rows = [];
    for (let r = 0; r < n; r++) {
      const row = {};
      for (const c of colNames) row[c] = named[c][r];
      rows.push(row);
    }
    return createDataFrame(rows);
  });

  define('col', name => qcol(name));
  define('lit', value => qlit(value));
  define('expr', sql => qexpr(sql));
  define('avg', column => qavg(column));
  define('count', column => qcount(column));
  define('countStar', () => qcountStar());

  define('load_csv', (...args) => {
    const named = takeNamed(args);
    delete named.__named;
    const path = args[0];
    if (typeof path !== 'string') throw new Error('load_csv() requires a file path string');
    if (_uploadedCsv.has(path)) return engine().sql(`SELECT * FROM ${_uploadedCsv.get(path)}`);
    const sep = named.separator ?? named.sep ?? ',';
    const { rows } = loadCsvRows(path, sep);
    return createDataFrame(rows);
  });
}

export const QUERY_SIGNATURES = {
  load_csv: [{ name: 'path' }, { name: 'separator', defaultValue: '","', isOptional: true }],
  DataFrame: [{ name: 'columns' }],
  col: [{ name: 'name' }],
  lit: [{ name: 'value' }],
  expr: [{ name: 'sql' }],
  avg: [{ name: 'column' }],
  count: [{ name: 'column' }],
  countStar: [],
};
