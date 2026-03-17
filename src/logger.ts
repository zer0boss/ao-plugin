/**
 * AO Plugin Logger - File-based logging
 *
 * Writes logs to a text file for easy debugging and monitoring
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const LOG_FILE = join(__dirname, "../../ao-plugin.log");
const MAX_LOG_LINES = 1000;

export function initLogFile(): void {
  const timestamp = formatBeijingTime(new Date());
  writeFileSync(LOG_FILE, `=== AO Plugin Log Started: ${timestamp} ===\n`);
}

function formatBeijingTime(date: Date): string {
  // Convert to Beijing time (UTC+8)
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${ms}+08:00`;
}

export function log(level: "INFO" | "ERROR" | "WARN" | "DEBUG", message: string): void {
  const timestamp = formatBeijingTime(new Date());
  const logLine = `[${timestamp}] [${level}] ${message}\n`;

  try {
    appendFileSync(LOG_FILE, logLine);
  } catch (e) {
    // Silently fail if file write fails
  }
}

export function getLogs(lines: number = 100): string {
  try {
    if (!existsSync(LOG_FILE)) {
      return "No log file found";
    }

    const content = readFileSync(LOG_FILE, "utf-8");
    const allLines = content.split("\n");
    const recentLines = allLines.slice(-lines);
    return recentLines.join("\n");
  } catch (e) {
    return `Error reading log: ${e}`;
  }
}

export function clearLogs(): void {
  const timestamp = formatBeijingTime(new Date());
  writeFileSync(LOG_FILE, `=== AO Plugin Log Cleared: ${timestamp} ===\n`);
}
