export const JSON_NAMESPACE = "JSON";
export const JSON_PARSE_MEMBER = "parse";

const PREFIX = "_json";
const CURSOR = `${PREFIX}_at`;
const PRINTABLE = `${PREFIX}_printable`;
const FIRST_PRINTABLE = 32;
const LAST_PRINTABLE = 126;

export type JsonFieldSurface = {
  readonly name: string;
  readonly type: string;
};

export type JsonShapeSurface = {
  readonly name: string;
  readonly fields: readonly JsonFieldSurface[];
};

const SCALAR_READERS: ReadonlyMap<string, string> = new Map<string, string>([
  ["int", `${PREFIX}_int`],
  ["float", `${PREFIX}_number`],
  ["bool", `${PREFIX}_bool`],
  ["boolean", `${PREFIX}_bool`],
  ["string", `${PREFIX}_string`],
]);

const SCALAR_DEFAULTS: ReadonlyMap<string, string> = new Map<string, string>([
  ["int", "0"],
  ["float", "0.0"],
  ["bool", "false"],
  ["boolean", "false"],
  ["string", `""`],
]);

const DECLARED_SPELLING: ReadonlyMap<string, string> = new Map<string, string>([
  ["boolean", "bool"],
]);

export function jsonParserName(shape: string): string {
  return `${PREFIX}_parse_${shape}`;
}

function readerName(shape: string): string {
  return `${PREFIX}_read_${shape}`;
}

function fillName(shape: string): string {
  return `${PREFIX}_fill_${shape}`;
}

function listName(element: string): string {
  return `${PREFIX}_list_${element}`;
}

export function jsonElementTypeOf(type: string): string | null {
  const trimmed = type.trim();
  return trimmed.endsWith("[]") ? trimmed.slice(0, -2).trim() : null;
}

export function jsonScalarTypes(): ReadonlySet<string> {
  return new Set(SCALAR_READERS.keys());
}

function declaredSpelling(type: string): string {
  const element = jsonElementTypeOf(type);
  if (element !== null) return `${declaredSpelling(element)}[]`;
  return DECLARED_SPELLING.get(type) ?? type;
}

function printableTable(): string {
  const spelled: string[] = [];
  for (let code = FIRST_PRINTABLE; code <= LAST_PRINTABLE; code++) {
    const character = String.fromCharCode(code);
    spelled.push(character === `"` || character === "\\" ? `\\${character}` : character);
  }
  return spelled.join("");
}

function supportSource(): readonly string[] {
  return [
    `${CURSOR}: int = 0`,
    "",
    `fn ${PRINTABLE}(code: int) -> string:`,
    `  return "${printableTable()}"[code - ${FIRST_PRINTABLE}]`,
    "",
    `fn ${PREFIX}_fail(at: int) -> void:`,
    `  throw "invalid JSON at position " + at`,
    "",
    `fn ${PREFIX}_space(text: string) -> void:`,
    `  while ${CURSOR} < text.length:`,
    `    c: int = text.char_code_at(${CURSOR})`,
    "    if c != 32 and c != 9 and c != 10 and c != 13:",
    "      return",
    `    ${CURSOR} = ${CURSOR} + 1`,
    "",
    `fn ${PREFIX}_expect(text: string, code: int) -> void:`,
    `  ${PREFIX}_space(text)`,
    `  if ${CURSOR} >= text.length:`,
    `    ${PREFIX}_fail(${CURSOR})`,
    `  if text.char_code_at(${CURSOR}) != code:`,
    `    ${PREFIX}_fail(${CURSOR})`,
    `  ${CURSOR} = ${CURSOR} + 1`,
    "",
    `fn ${PREFIX}_digit(text: string, at: int) -> int:`,
    "  c: int = text.char_code_at(at)",
    "  if c >= 48 and c <= 57:",
    "    return c - 48",
    "  if c >= 97 and c <= 102:",
    "    return c - 87",
    "  if c >= 65 and c <= 70:",
    "    return c - 55",
    `  ${PREFIX}_fail(at)`,
    "  return 0",
    "",
    `fn ${PREFIX}_escape(text: string) -> string:`,
    `  if ${CURSOR} >= text.length:`,
    `    ${PREFIX}_fail(${CURSOR})`,
    `  c: int = text.char_code_at(${CURSOR})`,
    `  ${CURSOR} = ${CURSOR} + 1`,
    "  if c == 110:",
    `    return "\\n"`,
    "  if c == 116:",
    `    return "\\t"`,
    "  if c == 114:",
    `    return "\\r"`,
    "  if c == 117:",
    `    if ${CURSOR} + 4 > text.length:`,
    `      ${PREFIX}_fail(${CURSOR})`,
    "    code: int = 0",
    "    taken: int = 0",
    "    while taken < 4:",
    `      code = code * 16 + ${PREFIX}_digit(text, ${CURSOR} + taken)`,
    "      taken = taken + 1",
    `    ${CURSOR} = ${CURSOR} + 4`,
    `    if code < ${FIRST_PRINTABLE} or code > ${LAST_PRINTABLE}:`,
    `      throw "JSON escape is outside the range the compiler can spell"`,
    `    return ${PRINTABLE}(code)`,
    `  if c < ${FIRST_PRINTABLE} or c > ${LAST_PRINTABLE}:`,
    `    ${PREFIX}_fail(${CURSOR})`,
    `  return ${PRINTABLE}(c)`,
    "",
    `fn ${PREFIX}_string(text: string) -> string:`,
    `  ${PREFIX}_expect(text, 34)`,
    `  out = ""`,
    `  while ${CURSOR} < text.length:`,
    `    c: int = text.char_code_at(${CURSOR})`,
    "    if c == 34:",
    `      ${CURSOR} = ${CURSOR} + 1`,
    "      return out",
    `    piece: string = ""`,
    "    if c == 92:",
    `      ${CURSOR} = ${CURSOR} + 1`,
    `      piece = ${PREFIX}_escape(text)`,
    "    else:",
    `      piece = text[${CURSOR}]`,
    `      ${CURSOR} = ${CURSOR} + 1`,
    "    out = out + piece",
    `  ${PREFIX}_fail(${CURSOR})`,
    "  return out",
    "",
    `fn ${PREFIX}_pass_string(text: string) -> void:`,
    `  ${PREFIX}_expect(text, 34)`,
    `  while ${CURSOR} < text.length:`,
    `    c: int = text.char_code_at(${CURSOR})`,
    `    ${CURSOR} = ${CURSOR} + 1`,
    "    if c == 92:",
    `      ${CURSOR} = ${CURSOR} + 1`,
    "    else if c == 34:",
    "      return",
    `  ${PREFIX}_fail(${CURSOR})`,
    "",
    `fn ${PREFIX}_number(text: string) -> float:`,
    `  ${PREFIX}_space(text)`,
    `  start: int = ${CURSOR}`,
    "  seen: int = 0",
    `  while ${CURSOR} < text.length:`,
    `    c: int = text.char_code_at(${CURSOR})`,
    "    if c >= 48 and c <= 57 or c == 45 or c == 43 or c == 46 or c == 101 or c == 69:",
    `      ${CURSOR} = ${CURSOR} + 1`,
    "      seen = seen + 1",
    "    else:",
    "      break",
    "  if seen == 0:",
    `    ${PREFIX}_fail(start)`,
    `  return parse_float(text.slice(start, ${CURSOR}))`,
    "",
    `fn ${PREFIX}_int(text: string) -> int:`,
    `  ${PREFIX}_space(text)`,
    `  start: int = ${CURSOR}`,
    "  sign: int = 1",
    `  if ${CURSOR} < text.length and text.char_code_at(${CURSOR}) == 45:`,
    "    sign = -1",
    `    ${CURSOR} = ${CURSOR} + 1`,
    "  seen: int = 0",
    "  whole: int = 0",
    `  while ${CURSOR} < text.length:`,
    `    c: int = text.char_code_at(${CURSOR})`,
    "    if c < 48 or c > 57:",
    "      break",
    "    whole = whole * 10 + c - 48",
    "    seen = seen + 1",
    `    ${CURSOR} = ${CURSOR} + 1`,
    "  if seen == 0:",
    `    ${PREFIX}_fail(start)`,
    `  while ${CURSOR} < text.length:`,
    `    c: int = text.char_code_at(${CURSOR})`,
    "    if c >= 48 and c <= 57 or c == 46 or c == 101 or c == 69 or c == 43 or c == 45:",
    `      ${CURSOR} = ${CURSOR} + 1`,
    "    else:",
    "      break",
    "  return whole * sign",
    "",
    `fn ${PREFIX}_bool(text: string) -> bool:`,
    `  ${PREFIX}_space(text)`,
    `  if text.slice(${CURSOR}, ${CURSOR} + 4) == "true":`,
    `    ${CURSOR} = ${CURSOR} + 4`,
    "    return true",
    `  if text.slice(${CURSOR}, ${CURSOR} + 5) == "false":`,
    `    ${CURSOR} = ${CURSOR} + 5`,
    "    return false",
    `  ${PREFIX}_fail(${CURSOR})`,
    "  return false",
    "",
    `fn ${PREFIX}_skip(text: string) -> void:`,
    `  ${PREFIX}_space(text)`,
    `  if ${CURSOR} >= text.length:`,
    `    ${PREFIX}_fail(${CURSOR})`,
    `  first: int = text.char_code_at(${CURSOR})`,
    "  if first == 34:",
    `    ${PREFIX}_pass_string(text)`,
    "    return",
    "  if first == 123 or first == 91:",
    "    depth: int = 0",
    `    while ${CURSOR} < text.length:`,
    `      c: int = text.char_code_at(${CURSOR})`,
    "      if c == 34:",
    `        ${PREFIX}_pass_string(text)`,
    "      else:",
    "        if c == 123 or c == 91:",
    "          depth = depth + 1",
    "        else if c == 125 or c == 93:",
    "          depth = depth - 1",
    `        ${CURSOR} = ${CURSOR} + 1`,
    "        if depth == 0:",
    "          return",
    `    ${PREFIX}_fail(${CURSOR})`,
    "    return",
    `  while ${CURSOR} < text.length:`,
    `    c: int = text.char_code_at(${CURSOR})`,
    "    if c == 44 or c == 125 or c == 93 or c == 32 or c == 9 or c == 10 or c == 13:",
    "      return",
    `    ${CURSOR} = ${CURSOR} + 1`,
    "",
  ];
}

function emptyName(element: string): string {
  return `${PREFIX}_empty_${element}`;
}

function listSource(element: string, reader: string): readonly string[] {
  const declared = declaredSpelling(element);
  return [
    `fn ${emptyName(element)}() -> ${declared}[]:`,
    `  out: ${declared}[] = []`,
    "  return out",
    "",
    `fn ${listName(element)}(text: string) -> ${declared}[]:`,
    `  out: ${declared}[] = ${emptyName(element)}()`,
    `  ${PREFIX}_expect(text, 91)`,
    `  ${PREFIX}_space(text)`,
    `  if ${CURSOR} < text.length and text.char_code_at(${CURSOR}) == 93:`,
    `    ${CURSOR} = ${CURSOR} + 1`,
    "    return out",
    "  while true:",
    `    out.push(${reader}(text))`,
    `    ${PREFIX}_space(text)`,
    `    if ${CURSOR} >= text.length:`,
    `      ${PREFIX}_fail(${CURSOR})`,
    `    c: int = text.char_code_at(${CURSOR})`,
    `    ${CURSOR} = ${CURSOR} + 1`,
    "    if c == 93:",
    "      return out",
    "    if c != 44:",
    `      ${PREFIX}_fail(${CURSOR})`,
    "  return out",
    "",
  ];
}

function shapeSource(
  shape: JsonShapeSurface,
  reader: (type: string) => string,
  spelledDefault: (type: string) => string,
): readonly string[] {
  const defaults = shape.fields
    .map((field) => `${field.name}: ${spelledDefault(field.type)}`)
    .join(", ");
  const dispatch: string[] = [];
  const stores: string[] = [];
  shape.fields.forEach((field, at) => {
    dispatch.push(`    ${at === 0 ? "if" : "else if"} key == "${field.name}":`);
    dispatch.push(`      which = ${at + 1}`);
    stores.push(`    ${at === 0 ? "if" : "else if"} which == ${at + 1}:`);
    stores.push(`      out.${field.name} = ${reader(field.type)}(text)`);
  });
  stores.push("    else:");
  stores.push(`      ${PREFIX}_skip(text)`);
  return [
    `fn ${fillName(shape.name)}(out: ${shape.name}, text: string) -> ${shape.name}:`,
    `  ${PREFIX}_expect(text, 123)`,
    `  ${PREFIX}_space(text)`,
    `  if ${CURSOR} < text.length and text.char_code_at(${CURSOR}) == 125:`,
    `    ${CURSOR} = ${CURSOR} + 1`,
    "    return out",
    "  while true:",
    `    key = ${PREFIX}_string(text)`,
    "    which: int = 0",
    ...dispatch,
    `    ${PREFIX}_expect(text, 58)`,
    ...stores,
    `    ${PREFIX}_space(text)`,
    `    if ${CURSOR} >= text.length:`,
    `      ${PREFIX}_fail(${CURSOR})`,
    `    c: int = text.char_code_at(${CURSOR})`,
    `    ${CURSOR} = ${CURSOR} + 1`,
    "    if c == 125:",
    "      return out",
    "    if c != 44:",
    `      ${PREFIX}_fail(${CURSOR})`,
    "  return out",
    "",
    `fn ${readerName(shape.name)}(text: string) -> ${shape.name}:`,
    `  return ${fillName(shape.name)}({ ${defaults} }, text)`,
    "",
    `fn ${jsonParserName(shape.name)}(text: string) -> ${shape.name}:`,
    `  ${CURSOR} = 0`,
    `  held: ${shape.name} = ${readerName(shape.name)}(text)`,
    `  ${PREFIX}_space(text)`,
    `  if ${CURSOR} != text.length:`,
    `    ${PREFIX}_fail(${CURSOR})`,
    "  return held",
    "",
  ];
}

export function jsonPrelude(shapes: readonly JsonShapeSurface[]): string {
  if (shapes.length === 0) return "";
  const byName = new Map(shapes.map((shape) => [shape.name, shape]));
  const spelling = new Set<string>();

  const spelledDefault = (type: string): string => {
    const scalar = SCALAR_DEFAULTS.get(type);
    if (scalar !== undefined) return scalar;
    const element = jsonElementTypeOf(type);
    if (element !== null) return `${emptyName(element)}()`;
    const shape = byName.get(type);
    if (shape === undefined || spelling.has(type)) return "0";
    spelling.add(type);
    const spelled = shape.fields
      .map((field) => `${field.name}: ${spelledDefault(field.type)}`)
      .join(", ");
    spelling.delete(type);
    return `{ ${spelled} }`;
  };

  const reader = (type: string): string => {
    const scalar = SCALAR_READERS.get(type);
    if (scalar !== undefined) return scalar;
    const element = jsonElementTypeOf(type);
    return element === null ? readerName(type) : listName(element);
  };

  const lists = new Set<string>();
  for (const shape of shapes) {
    for (const field of shape.fields) {
      const element = jsonElementTypeOf(field.type);
      if (element !== null) lists.add(element);
    }
  }

  const source = [...supportSource()];
  for (const shape of shapes) source.push(...shapeSource(shape, reader, spelledDefault));
  for (const element of lists) source.push(...listSource(element, reader(element)));
  return `${source.join("\n")}\n`;
}
