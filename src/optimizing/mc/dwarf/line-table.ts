import type { IRSourcePosition } from "../../ir/index.js";
import { writeInteger } from "../buffer.js";
import { fixup, type FixupKind, type McFixup } from "../fixup.js";
import { bytesFragment, type McBytesFragment, type McFragment } from "../fragment.js";
import type { McModule } from "../module.js";
import { sleb128, uleb128 } from "./leb128.js";

export const DEBUG_LINE_SECTION = ".debug_line";
export const DEBUG_INFO_SECTION = ".debug_info";
export const DEBUG_ABBREV_SECTION = ".debug_abbrev";

const DW_LNS_COPY = 0x01;
const DW_LNS_ADVANCE_LINE = 0x03;
const DW_LNS_SET_FILE = 0x04;
const DW_LNS_SET_COLUMN = 0x05;
const DW_LNS_FIXED_ADVANCE_PC = 0x09;
const DW_LNE_END_SEQUENCE = 0x01;
const DW_LNE_SET_ADDRESS = 0x02;
const EXTENDED_PREFIX = 0x00;

const DWARF_VERSION = 4;
const OPCODE_BASE = 13;
const LINE_BASE = -5;
const LINE_RANGE = 14;
const MINIMUM_INSTRUCTION_BYTES = 1;
const OPERATIONS_PER_INSTRUCTION = 1;
const DEFAULT_IS_STMT = 1;
const STANDARD_OPCODE_LENGTHS = [0, 1, 1, 1, 1, 0, 0, 0, 1, 0, 0, 1];
const BYTE_MASK = 0xff;
const FIRST_FILE = 1;
const FIRST_LINE = 1;
const FIRST_COLUMN = 0;
const NO_ENTRY = 0;

const LENGTH_BYTES = 4;
const VERSION_BYTES = 2;
const LANGUAGE_BYTES = 2;
const ADVANCE_BYTES = 2;
const ADVANCE_LIMIT = 0xffff;
const SECTION_ALIGNMENT = 1;

const DW_TAG_COMPILE_UNIT = 0x11;
const DW_CHILDREN_NO = 0;
const DW_AT_NAME = 0x03;
const DW_AT_STMT_LIST = 0x10;
const DW_AT_LOW_PC = 0x11;
const DW_AT_HIGH_PC = 0x12;
const DW_AT_LANGUAGE = 0x13;
const DW_AT_COMP_DIR = 0x1b;
const DW_AT_PRODUCER = 0x25;
const DW_FORM_ADDR = 0x01;
const DW_FORM_DATA2 = 0x05;
const DW_FORM_DATA8 = 0x07;
const DW_FORM_STRING = 0x08;
const DW_FORM_SEC_OFFSET = 0x17;
const ABBREV_CODE = 1;
const ABBREV_END = 0;
const DW_LANG_C99 = 0x0c;
const PRODUCER = "tera";
const WORKING_DIRECTORY = "";
const ONLY_UNIT_OFFSET = 0;

export interface SourceLine {
  readonly fragment: McFragment;
  readonly source: IRSourcePosition;
}

export interface SourceUnit {
  readonly symbol: string;
  readonly entry: McFragment;
  readonly end: McFragment;
  readonly lines: readonly SourceLine[];
}

export interface DebugLineTarget {
  readonly addressFixup: FixupKind;
  readonly addressBytes: number;
}

interface PendingAdvance {
  readonly at: number;
  readonly from: McFragment;
  readonly to: McFragment;
}

function text(value: string): number[] {
  return [...new TextEncoder().encode(value), 0];
}

class FileTable {
  private readonly indexes = new Map<string, number>();

  indexOf(name: string): number {
    const known = this.indexes.get(name);
    if (known !== undefined) return known;
    const index = this.indexes.size + FIRST_FILE;
    this.indexes.set(name, index);
    return index;
  }

  get names(): readonly string[] {
    return [...this.indexes.keys()];
  }
}

class LineProgram {
  readonly bytes: number[] = [];
  readonly fixups: McFixup[] = [];
  readonly advances: PendingAdvance[] = [];
  private file = FIRST_FILE;
  private line = FIRST_LINE;
  private column = FIRST_COLUMN;

  constructor(private readonly target: DebugLineTarget) {}

  add(unit: SourceUnit, files: FileTable): void {
    this.restart();
    this.extended(DW_LNE_SET_ADDRESS, new Array<number>(this.target.addressBytes).fill(0));
    this.fixups.push(
      fixup(
        this.bytes.length - this.target.addressBytes,
        this.target.addressFixup,
        unit.symbol,
      ),
    );
    let reached = unit.entry;
    for (const row of unit.lines) {
      this.locate(files.indexOf(row.source.file), row.source);
      this.advance(reached, row.fragment);
      this.bytes.push(DW_LNS_COPY);
      reached = row.fragment;
    }
    this.advance(reached, unit.end);
    this.extended(DW_LNE_END_SEQUENCE, []);
  }

  private extended(opcode: number, operands: readonly number[]): void {
    this.bytes.push(EXTENDED_PREFIX, ...uleb128(operands.length + 1), opcode, ...operands);
  }

  private advance(from: McFragment, to: McFragment): void {
    this.bytes.push(DW_LNS_FIXED_ADVANCE_PC);
    this.advances.push({ at: this.bytes.length, from, to });
    this.bytes.push(...new Array<number>(ADVANCE_BYTES).fill(0));
  }

  private restart(): void {
    this.file = FIRST_FILE;
    this.line = FIRST_LINE;
    this.column = FIRST_COLUMN;
  }

  private locate(file: number, source: IRSourcePosition): void {
    if (file !== this.file) {
      this.bytes.push(DW_LNS_SET_FILE, ...uleb128(file));
      this.file = file;
    }
    if (source.column !== this.column) {
      this.bytes.push(DW_LNS_SET_COLUMN, ...uleb128(source.column));
      this.column = source.column;
    }
    if (source.line !== this.line) {
      this.bytes.push(DW_LNS_ADVANCE_LINE, ...sleb128(source.line - this.line));
      this.line = source.line;
    }
  }
}

function fileEntries(files: FileTable): number[] {
  return files.names.flatMap((name) => [
    ...text(name),
    ...uleb128(NO_ENTRY),
    ...uleb128(NO_ENTRY),
    ...uleb128(NO_ENTRY),
  ]);
}

function headerBytes(files: FileTable): number[] {
  const described = [
    MINIMUM_INSTRUCTION_BYTES,
    OPERATIONS_PER_INSTRUCTION,
    DEFAULT_IS_STMT,
    LINE_BASE & BYTE_MASK,
    LINE_RANGE,
    OPCODE_BASE,
    ...STANDARD_OPCODE_LENGTHS,
    NO_ENTRY,
    ...fileEntries(files),
    NO_ENTRY,
  ];
  const head = new Array<number>(LENGTH_BYTES + VERSION_BYTES + LENGTH_BYTES).fill(0);
  writeInteger(head, LENGTH_BYTES, DWARF_VERSION, VERSION_BYTES);
  writeInteger(head, LENGTH_BYTES + VERSION_BYTES, described.length, LENGTH_BYTES);
  return [...head, ...described];
}

function abbrevBytes(): number[] {
  const attributes: readonly (readonly [number, number])[] = [
    [DW_AT_PRODUCER, DW_FORM_STRING],
    [DW_AT_LANGUAGE, DW_FORM_DATA2],
    [DW_AT_NAME, DW_FORM_STRING],
    [DW_AT_COMP_DIR, DW_FORM_STRING],
    [DW_AT_LOW_PC, DW_FORM_ADDR],
    [DW_AT_HIGH_PC, DW_FORM_DATA8],
    [DW_AT_STMT_LIST, DW_FORM_SEC_OFFSET],
  ];
  return [
    ...uleb128(ABBREV_CODE),
    ...uleb128(DW_TAG_COMPILE_UNIT),
    DW_CHILDREN_NO,
    ...attributes.flatMap(([name, form]) => [...uleb128(name), ...uleb128(form)]),
    ABBREV_END,
    ABBREV_END,
    ABBREV_END,
  ];
}

interface CompileUnit {
  readonly record: McBytesFragment;
  readonly highPcAt: number;
  readonly first: McFragment;
  readonly last: McFragment;
}

function compileUnitBytes(
  target: DebugLineTarget,
  primary: string,
  units: readonly SourceUnit[],
): CompileUnit {
  const language = new Array<number>(LANGUAGE_BYTES).fill(0);
  writeInteger(language, 0, DW_LANG_C99, LANGUAGE_BYTES);
  const attributes = [
    ...uleb128(ABBREV_CODE),
    ...text(PRODUCER),
    ...language,
    ...text(primary),
    ...text(WORKING_DIRECTORY),
  ];
  const lowPcAt = attributes.length;
  attributes.push(...new Array<number>(target.addressBytes).fill(0));
  const highPcAt = attributes.length;
  attributes.push(...new Array<number>(target.addressBytes).fill(0));
  attributes.push(...new Array<number>(LENGTH_BYTES).fill(ONLY_UNIT_OFFSET));

  const head = new Array<number>(LENGTH_BYTES + VERSION_BYTES + LENGTH_BYTES + 1).fill(0);
  writeInteger(head, LENGTH_BYTES, DWARF_VERSION, VERSION_BYTES);
  writeInteger(head, LENGTH_BYTES + VERSION_BYTES, ONLY_UNIT_OFFSET, LENGTH_BYTES);
  head[head.length - 1] = target.addressBytes;

  const bytes = [...head, ...attributes];
  writeInteger(bytes, 0, bytes.length - LENGTH_BYTES, LENGTH_BYTES);
  return {
    record: bytesFragment(bytes, [
      fixup(head.length + lowPcAt, target.addressFixup, units[0]!.symbol),
    ]),
    highPcAt: head.length + highPcAt,
    first: units[0]!.entry,
    last: units[units.length - 1]!.end,
  };
}

export function appendDebugLine(
  module: McModule,
  target: DebugLineTarget,
  functions: readonly SourceUnit[],
): () => void {
  const units = functions.filter((unit) => unit.lines.length > 0);
  if (units.length === 0) return () => {};

  const files = new FileTable();
  const program = new LineProgram(target);
  for (const unit of units) program.add(unit, files);

  const header = headerBytes(files);
  const bytes = [...header, ...program.bytes];
  writeInteger(bytes, 0, bytes.length - LENGTH_BYTES, LENGTH_BYTES);
  const placed = program.fixups.map((entry) =>
    fixup(entry.offset + header.length, entry.kind, entry.symbol, entry.addend),
  );
  const lines = module
    .section(DEBUG_LINE_SECTION, "debug", SECTION_ALIGNMENT)
    .add(bytesFragment(bytes, placed));

  const unit = compileUnitBytes(target, files.names[0]!, units);
  module
    .section(DEBUG_ABBREV_SECTION, "debug", SECTION_ALIGNMENT)
    .add(bytesFragment(abbrevBytes()));
  module.section(DEBUG_INFO_SECTION, "debug", SECTION_ALIGNMENT).add(unit.record);

  return () => {
    for (const pending of program.advances) {
      const delta = pending.to.address - pending.from.address;
      if (delta < 0 || delta > ADVANCE_LIMIT) {
        throw new RangeError(`debug line advance of ${delta} bytes does not fit`);
      }
      writeInteger(lines.bytes, header.length + pending.at, delta, ADVANCE_BYTES);
    }
    writeInteger(
      unit.record.bytes,
      unit.highPcAt,
      unit.last.address - unit.first.address,
      target.addressBytes,
    );
  };
}
