import { alignUp, ByteBuffer, writeInteger } from "../buffer.js";
import { MachineCodeError } from "../errors.js";
import { relocationTypeOf } from "../fixup.js";
import {
  alignFragment,
  bytesFragment,
  type McBytesFragment,
  type McFragment,
} from "../fragment.js";
import { layoutModule } from "../layout.js";
import {
  relocationsBySection,
  type McModule,
  type McRelocation,
} from "../module.js";
import { fragmentOwners, isLoadable, type McSection } from "../section.js";
import type { McSymbol } from "../symbol.js";
import type { McTarget } from "../target.js";
import type { McExecutableWriter, McObjectWriter } from "./container.js";

export const PE_MACHINE_AMD64 = 0x8664;

export const COFF_OBJECT_EXTENSION = "obj";
export const PE_EXECUTABLE_EXTENSION = "exe";
const COFF_RELOCATIONS = "coff";

const DOS_HEADER_BYTES = 64;
const DOS_PAGE_BYTES = 512;
const DOS_PARAGRAPH_BYTES = 16;
const DOS_STACK_POINTER = 0xb8;
const DOS_MESSAGE = "This program cannot be run in DOS mode.\r\r\n$";
const DOS_MESSAGE_OFFSET_FIELD = 3;

const PE_SIGNATURE = [0x50, 0x45, 0, 0];
const PE_SIGNATURE_ALIGNMENT = 8;
const COFF_HEADER_BYTES = 20;
const OPTIONAL_HEADER_MAGIC = 0x20b;
const OPTIONAL_HEADER_FIXED_BYTES = 112;
const DATA_DIRECTORY_BYTES = 8;
const DATA_DIRECTORY_COUNT = 16;
const SECTION_HEADER_BYTES = 40;
const SECTION_NAME_BYTES = 8;
const OFFSET_FIELD_BYTES = 4;
const SYMBOL_ENTRY_BYTES = 18;
const RELOCATION_ENTRY_BYTES = 10;
const STRING_TABLE_SIZE_BYTES = 4;
const OBJECT_BODY_ALIGNMENT = 4;

const IMAGE_SYM_UNDEFINED = 0;
const IMAGE_SYM_CLASS_EXTERNAL = 2;
const IMAGE_SYM_CLASS_STATIC = 3;
const IMAGE_SYM_DTYPE_FUNCTION = 0x20;

const IMAGE_SCN_ALIGN_SHIFT = 20;
const IMAGE_SCN_ALIGN_LIMIT = 0x2000;

const IMAGE_FILE_RELOCS_STRIPPED = 0x0001;
const IMAGE_FILE_EXECUTABLE_IMAGE = 0x0002;
const IMAGE_FILE_LARGE_ADDRESS_AWARE = 0x0020;

const IMAGE_SCN_CNT_CODE = 0x00000020;
const IMAGE_SCN_CNT_INITIALIZED_DATA = 0x00000040;
const IMAGE_SCN_CNT_UNINITIALIZED_DATA = 0x00000080;
const IMAGE_SCN_MEM_EXECUTE = 0x20000000;
const IMAGE_SCN_MEM_READ = 0x40000000;
const IMAGE_SCN_MEM_WRITE = 0x80000000;
const IMAGE_SCN_MEM_DISCARDABLE = 0x02000000;

const SUBSYSTEM_WINDOWS_CUI = 3;
const DLL_NX_COMPAT = 0x0100;
const WINDOWS_VERSION_MAJOR = 6;
const WINDOWS_VERSION_MINOR = 0;

const IMPORT_DIRECTORY_INDEX = 1;
const EXCEPTION_DIRECTORY_INDEX = 3;
const EXCEPTION_SECTION = ".pdata";
const IMPORT_ADDRESS_TABLE_INDEX = 12;

const IMPORT_SECTION = ".idata";
const IMPORT_SYMBOL_PREFIX = "__imp_";
const IMPORT_DIRECTORY_ENTRY_BYTES = 20;
const IMPORT_LOOKUP_TABLE_FIELD = 0;
const IMPORT_NAME_FIELD = 12;
const IMPORT_ADDRESS_TABLE_FIELD = 16;
const THUNK_BYTES = 8;
const HINT_BYTES = 2;
const HINT_NAME_ALIGNMENT = 2;

const DEFAULT_IMAGE_BASE = 0x400000;
const DEFAULT_SECTION_ALIGNMENT = 0x1000;
const DEFAULT_FILE_ALIGNMENT = 0x200;
const DEFAULT_STACK_RESERVE = 0x100000;
const DEFAULT_STACK_COMMIT = 0x1000;
const DEFAULT_HEAP_RESERVE = 0x100000;
const DEFAULT_HEAP_COMMIT = 0x1000;

const encoder = new TextEncoder();

export interface PeImportLibrary {
  readonly dll: string;
  readonly functions: readonly string[];
}

export interface PeDataDirectory {
  readonly address: number;
  readonly size: number;
}

export interface PeImportPlacement {
  readonly directory: PeDataDirectory;
  readonly addressTable: PeDataDirectory;
}

export interface PeExecutableOptions {
  readonly machine: number;
  readonly entrySymbol: string;
  readonly imports: PeImportTable;
  readonly imageBase?: number;
  readonly sectionAlignment?: number;
  readonly fileAlignment?: number;
}

export function importAddressSymbol(name: string): string {
  return `${IMPORT_SYMBOL_PREFIX}${name}`;
}

interface ImportedFunction {
  readonly lookup: McBytesFragment;
  readonly address: McBytesFragment;
  readonly hint: McBytesFragment;
}

interface ImportedLibrary {
  readonly directory: McBytesFragment;
  readonly name: McBytesFragment;
  readonly lookupTable: readonly McBytesFragment[];
  readonly addressTable: readonly McBytesFragment[];
  readonly functions: readonly ImportedFunction[];
}

function zeroBytes(count: number): number[] {
  return new Array<number>(count).fill(0);
}

function paddedTo(bytes: readonly number[], alignment: number): number[] {
  return [...bytes, ...zeroBytes(alignUp(bytes.length, alignment) - bytes.length)];
}

function asciiFragment(text: string): McBytesFragment {
  return bytesFragment([...encoder.encode(text), 0]);
}

function hintNameFragment(name: string): McBytesFragment {
  const entry = [...zeroBytes(HINT_BYTES), ...encoder.encode(name), 0];
  return bytesFragment(paddedTo(entry, HINT_NAME_ALIGNMENT));
}

function thunkFragment(): McBytesFragment {
  return bytesFragment(zeroBytes(THUNK_BYTES));
}

function thunkTable(section: McSection, count: number): McBytesFragment[] {
  const table: McBytesFragment[] = [];
  for (let index = 0; index < count; index++) table.push(section.add(thunkFragment()));
  table.push(section.add(thunkFragment()));
  return table;
}

function spanOf(fragments: readonly McFragment[], imageBase: number): PeDataDirectory {
  const first = fragments[0];
  const last = fragments[fragments.length - 1];
  if (first === undefined || last === undefined) return { address: 0, size: 0 };
  return {
    address: first.address - imageBase,
    size: last.address + last.size - first.address,
  };
}

export class PeImportTable {
  private readonly entries: ImportedLibrary[] = [];
  private readonly directories: McBytesFragment[] = [];
  private readonly addresses: McBytesFragment[] = [];

  constructor(module: McModule, libraries: readonly PeImportLibrary[]) {
    const section = module.section(IMPORT_SECTION, "data", THUNK_BYTES);
    const hints = libraries.map((library) => library.functions.map(hintNameFragment));
    const names = libraries.map((library) => asciiFragment(library.dll));

    for (let index = 0; index <= libraries.length; index++) {
      this.directories.push(
        section.add(bytesFragment(zeroBytes(IMPORT_DIRECTORY_ENTRY_BYTES))),
      );
    }

    section.add(alignFragment(THUNK_BYTES));
    const lookups = libraries.map((library) => thunkTable(section, library.functions.length));

    section.add(alignFragment(THUNK_BYTES));
    const addresses = libraries.map((library) => {
      const table = thunkTable(section, library.functions.length);
      library.functions.forEach((name, position) => {
        module.symbols.define(importAddressSymbol(name), table[position]!, "local", "object");
      });
      this.addresses.push(...table);
      return table;
    });

    for (const group of hints) for (const fragment of group) section.add(fragment);
    for (const fragment of names) section.add(fragment);

    libraries.forEach((library, position) => {
      this.entries.push({
        directory: this.directories[position]!,
        name: names[position]!,
        lookupTable: lookups[position]!,
        addressTable: addresses[position]!,
        functions: library.functions.map((_name, index) => ({
          lookup: lookups[position]![index]!,
          address: addresses[position]![index]!,
          hint: hints[position]![index]!,
        })),
      });
    });
  }

  resolve(imageBase: number): PeImportPlacement {
    const rva = (fragment: McFragment): number => fragment.address - imageBase;
    for (const library of this.entries) {
      for (const entry of library.functions) {
        writeInteger(entry.lookup.bytes, 0, rva(entry.hint), THUNK_BYTES);
        writeInteger(entry.address.bytes, 0, rva(entry.hint), THUNK_BYTES);
      }
      const directory = library.directory.bytes;
      const lookup = library.lookupTable[0]!;
      const address = library.addressTable[0]!;
      writeInteger(directory, IMPORT_LOOKUP_TABLE_FIELD, rva(lookup), OFFSET_FIELD_BYTES);
      writeInteger(directory, IMPORT_NAME_FIELD, rva(library.name), OFFSET_FIELD_BYTES);
      writeInteger(directory, IMPORT_ADDRESS_TABLE_FIELD, rva(address), OFFSET_FIELD_BYTES);
    }
    return {
      directory: spanOf(this.directories, imageBase),
      addressTable: spanOf(this.addresses, imageBase),
    };
  }
}

export function definePeImports(
  module: McModule,
  libraries: readonly PeImportLibrary[],
): PeImportTable {
  return new PeImportTable(module, libraries);
}

function dosStub(): number[] {
  const code = [0x0e, 0x1f, 0xba, 0, 0, 0xb4, 0x09, 0xcd, 0x21, 0xb8, 0x01, 0x4c, 0xcd, 0x21];
  writeInteger(code, DOS_MESSAGE_OFFSET_FIELD, code.length, 2);
  return [...code, ...encoder.encode(DOS_MESSAGE)];
}

const DOS_STUB = dosStub();

const PE_SIGNATURE_OFFSET = alignUp(DOS_HEADER_BYTES + DOS_STUB.length, PE_SIGNATURE_ALIGNMENT);

const OPTIONAL_HEADER_BYTES =
  OPTIONAL_HEADER_FIXED_BYTES + DATA_DIRECTORY_COUNT * DATA_DIRECTORY_BYTES;

function headerBytes(sectionCount: number): number {
  return (
    PE_SIGNATURE_OFFSET +
    PE_SIGNATURE.length +
    COFF_HEADER_BYTES +
    OPTIONAL_HEADER_BYTES +
    SECTION_HEADER_BYTES * sectionCount
  );
}

function sectionCharacteristics(section: McSection): number {
  if (!isLoadable(section)) {
    return (
      IMAGE_SCN_CNT_INITIALIZED_DATA | IMAGE_SCN_MEM_READ | IMAGE_SCN_MEM_DISCARDABLE
    ) >>> 0;
  }
  const permissions = section.permissions;
  let flags = permissions.execute
    ? IMAGE_SCN_CNT_CODE
    : section.kind === "bss"
      ? IMAGE_SCN_CNT_UNINITIALIZED_DATA
      : IMAGE_SCN_CNT_INITIALIZED_DATA;
  if (permissions.read) flags |= IMAGE_SCN_MEM_READ;
  if (permissions.write) flags |= IMAGE_SCN_MEM_WRITE;
  if (permissions.execute) flags |= IMAGE_SCN_MEM_EXECUTE;
  return flags >>> 0;
}

function sectionNameBytes(section: McSection, strings: CoffStringTable): Uint8Array {
  const padded = new Uint8Array(SECTION_NAME_BYTES);
  const encoded = encoder.encode(section.name);
  if (encoded.length <= SECTION_NAME_BYTES) {
    padded.set(encoded);
    return padded;
  }
  const reference = encoder.encode(`/${strings.intern(section.name)}`);
  if (reference.length > SECTION_NAME_BYTES) {
    throw new MachineCodeError(
      `section name ${section.name} does not fit a pe section header`,
    );
  }
  padded.set(reference);
  return padded;
}

interface PlacedSection {
  readonly section: McSection;
  readonly fileOffset: number;
  readonly rawSize: number;
  readonly address: number;
}

interface ImageGeometry {
  readonly placed: readonly PlacedSection[];
  readonly imageBase: number;
  readonly sectionAlignment: number;
  readonly fileAlignment: number;
  readonly headerSize: number;
  readonly imageSize: number;
  readonly entry: number;
}

function writeDosHeader(out: ByteBuffer): void {
  const total = DOS_HEADER_BYTES + DOS_STUB.length;
  out.bytes(encoder.encode("MZ"));
  out.integer(total % DOS_PAGE_BYTES, 2);
  out.integer(Math.ceil(total / DOS_PAGE_BYTES), 2);
  out.integer(0, 2);
  out.integer(DOS_HEADER_BYTES / DOS_PARAGRAPH_BYTES, 2);
  out.integer(0, 2);
  out.integer(0xffff, 2);
  out.integer(0, 2);
  out.integer(DOS_STACK_POINTER, 2);
  out.fill(6, 0);
  out.integer(DOS_HEADER_BYTES, 2);
  out.fill(DOS_HEADER_BYTES - OFFSET_FIELD_BYTES - out.length, 0);
  out.integer(PE_SIGNATURE_OFFSET, OFFSET_FIELD_BYTES);
  out.bytes(DOS_STUB);
  out.align(PE_SIGNATURE_ALIGNMENT);
}

interface CoffHeader {
  readonly machine: number;
  readonly sectionCount: number;
  readonly symbolTableOffset: number;
  readonly symbolCount: number;
  readonly optionalHeaderBytes: number;
  readonly characteristics: number;
}

function writeCoffHeader(out: ByteBuffer, header: CoffHeader): void {
  out.integer(header.machine, 2);
  out.integer(header.sectionCount, 2);
  out.integer(0, 4);
  out.integer(header.symbolTableOffset, 4);
  out.integer(header.symbolCount, 4);
  out.integer(header.optionalHeaderBytes, 2);
  out.integer(header.characteristics, 2);
}

function writeOptionalHeader(
  out: ByteBuffer,
  geometry: ImageGeometry,
  directories: ReadonlyMap<number, PeDataDirectory>,
): void {
  const totalOf = (executable: boolean): number =>
    geometry.placed
      .filter((item) => item.section.permissions.execute === executable)
      .reduce((total, item) => total + item.rawSize, 0);
  const code = geometry.placed.find((item) => item.section.permissions.execute);

  out.integer(OPTIONAL_HEADER_MAGIC, 2);
  out.integer(0, 2);
  out.integer(totalOf(true), 4);
  out.integer(totalOf(false), 4);
  out.integer(0, 4);
  out.integer(geometry.entry, 4);
  out.integer(code === undefined ? 0 : code.address, 4);
  out.integer(geometry.imageBase, 8);
  out.integer(geometry.sectionAlignment, 4);
  out.integer(geometry.fileAlignment, 4);
  out.integer(WINDOWS_VERSION_MAJOR, 2);
  out.integer(WINDOWS_VERSION_MINOR, 2);
  out.integer(0, 4);
  out.integer(WINDOWS_VERSION_MAJOR, 2);
  out.integer(WINDOWS_VERSION_MINOR, 2);
  out.integer(0, 4);
  out.integer(geometry.imageSize, 4);
  out.integer(geometry.headerSize, 4);
  out.integer(0, 4);
  out.integer(SUBSYSTEM_WINDOWS_CUI, 2);
  out.integer(DLL_NX_COMPAT, 2);
  out.integer(DEFAULT_STACK_RESERVE, 8);
  out.integer(DEFAULT_STACK_COMMIT, 8);
  out.integer(DEFAULT_HEAP_RESERVE, 8);
  out.integer(DEFAULT_HEAP_COMMIT, 8);
  out.integer(0, 4);
  out.integer(DATA_DIRECTORY_COUNT, 4);
  for (let index = 0; index < DATA_DIRECTORY_COUNT; index++) {
    const directory = directories.get(index);
    out.integer(directory?.address ?? 0, 4);
    out.integer(directory?.size ?? 0, 4);
  }
}

interface SectionHeader {
  readonly name: Uint8Array;
  readonly section: McSection;
  readonly virtualSize: number;
  readonly address: number;
  readonly rawSize: number;
  readonly fileOffset: number;
  readonly relocationOffset: number;
  readonly relocationCount: number;
  readonly characteristics: number;
}

function writeSectionHeader(out: ByteBuffer, header: SectionHeader): void {
  out.bytes(header.name);
  out.integer(header.virtualSize, 4);
  out.integer(header.address, 4);
  out.integer(header.rawSize, 4);
  out.integer(header.fileOffset, 4);
  out.integer(header.relocationOffset, 4);
  out.integer(0, 4);
  out.integer(header.relocationCount, 2);
  out.integer(0, 2);
  out.integer(header.characteristics, 4);
}

export function layoutPeExecutable(
  module: McModule,
  target: McTarget,
  options: PeExecutableOptions,
): void {
  const imageBase = options.imageBase ?? DEFAULT_IMAGE_BASE;
  const sectionAlignment = options.sectionAlignment ?? DEFAULT_SECTION_ALIGNMENT;
  const sections = module.nonEmptySections;
  for (const section of sections) section.require(sectionAlignment);
  layoutModule(module, target, { base: imageBase + headerBytes(sections.length) });
}

export function writePeExecutable(
  module: McModule,
  options: PeExecutableOptions,
): Uint8Array {
  const imageBase = options.imageBase ?? DEFAULT_IMAGE_BASE;
  const sectionAlignment = options.sectionAlignment ?? DEFAULT_SECTION_ALIGNMENT;
  const fileAlignment = options.fileAlignment ?? DEFAULT_FILE_ALIGNMENT;
  const sections = module.nonEmptySections;
  const entry = module.symbols.addressOf(options.entrySymbol);
  if (entry === null) {
    throw new MachineCodeError(`entry symbol ${options.entrySymbol} is not defined`);
  }
  if (module.relocations.length > 0) {
    const missing = [...new Set(module.relocations.map((item) => item.symbol))];
    throw new MachineCodeError(`executable has unresolved symbols: ${missing.join(", ")}`);
  }

  const placement = options.imports.resolve(imageBase);
  const headerSize = alignUp(headerBytes(sections.length), fileAlignment);

  let cursor = headerSize;
  const placed: PlacedSection[] = sections.map((section) => {
    const item: PlacedSection = {
      section,
      fileOffset: cursor,
      rawSize: section.kind === "bss" ? 0 : alignUp(section.size, fileAlignment),
      address: section.address - imageBase,
    };
    cursor += item.rawSize;
    return item;
  });

  const geometry: ImageGeometry = {
    placed,
    imageBase,
    sectionAlignment,
    fileAlignment,
    headerSize,
    imageSize: alignUp(
      placed.reduce((total, item) => Math.max(total, item.address + item.section.size), 0),
      sectionAlignment,
    ),
    entry: entry - imageBase,
  };

  const strings = new CoffStringTable();
  const names = placed.map((item) => sectionNameBytes(item.section, strings));
  const stringBytes = strings.bytes;
  const named = stringBytes.length > STRING_TABLE_SIZE_BYTES;
  const out = new ByteBuffer(cursor + (named ? stringBytes.length : 0));
  writeDosHeader(out);
  out.bytes(PE_SIGNATURE);
  writeCoffHeader(out, {
    machine: options.machine,
    sectionCount: placed.length,
    symbolTableOffset: named ? cursor : 0,
    symbolCount: 0,
    optionalHeaderBytes: OPTIONAL_HEADER_BYTES,
    characteristics:
      IMAGE_FILE_RELOCS_STRIPPED |
      IMAGE_FILE_EXECUTABLE_IMAGE |
      IMAGE_FILE_LARGE_ADDRESS_AWARE,
  });
  const exceptions = placed.find((item) => item.section.name === EXCEPTION_SECTION);
  writeOptionalHeader(
    out,
    geometry,
    new Map([
      [IMPORT_DIRECTORY_INDEX, placement.directory],
      [IMPORT_ADDRESS_TABLE_INDEX, placement.addressTable],
      ...(exceptions === undefined
        ? []
        : ([
            [
              EXCEPTION_DIRECTORY_INDEX,
              { address: exceptions.address, size: exceptions.section.size },
            ],
          ] as const)),
    ]),
  );
  placed.forEach((item, position) => {
    writeSectionHeader(out, {
      name: names[position]!,
      section: item.section,
      virtualSize: item.section.size,
      address: item.address,
      rawSize: item.rawSize,
      fileOffset: item.fileOffset,
      relocationOffset: 0,
      relocationCount: 0,
      characteristics: sectionCharacteristics(item.section),
    });
  });
  for (const item of placed) {
    if (item.rawSize === 0) continue;
    out.fill(item.fileOffset - out.length, 0);
    out.bytes(item.section.contents());
  }
  out.fill(cursor - out.length, 0);
  if (named) out.bytes(stringBytes);
  return out.toBytes();
}

class CoffStringTable {
  private readonly offsets = new Map<string, number>();
  private readonly buffer = new ByteBuffer();

  intern(text: string): number {
    const existing = this.offsets.get(text);
    if (existing !== undefined) return existing;
    const offset = STRING_TABLE_SIZE_BYTES + this.buffer.length;
    this.buffer.bytes(encoder.encode(text));
    this.buffer.byte(0);
    this.offsets.set(text, offset);
    return offset;
  }

  get bytes(): Uint8Array {
    const out = new ByteBuffer(STRING_TABLE_SIZE_BYTES + this.buffer.length);
    out.integer(STRING_TABLE_SIZE_BYTES + this.buffer.length, STRING_TABLE_SIZE_BYTES);
    out.bytes(this.buffer.toBytes());
    return out.toBytes();
  }
}

function alignmentCharacteristics(alignment: number): number {
  if (alignment >= IMAGE_SCN_ALIGN_LIMIT) {
    throw new MachineCodeError(`a coff section cannot request ${alignment} byte alignment`);
  }
  return (Math.log2(alignment) + 1) << IMAGE_SCN_ALIGN_SHIFT;
}

function storageClassOf(symbol: McSymbol): number {
  if (symbol.definition === null) return IMAGE_SYM_CLASS_EXTERNAL;
  return symbol.binding === "local" ? IMAGE_SYM_CLASS_STATIC : IMAGE_SYM_CLASS_EXTERNAL;
}

function writeSymbolName(out: ByteBuffer, name: string, strings: CoffStringTable): void {
  const encoded = encoder.encode(name);
  if (encoded.length > SECTION_NAME_BYTES) {
    out.integer(0, OFFSET_FIELD_BYTES);
    out.integer(strings.intern(name), OFFSET_FIELD_BYTES);
    return;
  }
  const padded = new Uint8Array(SECTION_NAME_BYTES);
  padded.set(encoded);
  out.bytes(padded);
}

function symbolTableBytes(
  symbols: readonly McSymbol[],
  owners: ReadonlyMap<McFragment, McSection>,
  indexOfSection: ReadonlyMap<McSection, number>,
  strings: CoffStringTable,
): Uint8Array {
  const out = new ByteBuffer(symbols.length * SYMBOL_ENTRY_BYTES);
  for (const symbol of symbols) {
    const definition = symbol.definition;
    const section = definition === null ? undefined : owners.get(definition.fragment);
    writeSymbolName(out, symbol.name, strings);
    out.integer(
      section === undefined ? 0 : definition!.fragment.address - section.address,
      4,
    );
    out.integer(
      section === undefined ? IMAGE_SYM_UNDEFINED : (indexOfSection.get(section) ?? 0),
      2,
    );
    out.integer(symbol.kind === "function" ? IMAGE_SYM_DTYPE_FUNCTION : 0, 2);
    out.integer(storageClassOf(symbol), 1);
    out.integer(0, 1);
  }
  return out.toBytes();
}

function relocationTableBytes(
  entries: readonly McRelocation[],
  indexOfSymbol: ReadonlyMap<string, number>,
  target: McTarget,
): Uint8Array {
  const out = new ByteBuffer(entries.length * RELOCATION_ENTRY_BYTES);
  for (const entry of entries) {
    const index = indexOfSymbol.get(entry.symbol);
    if (index === undefined) {
      throw new MachineCodeError(`relocation names unknown symbol ${entry.symbol}`);
    }
    out.integer(entry.offset, 4);
    out.integer(index, 4);
    out.integer(
      relocationTypeOf(target.fixups, entry.kind, COFF_RELOCATIONS, entry.symbol),
      2,
    );
  }
  return out.toBytes();
}

function storedAddendOf(target: McTarget, entry: McRelocation): number {
  if (target.fixups.anchorOf(entry.kind) === "absolute") return entry.addend;
  return entry.addend + target.fixups.sizeOf(entry.kind);
}

function relocatedContents(
  section: McSection,
  entries: readonly McRelocation[],
  target: McTarget,
): Uint8Array {
  const bytes = [...section.contents()];
  for (const entry of entries) {
    target.fixups.apply(entry.kind, bytes, entry.offset, storedAddendOf(target, entry));
  }
  return new Uint8Array(bytes);
}

interface PlacedObjectSection {
  readonly section: McSection;
  readonly contents: Uint8Array;
  readonly fileOffset: number;
  readonly relocations: Uint8Array;
  readonly relocationOffset: number;
  readonly relocationCount: number;
}

export interface CoffObjectOptions {
  readonly machine: number;
}

export function writeCoffObject(
  module: McModule,
  target: McTarget,
  options: CoffObjectOptions,
): Uint8Array {
  const sections = module.nonEmptySections;
  const symbols = module.symbols.symbols;
  const strings = new CoffStringTable();
  const grouped = relocationsBySection(module);

  const indexOfSection = new Map<McSection, number>();
  sections.forEach((section, position) => indexOfSection.set(section, position + 1));

  const indexOfSymbol = new Map<string, number>();
  symbols.forEach((symbol, position) => indexOfSymbol.set(symbol.name, position));

  const symbolBytes = symbolTableBytes(
    symbols,
    fragmentOwners(sections),
    indexOfSection,
    strings,
  );
  const names = sections.map((section) => sectionNameBytes(section, strings));

  let cursor = COFF_HEADER_BYTES + SECTION_HEADER_BYTES * sections.length;
  const placed: PlacedObjectSection[] = sections.map((section) => {
    const entries = grouped.get(section) ?? [];
    const contents = relocatedContents(section, entries, target);
    const fileOffset = alignUp(cursor, OBJECT_BODY_ALIGNMENT);
    const relocations = relocationTableBytes(entries, indexOfSymbol, target);
    const relocationOffset = fileOffset + contents.length;
    cursor = relocationOffset + relocations.length;
    return {
      section,
      contents,
      fileOffset,
      relocations,
      relocationOffset: entries.length === 0 ? 0 : relocationOffset,
      relocationCount: entries.length,
    };
  });

  const symbolOffset = alignUp(cursor, OBJECT_BODY_ALIGNMENT);
  const stringBytes = strings.bytes;
  const out = new ByteBuffer(symbolOffset + symbolBytes.length + stringBytes.length);

  writeCoffHeader(out, {
    machine: options.machine,
    sectionCount: sections.length,
    symbolTableOffset: symbolOffset,
    symbolCount: symbols.length,
    optionalHeaderBytes: 0,
    characteristics: 0,
  });
  placed.forEach((item, position) => {
    writeSectionHeader(out, {
      name: names[position]!,
      section: item.section,
      virtualSize: 0,
      address: 0,
      rawSize: item.contents.length,
      fileOffset: item.fileOffset,
      relocationOffset: item.relocationOffset,
      relocationCount: item.relocationCount,
      characteristics:
        (sectionCharacteristics(item.section) |
          alignmentCharacteristics(item.section.alignment)) >>>
        0,
    });
  });
  for (const item of placed) {
    out.fill(item.fileOffset - out.length, 0);
    out.bytes(item.contents);
    out.bytes(item.relocations);
  }
  out.fill(symbolOffset - out.length, 0);
  out.bytes(symbolBytes);
  out.bytes(stringBytes);
  return out.toBytes();
}

export function coffObject(machine: number): McObjectWriter {
  return {
    extension: COFF_OBJECT_EXTENSION,
    carriesDebug: true,
    image(module, target) {
      layoutModule(module, target, { mode: "object" });
      return writeCoffObject(module, target, { machine });
    },
  };
}

export function peExecutable(
  machine: number,
  libraries: readonly PeImportLibrary[],
): McExecutableWriter {
  return {
    extension: PE_EXECUTABLE_EXTENSION,
    carriesDebug: true,
    image(module, target, entrySymbol) {
      const options = {
        machine,
        entrySymbol,
        imports: definePeImports(module, libraries),
      };
      layoutPeExecutable(module, target, options);
      return writePeExecutable(module, options);
    },
  };
}
