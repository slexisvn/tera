import { TeraRuntime, formatValue, memfs } from '../dist/index.js';
import { createChartApi, isChartSpec } from './chart/index.js';

const DF_PREVIEW_ROWS = 50;

function isDataFrame(value) {
  return value && typeof value.limit === 'function' && typeof value.collect === 'function' && typeof value.count === 'function';
}

async function serializeValue(value) {
  if (value === undefined) return { kind: 'empty' };
  if (value && value.__isFigureBuilder) value = await value.build();
  if (isChartSpec(value)) return { kind: 'chart', spec: value };
  if (isDataFrame(value)) {
    const columns = await value.columns();
    const total = await value.count();
    const rows = await value.limit(DF_PREVIEW_ROWS, 0).collect();
    return { kind: 'dataframe', columns, total, rows };
  }
  return { kind: 'text', text: formatValue(value) };
}

export function createKernel() {
  let prints = [];
  let runtime = null;

  function make() {
    prints = [];
    runtime = new TeraRuntime({ output: (text) => prints.push(String(text)) });
    runtime.registerGlobal('chart', createChartApi());
  }

  make();

  return {
    async execute(source) {
      prints = [];
      const value = await runtime.execute(source);
      return { prints: prints.slice(), value: await serializeValue(value) };
    },
    restart() {
      make();
    },
    writeFile(name, data, binary) {
      if (binary) memfs.writeBinary(name, new Uint8Array(data));
      else memfs.writeFile(name, data);
    },
  };
}
