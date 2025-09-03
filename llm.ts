export type LlmProvider = 'gemini' | 'openai' | 'anthropic' | 'ollama';

export interface LlmConfig {
  provider: LlmProvider;
  apiKey?: string;
  model: string;
  endpoint?: string; // for self-hosted like Ollama or custom endpoints
}

export async function summarizeWithLLM(cfg: LlmConfig, prompt: string, transcript: string, expectedLang?: string): Promise<string> {
  // Pre-flight guard: avoid calling models on empty/invalid input
  if (isInvalidTranscript(transcript)) return '';
  switch (cfg.provider) {
    case 'gemini':
      return summarizeWithGemini(cfg, prompt, transcript, expectedLang);
    case 'openai':
      return summarizeWithOpenAI(cfg, prompt, transcript, expectedLang);
    case 'anthropic':
      return summarizeWithAnthropic(cfg, prompt, transcript, expectedLang);
    case 'ollama':
      return summarizeWithOllama(cfg, prompt, transcript, expectedLang);
    default:
      throw new Error('Unsupported LLM provider');
  }
}

function isInvalidTranscript(transcript: string): boolean {
  try {
    const t = (transcript || '').trim();
    if (!t) return true;
    const letters = (t.match(/[A-Za-zÀ-ÖØ-öø-ÿ]/g) || []).length;
    // Consider invalid if too short or almost no letters (likely noise)
    if (t.length < 40 || letters < 30) return true;
  } catch {}
  return false;
}

function buildSystemGuard(expectedLang: string, transcript: string): string {
  const actualLang = expectedLang === 'auto' ? detectLanguageFromTranscript(transcript) : expectedLang;
  
  const langRule = actualLang === 'it' ? 'Output language MUST be Italian (italiano).'
    : actualLang === 'es' ? 'Output language MUST be Spanish (español).'
    : actualLang === 'fr' ? 'Output language MUST be French (français).'
    : actualLang === 'auto' ? 'Output MUST be in the SAME language as the transcript.'
    : `Output language MUST be ${actualLang}.`;
    
  return [
    'You are a careful summarizer that writes clean Markdown.',
    'STRICT RULES:',
    `- ${langRule}`,
    '- Use ONLY information present in the transcript. Do NOT invent or infer beyond it.',
    '- If the transcript is empty, invalid, or contains insufficient linguistic content, return an empty string and nothing else.',
  ].join('\n');
}

export function detectLanguageFromTranscript(transcript: string): string {
  const text = transcript.toLowerCase();
  
  // Parole comuni italiane
  const italianWords = ['è', 'che', 'di', 'sono', 'con', 'per', 'una', 'abbiamo', 'quindi', 'però', 'anche', 'della', 'nell', 'sulla', 'questa', 'quello', 'molto', 'tutto', 'più', 'quando', 'dove', 'come', 'perché', 'allora', 'cioè'];
  const englishWords = ['the', 'and', 'that', 'have', 'for', 'not', 'with', 'you', 'this', 'but', 'his', 'from', 'they', 'know', 'want', 'been', 'good', 'much', 'some', 'time', 'very', 'when', 'come', 'here', 'just', 'like', 'long', 'make', 'many', 'over', 'such', 'take', 'than', 'only', 'well', 'year'];
  const spanishWords = ['que', 'de', 'no', 'la', 'el', 'en', 'un', 'ser', 'se', 'no', 'te', 'lo', 'le', 'da', 'su', 'por', 'son', 'con', 'para', 'al', 'una', 'su', 'del', 'las', 'los', 'como', 'pero', 'sus', 'ese', 'hasta'];
  const frenchWords = ['le', 'de', 'et', 'un', 'il', 'être', 'et', 'en', 'avoir', 'que', 'pour', 'dans', 'ce', 'son', 'une', 'sur', 'avec', 'ne', 'se', 'pas', 'tout', 'plus', 'par', 'grand', 'celui', 'me', 'bien', 'où', 'sans', 'aux'];

  let italianScore = 0;
  let englishScore = 0;
  let spanishScore = 0;
  let frenchScore = 0;

  // Conta le occorrenze di parole tipiche
  for (const word of italianWords) {
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    italianScore += (text.match(regex) || []).length;
  }
  
  for (const word of englishWords) {
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    englishScore += (text.match(regex) || []).length;
  }
  
  for (const word of spanishWords) {
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    spanishScore += (text.match(regex) || []).length;
  }
  
  for (const word of frenchWords) {
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    frenchScore += (text.match(regex) || []).length;
  }

  // Cerca caratteri accentati tipici
  if (/[àèéìòù]/g.test(text)) italianScore += 3;
  if (/[ñáéíóúü]/g.test(text)) spanishScore += 3;
  if (/[àâäéèêëïîôöùûüÿç]/g.test(text)) frenchScore += 3;

  // Trova il punteggio massimo
  const scores = { it: italianScore, en: englishScore, es: spanishScore, fr: frenchScore };
  const maxScore = Math.max(...Object.values(scores));
  
  if (maxScore === 0) return 'en'; // default a inglese se non rileva nulla
  
  return Object.keys(scores).find(lang => scores[lang as keyof typeof scores] === maxScore) || 'en';
}

function buildLanguageInstruction(expectedLang: string, transcript: string): string {
  // Risolvi la lingua effettiva
  const actualLang = expectedLang === 'auto' ? detectLanguageFromTranscript(transcript) : expectedLang;
  
  // Istruzioni specifiche per lingua
  if (actualLang === 'it') {
    return [
      'IMPORTANTE: Devi rispondere ESCLUSIVAMENTE in italiano.',
      'Non usare mai l\'inglese. Scrivi tutto in italiano.',
      'Usa solo informazioni presenti nel transcript, non inventare nulla.',
    ].join('\n');
  }
  
  if (actualLang === 'es') {
    return [
      'IMPORTANTE: Debes responder EXCLUSIVAMENTE en español.',
      'No uses nunca el inglés. Escribe todo en español.',
      'Usa solo información presente en la transcripción, no inventes nada.',
    ].join('\n');
  }
  
  if (actualLang === 'fr') {
    return [
      'IMPORTANT: Vous devez répondre EXCLUSIVEMENT en français.',
      'N\'utilisez jamais l\'anglais. Écrivez tout en français.',
      'Utilisez uniquement les informations présentes dans la transcription, n\'inventez rien.',
    ].join('\n');
  }
  
  // Default a inglese per altre lingue o lingua non rilevata
  return [
    'IMPORTANT: Respond EXCLUSIVELY in English.',
    'Use only information from the transcript, do not invent anything.',
  ].join('\n');
}

async function summarizeWithGemini(cfg: LlmConfig, prompt: string, transcript: string, expectedLang?: string): Promise<string> {
  if (!cfg.apiKey) throw new Error('Gemini API Key not configured');
  const model = cfg.model || 'gemini-1.5-pro';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const systemInstruction = buildSystemGuard(expectedLang || 'auto', transcript);
  const body = {
    systemInstruction: { role: 'system', parts: [{ text: systemInstruction }] },
    contents: [
      { role: 'user', parts: [{ text: `${prompt}\n\nTranscript:\n${transcript}` }] }
    ]
  } as any;
  const res = await fetch(`${url}?key=${encodeURIComponent(cfg.apiKey)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Gemini API error: ${res.status} ${await res.text().catch(()=> '')}`);
  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text ?? '').join('\n');
  const out = typeof text === 'string' ? text.trim() : '';
  if (!out) throw new Error('Empty summary from Gemini');
  return out;
}

async function summarizeWithOpenAI(cfg: LlmConfig, prompt: string, transcript: string, expectedLang?: string): Promise<string> {
  if (!cfg.apiKey) throw new Error('OpenAI API Key not configured');
  const base = cfg.endpoint?.trim() || 'https://api.openai.com/v1';
  const url = `${base}/chat/completions`;
  const body = {
    model: cfg.model || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: buildSystemGuard(expectedLang || 'auto', transcript) },
      { role: 'user', content: `${prompt}\n\nTranscript:\n${transcript}` },
    ],
    temperature: 0,
  };
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.apiKey}` }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`OpenAI API error: ${res.status} ${await res.text().catch(()=> '')}`);
  const json = await res.json();
  const text = json?.choices?.[0]?.message?.content ?? '';
  const out = typeof text === 'string' ? text.trim() : '';
  if (!out) throw new Error('Empty summary from OpenAI');
  return out;
}

async function summarizeWithAnthropic(cfg: LlmConfig, prompt: string, transcript: string, expectedLang?: string): Promise<string> {
  if (!cfg.apiKey) throw new Error('Anthropic API Key not configured');
  const base = cfg.endpoint?.trim() || 'https://api.anthropic.com';
  const url = `${base}/v1/messages`;
  const body = {
    model: cfg.model || 'claude-3-5-sonnet-latest',
    max_tokens: 2000,
    temperature: 0,
    system: buildSystemGuard(expectedLang || 'auto', transcript),
    messages: [
      { role: 'user', content: `${prompt}\n\nTranscript:\n${transcript}` },
    ],
  } as any;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Anthropic API error: ${res.status} ${await res.text().catch(()=> '')}`);
  const json = await res.json();
  const text = json?.content?.map((p: any) => p?.text ?? '').join('\n');
  const out = typeof text === 'string' ? text.trim() : '';
  if (!out) throw new Error('Empty summary from Anthropic');
  return out;
}

async function summarizeWithOllama(cfg: LlmConfig, prompt: string, transcript: string, expectedLang?: string): Promise<string> {
  const base = cfg.endpoint?.trim() || 'http://localhost:11434';
  const url = `${base}/api/generate`;
  
  // Per Ollama includiamo le istruzioni di lingua direttamente nel prompt per maggiore efficacia
  const langSetting = expectedLang || 'auto';
  const langInstruction = buildLanguageInstruction(langSetting, transcript);
  const fullPrompt = `${langInstruction}\n\n${prompt}\n\nTranscript:\n${transcript}`;
  
  // Debug logging per Ollama
  const detectedLang = langSetting === 'auto' ? detectLanguageFromTranscript(transcript) : langSetting;
  console.log(`[Resonance/Ollama] Expected language: ${langSetting}`);
  console.log(`[Resonance/Ollama] Detected/Final language: ${detectedLang}`);
  console.log(`[Resonance/Ollama] Language instruction: ${langInstruction}`);
  
  const body = {
    model: cfg.model || 'llama3.1',
    prompt: fullPrompt,
    stream: false,
    options: { temperature: 0 },
  };
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Ollama API error: ${res.status} ${await res.text().catch(()=> '')}`);
  const json = await res.json();
  const text = json?.response ?? '';
  const out = typeof text === 'string' ? text.trim() : '';
  if (!out) throw new Error('Empty summary from Ollama');
  return out;
}


