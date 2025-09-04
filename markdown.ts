// This module provides a function to normalize the markdown.

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

// Rimuove intro/outro generiche, blocchi di "thinking" o meta‑output dai modelli
export function sanitizeSummary(markdown: string): string {
  try {
    let s = String(markdown ?? '').trim();

    if (!s) return s;

    // Normalizza eventuali angoli fullwidth
    s = s.replace(/[\uFF1C]/g, '<').replace(/[\uFF1E]/g, '>');

    // Rimuovi completamente blocchi di ragionamento (tag stile XML)
    const cotTags = ['think', 'analysis', 'reflection', 'reasoning', 'chain_of_thought', 'chain-of-thought', 'cot'];
    for (const tag of cotTags) {
      const re = new RegExp(`<\s*${tag}[^>]*>[\\s\\S]*?<\\/\s*${tag}\s*>`, 'gi');
      s = s.replace(re, '');
    }

    // Rimuovi code-fence con etichette di ragionamento
    s = s.replace(/```\s*(thinking|analysis|reasoning|reflection|chain[_ -]?of[_ -]?thought|cot|log)[\s\S]*?```/gi, '');

    // Rimuovi intestazioni tipo "assistant", "system" ecc.
    s = s.replace(/^\s*<(assistant|system|user)[^>]*>\s*/gim, '');

    // Rimuovi frasi introduttive (robusto su 1-2 paragrafi iniziali)
    const dropIntro = (text: string): string => {
      const paras = text.split(/\n\s*\n/);
      const isIntro = (p: string): boolean => {
        const t = p.trim().toLowerCase();
        if (t.length < 4) return true; // vuoto/spazi all'inizio
        const starts = /^(ecco|qui|di\s+seguito|in\s+sintesi|in\s+breve|riassunto|sintesi|panoramica|overview|summary|below|here)/.test(t);
        const hasKeywords = /(sintesi|riassun|summary|overview|organizz|panoramica)/.test(t);
        return starts && hasKeywords;
      };
      let i = 0;
      while (i < Math.min(2, paras.length) && isIntro(paras[i])) i++;
      return paras.slice(i).join('\n\n').trimStart();
    };
    s = dropIntro(s);

    // Rimuovi frasi conclusive comuni in coda
    s = s.replace(/\n+\s*(se\s+hai\s+bisogno[^\n]*|fammi\s+sapere[^\n]*|per\s+ulteriori\s+chiarimenti[^\n]*|rimango\s+a\s+disposizione[^\n]*|contattami[^\n]*|let\s+me\s+know[^\n]*|hope\s+this\s+helps[^\n]*|i\s+can\s+help[^\n]*)\s*$/i, '');

    // Evita doppi spaziature iniziali
    s = s.replace(/^(\s*\n)+/, '').trim();

    // Collassa e normalizza spaziature multiple
    s = s.replace(/\n{3,}/g, '\n\n');

    return s;
  } catch {
    return markdown;
  }
}


