/**
 * Database migrations — creates tables on first run.
 */

import { getDb } from "./connection.js";

export function runMigrations(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      domain TEXT NOT NULL UNIQUE,
      site_url TEXT NOT NULL,
      brand_name TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_scraped_at TEXT,
      pages_count INTEGER DEFAULT 0,
      chunks_count INTEGER DEFAULT 0,
      qdrant_collection TEXT NOT NULL,
      settings_json TEXT DEFAULT '{}',
      owner_password_hash TEXT,
      api_key TEXT UNIQUE,
      setup_token TEXT
    );

    CREATE TABLE IF NOT EXISTS scrape_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      started_at TEXT,
      completed_at TEXT,
      error TEXT,
      pages_scraped INTEGER DEFAULT 0,
      chunks_embedded INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Add setup_token column if missing (for existing databases)
  try {
    db.exec(`ALTER TABLE tenants ADD COLUMN setup_token TEXT`);
  } catch {
    // Column already exists — ignore
  }
}
