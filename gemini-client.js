// Shared low-level Gemini call: auth, retry/backoff, and JSON-schema response
// parsing. Callers only supply their own prompt/schema - this is pure HTTP
// plumbing reused by every Gemini-backed feature (AI recommendations, AI
// search fallback, ...).
export async function callGemini({ instruction, input, schema, maxOutputTokens = 800, temperature = .2 }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw Object.assign(new Error('Gemini API key is unavailable'), { noRetry: true });
  const model = process.env.GEMINI_MODEL || 'gemini-3.7-flash';
  const retries = Math.max(0, Math.min(2, Number.parseInt(process.env.MAX_GEMINI_RETRIES || '2', 10) || 0));
  const body = {
    systemInstruction: { parts: [{ text: instruction }] },
    contents: [{ role: 'user', parts: [{ text: JSON.stringify(input) }] }],
    generationConfig: { temperature, maxOutputTokens, responseMimeType: 'application/json', responseJsonSchema: schema },
  };
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify(body), signal: AbortSignal.timeout(25_000) });
      if (!response.ok) {
        const error = new Error(`Gemini returned HTTP ${response.status}`); error.status = response.status;
        if (response.status < 500 && response.status !== 429) error.noRetry = true;
        throw error;
      }
      const data = await response.json();
      const text = data?.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || '';
      return JSON.parse(text);
    } catch (error) {
      lastError = error;
      if (error.noRetry || attempt >= retries) break;
      await new Promise(resolve => setTimeout(resolve, 350 * (2 ** attempt)));
    }
  }
  throw lastError || new Error('Gemini request failed');
}
