import { Tensor } from "@slexisvn/mlfw";

const INLINE_ELEMENT_LIMIT = 64;
const DEFAULT_DEVICE = "cpu";

function deviceSuffix(tensor: Tensor): string {
  const device = String(tensor.device);
  return device === DEFAULT_DEVICE ? "" : `, device=${device}`;
}

function tensorHeader(tensor: Tensor): string {
  return `Tensor(shape=[${tensor.shape.join(", ")}], dtype=${tensor.dtype}${deviceSuffix(tensor)})`;
}

function inlineElements(tensor: Tensor): string | undefined {
  if (!tensor.data || tensor.numel > INLINE_ELEMENT_LIMIT) return undefined;
  return JSON.stringify(tensor.toArray());
}

function formatTensor(tensor: Tensor, compact: boolean): string {
  if (tensor.ndim === 0 && tensor.data) {
    const scalar = tensor.item();
    return compact ? String(scalar) : `Tensor(${scalar}, dtype=${tensor.dtype}${deviceSuffix(tensor)})`;
  }
  const header = tensorHeader(tensor);
  const elements = inlineElements(tensor);
  if (elements === undefined) return header;
  return compact ? elements : `${header}\n${elements}`;
}

export function formatHostValue(value: unknown, compact: boolean): string | undefined {
  if (value instanceof Tensor) return formatTensor(value, compact);
  return undefined;
}
