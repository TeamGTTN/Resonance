export function normalizeCheckboxes(markdown: string): string {
  try {
    const lines = markdown.split(/\r?\n/);
    const out: string[] = [];
    for (let raw of lines) {
      let line = raw;
      line = line.replace(/[\uFF3B\u3010]/g, "[").replace(/[\uFF3D\u3011]/g, "]");
      line = line.replace(/[“”«»]/g, '"').replace(/[‘’]/g, "'");

      const match = line.match(/^(\s*)[-*]?\s*(?:["']\s*)?\[\s*([xX])?\s*\](?:\s*["'])?\s*(.*)$/);
      if (match) {
        const indent = match[1] || "";
        const checked = match[2] ? "x" : " ";
        const rest = match[3] || "";
        out.push(`${indent}- [${checked}] ${rest}`.trimEnd());
        continue;
      }

      line = line.replace(
        /^(\s*)[-*]\s*\[\s*([xX ])\s*\]\s*(.*)$/,
        (_source: string, indent: string, checked: string, rest: string) =>
          `${indent}- [${checked.toLowerCase() === "x" ? "x" : " "}] ${rest}`
      );
      out.push(line);
    }
    return out.join("\n");
  } catch {
    return markdown;
  }
}

export function sanitizeSummary(markdown: string): string {
  try {
    let value = String(markdown ?? "").trim();
    if (!value) return value;

    value = value.replace(/[\uFF1C]/g, "<").replace(/[\uFF1E]/g, ">");
    const cotTags = ["think", "analysis", "reflection", "reasoning", "chain_of_thought", "chain-of-thought", "cot"];
    for (const tag of cotTags) {
      const pattern = new RegExp(`<\\s*${tag}[^>]*>[\\s\\S]*?<\\/\\s*${tag}\\s*>`, "gi");
      value = value.replace(pattern, "");
    }

    const fencedMarkdownMatch = value.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
    if (fencedMarkdownMatch) {
      value = fencedMarkdownMatch[1].trim();
    }

    value = value.replace(/```\s*(thinking|analysis|reasoning|reflection|chain[_ -]?of[_ -]?thought|cot|log)[\s\S]*?```/gi, "");
    value = value.replace(/^\s*<(assistant|system|user)[^>]*>\s*/gim, "");
    value = value.replace(/\n{3,}/g, "\n\n").trim();
    return value;
  } catch {
    return markdown;
  }
}

export function formatTranscriptChunkMarkdown(_index: number, text: string): string {
  const clean = normalizeTranscriptChunk(text);
  if (!clean) return "";
  return clean;
}

export function formatLiveTranscriptNote(title: string, transcript: string): string {
  const clean = normalizeTranscriptChunk(transcript);
  const body = clean ? `\n\n${clean}\n` : "\n\n";
  return `# ${title}\n\n> Live draft while recording. Minor errors are normal.${body}`;
}

function normalizeTranscriptChunk(text: string): string {
  const normalized = String(text ?? "").trim().replace(/\r\n/g, "\n");
  if (!normalized) return "";

  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !isTranscriptAnnotationLine(line));

  const compact: string[] = [];
  let previousBlank = false;
  for (const line of lines) {
    const isBlank = line.length === 0;
    if (isBlank) {
      if (!previousBlank && compact.length > 0) {
        compact.push("");
      }
      previousBlank = true;
      continue;
    }
    compact.push(line);
    previousBlank = false;
  }

  return compact.join("\n").trim();
}

function isTranscriptAnnotationLine(line: string): boolean {
  const value = line.trim();
  if (!value) return false;
  if (!/^\[[^\]\n]{1,120}\]$/.test(value)) return false;

  const inner = value.slice(1, -1).trim();
  if (!inner) return true;

  const normalized = inner
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  return [
    "music",
    "musica",
    "applause",
    "applausi",
    "laughter",
    "risate",
    "silence",
    "silenzio",
    "noise",
    "rumore",
    "sottotitoli",
    "respondenti del mio canale",
    "rispondenti del mio canale",
    "subtitle",
    "subtitles",
  ].some((token) => normalized.includes(token));
}
