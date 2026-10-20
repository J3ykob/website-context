/**
 * Plain-text email templates kept as files in templates/emails/ (README.md there): the text is edited
 * there, not in code. First line "Temat:" / "Subject:", then the body; {{name}} placeholders; leading
 * "#" lines are notes for whoever edits it. Language versions name.<lang>.txt, falling back to Polish.
 */
import { readFileSync } from "fs";
import { resolve } from "path";

const DIR = resolve(process.cwd(), "templates/emails");

function read(name: string, lang?: string): string | null {
  for (const file of [lang ? `${name}.${lang}.txt` : "", `${name}.pl.txt`, `${name}.txt`].filter(Boolean)) {
    try { return readFileSync(resolve(DIR, file), "utf-8"); } catch { /* next */ }
  }
  return null;
}

/** The email filled with `vars`; null when the template file is missing. */
export function renderTemplate(name: string, vars: Record<string, string>, lang?: string): { subject: string; text: string } | null {
  const raw = read(name, lang);
  if (raw === null) return null;
  const lines = raw.split("\n");
  while (lines.length && lines[0].startsWith("#")) lines.shift();
  const first = (lines.shift() || "").trim();
  const subject = first.includes(":") ? first.slice(first.indexOf(":") + 1).trim() : first;
  while (lines.length && !lines[0].trim()) lines.shift();
  let text = lines.join("\n").trimEnd();
  let subj = subject;
  for (const [k, v] of Object.entries(vars)) { text = text.split(`{{${k}}}`).join(v); subj = subj.split(`{{${k}}}`).join(v); }
  return { subject: subj, text };
}
