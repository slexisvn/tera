export type IrToken = {
  readonly text: string;
  readonly cls: string;
};

const TOKEN =
  /(v\d+|B\d+|!fs|loop-header|"(?:\\.|[^"\n])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?n?|[A-Za-z_$][\w$]*|(?:[^\sA-Za-z0-9_$"-]|-(?!\d))+|\s+)/g;
const KEYWORDS = new Set(["fn", "graph", "params", "succs", "preds"]);

export function highlightIr(line: string): readonly IrToken[] {
  const tokens: IrToken[] = [];
  TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  let afterEquals = false;
  while ((match = TOKEN.exec(line)) !== null) {
    const text = match[0];
    if (text.trim() === "") {
      tokens.push({ text, cls: "" });
      continue;
    }
    tokens.push({ text, cls: classOf(text, afterEquals) });
    if (text === "=") afterEquals = true;
    else if (/\S/.test(text) && afterEquals && /^[A-Za-z_$]/.test(text)) afterEquals = false;
  }
  return tokens;
}

function classOf(text: string, afterEquals: boolean): string {
  if (/^v\d+$/.test(text)) return "ir-value";
  if (/^B\d+$/.test(text)) return "ir-block";
  if (text === "!fs") return "ir-frame-state";
  if (text === "loop-header") return "ir-flag";
  if (text.startsWith('"')) return "ir-string";
  if (/^-?\d/.test(text)) return "ir-number";
  if (KEYWORDS.has(text)) return "ir-keyword";
  if (afterEquals && /^[A-Z]/.test(text)) return "ir-opcode";
  if (/^[A-Za-z_$]/.test(text)) return "ir-prop";
  return "ir-punct";
}
