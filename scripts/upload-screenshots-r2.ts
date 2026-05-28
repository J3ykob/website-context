import { uploadToR2 } from "../src/storage/r2.js";
import { readdirSync, readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(__dirname, "../data");

async function main() {
  const dirs = readdirSync(dataDir).filter(d => existsSync(resolve(dataDir, d, "screenshot.png")));
  console.log(`Uploading ${dirs.length} screenshots to R2...`);
  let ok = 0;
  for (const tid of dirs) {
    const data = readFileSync(resolve(dataDir, tid, "screenshot.png"));
    const success = await uploadToR2(`tenants/${tid}/screenshot.png`, data, "image/png");
    if (success) ok++;
    if (ok % 20 === 0 && ok > 0) console.log(`${ok}/${dirs.length}`);
  }
  console.log(`DONE: ${ok}/${dirs.length} uploaded`);
}
main().catch(console.error);
