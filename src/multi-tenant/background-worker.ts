/**
 * Background worker — processes scrape jobs one at a time (Playwright memory constraint).
 * Features: per-job timeout, retry with backoff, forced browser cleanup, stuck-job recovery.
 */

import { getDb } from "./db/connection.js";
import { runMigrations } from "./db/migrations.js";
import { getTenant, updateTenant, listTenants } from "./tenant-registry.js";
import { scrapeTenant } from "./scrape-pipeline.js";
import { closeBrowser } from "../scraper/index.js";
import { sendBotReadyEmail } from "./email.js";

const MAX_RETRIES = 3;
const JOB_TIMEOUT_MS = 3 * 60 * 1000;
const COOLDOWN_MS = 10_000; // 10s between jobs for GC / memory recovery

interface QueuedJob {
  tenantId: string;
  siteUrl: string;
  maxPages: number;
  attempt: number;
}

let migrated = false;
function ensureMigrated(): void {
  if (!migrated) {
    runMigrations();
    migrated = true;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

async function forceCleanupBrowser(): Promise<void> {
  try {
    await closeBrowser();
  } catch {}
}

export class ScrapeWorker {
  private queue: QueuedJob[] = [];
  private processing = false;
  private retryQueue: QueuedJob[] = [];

  enqueue(tenantId: string, siteUrl: string, maxPages: number = 20): void {
    ensureMigrated();
    const db = getDb();

    const alreadyQueued = this.queue.some((j) => j.tenantId === tenantId) ||
      this.retryQueue.some((j) => j.tenantId === tenantId);
    if (alreadyQueued) {
      console.log(`[worker] ${tenantId} already in queue, skipping`);
      return;
    }

    db.prepare(`
      INSERT INTO scrape_jobs (tenant_id, status)
      VALUES (?, 'queued')
    `).run(tenantId);

    this.queue.push({ tenantId, siteUrl, maxPages, attempt: 1 });
    this.kick();
  }

  enqueuePriority(tenantId: string, siteUrl: string, maxPages: number = 20): void {
    ensureMigrated();
    const db = getDb();

    const alreadyQueued = this.queue.some((j) => j.tenantId === tenantId) ||
      this.retryQueue.some((j) => j.tenantId === tenantId);
    if (alreadyQueued) {
      // Move to front if already in queue
      this.queue = this.queue.filter((j) => j.tenantId !== tenantId);
      this.queue.unshift({ tenantId, siteUrl, maxPages, attempt: 1 });
      console.log(`[worker] ${tenantId} moved to front of queue`);
      return;
    }

    db.prepare(`
      INSERT INTO scrape_jobs (tenant_id, status)
      VALUES (?, 'queued')
    `).run(tenantId);

    this.queue.unshift({ tenantId, siteUrl, maxPages, attempt: 1 });
    this.kick();
  }

  isProcessing(): boolean {
    return this.processing;
  }

  clearQueue(): void {
    this.queue = [];
    this.retryQueue = [];
    console.log("[worker] Queue cleared");
  }

  getQueueLength(): number {
    return this.queue.length + this.retryQueue.length;
  }

  recoverStuckJobs(): void {
    ensureMigrated();
    const allTenants = listTenants();

    // Reset any stuck "scraping" to pending
    const stuck = allTenants.filter((t) => t.status === "scraping");
    for (const tenant of stuck) {
      updateTenant(tenant.id, { status: "pending" });
    }
    if (stuck.length > 0) {
      console.log(`[worker] Reset ${stuck.length} stuck tenant(s) to pending`);
    }

    // Auto-enqueue pending tenants on startup (skip "paused" ones)
    const pending = listTenants().filter((t) => t.status === "pending" && t.siteUrl);
    if (pending.length > 0) {
      console.log(`[worker] Auto-enqueuing ${pending.length} pending tenant(s)`);
      for (const tenant of pending) {
        const alreadyQueued = this.queue.some((j) => j.tenantId === tenant.id);
        if (!alreadyQueued) {
          this.queue.push({ tenantId: tenant.id, siteUrl: tenant.siteUrl, maxPages: 20, attempt: 1 });
        }
      }
      this.kick();
    }
  }

  private kick(): void {
    if (!this.processing) {
      this.processLoop();
    }
  }

  private async processLoop(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift()!;
        try {
          await this.runJob(job);
        } catch (err: any) {
          console.error(`[worker] Unhandled error in job ${job.tenantId}: ${err.message}`);
        }
        if (this.queue.length > 0) {
          console.log(`[worker] Cooldown ${COOLDOWN_MS / 1000}s before next job (${this.queue.length} remaining)`);
          await new Promise((r) => setTimeout(r, COOLDOWN_MS));
        }
      }

      // After primary queue is drained, process retries
      if (this.retryQueue.length > 0) {
        console.log(`[worker] Processing ${this.retryQueue.length} retry job(s)`);
        const retries = [...this.retryQueue];
        this.retryQueue = [];
        for (const job of retries) {
          await new Promise((r) => setTimeout(r, COOLDOWN_MS));
          try {
            await this.runJob(job);
          } catch (err: any) {
            console.error(`[worker] Unhandled error in retry ${job.tenantId}: ${err.message}`);
          }
        }
      }
    } finally {
      this.processing = false;
    }

    // Check if new jobs arrived while we were finishing
    if (this.queue.length > 0 || this.retryQueue.length > 0) {
      this.processLoop();
    }
  }

  private async runJob(job: QueuedJob): Promise<void> {
    const db = getDb();

    try {
      updateTenant(job.tenantId, { status: "scraping" });

      db.prepare(`
        UPDATE scrape_jobs
        SET status = 'running', started_at = datetime('now')
        WHERE tenant_id = ? AND status = 'queued'
        ORDER BY created_at DESC
        LIMIT 1
      `).run(job.tenantId);

      console.log(`[worker] Starting ${job.tenantId} (attempt ${job.attempt}/${MAX_RETRIES})`);

      const result = await withTimeout(
        scrapeTenant(job.tenantId, job.siteUrl, job.maxPages),
        JOB_TIMEOUT_MS,
        `scrape ${job.tenantId}`,
      );

      await forceCleanupBrowser();

      if (result.pages === 0) {
        throw new Error("Scraped 0 pages — site may be unreachable or blocking crawlers");
      }
      if (result.chunks === 0 && result.pages > 0) {
        throw new Error(`Scraped ${result.pages} pages but 0 chunks embedded — embedding likely failed`);
      }

      updateTenant(job.tenantId, {
        status: "active",
        lastScrapedAt: new Date().toISOString(),
        pagesCount: result.pages,
        chunksCount: result.chunks,
      });

      db.prepare(`
        UPDATE scrape_jobs
        SET status = 'completed', completed_at = datetime('now'),
            pages_scraped = ?, chunks_embedded = ?
        WHERE tenant_id = ? AND status = 'running'
        ORDER BY created_at DESC
        LIMIT 1
      `).run(result.pages, result.chunks, job.tenantId);

      console.log(`[worker] Done ${job.tenantId}: ${result.pages} pages, ${result.chunks} chunks`);

      try {
        const tenant = getTenant(job.tenantId);
        if (tenant && result.chunks > 0) {
          const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3211}`;
          await sendBotReadyEmail(tenant.email, tenant.id, tenant.domain, baseUrl);
        } else if (tenant && result.chunks === 0) {
          console.log(`[worker] Skipping bot-ready email for ${job.tenantId} — 0 chunks, demo won't work`);
        }
      } catch (emailErr: any) {
        console.error(`[worker] Email failed for ${job.tenantId}:`, emailErr.message);
      }
    } catch (error: any) {
      await forceCleanupBrowser();

      const msg = error.message || "Unknown error";
      console.error(`[worker] Failed ${job.tenantId} (attempt ${job.attempt}): ${msg}`);

      db.prepare(`
        UPDATE scrape_jobs
        SET status = 'failed', completed_at = datetime('now'), error = ?
        WHERE tenant_id = ? AND status = 'running'
        ORDER BY created_at DESC
        LIMIT 1
      `).run(msg, job.tenantId);

      if (job.attempt < MAX_RETRIES) {
        console.log(`[worker] Queuing retry for ${job.tenantId} (attempt ${job.attempt + 1}/${MAX_RETRIES})`);
        updateTenant(job.tenantId, { status: "pending" });

        db.prepare(`
          INSERT INTO scrape_jobs (tenant_id, status)
          VALUES (?, 'queued')
        `).run(job.tenantId);

        this.retryQueue.push({
          ...job,
          attempt: job.attempt + 1,
        });
      } else {
        console.error(`[worker] Giving up on ${job.tenantId} after ${MAX_RETRIES} attempts`);
        updateTenant(job.tenantId, { status: "error" });
      }
    }
  }
}
