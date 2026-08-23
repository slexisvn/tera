import { alignUp, ByteBuffer } from "../buffer.js";
import { MachineCodeError } from "../errors.js";
import { relocationTypeOf } from "../fixup.js";
import type { McFragment } from "../fragment.js";
import { layoutModule } from "../layout.js";
import { relocationsBySection, type McModule, type McRelocation } from "../module.js";
import { fragmentOwners, type McSection } from "../section.js";
import type { McSymbol } from "../symbol.js";
import type { McTarget } from "../target.js";
import type { McExecutableWriter, McObjectWriter } from "./container.js";

export const ELF_OBJECT_EXTENSION = "o";
export const ELF_EXECUTABLE_EXTENSION = "elf";
const ELF_RELOCATIONS = "elf";

export const ELF_MACHINE_X86_64 = 62;
export const ELF_MACHINE_RISCV = 243;

export const ELF_HEADER_BYTES = 64;
export const ELF_PROGRAM_HEADER_BYTES = 56;
export const ELF_SECTION_HEADER_BYTES = 64;
export const ELF_SYMBOL_BYTES = 24;
export const ELF_RELOCATION_BYTES = 24;

const ET_REL = 1;
const ET_EXEC = 2;

const SHT_PROGBITS = 1;
const SHT_NOBITS = 8;
const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const SHT_RELA = 4;

const SHF_WRITE = 0x1;
const SHF_ALLOC = 0x2;
const SHF_EXECINSTR = 0x4;

const PT_LOAD = 1;
const PT_GNU_EH_FRAME = 0x6474e550;
const EH_FRAME_HEADER_SECTION = ".eh_frame_hdr";
const PF_X = 0x1;
const PF_W = 0x2;
const PF_R = 0x4;

const STB_LOCAL = 0;
const STB_GLOBAL = 1;
const STT_NOTYPE = 0;
const STT_OBJECT = 1;
const STT_FUNC = 2;

const DEFAULT_BASE_ADDRESS = 0x400000;
const DEFAULT_PAGE_SIZE = 0x1000;

export interface Elf64ObjectOptions {
  readonly machine: number;
  readonly flags?: number;
}

export interface Elf64ExecutableOptions extends Elf64ObjectOptions {
  readonly entrySymbol: string;
  readonly baseAddress?: number;
  readonly pageSize?: number;
}

class StringTable {
  private readonly offsets = new Map<string, number>();
  private readonly buffer = new ByteBuffer();

  constructor() {
    this.buffer.byte(0);
  }

  intern(text: string): number {
    if (text.length === 0) return 0;
    const existing = this.offsets.get(text);
    if (existing !== undefined) return existing;
    const offset = this.buffer.length;
    this.buffer.bytes(new TextEncoder().encode(text));
    this.buffer.byte(0);
    this.offsets.set(text, offset);
    return offset;
  }

  get bytes(): Uint8Array {
    return this.buffer.toBytes();
  }
}

interface PlacedSection {
  readonly section: McSection;
  readonly fileOffset: number;
  readonly address: number;
}

function sectionFlags(section: McSection): number {
  const permissions = section.permissions;
  let flags = SHF_ALLOC;
  if (permissions.write) flags |= SHF_WRITE;
  if (permissions.execute) flags |= SHF_EXECINSTR;
  return flags;
}

function segmentFlags(section: McSection): number {
  const permissions = section.permissions;
  let flags = permissions.read ? PF_R : 0;
  if (permissions.write) flags |= PF_W;
  if (permissions.execute) flags |= PF_X;
  return flags;
}

function unwindHeaderOf(sections: readonly McSection[]): McSection | undefined {
  return sections.find((section) => section.name === EH_FRAME_HEADER_SECTION);
}

function programHeaderCount(sections: readonly McSection[]): number {
  return sections.length + (unwindHeaderOf(sections) === undefined ? 0 : 1);
}

function symbolTypeOf(symbol: McSymbol): number {
  if (symbol.kind === "function") return STT_FUNC;
  if (symbol.kind === "object") return STT_OBJECT;
  return STT_NOTYPE;
}

function orderedSymbols(module: McModule): McSymbol[] {
  const locals = module.symbols.symbols.filter((symbol) => symbol.binding === "local");
  const globals = module.symbols.symbols.filter((symbol) => symbol.binding !== "local");
  return [...locals, ...globals];
}

function writeElfHeader(
  out: ByteBuffer,
  type: number,
  options: Elf64ObjectOptions,
  entry: number,
  programOffset: number,
  programCount: number,
  sectionOffset: number,
  sectionCount: number,
  stringIndex: number,
): void {
  out.bytes([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
  out.fill(8, 0);
  out.integer(type, 2);
  out.integer(options.machine, 2);
  out.integer(1, 4);
  out.integer(entry, 8);
  out.integer(programCount === 0 ? 0 : programOffset, 8);
  out.integer(sectionOffset, 8);
  out.integer(options.flags ?? 0, 4);
  out.integer(ELF_HEADER_BYTES, 2);
  out.integer(ELF_PROGRAM_HEADER_BYTES, 2);
  out.integer(programCount, 2);
  out.integer(ELF_SECTION_HEADER_BYTES, 2);
  out.integer(sectionCount, 2);
  out.integer(stringIndex, 2);
}

function writeSectionHeader(
  out: ByteBuffer,
  name: number,
  type: number,
  flags: number,
  address: number,
  offset: number,
  size: number,
  link: number,
  info: number,
  alignment: number,
  entrySize: number,
): void {
  out.integer(name, 4);
  out.integer(type, 4);
  out.integer(flags, 8);
  out.integer(address, 8);
  out.integer(offset, 8);
  out.integer(size, 8);
  out.integer(link, 4);
  out.integer(info, 4);
  out.integer(alignment, 8);
  out.integer(entrySize, 8);
}

function symbolTableBytes(
  symbols: readonly McSymbol[],
  owners: ReadonlyMap<McFragment, McSection>,
  indexOfSection: Map<McSection, number>,
  names: StringTable,
): Uint8Array {
  const out = new ByteBuffer();
  out.fill(ELF_SYMBOL_BYTES, 0);
  for (const symbol of symbols) {
    const definition = symbol.definition;
    const section = definition === null ? undefined : owners.get(definition.fragment);
    const address = definition === null ? 0 : definition.fragment.address;
    const base = section === undefined ? 0 : section.address;
    out.integer(names.intern(symbol.name), 4);
    out.integer(
      ((symbol.binding === "local" ? STB_LOCAL : STB_GLOBAL) << 4) | symbolTypeOf(symbol),
      1,
    );
    out.integer(0, 1);
    out.integer(section === undefined ? 0 : (indexOfSection.get(section) ?? 0), 2);
    out.integer(section === undefined ? 0 : address - base, 8);
    out.integer(0, 8);
  }
  return out.toBytes();
}

function relocationTableBytes(
  entries: readonly McRelocation[],
  indexOfSymbol: Map<string, number>,
  target: McTarget,
): Uint8Array {
  const out = new ByteBuffer();
  for (const entry of entries) {
    const index = indexOfSymbol.get(entry.symbol);
    if (index === undefined) {
      throw new MachineCodeError(`relocation names unknown symbol ${entry.symbol}`);
    }
    const type = relocationTypeOf(
      target.fixups,
      entry.kind,
      ELF_RELOCATIONS,
      entry.symbol,
    );
    out.integer(entry.offset, 8);
    out.integer((BigInt(index) << 32n) | BigInt(type >>> 0), 8);
    out.integer(BigInt(entry.addend), 8);
  }
  return out.toBytes();
}

export function writeElf64Object(
  module: McModule,
  target: McTarget,
  options: Elf64ObjectOptions,
): Uint8Array {
  const sections = module.nonEmptySections;
  const owners = fragmentOwners(sections);
  const names = new StringTable();
  const symbolNames = new StringTable();
  const symbols = orderedSymbols(module);
  const localCount = symbols.filter((symbol) => symbol.binding === "local").length;

  const indexOfSection = new Map<McSection, number>();
  sections.forEach((section, position) => indexOfSection.set(section, position + 1));

  const indexOfSymbol = new Map<string, number>();
  symbols.forEach((symbol, position) => indexOfSymbol.set(symbol.name, position + 1));

  const grouped = relocationsBySection(module);

  const symbolBytes = symbolTableBytes(symbols, owners, indexOfSection, symbolNames);

  interface Blob {
    readonly name: string;
    readonly type: number;
    readonly flags: number;
    readonly alignment: number;
    readonly entrySize: number;
    readonly link: number;
    readonly info: number;
    readonly bytes: Uint8Array;
  }

  const blobs: Blob[] = sections.map((section) => ({
    name: section.name,
    type: section.kind === "bss" ? SHT_NOBITS : SHT_PROGBITS,
    flags: sectionFlags(section),
    alignment: section.alignment,
    entrySize: 0,
    link: 0,
    info: 0,
    bytes: section.kind === "bss" ? new Uint8Array(0) : section.contents(),
  }));

  const symbolTableIndex = blobs.length + 1;
  blobs.push({
    name: ".symtab",
    type: SHT_SYMTAB,
    flags: 0,
    alignment: 8,
    entrySize: ELF_SYMBOL_BYTES,
    link: symbolTableIndex + 1,
    info: localCount + 1,
    bytes: symbolBytes,
  });
  blobs.push({
    name: ".strtab",
    type: SHT_STRTAB,
    flags: 0,
    alignment: 1,
    entrySize: 0,
    link: 0,
    info: 0,
    bytes: symbolNames.bytes,
  });

  for (const [section, entries] of grouped) {
    blobs.push({
      name: `.rela${section.name}`,
      type: SHT_RELA,
      flags: 0,
      alignment: 8,
      entrySize: ELF_RELOCATION_BYTES,
      link: symbolTableIndex,
      info: indexOfSection.get(section)!,
      bytes: relocationTableBytes(entries, indexOfSymbol, target),
    });
  }

  const stringIndex = blobs.length + 1;
  for (const blob of blobs) names.intern(blob.name);
  names.intern(".shstrtab");
  blobs.push({
    name: ".shstrtab",
    type: SHT_STRTAB,
    flags: 0,
    alignment: 1,
    entrySize: 0,
    link: 0,
    info: 0,
    bytes: names.bytes,
  });

  const body = new ByteBuffer();
  const offsets: number[] = [];
  let cursor = ELF_HEADER_BYTES;
  for (const blob of blobs) {
    const padded = alignUp(cursor, blob.alignment);
    body.fill(padded - cursor, 0);
    offsets.push(padded);
    body.bytes(blob.bytes);
    cursor = padded + blob.bytes.length;
  }

  const sectionOffset = alignUp(cursor, 8);
  const out = new ByteBuffer(sectionOffset + (blobs.length + 1) * ELF_SECTION_HEADER_BYTES);
  writeElfHeader(out, ET_REL, options, 0, 0, 0, sectionOffset, blobs.length + 1, stringIndex);
  out.bytes(body.toBytes());
  out.fill(sectionOffset - cursor, 0);
  writeSectionHeader(out, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  blobs.forEach((blob, position) => {
    writeSectionHeader(
      out,
      names.intern(blob.name),
      blob.type,
      blob.flags,
      0,
      offsets[position]!,
      blob.bytes.length,
      blob.link,
      blob.info,
      blob.alignment,
      blob.entrySize,
    );
  });
  return out.toBytes();
}

export function layoutElf64Executable(
  module: McModule,
  target: McTarget,
  options: Elf64ExecutableOptions,
): void {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const base = options.baseAddress ?? DEFAULT_BASE_ADDRESS;
  const sections = module.nonEmptySections;
  for (const section of sections) section.require(pageSize);
  layoutModule(module, target, {
    base: base + ELF_HEADER_BYTES + ELF_PROGRAM_HEADER_BYTES * programHeaderCount(sections),
  });
}

export function writeElf64Executable(
  module: McModule,
  options: Elf64ExecutableOptions,
): Uint8Array {
  const base = options.baseAddress ?? DEFAULT_BASE_ADDRESS;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const sections = module.nonEmptySections;
  const entry = module.symbols.addressOf(options.entrySymbol);
  if (entry === null) {
    throw new MachineCodeError(`entry symbol ${options.entrySymbol} is not defined`);
  }
  if (module.relocations.length > 0) {
    const missing = [...new Set(module.relocations.map((entry) => entry.symbol))];
    throw new MachineCodeError(`executable has unresolved symbols: ${missing.join(", ")}`);
  }

  const placed: PlacedSection[] = sections.map((section) => ({
    section,
    address: section.address,
    fileOffset: section.address - base,
  }));

  const headerCount = programHeaderCount(sections);
  const end = placed.reduce(
    (total, item) => Math.max(total, item.fileOffset + item.section.size),
    ELF_HEADER_BYTES + ELF_PROGRAM_HEADER_BYTES * headerCount,
  );

  const out = new ByteBuffer(end);
  writeElfHeader(
    out,
    ET_EXEC,
    options,
    entry,
    ELF_HEADER_BYTES,
    headerCount,
    0,
    0,
    0,
  );
  const segment = (type: number, item: PlacedSection, alignment: number): void => {
    out.integer(type, 4);
    out.integer(segmentFlags(item.section), 4);
    out.integer(item.fileOffset, 8);
    out.integer(item.address, 8);
    out.integer(item.address, 8);
    out.integer(item.section.kind === "bss" ? 0 : item.section.size, 8);
    out.integer(item.section.size, 8);
    out.integer(alignment, 8);
  };
  for (const item of placed) segment(PT_LOAD, item, pageSize);
  const unwind = placed.find((item) => item.section.name === EH_FRAME_HEADER_SECTION);
  if (unwind !== undefined) segment(PT_GNU_EH_FRAME, unwind, unwind.section.alignment);
  for (const item of placed) {
    if (item.section.kind === "bss") continue;
    out.fill(item.fileOffset - out.length, 0);
    out.bytes(item.section.contents());
  }
  return out.toBytes();
}

export function elf64Object(machine: number): McObjectWriter {
  return {
    extension: ELF_OBJECT_EXTENSION,
    image(module, target) {
      layoutModule(module, target, { mode: "object" });
      return writeElf64Object(module, target, { machine });
    },
  };
}

export function elf64Executable(machine: number): McExecutableWriter {
  return {
    extension: ELF_EXECUTABLE_EXTENSION,
    image(module, target, entrySymbol) {
      const options = { machine, entrySymbol };
      layoutElf64Executable(module, target, options);
      return writeElf64Executable(module, options);
    },
  };
}
