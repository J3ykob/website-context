import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

const R2_ACCOUNT_ID = "98e447c9e14d384e1b7e6f4d42c39ad2";
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY || "de08d17162106b5a078b93ad12fa8a56";
const R2_SECRET_KEY = process.env.R2_SECRET_KEY || "9aa3b7b3aafff813e826519c145597182e6743cbd148d2715b6a0018101f4b26";
const R2_BUCKET = process.env.R2_BUCKET || "whisp-data";

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

export async function uploadTenantFiles(tenantId: string, dataDir: string): Promise<number> {
  const { readFileSync, existsSync } = await import("fs");
  const { resolve } = await import("path");
  const files = ["context-meta.json", "business-info.json", "auto-context-notes.json", "screenshot.png"];
  let uploaded = 0;
  for (const file of files) {
    const filePath = resolve(dataDir, tenantId, file);
    if (!existsSync(filePath)) continue;
    const data = readFileSync(filePath);
    const contentType = file.endsWith(".json") ? "application/json" : "image/png";
    const ok = await uploadToR2(`tenants/${tenantId}/${file}`, data, contentType);
    if (ok) uploaded++;
  }
  return uploaded;
}

export async function downloadTenantFile(tenantId: string, file: string): Promise<Buffer | null> {
  return downloadFromR2(`tenants/${tenantId}/${file}`);
}
