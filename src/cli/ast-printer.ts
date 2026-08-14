type AstNode = { type: string } & Record<string, unknown>;

function isNode(value: unknown): value is AstNode {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function isBranch(value: unknown): boolean {
  return (isNode(value) || Array.isArray(value)) && value !== null;
}

function formatScalar(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function inlineScalars(node: AstNode): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "type" || isBranch(value)) continue;
    parts.push(`${key}=${formatScalar(value)}`);
  }
  return parts.join(" ");
}

function render(
  value: unknown,
  label: string,
  indent: string,
  seen: WeakSet<object>,
  lines: string[],
): void {
  const prefix = label ? `${label}: ` : "";

  if (isNode(value)) {
    if (seen.has(value)) {
      lines.push(`${indent}${prefix}${value.type} <cycle>`);
      return;
    }
    seen.add(value);
    const scalars = inlineScalars(value);
    lines.push(`${indent}${prefix}${value.type}${scalars ? "  " + scalars : ""}`);
    for (const [key, child] of Object.entries(value)) {
      if (key === "type" || !isBranch(child)) continue;
      render(child, key, indent + "  ", seen, lines);
    }
    return;
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      lines.push(`${indent}${prefix}[cycle]`);
      return;
    }
    seen.add(value);
    lines.push(`${indent}${prefix}[${value.length}]`);
    for (const item of value) render(item, "", indent + "  ", seen, lines);
    return;
  }

  lines.push(`${indent}${prefix}${formatScalar(value)}`);
}

export function printAst(root: unknown): string {
  const lines: string[] = [];
  render(root, "", "", new WeakSet(), lines);
  return lines.join("\n");
}
