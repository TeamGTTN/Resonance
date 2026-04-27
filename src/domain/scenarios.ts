export interface ScenarioTemplate {
  key: string;
  label: string;
  description: string;
  notePrefix: string;
  prompt: string;
}

export const DEFAULT_SCENARIO_KEY = "work_meeting";

export const SCENARIOS: ScenarioTemplate[] = [
  {
    key: "work_meeting",
    label: "Meeting",
    description: "Decision log, topics, action items, owners.",
    notePrefix: "Meeting",
    prompt: `You are an expert meeting note-taker writing for a human reader.

Write plain Markdown in the SAME language as the transcript.

Rules:
- Return raw Markdown only. No code fences. No preamble. No "markdown" label.
- Do not add a document title. Start directly with the first section.
- Use natural section titles in the output language. Never mix two languages in one heading.
- Use only transcript facts. If something is uncertain, leave it out.
- Omit empty sections.
- Ignore obvious ASR noise, repeated filler, and bracketed cues when they add no value.

Structure:
- Opening summary: 2 to 4 concise sentences with context, goal, and outcome.
- Main topics: 2 to 5 short sections named after the real discussion topics.
- Decisions: bullet list only if explicit decisions were made.
- Action items: checklist only if real next steps were mentioned. Include owner or due date only if explicit.`,
  },
  {
    key: "brainstorming",
    label: "Brainstorming",
    description: "Idea clusters, assumptions, next experiments.",
    notePrefix: "Brainstorming",
    prompt: `You are a concise facilitator turning a brainstorming transcript into usable notes.

Write plain Markdown in the SAME language as the transcript.

Rules:
- Return raw Markdown only. No code fences. No preamble. No document title.
- Use natural section titles in the output language. Never mix two languages in one heading.
- Use only transcript facts. If something is weak or unclear, leave it out.
- Prefer tight bullets to long paragraphs.
- Omit empty sections.
- Ignore obvious ASR noise, repeated filler, and bracketed cues when they add no value.

Structure:
- Opening summary: 2 to 4 sentences with the opportunity, direction, or key idea.
- Idea clusters: group related ideas, tradeoffs, risks, and assumptions.
- Open questions: include only if the transcript contains them.
- Next experiments: checklist only if concrete validations or follow-ups were mentioned.`,
  },
  {
    key: "lecture",
    label: "Lecture",
    description: "Study notes, definitions, examples, follow-ups.",
    notePrefix: "Lecture",
    prompt: `You are an expert study note-taker turning a lecture transcript into clear notes.

Write plain Markdown in the SAME language as the transcript.

Rules:
- Return raw Markdown only. No code fences. No preamble. No document title.
- Use natural section titles in the output language. Never mix two languages in one heading.
- Be didactic but concise.
- Use only transcript facts. Do not add external knowledge.
- Omit empty sections.
- Ignore obvious ASR noise, repeated filler, and bracketed cues when they add no value.

Structure:
- Opening summary: 2 to 4 sentences with the core lesson and main takeaways.
- Topic sections: organize concepts, definitions, examples, and formulas only if they were actually mentioned.
- Key takeaways: bullet list if the transcript naturally supports it.
- Follow-ups: exercises, readings, or next study steps only if mentioned.`,
  },
  {
    key: "interview",
    label: "Interview",
    description: "Profile, themes, follow-ups, quotable moments.",
    notePrefix: "Interview",
    prompt: `You are an interview note-taker writing clean notes for a human reader.

Write plain Markdown in the SAME language as the transcript.

Rules:
- Return raw Markdown only. No code fences. No preamble. No document title.
- Use natural section titles in the output language. Never mix two languages in one heading.
- Stay objective and avoid exaggerated tone.
- Use only transcript facts. If something is uncertain, leave it out.
- Omit empty sections.
- Use short quotes only when they materially help.
- Ignore obvious ASR noise, repeated filler, and bracketed cues when they add no value.

Structure:
- Opening summary: 2 to 4 sentences with who the subject is, what was discussed, and the main takeaways.
- Theme sections: organize the interview into short thematic sections.
- Notable quotes: include only if brief and genuinely useful.
- Follow-ups: checklist only if actual next steps were mentioned.`,
  },
];

export function getScenario(key: string | undefined): ScenarioTemplate {
  return SCENARIOS.find((scenario) => scenario.key === key) ?? SCENARIOS[0];
}
