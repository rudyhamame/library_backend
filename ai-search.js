import { callGemini } from './gemini-client.js';

const variantsSchema = {
  type: 'object',
  properties: {
    variants: { type: 'array', items: { type: 'string' }, maxItems: 4 },
  },
  required: ['variants'],
};

const kindLabels = { movie: 'movies', series: 'TV series', channel: 'live TV channels' };

// The literal (regex substring) catalog search found nothing for this exact
// text. Ask Gemini for a short list of alternate search strings more likely
// to appear as a substring of a REAL catalog title - a corrected spelling,
// the well-known official title, or the same title transliterated/translated
// into the other script (Arabic query against a Latin-script title, or vice
// versa). Gemini never sees the catalog and never picks a result directly -
// it only proposes better search text, which the caller re-runs through the
// existing literal search. That keeps this cheap (no catalog in the prompt),
// fast (one small call), and safe against hallucinated titles reaching users
// as if they were real matches.
export async function aiSearchQueryVariants({ query, kind, uiLanguage, caller = callGemini, aiAvailable = Boolean(process.env.GEMINI_API_KEY) }) {
  const trimmed = String(query || '').trim();
  if (!trimmed || !aiAvailable) return [];
  const instruction = `A viewer searched an IPTV catalog of ${kindLabels[kind] || 'titles'} and got zero results for their exact text. The query may have a typo, missing or extra words, or be written in a different script than the actual catalog entry (e.g. Arabic vs. a Latin transliteration, or a translated title). Suggest up to 4 short alternate search strings more likely to match a real catalog title as a substring: corrected spelling, the well-known official title, and/or the same title transliterated or translated into the other script. Never invent specific details (year, episode number, subtitle) the query does not already imply. Keep each suggestion short (1-6 words). If the query already looks like a normal, unambiguous title with no likely typo, return an empty list. The app interface language is ${uiLanguage === 'ar' ? 'Arabic' : 'English'}. Return JSON only.`;
  try {
    const output = await caller({ instruction, input: { query: trimmed }, schema: variantsSchema, maxOutputTokens: 300 });
    const seen = new Set([trimmed.toLocaleLowerCase()]);
    const variants = [];
    for (const value of Array.isArray(output?.variants) ? output.variants : []) {
      const candidate = String(value || '').trim();
      const key = candidate.toLocaleLowerCase();
      if (!candidate || seen.has(key)) continue;
      seen.add(key);
      variants.push(candidate);
    }
    return variants.slice(0, 4);
  } catch (error) {
    console.warn(`[AISearch] gemini-${error?.status === 429 ? 'rate-limited' : 'failed'}: ${error.message}`);
    return [];
  }
}

// Builds one combined case-insensitive regex alternation across every
// variant, so retrying costs exactly one extra catalog query no matter how
// many alternates Gemini proposed.
export function combinedVariantRegex(variants) {
  const escaped = variants.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).filter(Boolean);
  return escaped.length ? escaped.join('|') : null;
}
