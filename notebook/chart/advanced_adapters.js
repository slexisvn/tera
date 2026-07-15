import { isDataFrame, isTensor } from './adapters.js';
import { MAX_POINTS } from './spec.js';
import { boxSummary, correlationMatrix, kde, linearRegression, makeHexbins } from './statistics.js';

export async function adaptDistribution(data, config, includeDensity = false) {
  const groups = await numericGroups(data, config.x, config.color);
  const whisker = config.whisker == null ? 1.5 : Number(config.whisker);
  return groups.map(group => {
    const summary = boxSummary(group.values, whisker);
    const density = includeDensity ? kde(group.values, config.bandwidth) : null;
    return { name: group.name, count: group.values.length, missing: group.missing, summary, density };
  });
}

export async function adaptDensity(data, config) {
  const groups = await numericGroups(data, config.x, config.color);
  return groups.map(group => {
    const density = kde(group.values, config.bandwidth);
    return { name: group.name, points: density.points, count: group.values.length, missing: group.missing, bandwidth: density.bandwidth };
  });
}

export async function adaptEcdf(data, config) {
  const groups = await numericGroups(data, config.x, config.color);
  return groups.map(group => {
    const values = [...group.values].sort((a, b) => a - b);
    const n = values.length;
    return {
      name: group.name,
      points: values.map((value, index) => ({ x: value, y: (index + 1) / n })),
      count: n,
      missing: group.missing,
    };
  });
}

export async function adaptCorrelation(data, config) {
  if (!isDataFrame(data)) throw new Error('chart.correlation expects a DataFrame');
  const schema = data.schema();
  const fields = schema?._fields ?? schema?.fields ?? [];
  const numeric = fields.filter(field => ['INT32', 'INT64', 'FLOAT64', 'DECIMAL'].includes(String(field.dataType))).map(field => field.name);
  const columns = config.columns == null ? numeric : normalizeColumns(config.columns);
  if (columns.length < 2) throw new Error('chart.correlation requires at least two numeric columns');
  for (const column of columns) {
    if (!numeric.includes(column)) throw new Error(`Correlation column '${column}' is not numeric`);
  }
  const count = Number(await data.count());
  ensureLimit(count);
  const rows = await data.select(...columns).collect();
  const method = config.method ?? 'pearson';
  return { columns, cells: correlationMatrix(rows, columns, method), method };
}

export async function adaptHexbin(data, config) {
  const series = await xyPoints(data, config.x, config.y);
  return { bins: makeHexbins(series.points, config.bins ?? 30), count: series.points.length, missing: series.missing };
}

export async function adaptRegression(data, config) {
  const series = await xyPoints(data, config.x, config.y);
  const fit = linearRegression(series.points);
  const points = { name: 'points', points: series.points };
  const line = fit ? { name: 'linear fit', points: fit.points, fit } : { name: 'linear fit', points: [], fit: null };
  return { series: [points, line], count: series.points.length, missing: series.missing, fit };
}

export async function adaptBubble(data, config) {
  if (isDataFrame(data)) {
    const x = requiredColumn(config.x, 'x');
    const y = requiredColumn(config.y, 'y');
    const size = requiredColumn(config.size ?? config.value, 'size');
    const columns = unique([x, y, size, config.color].filter(value => value != null));
    const count = Number(await data.count());
    ensureLimit(count);
    const rows = await data.select(...columns).collect();
    const groups = new Map();
    let missing = 0;
    for (const row of rows) {
      const groupName = config.color == null ? size : String(row[config.color] ?? 'NULL');
      if (!groups.has(groupName)) groups.set(groupName, { name: groupName, points: [] });
      if (validNumber(row[x]) && validNumber(row[y]) && validNumber(row[size])) {
        groups.get(groupName).points.push({ x: row[x], y: row[y], size: Math.abs(row[size]), value: row[size] });
      } else {
        missing++;
      }
    }
    return [...groups.values()].map(group => ({ ...group, missing }));
  }
  const rows = isTensor(data) ? data.toArray() : data;
  if (!Array.isArray(rows) || !Array.isArray(rows[0])) throw new Error('chart.bubble array data must be 2D');
  ensureLimit(rows.length);
  const xi = Number(config.x ?? 0);
  const yi = Number(config.y ?? 1);
  const si = Number(config.size ?? config.value ?? 2);
  const points = [];
  let missing = 0;
  for (const row of rows) {
    if (validNumber(row[xi]) && validNumber(row[yi]) && validNumber(row[si])) {
      points.push({ x: row[xi], y: row[yi], size: Math.abs(row[si]), value: row[si] });
    } else {
      missing++;
    }
  }
  return [{ name: 'bubble', points, missing }];
}

export async function adaptFunnel(data, config) {
  const steps = await orderedSteps(data, config.step ?? config.x, config.value ?? config.y, 'chart.funnel');
  const first = steps[0]?.value || 0;
  return {
    steps: steps.map((step, index) => ({
      ...step,
      index,
      rate: first === 0 ? 0 : step.value / first,
      previousRate: index === 0 || steps[index - 1].value === 0 ? null : step.value / steps[index - 1].value,
    })),
  };
}

export async function adaptWaterfall(data, config) {
  const rows = await orderedSteps(data, config.step ?? config.x, config.value ?? config.y, 'chart.waterfall');
  let total = 0;
  return {
    steps: rows.map((row, index) => {
      const start = total;
      total += row.value;
      return { ...row, index, start, end: total };
    }),
    total,
  };
}

export async function adaptHeatmap(data, config) {
  if (isDataFrame(data)) {
    const x = requiredColumn(config.x, 'x');
    const y = requiredColumn(config.y, 'y');
    const value = requiredColumn(config.value ?? config.z, 'value');
    const count = Number(await data.count());
    ensureLimit(count);
    const rows = await data.select(x, y, value).collect();
    const cells = [];
    for (const row of rows) {
      if (!validNumber(row[value])) continue;
      cells.push({ x: String(row[x]), y: String(row[y]), value: row[value], count: 1 });
    }
    return {
      columns: unique(cells.map(cell => cell.x)),
      rows: unique(cells.map(cell => cell.y)),
      cells,
      value,
    };
  }
  const rows = isTensor(data) ? data.toArray() : data;
  if (!Array.isArray(rows) || !Array.isArray(rows[0])) throw new Error('chart.heatmap expects a DataFrame or 2D array');
  ensureLimit(rows.length * rows[0].length);
  const height = rows.length;
  const width = rows[0].length;
  const cells = [];
  for (let rowIndex = 0; rowIndex < height; rowIndex++) {
    const row = rows[rowIndex];
    if (!Array.isArray(row) || row.length !== width) throw new Error('heatmap array rows must have equal length');
    for (let columnIndex = 0; columnIndex < width; columnIndex++) {
      if (validNumber(row[columnIndex])) cells.push({ x: String(columnIndex), y: String(rowIndex), value: row[columnIndex], count: 1 });
    }
  }
  return {
    columns: Array.from({ length: width }, (_, index) => String(index)),
    rows: Array.from({ length: height }, (_, index) => String(index)),
    cells,
    value: 'value',
  };
}

export function prepareSeriesMode(series, type, modeValue) {
  const allowed = type === 'area' ? ['overlay', 'stacked'] : ['grouped', 'stacked'];
  const mode = modeValue ?? allowed[0];
  if (!allowed.includes(mode)) throw new Error(`${type} mode must be ${allowed.map(value => `"${value}"`).join(' or ')}`);
  if (mode !== 'stacked') return { mode, series };
  const categories = [...new Set(series.flatMap(item => item.points.map(point => String(point.x))))];
  if (type === 'area') {
    const first = series[0]?.points.map(point => String(point.x)) ?? [];
    for (const item of series) {
      const current = item.points.map(point => String(point.x));
      if (current.length !== first.length || current.some((value, index) => value !== first[index])) {
        throw new Error('stacked area requires all series to have matching x values in the same order');
      }
    }
    return { mode, series };
  }
  return {
    mode,
    series: series.map(item => {
      const values = new Map(item.points.map(point => [String(point.x), point.y]));
      return { ...item, points: categories.map(category => ({ x: category, y: values.get(category) ?? 0 })) };
    }),
  };
}

async function numericGroups(data, x, color) {
  if (isDataFrame(data)) {
    if (typeof x !== 'string') throw new Error('Distribution charts require x="numeric_column"');
    const columns = [x, color].filter(value => value != null);
    const count = Number(await data.count());
    ensureLimit(count);
    const rows = await data.select(...columns).collect();
    const groups = new Map();
    for (const row of rows) {
      const name = color == null ? x : String(row[color] ?? 'NULL');
      if (!groups.has(name)) groups.set(name, { name, values: [], missing: 0 });
      const group = groups.get(name);
      if (validNumber(row[x])) group.values.push(row[x]);
      else group.missing++;
    }
    return [...groups.values()];
  }
  const values = isTensor(data) ? flatten(data.toArray()) : flatten(data);
  ensureLimit(values.length);
  const numeric = values.filter(validNumber);
  return [{ name: 'value', values: numeric, missing: values.length - numeric.length }];
}

async function xyPoints(data, x, y) {
  if (isDataFrame(data)) {
    if (typeof x !== 'string' || typeof y !== 'string') throw new Error('chart.hexbin requires x and y column names');
    const count = Number(await data.count());
    ensureLimit(count);
    const rows = await data.select(x, y).collect();
    const points = [];
    let missing = 0;
    for (const row of rows) {
      if (validNumber(row[x]) && validNumber(row[y])) points.push({ x: row[x], y: row[y] });
      else missing++;
    }
    return { points, missing };
  }
  const rows = isTensor(data) ? data.toArray() : data;
  if (!Array.isArray(rows) || !Array.isArray(rows[0])) throw new Error('chart.hexbin array data must be 2D');
  const xi = Number(x ?? 0);
  const yi = Number(y ?? 1);
  const points = [];
  let missing = 0;
  for (const row of rows) {
    if (validNumber(row[xi]) && validNumber(row[yi])) points.push({ x: row[xi], y: row[yi] });
    else missing++;
  }
  ensureLimit(rows.length);
  return { points, missing };
}

async function orderedSteps(data, stepColumn, valueColumn, label) {
  if (isDataFrame(data)) {
    const step = requiredColumn(stepColumn, 'step');
    const value = requiredColumn(valueColumn, 'value');
    const count = Number(await data.count());
    ensureLimit(count);
    const rows = await data.select(step, value).collect();
    const result = [];
    for (const row of rows) {
      if (validNumber(row[value])) result.push({ name: String(row[step]), value: row[value] });
    }
    return result;
  }
  const rows = isTensor(data) ? data.toArray() : data;
  if (!Array.isArray(rows) || !Array.isArray(rows[0])) throw new Error(`${label} array data must be 2D`);
  ensureLimit(rows.length);
  const si = Number(stepColumn ?? 0);
  const vi = Number(valueColumn ?? 1);
  return rows
    .filter(row => validNumber(row[vi]))
    .map(row => ({ name: String(row[si]), value: row[vi] }));
}

function requiredColumn(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`chart requires ${label}="column"`);
  return value;
}

function normalizeColumns(value) {
  const columns = Array.isArray(value) ? value : [value];
  if (columns.some(column => typeof column !== 'string')) throw new Error('columns must be an array of column names');
  return columns;
}

function unique(values) {
  return [...new Set(values)];
}

function flatten(value) {
  if (!Array.isArray(value)) return [value];
  return value.flat(Infinity);
}

function ensureLimit(count) {
  if (count > MAX_POINTS) throw new Error(`Chart has ${count} rows; maximum is ${MAX_POINTS}. Filter or sample the data before charting.`);
}

function validNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}
