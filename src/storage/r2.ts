import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || "98e447c9e14d384e1b7e6f4d42c39ad2";
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY;
const R2_SECRET_KEY = process.env.R2_SECRET_KEY;
const R2_BUCKET = process.env.R2_BUCKET || "whisp-data";

if (!R2_ACCESS_KEY || !R2_SECRET_KEY) {
  // No hardcoded fallback: the previous literal secret leaked into git history and
  // was rotated. Fail fast so a misconfigured deploy can never silently run with
  // bad/leaked creds (on Render a boot throw keeps the last good version live).
  throw new Error("R2_ACCESS_KEY and R2_SECRET_KEY are required (set them in the VPS .env and Render env).");
}

const client = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY, secretAccessKey: R2_SECRET_KEY },
});

export async function uploadToR2(key: string, data: Buffer | string, contentType?: string): Promise<boolean> {
  try {
    await client.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: typeof data === "string" ? Buffer.from(data) : data,
      ContentType: contentType,
    }));
    return true;
  } catch (err: any) {
    console.error(`[r2] Upload failed for ${key}: ${err.message}`);
    return false;
  }
}

export async function deleteFromR2(key: string): Promise<boolean> {
  try {
    await client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return true;
  } catch (err: any) {
    console.error(`[r2] Delete failed for ${key}: ${err.message}`);
    return false;
  }
}

export async function downloadFromR2(key: string): Promise<Buffer | null> {
  try {
    const resp = await client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    const chunks: Buffer[] = [];
    for await (const chunk of resp.Body as any) chunks.push(chunk);
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

export interface TenantUploadResult {
  uploaded: string[]; // files that landed in R2
  missing: string[];  // files not present on disk
  failed: string[];   // files present on disk but whose upload failed
}

// Uploads a tenant's R2 artifacts and reports exactly which landed. Pass `required`
// (e.g. ["context-meta.json"]) to make those mandatory: if any required file is
// missing or failed to upload, this THROWS so the caller never registers / emails a
// tenant whose critical R2 files aren't actually present (serving hard-depends on
// context-meta.json; the demo email's hero needs screenshot.png).
export async function uploadTenantFiles(tenantId: string, dataDir: string, required: string[] = []): Promise<TenantUploadResult> {
  const { readFileSync, existsSync } = await import("fs");
  const { resolve } = await import("path");
  const files = ["context-meta.json", "business-info.json", "auto-context-notes.json", "screenshot.png"];
  const uploaded: string[] = [];
  const missing: string[] = [];
  const failed: string[] = [];
  for (const file of files) {
    const filePath = resolve(dataDir, tenantId, file);
    if (!existsSync(filePath)) { missing.push(file); continue; }
    const data = readFileSync(filePath);
    const contentType = file.endsWith(".json") ? "application/json" : "image/png";
    const ok = await uploadToR2(`tenants/${tenantId}/${file}`, data, contentType);
    (ok ? uploaded : failed).push(file);
  }
  const bad = required.filter((f) => !uploaded.includes(f));
  if (bad.length > 0) {
    throw new Error(`uploadTenantFiles ${tenantId}: required file(s) not uploaded: ${bad.join(", ")} (missing=[${missing.join(",")}] failed=[${failed.join(",")}])`);
  }
  return { uploaded, missing, failed };
}

export async function downloadTenantFile(tenantId: string, file: string): Promise<Buffer | null> {
  return downloadFromR2(`tenants/${tenantId}/${file}`);
}

// Like downloadFromR2 but distinguishes a genuinely-absent key (returns null) from an
// R2 auth/network/throttle error (THROWS). Lets callers return 404-vs-500 correctly
// and lets health checks detect R2 being down — unlike downloadFromR2, whose bare
// catch makes a dead credential indistinguishable from a missing file. Used on paths
// that need that distinction; the lenient downloadFromR2 stays for everything else.
export async function downloadFromR2Strict(key: string): Promise<Buffer | null> {
  try {
    const resp = await client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    const chunks: Buffer[] = [];
    for await (const chunk of resp.Body as any) chunks.push(chunk);
    return Buffer.concat(chunks);
  } catch (err: any) {
    const name = err?.name || err?.Code || "";
    if (name === "NoSuchKey" || name === "NotFound" || err?.$metadata?.httpStatusCode === 404) return null;
    throw new Error(`R2 download error for ${key}: ${name} ${err?.message || ""}`.slice(0, 200));
  }
}

export async function downloadTenantFileStrict(tenantId: string, file: string): Promise<Buffer | null> {
  return downloadFromR2Strict(`tenants/${tenantId}/${file}`);
}
