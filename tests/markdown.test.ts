import test from "node:test";
import assert from "node:assert/strict";
import { formatLiveTranscriptNote, formatTranscriptChunkMarkdown, sanitizeSummary } from "../src/utils/markdown";

test("formatTranscriptChunkMarkdown emits plain transcript text without segment headings", () => {
  assert.equal(
    formatTranscriptChunkMarkdown(3, "Ciao.\n\nCome va?"),
    "Ciao.\n\nCome va?"
  );
});

test("formatLiveTranscriptNote builds a user-facing transcript note", () => {
  const note = formatLiveTranscriptNote("Meeting — Transcript", "Prima riga.\n\nSeconda riga.");
  assert.match(note, /^# Meeting — Transcript/);
  assert.match(note, /> Live draft while recording/);
  assert.ok(!note.includes("Segment 0000"));
});

test("formatTranscriptChunkMarkdown removes standalone annotation lines in brackets", () => {
  assert.equal(
    formatTranscriptChunkMarkdown(1, "[Musica]\n\nCiao a tutti.\n[Sottotitoli e rispondenti del mio canale]\nCome va?"),
    "Ciao a tutti.\nCome va?"
  );
});

test("sanitizeSummary removes a wrapping markdown code fence", () => {
  assert.equal(
    sanitizeSummary("```markdown\n## Riassunto\n\nTesto.\n```"),
    "## Riassunto\n\nTesto."
  );
});
