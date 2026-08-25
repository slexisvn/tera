import { BINARY_EXTS } from "../config/constants";

export function fileExt(name: string) {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function csvVarName(filename: string) {
  let base = filename.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_]/g, "_");
  if (!/^[A-Za-z_]/.test(base)) base = "_" + base;
  return base || "data";
}

export function loadCommandFor(name: string) {
  const ext = fileExt(name);
  const v = csvVarName(name);
  if (ext === "csv" || ext === "tsv") return `${v} = load_csv("${name}")`;
  if (ext === "json") return `${v} = load_json("${name}")`;
  if (ext === "ckpt" || ext === "safetensors") return `load_model(model, "${name}")`;
  return `${v} = read_text("${name}")`;
}

export function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function isBinaryFile(name: string) {
  return BINARY_EXTS.has(fileExt(name));
}
