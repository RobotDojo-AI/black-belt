/**
 * Document classifier — decides whether a piece of text is a key document and
 * which type (documents.yaml enum). Deterministic rules fire first; Haiku is
 * the fallback for ambiguous cases. Returns `null` when the text is not a key
 * document.
 *
 * Classification is separated from extraction so we can skip non-documents
 * without paying any LLM cost.
 */

// INTELLIGENCE_TIER: extraction — Haiku is a fallback classifier deciding a
// documents.yaml enum value; a closed structured decision, not prose.
export const INTELLIGENCE_TIER = 'extraction';

import { llmCreate } from './llm-gateway.js';
import { modelFor } from './model-lane.js';

const EXTRACTOR_ID = 'doc-classifier-haiku-4.5';

const DOC_TYPES = [
  'tax_return', 'utility_bill', 'lease', 'mortgage', 'insurance_policy',
  'id_document', 'vehicle_registration', 'medical_record', 'financial_statement',
  'legal_doc', 'other',
];

// Deterministic patterns — clean wins, zero LLM spend.
const RULES = [
  { type: 'tax_return',          re: /\b(form\s*1040|irs\s+form\s*1040|u\.?s\.?\s*individual\s*income\s*tax\s*return)\b/i },
  { type: 'tax_return',          re: /\b(w-?2\s+wage\s+and\s+tax|form\s*1099-(MISC|INT|DIV|NEC|B|R))\b/i },
  { type: 'utility_bill',        re: /\b(your\s+(?:electric|gas|water|sewer)\s+bill|service\s+period|account\s+number|amount\s+due|usage\s*[:\s]*\d+\s*(?:kwh|therms|gallons))\b/i },
  { type: 'lease',               re: /\b(residential\s+lease\s+agreement|lease\s+term|monthly\s+rent|security\s+deposit|landlord\s+and\s+tenant)\b/i },
  { type: 'mortgage',            re: /\b(promissory\s+note|mortgage\s+deed|uniform\s+residential\s+loan\s+application|closing\s+disclosure|interest\s+rate\s+lock)\b/i },
  { type: 'insurance_policy',    re: /\b(declarations\s+page|policy\s+number|effective\s+date|coverage\s+limits|premium\s+amount)\b/i },
  { type: 'id_document',         re: /\b(united\s+states\s+of\s+america|passport|driver(?:'s)?\s+license|state\s+id|date\s+of\s+birth)\b/i },
  { type: 'vehicle_registration',re: /\b(certificate\s+of\s+registration|vehicle\s+identification\s+number|vin\s*:?\s*[A-Z0-9]{17}|registered\s+owner)\b/i },
  { type: 'medical_record',      re: /\b(lab\s+result|specimen\s+collection|test\s+result|clinical\s+summary|discharge\s+summary|hipaa)\b/i },
  { type: 'financial_statement', re: /\b(account\s+summary|beginning\s+balance|ending\s+balance|statement\s+period)\b/i },
  { type: 'legal_doc',           re: /\b(nda|non-disclosure\s+agreement|operating\s+agreement|last\s+will\s+and\s+testament|power\s+of\s+attorney)\b/i },
];

function deterministic(text) {
  for (const { type, re } of RULES) {
    if (re.test(text)) return { doc_type: type, confidence: 0.95, extraction_model: 'deterministic' };
  }
  return null;
}

/**
 * Classify a document. Returns { doc_type, confidence, extraction_model } or null.
 * metadata: { subject?, sender?, mime_type? } — optional hints used by the LLM prompt.
 */
export async function classifyDocument(text, metadata = {}) {
  if (!text || text.length < 40) return null;

  const det = deterministic(text);
  if (det) return det;

  // LLM fallback — Haiku, structured output.
  const snippet = text.slice(0, 4000);
  const hints = [
    metadata.subject && `Subject: ${metadata.subject}`,
    metadata.sender && `Sender: ${metadata.sender}`,
  ].filter(Boolean).join('\n');

  const system = `You classify personal documents into one of these types: ${DOC_TYPES.join(', ')}.
Return STRICT JSON: {"doc_type": "<one>", "confidence": 0..1}.
If the text is not a key document (e.g., marketing email, newsletter, casual message), return {"doc_type": "other", "confidence": 0.1}.`;

  const user = `${hints ? hints + '\n\n' : ''}--- Document text ---\n${snippet}`;

  try {
    const resp = await llmCreate({
      model: modelFor('fast'),
      max_tokens: 100,
      system,
      messages: [{ role: 'user', content: user }],
    }, 'doc-classify');
    const body = resp.content.map(b => b.text || '').join('');
    const json = body.replace(/```json\s*|\s*```/g, '').trim();
    const parsed = JSON.parse(json);
    if (!DOC_TYPES.includes(parsed.doc_type)) return null;
    if (parsed.doc_type === 'other' && (parsed.confidence ?? 0) < 0.6) return null;
    return {
      doc_type: parsed.doc_type,
      confidence: Math.max(0, Math.min(1, parsed.confidence ?? 0.5)),
      extraction_model: EXTRACTOR_ID,
    };
  } catch (err) {
    console.warn('[doc-classify] LLM failed:', err.message);
    return null;
  }
}

export { DOC_TYPES, EXTRACTOR_ID };
