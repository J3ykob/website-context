/**
 * A PDF's text line by line as it is laid out on the page. unpdf's extractText returns text in drawing
 * order, which for tables is often column by column ("350 240 455 520 ... Kozioł B-BR Kozioł MINI"): a
 * price could no longer be told from a weight. Here every text item is placed by its position: items on
 * the same line (same y) are joined left to right, so a table row stays one line ("Kozioł B-S ... 520").
 */
export async function pdfLayoutText(pdf: any): Promise<string> {
  const lines: string[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    const items = (content.items as any[])
      .filter((it) => typeof it.str === "string" && it.str.trim())
      .map((it) => ({ s: it.str as string, x: it.transform[4] as number, y: it.transform[5] as number, w: (it.width as number) || 0, h: Math.abs(it.transform[3] as number) || 10 }));
    // Rows: items whose baselines are within a third of the text height of each other.
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const rows: (typeof items)[] = [];
    for (const it of items) {
      const row = rows[rows.length - 1];
      if (row && Math.abs(row[0].y - it.y) <= Math.max(2, it.h / 3)) row.push(it);
      else rows.push([it]);
    }
    for (const row of rows) {
      row.sort((a, b) => a.x - b.x);
      let line = "";
      let end = -Infinity;
      for (const it of row) {
        // A wide gap (a table column) becomes " | ", a small one a space, touching items join.
        const gap = it.x - end;
        line += !line ? it.s : gap > it.h * 1.5 ? ` | ${it.s}` : gap > it.h * 0.15 ? ` ${it.s}` : it.s;
        end = it.x + it.w;
      }
      lines.push(line.replace(/\s+/g, " ").trim());
    }
    lines.push("");
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
