import { withoutThreadEntryPoints } from "./runtime-layout.js";

export interface SyscallTable {
  readonly read: number;
  readonly write: number;
  readonly exit: number;
  readonly mmap: number;
  readonly mapFlags: number;
}

export const PROT_NONE = 0x0;
export const PROT_READ_WRITE = 0x1 | 0x2;

export const WINDOWS_MEM_COMMIT = 0x1000;
export const WINDOWS_MEM_RESERVE = 0x2000;
export const WINDOWS_PAGE_READWRITE = 0x04;
export const MMAP_ANY_ADDRESS = 0;
export const MMAP_NO_FILE = -1;
export const MMAP_NO_OFFSET = 0;
export const MMAP_ERROR_LIMIT = -4095;

const MAP_PRIVATE = 0x02;
const LINUX_MAP_ANONYMOUS = 0x20;
const LINUX_MAP_NORESERVE = 0x4000;
const MACOS_MAP_ANONYMOUS = 0x1000;
const MACOS_CLASS_UNIX = 0x2000000;

const LINUX_MAP_FLAGS = MAP_PRIVATE | LINUX_MAP_ANONYMOUS | LINUX_MAP_NORESERVE;

function declareSyscalls(table: SyscallTable): SyscallTable {
  withoutThreadEntryPoints(Object.keys(table));
  return table;
}

export const X64_LINUX_SYSCALLS: SyscallTable = declareSyscalls({
  read: 0,
  write: 1,
  exit: 60,
  mmap: 9,
  mapFlags: LINUX_MAP_FLAGS,
});

export const X64_MACOS_SYSCALLS: SyscallTable = declareSyscalls({
  read: MACOS_CLASS_UNIX | 3,
  write: MACOS_CLASS_UNIX | 4,
  exit: MACOS_CLASS_UNIX | 1,
  mmap: MACOS_CLASS_UNIX | 197,
  mapFlags: MAP_PRIVATE | MACOS_MAP_ANONYMOUS,
});

export const RISCV64_LINUX_SYSCALLS: SyscallTable = declareSyscalls({
  read: 63,
  write: 64,
  exit: 93,
  mmap: 222,
  mapFlags: LINUX_MAP_FLAGS,
});
