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
const JOB_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes per scrape
const RETRY_BACKOFF = [5_000, 15_000, 30_000]; // 5s, 15s, 30s

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
  } catch {
    // Browser may already be dead — that's fine
  }
}

export class ScrapeWorker {
  private queue: QueuedJob[] = [];
  private processing = false;

  enqueue(tenantId: string, siteUrl: string, maxPages: number = 20): void {
    ensureMigrated();
    const db = getDb();

    const alreadyQueued = this.queue.some((j) => j.tenantId === tenantId);
    if (alreadyQueued) {
      console.log(`[worker] ${tenantId} already in queue, skipping`);
      return;
    }

    db.prepare(`
      INSERT INTO scrape_jobs (tenant_id, status)
      VALUES (?, 'queued')
    `).run(tenantId);

    this.queue.push({ tenantId, siteUrl, maxPages, attempt: 1 });
    this.processNext();
  }

  isProcessing(): boolean {
    return this.processing;
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  /**
   * On startup, recover tenants stuck in 'scraping' status (crashed mid-job).
   * Re-enqueue them for retry.
   */
  recoverStuckJobs(): void {
    ensureMigrated();
    const stuck = listTenants().filter((t) => t.status === "scraping");
    for (const tenant of stuck) {
      console.log(`[worker] Recovering stuck tenant: ${tenant.id}`);
      updateTenant(tenant.id, { status: "pending" });
      this.enqueue(tenant.id, tenant.siteUrl, 20);
    }
    if (stuck.length > 0) {
      console.log(`[worker] Recovered ${stuck.length} stuck tenant(s)`);
    }
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;

    this.processing = true;
    const job = this.queue.shift()!;
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

      console.log(`[worker] Starting scrape for ${job.tenantId} (attempt ${job.attempt}/${MAX_RETRIES})`);

      const result = await withTimeout(
        scrapeTenant(job.tenantId, job.siteUrl, job.maxPages),
        JOB_TIMEOUT_MS,
        `scrape ${job.tenantId}`,
      );

      await forceCleanupBrowser();

      if (result.pages === 0) {
        throw new Error("Scraped 0 pages — site may be unreachable or blocking crawlers");
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

      console.log(`[worker] Completed ${job.tenantId}: ${result.pages} pages, ${result.chunks} chunks`);

      try {
        const tenant = getTenant(job.tenantId);
        if (tenant) {
          const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3211}`;
          await sendBotReadyEmail(tenant.email, tenant.id, tenant.domain, baseUrl);
        }
      } catch (emailErr: any) {
        console.error(`[worker] Failed to send bot-ready email for ${job.tenantId}:`, emailErr.message);
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
        const delay = RETRY_BACKOFF[job.attempt - 1] || 30_000;
        console.log(`[worker] Will retry ${job.tenantId} in ${delay / 1000}s (attempt ${job.attempt + 1}/${MAX_RETRIES})`);

        updateTenant(job.tenantId, { status: "pending" });

        setTimeout(() => {
          db.prepare(`
            INSERT INTO scrape_jobs (tenant_id, status)
            VALUES (?, 'queued')
          `).run(job.tenantId);

          this.queue.push({
            tenantId: job.tenantId,
            siteUrl: job.siteUrl,
            maxPages: job.maxPages,
            attempt: job.attempt + 1,
          });
          this.processNext();
        }, delay);
      } else {
        console.error(`[worker] Giving up on ${job.tenantId} after ${MAX_RETRIES} attempts`);
        updateTenant(job.tenantId, { status: "error" });
      }
    } finally {
      this.processing = false;
      this.processNext();
    }
  }
}
