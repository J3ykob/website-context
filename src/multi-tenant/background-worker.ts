/**
 * Background worker — processes scrape jobs one at a time (Playwright memory constraint).
 * Updates tenant status and scrape_jobs table as jobs progress.
 */

import { getDb } from "./db/connection.js";
import { runMigrations } from "./db/migrations.js";
import { getTenant, updateTenant } from "./tenant-registry.js";
import { scrapeTenant } from "./scrape-pipeline.js";
import { sendBotReadyEmail } from "./email.js";

interface QueuedJob {
  tenantId: string;
  siteUrl: string;
  maxPages: number;
}

let migrated = false;
function ensureMigrated(): void {
  if (!migrated) {
    runMigrations();
    migrated = true;
  }
}

export class ScrapeWorker {
  private queue: QueuedJob[] = [];
  private processing = false;

  /**
   * Enqueue a scrape job for a tenant.
   */
  enqueue(tenantId: string, siteUrl: string, maxPages: number = 20): void {
    ensureMigrated();
    const db = getDb();

    // Insert into scrape_jobs table
    db.prepare(`
      INSERT INTO scrape_jobs (tenant_id, status)
      VALUES (?, 'queued')
    `).run(tenantId);

    this.queue.push({ tenantId, siteUrl, maxPages });
    this.processNext();
  }

  /**
   * Check if the worker is currently processing a job.
   */
  isProcessing(): boolean {
    return this.processing;
  }

  /**
   * Get the number of queued jobs (not including the current one).
   */
  getQueueLength(): number {
    return this.queue.length;
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;

    this.processing = true;
    const job = this.queue.shift()!;

    const db = getDb();

    try {
      // Update tenant status to scraping
      updateTenant(job.tenantId, { status: "scraping" });

      // Update scrape_jobs: mark as running
      db.prepare(`
        UPDATE scrape_jobs
        SET status = 'running', started_at = datetime('now')
        WHERE tenant_id = ? AND status = 'queued'
        ORDER BY created_at DESC
        LIMIT 1
      `).run(job.tenantId);

      console.log(`[worker] Starting scrape for tenant ${job.tenantId}`);

      // Run the scrape pipeline
      const result = await scrapeTenant(job.tenantId, job.siteUrl, job.maxPages);

      // Update tenant status to active
      updateTenant(job.tenantId, {
        status: "active",
        lastScrapedAt: new Date().toISOString(),
        pagesCount: result.pages,
        chunksCount: result.chunks,
      });

      // Update scrape_jobs: mark as completed
      db.prepare(`
        UPDATE scrape_jobs
        SET status = 'completed', completed_at = datetime('now'),
            pages_scraped = ?, chunks_embedded = ?
        WHERE tenant_id = ? AND status = 'running'
        ORDER BY created_at DESC
        LIMIT 1
      `).run(result.pages, result.chunks, job.tenantId);

      console.log(`[worker] Completed scrape for tenant ${job.tenantId}: ${result.pages} pages, ${result.chunks} chunks`);

      // Send "bot ready" email
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
      console.error(`[worker] Failed scrape for tenant ${job.tenantId}:`, error.message);

      // Update tenant status to error
      updateTenant(job.tenantId, { status: "error" });

      // Update scrape_jobs: mark as failed
      db.prepare(`
        UPDATE scrape_jobs
        SET status = 'failed', completed_at = datetime('now'), error = ?
        WHERE tenant_id = ? AND status = 'running'
        ORDER BY created_at DESC
        LIMIT 1
      `).run(error.message || "Unknown error", job.tenantId);
    } finally {
      this.processing = false;
      // Process next job in queue
      this.processNext();
    }
  }
}
