const MAX_REMEMBER_FACT_CHARS = 2000;

function cleanFact(value) {
  let fact = String(value || '').trim();
  fact = fact.replace(/^this\s+exact(?:ly)?\s*:\s*/i, '').trim();
  fact = fact.replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, '').trim();
  if (!fact || fact.length > MAX_REMEMBER_FACT_CHARS) return null;
  return fact;
}

export function parseRememberFact(input) {
  const text = String(input || '').trim();
  if (!text) return null;
  if (/[?？]\s*$/.test(text)) return null;
  if (/^(?:what|who|when|where|why|how|do|does|did|can|could|would|will|should)\b[\s\S]*\bremember\b/i.test(text)) {
    return null;
  }

  const patterns = [
    /^(?:please\s+)?remember\s+this\s+exactly\s*:\s*([\s\S]+)$/i,
    /^(?:please\s+)?remember(?:\s+this)?(?:\s+exact)?(?:\s+(?:launch\s+qa\s+)?fact)?\s*:\s*([\s\S]+)$/i,
    /^(?:please\s+)?remember\s+(?:that\s+)?([\s\S]+)$/i,
    /^(?:please\s+)?store(?:\s+this)?(?:\s+fact)?(?:\s+in\s+memory)?\s*:\s*([\s\S]+)$/i,
    /^(?:please\s+)?save(?:\s+this)?(?:\s+to\s+memory|(?:\s+as)?\s+a\s+memory|(?:\s+as)?\s+a\s+fact)\s*:\s*([\s\S]+)$/i,
    /^(?:please\s+)?make\s+a\s+note\s+(?:that\s+)?([\s\S]+)$/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return cleanFact(match[1]);
  }
  return null;
}

export function parseRecallFactQuery(input) {
  const text = String(input || '').trim();
  if (!text) return null;
  if (!/[?？]/.test(text) && !/\b(answer|reply)\b/i.test(text)) return null;
  if (!/\bremember(?:ed)?\b/i.test(text)) return null;
  if (/\bwhat\s+do\s+you\s+remember\s+about\s+me\b/i.test(text)) return null;

  const exactRecall = /\bwhat\b[\s\S]*\bexact\b[\s\S]*\b(?:ask(?:ed)?|tell|told)\s+you\s+to\s+remember\b/i.test(text)
    || /\bwhat\b[\s\S]*\b(?:ask(?:ed)?|tell|told)\s+you\s+to\s+remember\b[\s\S]*\bexact\b/i.test(text)
    || /\bwhat\s+is\s+the\s+exact\b[\s\S]*\b(?:remember|memory|fact)\b/i.test(text)
    || /\bdo\s+you\s+remember\b[\s\S]*\b(?:exact|word|phrase|fact|sentinel|proof)\b/i.test(text);
  if (!exactRecall) return null;

  return { query: text };
}
