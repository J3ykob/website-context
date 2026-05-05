/**
 * SQLite database connection singleton using better-sqlite3.
 * Stores tenant data at ./data/tenants.db with WAL mode enabled.
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "../../../data");
const DB_PATH = resolve(DATA_DIR, "tenants.db");

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  // Auto-create data/ directory
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  db = new Database(DB_PATH);

  // Enable WAL mode for better concurrent read performance
  db.pragma("journal_mode = WAL");

  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
