/**
 * Files the server keeps only on its own disk - owners' notes, the e-mail unsubscribe list, the "do not call"
 * list, demo visits, SMS replies - mirrored to R2 (`disk/<path under data/>`), and restored from there when a
 * server starts without them (a new instance, a new region, a replaced disk). They were on the disk alone:
 * moving the server to Frankfurt would have dropped the unsubscribe and do-not-call lists.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, relative, resolve, sep } from "path";
import { uploadToR2, downloadFromR2 } from "./r2.js";

const INDEX_KEY = "disk/index.json";
let dataDir = "";
let known: Set<string> | null = null;
let indexWrites: Promise<unknown> = Promise.resolve(); // index updates one after another (no lost paths)

const keyOf = (abs: string) => `disk/${relative(dataDir, abs).split(sep).join("/")}`;

async function index(): Promise<Set<string>> {
  if (!known) {
    const buf = await downloadFromR2(INDEX_KEY);
    known = new Set(buf ? (JSON.parse(buf.toString("utf-8")) as string[]) : []);
  }
  return known;
}

/** After a local write: the file's current content to R2 (and its path to the index). Never throws. */
export async function mirror(abs: string): Promise<void> {
  try {
    if (!dataDir || !existsSync(abs)) return;
    const rel = relative(dataDir, abs).split(sep).join("/");
    if (rel.startsWith("..")) return;
    const ok = await uploadToR2(keyOf(abs), readFileSync(abs));
    if (ok) indexWrites = indexWrites.then(async () => {
      const idx = await index();
      if (!idx.has(rel)) { idx.add(rel); await uploadToR2(INDEX_KEY, JSON.stringify([...idx]), "application/json"); }
    }).catch(() => {});
    await indexWrites;
    if (!ok) console.warn(`[disk-mirror] ${rel} not mirrored`);
  } catch (e) {
    console.warn(`[disk-mirror] ${abs}: ${(e as Error).message}`);
  }
}

/** At startup, before the files are read: every mirrored file missing on this disk comes back from R2. */
export async function restoreDisk(dir: string): Promise<number> {
  dataDir = dir;
  let restored = 0;
  try {
    for (const rel of await index()) {
      const abs = resolve(dir, rel);
      if (!abs.startsWith(dir + sep) || existsSync(abs)) continue;
      const buf = await downloadFromR2(`disk/${rel}`);
      if (!buf) continue;
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, buf);
      restored++;
    }
    if (restored) console.log(`[disk-mirror] restored ${restored} file(s) from R2`);
  } catch (e) {
    console.warn(`[disk-mirror] restore failed: ${(e as Error).message}`);
  }
  return restored;
}
