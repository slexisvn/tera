import { Tensor } from '../tensor/core/tensor.js';
import { Module } from '../nn/module.js';

export function formatValueCompact(value) {
  if (value instanceof Tensor) {
    if (value.ndim === 0 && value.data) return String(value.item());
    if (value.numel <= 64 && value.data) return JSON.stringify(value.toArray());
    const device = String(value.device);
    const deviceText = device === 'cpu' ? '' : `, device=${device}`;
    return `Tensor(shape=[${value.shape.join(', ')}], dtype=${value.dtype}${deviceText})`;
  }
  return formatValue(value);
}

export function formatValue(value) {
  if (value instanceof Tensor) {
    const device = String(value.device);
    const deviceText = device === 'cpu' ? '' : `, device=${device}`;
    if (value.ndim === 0 && value.data) {
      return `Tensor(${value.item()}, dtype=${value.dtype}${deviceText})`;
    }
    const header = `Tensor(shape=[${value.shape.join(', ')}], dtype=${value.dtype}${deviceText})`;
    if (value.numel <= 64 && value.data) return `${header}\n${JSON.stringify(value.toArray())}`;
    return header;
  }
  if (value instanceof Module) return value.toString();
  if (value instanceof CompiledProgramView) return value.toString();
  if (typeof value === 'function' && value._isCompiled) {
    const view = value._compiledView;
    if (view) return view.toString();
    return '<compiled model (lazy)>';
  }
  if (typeof value === 'function') {
    const name = value._langName || value.name || 'anonymous';
    return `<fn ${name}>`;
  }
  if (Array.isArray(value)) return JSON.stringify(value);
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Map) {
    const entries = [...value.entries()].map(([key, item]) => `${key}: ${formatInline(item)}`);
    return `{${entries.join(', ')}}`;
  }
  if (value && value.constructor === Object) return JSON.stringify(value);
  return String(value);
}

function formatInline(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value instanceof Map || Array.isArray(value)) return formatValue(value);
  if (value instanceof Tensor && value.ndim === 0 && value.data) return String(value.item());
  return formatValue(value);
}

export class CompiledProgramView {
  constructor(data) { Object.assign(this, data); }

  toString() {
    const kernels = this.result.listKernels();
    const total = this.events
      .filter(e => e.type === 'phase' && e.action === 'end')
      .reduce((sum, e) => sum + (e.durationMs || 0), 0);
    return `Compiled(target=${this.target}, kernels=${kernels.length}, trace_events=${this.events.length}, ${total.toFixed(2)} ms)`;
  }
}

export function formatTrace(events) {
  const lines = ['Compile trace'];
  for (const event of events) {
    if (event.type === 'phase' && event.action === 'end') {
      lines.push(`  ${event.phase.padEnd(16)} ${event.durationMs.toFixed(2)} ms`);
    } else if (event.type === 'pass') {
      const ops = event.opCountBefore >= 0 ? ` ${event.opCountBefore} -> ${event.opCountAfter} ops` : '';
      lines.push(`  ${event.passName.padEnd(24)} ${event.changed ? 'changed' : 'unchanged'}${ops}`);
    } else if (event.type === 'codegen') {
      lines.push(`  codegen:${event.funcName.padEnd(12)} ${event.sourceSize} bytes`);
    } else if (event.type === 'memory') {
      lines.push(`  memory:${event.funcName.padEnd(13)} peak ${event.peakMemory} bytes`);
    } else if (event.type === 'ir_snapshot') {
      lines.push(`\n[${event.label}]\n${event.text}`);
    } else if (event.type === 'error') {
      lines.push(`  ERROR ${event.phase}: ${event.message}`);
    }
  }
  return lines.join('\n');
}
