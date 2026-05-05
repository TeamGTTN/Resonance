import { requestUrl, type RequestUrlParam } from "obsidian";
import { getProviderCapabilities, getSelectedSummaryModel, type SummaryProviderId } from "../../domain/providers";
import type { SummarySettings } from "../../domain/settings";

export interface SummaryResult {
  provider: SummaryProviderId;
  model: string;
  markdown: string;
}

interface OllamaGenerateResponse {
  response?: string;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
}

interface OpenAIResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

interface AnthropicResponse {
  content?: Array<{ text?: string }>;
}

function isInvalidTranscript(transcript: string): boolean {
  const text = transcript.trim();
  if (!text) return true;
  const letters = (text.match(/[A-Za-zÀ-ÖØ-öø-ÿ]/g) || []).length;
  return text.length < 40 || letters < 30;
}

export function detectLanguageFromTranscript(transcript: string): string {
  const text = transcript.toLowerCase();
  const italianWords = ["è", "che", "di", "sono", "con", "per", "una", "abbiamo", "quindi", "però", "anche", "questa"];
  const englishWords = ["the", "and", "that", "have", "with", "this", "but", "from", "they", "time", "very", "just"];
  const spanishWords = ["que", "de", "la", "el", "en", "un", "ser", "se", "por", "con", "para", "como"];
  const frenchWords = ["le", "de", "et", "un", "il", "être", "en", "avec", "pas", "plus", "sans", "où"];
  const scores = { it: 0, en: 0, es: 0, fr: 0 };

  const countWords = (words: string[]) =>
    words.reduce((total, word) => total + (text.match(new RegExp(`\\b${word}\\b`, "gi")) || []).length, 0);
  scores.it += countWords(italianWords);
  scores.en += countWords(englishWords);
  scores.es += countWords(spanishWords);
  scores.fr += countWords(frenchWords);
  if (/[àèéìòù]/.test(text)) scores.it += 3;
  if (/[ñáéíóúü]/.test(text)) scores.es += 3;
  if (/[àâäéèêëïîôöùûüÿç]/.test(text)) scores.fr += 3;
  const maxScore = Math.max(...Object.values(scores));
  if (maxScore === 0) return "en";
  return (Object.entries(scores).find(([, value]) => value === maxScore)?.[0] ?? "en");
}

function buildSystemGuard(expectedLanguage: string, transcript: string): string {
  const actualLanguage = expectedLanguage === "auto" ? detectLanguageFromTranscript(transcript) : expectedLanguage;
  const languageRule =
    actualLanguage === "it"
      ? "Output language MUST be Italian."
      : actualLanguage === "es"
      ? "Output language MUST be Spanish."
      : actualLanguage === "fr"
      ? "Output language MUST be French."
      : actualLanguage === "auto"
      ? "Output MUST be in the same language as the transcript."
      : `Output language MUST be ${actualLanguage}.`;

  return [
    "You are a careful summarizer that writes clean Markdown for a human reader.",
    "STRICT RULES:",
    `- ${languageRule}`,
    "- Use only transcript facts.",
    "- Do not invent or infer beyond the transcript.",
    "- Return raw Markdown only. No code fences. No preamble. No \"markdown\" label.",
    "- Do not add a document title unless the user explicitly asked for one.",
    "- Never mix two languages in the same heading.",
    "- Prefer natural section titles in the output language over literal translations of prompt wording.",
    "- Ignore obvious ASR glitches, repeated filler, and bracketed cues when they add no value.",
    "- If the transcript is empty, invalid, or too weak, return an empty string.",
  ].join("\n");
}

export class SummaryAdapter {
  async summarize(settings: SummarySettings, prompt: string, transcript: string, expectedLanguage: string): Promise<SummaryResult> {
    if (isInvalidTranscript(transcript)) {
      return {
        provider: settings.provider,
        model: getSelectedSummaryModel(settings),
        markdown: "",
      };
    }

    const provider = settings.provider;
    const model = getSelectedSummaryModel(settings);
    switch (provider) {
      case "gemini":
        return { provider, model, markdown: await this.summarizeWithGemini(settings, prompt, transcript, expectedLanguage) };
      case "openai":
        return { provider, model, markdown: await this.summarizeWithOpenAI(settings, prompt, transcript, expectedLanguage) };
      case "anthropic":
        return { provider, model, markdown: await this.summarizeWithAnthropic(settings, prompt, transcript, expectedLanguage) };
      case "ollama":
      default:
        return { provider: "ollama", model, markdown: await this.summarizeWithOllama(settings, prompt, transcript, expectedLanguage) };
    }
  }

  private async summarizeWithOllama(
    settings: SummarySettings,
    prompt: string,
    transcript: string,
    expectedLanguage: string
  ): Promise<string> {
    const base = settings.ollamaEndpoint.trim() || "http://localhost:11434";
    const json = await requestProviderJson<OllamaGenerateResponse>("Ollama", {
      url: `${base}/api/generate`,
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({
        model: settings.ollamaModel || getProviderCapabilities("ollama").defaultModel,
        prompt: `${buildSystemGuard(expectedLanguage, transcript)}\n\n${prompt}\n\nTranscript:\n${transcript}`,
        stream: false,
        options: { temperature: 0, top_p: 0.9, top_k: 40, num_predict: 2048 },
      }),
    });
    return String(json.response ?? "").trim();
  }

  private async summarizeWithGemini(
    settings: SummarySettings,
    prompt: string,
    transcript: string,
    expectedLanguage: string
  ): Promise<string> {
    if (!settings.geminiApiKey.trim()) throw new Error("Gemini API key not configured.");
    const model = settings.geminiModel || getProviderCapabilities("gemini").defaultModel;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const body = {
      systemInstruction: { role: "system", parts: [{ text: buildSystemGuard(expectedLanguage, transcript) }] },
      contents: [{ role: "user", parts: [{ text: `${prompt}\n\nTranscript:\n${transcript}` }] }],
    };
    const json = await requestProviderJson<GeminiResponse>("Gemini", {
      url: `${url}?key=${encodeURIComponent(settings.geminiApiKey)}`,
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify(body),
    });
    return String(json.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("\n") ?? "").trim();
  }

  private async summarizeWithOpenAI(
    settings: SummarySettings,
    prompt: string,
    transcript: string,
    expectedLanguage: string
  ): Promise<string> {
    if (!settings.openaiApiKey.trim()) throw new Error("OpenAI API key not configured.");
    const json = await requestProviderJson<OpenAIResponse>("OpenAI", {
      url: "https://api.openai.com/v1/chat/completions",
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.openaiApiKey}`,
      },
      contentType: "application/json",
      body: JSON.stringify({
        model: settings.openaiModel || getProviderCapabilities("openai").defaultModel,
        temperature: 0,
        messages: [
          { role: "system", content: buildSystemGuard(expectedLanguage, transcript) },
          { role: "user", content: `${prompt}\n\nTranscript:\n${transcript}` },
        ],
      }),
    });
    return String(json.choices?.[0]?.message?.content ?? "").trim();
  }

  private async summarizeWithAnthropic(
    settings: SummarySettings,
    prompt: string,
    transcript: string,
    expectedLanguage: string
  ): Promise<string> {
    if (!settings.anthropicApiKey.trim()) throw new Error("Anthropic API key not configured.");
    const json = await requestProviderJson<AnthropicResponse>("Anthropic", {
      url: "https://api.anthropic.com/v1/messages",
      method: "POST",
      headers: {
        "x-api-key": settings.anthropicApiKey,
        "anthropic-version": "2023-06-01",
      },
      contentType: "application/json",
      body: JSON.stringify({
        model: settings.anthropicModel || getProviderCapabilities("anthropic").defaultModel,
        max_tokens: 2000,
        temperature: 0,
        system: buildSystemGuard(expectedLanguage, transcript),
        messages: [{ role: "user", content: `${prompt}\n\nTranscript:\n${transcript}` }],
      }),
    });
    return String(json.content?.map((part) => part.text ?? "").join("\n") ?? "").trim();
  }
}

async function requestProviderJson<T>(providerLabel: string, request: RequestUrlParam): Promise<T> {
  const response = await requestUrl({
    ...request,
    throw: false,
  });
  if (response.status >= 400) {
    throw new Error(`${providerLabel} API error: ${response.status} ${response.text}`);
  }
  return response.json as T;
}
