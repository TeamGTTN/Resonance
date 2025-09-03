export function normalizeCheckboxes(markdown: string): string {
  try {
    const lines = markdown.split(/\r?\n/);
    const out: string[] = [];
    for (let raw of lines) {
      let line = raw;
      // Normalize fullwidth brackets and weird quotes to plain
      line = line.replace(/[\uFF3B\u3010]/g, '[').replace(/[\uFF3D\u3011]/g, ']');
      line = line.replace(/[“”«»]/g, '"').replace(/[‘’]/g, "'");

      // If line starts with checkbox variants possibly wrapped in quotes, normalize prefix
      const m = line.match(/^(\s*)[-*]?\s*(?:["']\s*)?\[\s*([xX])?\s*\](?:\s*["'])?\s*(.*)$/);
      if (m) {
        const indent = m[1] || '';
        const checked = m[2] ? 'x' : ' ';
        const rest = m[3] || '';
        out.push(`${indent}- [${checked}] ${rest}`.trimEnd());
        continue;
      }

      // If line starts with list + quoted checkbox, e.g., - "[ ]" Task
      const m2 = line.match(/^(\s*)[-*]\s*(?:["']\s*)?\[\s*([xX])?\s*\](?:\s*["'])?\s*(.*)$/);
      if (m2) {
        const indent = m2[1] || '';
        const checked = m2[2] ? 'x' : ' ';
        const rest = m2[3] || '';
        out.push(`${indent}- [${checked}] ${rest}`.trimEnd());
        continue;
      }

      // Ensure consistent spacing for already-correct checkboxes
      line = line.replace(/^(\s*)[-*]\s*\[\s*([xX ])\s*\]\s*(.*)$/,
        (_s, i, c, r) => `${i}- [${c.toLowerCase() === 'x' ? 'x' : ' '}] ${r}`);

      out.push(line);
    }
    return out.join('\n');
  } catch {
    return markdown;
  }
}


