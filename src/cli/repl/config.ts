import os from "os";
import path from "path";

export const INDENT_UNIT = 2;
export const HISTORY_LIMIT = 1000;
export const COMMAND_PREFIX = ".";
export const HELP_PREFIX = "?";
export const MAX_SUGGEST_DISTANCE = 2;
export const MAX_SUGGESTIONS = 3;
export const MAX_MENU_ITEMS = 40;

export const PRIMARY_PROMPT = "tera> ";
export const CONTINUATION_PROMPT = "...   ";

export function historyFilePath(): string {
  const override = process.env.TERA_HISTORY;
  if (override) return override;
  return path.join(os.homedir(), ".tera_history");
}
