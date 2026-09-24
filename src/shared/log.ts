/**
 * Debug-gated logger.
 *
 * OpenCode surfaces a plugin's stdout/stderr in the TUI (near the prompt), so
 * the plugin must stay quiet during normal use. All diagnostic output is
 * therefore silent by default and only emitted when debugging is explicitly
 * enabled via `OPENCODE_CURSOR_DEBUG` (`1`/`true`/`yes`/`on`). When enabled,
 * messages go to stderr to avoid corrupting any stdout-based protocols.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const debugEnabled: boolean = (() => {
  const value = (process.env.OPENCODE_CURSOR_DEBUG ?? "").toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
})();

function emit(args: unknown[]): void {
  const line = `[${new Date().toISOString()}] ${args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ")}\n`;
  try {
    const file = path.join(os.homedir(), ".cache", "opencode-cursor-runtime.log");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line);
  } catch {}
  if (!debugEnabled) return;
  console.error(...args);
}

export const log = {
  info(...args: unknown[]): void {
    emit(args);
  },
  warn(...args: unknown[]): void {
    emit(args);
  },
  error(...args: unknown[]): void {
    emit(args);
  },
};
