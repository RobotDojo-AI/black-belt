/**
 * Document extractor — per-type structured extraction against the ontology.
 * Every extractor returns a validated JSON object that conforms to the
 * documents.yaml contract for its doc_type. Invariants are enforced here
 * (masked account numbers, sane date ranges).
 *
 * Model: Haiku only. Sonnet is allowed as a fallback when Haiku fails 3x.
 */

// INTELLIGENCE_TIER: extraction — structured field extraction against the
// documents.yaml contract; the LLM's output is validated JSON, not prose.
export const INTELLIGENCE_TIER = 'extraction';

import { llmCreate } from './llm-gateway.js';
import { modelFor } from './model-lane.js';
const MAX_RETRIES = 3;

// --- Schema contracts (documents.yaml type-specific detail blocks) ---
// Each contract declares required/optional keys. Extracted JSON must conform.
const CONTRACTS = {
  tax_return: {
    required: ['tax_year'],
    optional: ['filing_status','agi','total_income','total_tax','refund_or_owed',
      'dependents_count','dependent_names','income_sources','filing_address','preparer'],
  },
  utility_bill: {
    required: ['utility_type'],
    optional: ['account_number_masked','amount_due','usage_amount','usage_unit',
      'service_address','period_start','period_end','provider'],
  },
  lease: {
    required: ['tenant_names','property_address','lease_start'],
    optional: ['lease_type','landlord_name','monthly_rent','lease_end','security_deposit'],
  },
  mortgage: {
    required: ['borrower_names','property_address'],
    optional: ['lender_name','loan_amount','interest_rate','term_months',
      'origination_date','current_balance'],
  },
  insurance_policy: {
    required: ['policy_type'],
    optional: ['carrier_name','policy_number_masked','insured_names',
      'coverage_amount','premium_amount','premium_period','effective_date','expiration_date'],
  },
  id_document: {
    required: ['id_type','holder_name'],
    optional: ['issuing_country','issuing_state','number_masked','issue_date','expiration_date'],
  },
  vehicle_registration: {
    required: [],
    optional: ['vin_masked','make','model','year','plate','registration_state',
      'registered_owner_names','registration_address','expiration_date'],
  },
  medical_record: {
    required: ['record_type','patient_name'],
    optional: ['provider_name','service_date','summary'],
  },
  financial_statement: {
    required: ['statement_type'],
    optional: ['institution_name','account_number_masked','account_holder_names',
      'ending_balance','period_start','period_end'],
  },
  legal_doc: {
    required: ['legal_type'],
    optional: ['counterparty_names','effective_date','expiration_date','summary'],
  },
};

// Schema prompt — one extraction prompt per doc_type.
function buildPrompt(doc_type) {
  const schema = CONTRACTS[doc_type];
  if (!schema) return null;
  const allKeys = [...schema.required, ...schema.optional];
  const addressShape = `{"line1":"...", "line2":"...", "city":"...", "region":"XX", "postal_code":"#####", "country":"US"}`;
  return `You extract structured data from a ${doc_type.replace(/_/g, ' ')}.
Return STRICT JSON with these keys (use null when unknown):
- ${allKeys.join('\n- ')}

Rules:
- Addresses are objects: ${addressShape}
- *_address fields always use that object shape.
- Any field ending in "_masked" MUST be last-4 only. Never the full number.
- Dates use ISO 8601 (YYYY-MM-DD).
- income_sources is a list of {kind, payer, amount} where kind ∈ {w2,1099,k1,interest,dividend,capital_gains,rental,royalty,other}.
- *_names fields are lists of strings (full names as they appear).
- Do not invent data. If a field isn't present in the text, return null.`;
}

function validate(doc_type, extracted) {
  const schema = CONTRACTS[doc_type];
  if (!schema) return { ok: false, reason: `no contract for ${doc_type}` };
  if (!extracted || typeof extracted !== 'object') return { ok: false, reason: 'not an object' };

  for (const key of schema.required) {
    if (extracted[key] == null) return { ok: false, reason: `missing required field: ${key}` };
  }

  // Invariant: masked fields are last-4 only.
  for (const key of Object.keys(extracted)) {
    if (key.endsWith('_masked') && typeof extracted[key] === 'string') {
      const digits = extracted[key].replace(/\D/g, '');
      if (digits.length > 4) return { ok: false, reason: `${key} contains more than 4 digits` };
    }
  }

  // Invariant: tax year sane.
  if (doc_type === 'tax_return' && extracted.tax_year != null) {
    const y = parseInt(extracted.tax_year, 10);
    const now = new Date().getFullYear();
    if (!Number.isFinite(y) || y < 1990 || y > now + 1) return { ok: false, reason: `tax_year ${y} out of range` };
  }

  // Invariant: lease dates ordered.
  if (doc_type === 'lease' && extracted.lease_start && extracted.lease_end) {
    if (extracted.lease_start > extracted.lease_end) return { ok: false, reason: 'lease_start > lease_end' };
  }

  return { ok: true };
}

function stripJsonFences(s) {
  return s.replace(/```json\s*|\s*```/g, '').trim();
}

async function callModel(model, system, user, maxTokens) {
  const resp = await llmCreate({
    model, max_tokens: maxTokens, system,
    messages: [{ role: 'user', content: user }],
  }, 'doc-extract');
  const body = resp.content.map(b => b.text || '').join('');
  return JSON.parse(stripJsonFences(body));
}

/**
 * Extract structured fields from a document given its classified type.
 * Returns { extracted_json, extraction_model, extraction_confidence } or null.
 */
export async function extractDocument(text, doc_type, metadata = {}) {
  const prompt = buildPrompt(doc_type);
  if (!prompt) return null;

  const snippet = text.slice(0, 12000);
  const hints = [
    metadata.subject && `Subject: ${metadata.subject}`,
    metadata.sender && `Sender: ${metadata.sender}`,
  ].filter(Boolean).join('\n');
  const user = `${hints ? hints + '\n\n' : ''}--- Document text ---\n${snippet}`;

  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const extracted = await callModel(modelFor('fast'), prompt, user, 1500);
      const v = validate(doc_type, extracted);
      if (v.ok) {
        return {
          extracted_json: extracted,
          extraction_model: modelFor('fast'),
          extraction_confidence: 0.85,
        };
      }
      lastErr = v.reason;
    } catch (err) {
      lastErr = err.message;
    }
  }

  // Sonnet fallback — last resort.
  try {
    const extracted = await callModel(modelFor('balanced'), prompt, user, 1500);
    const v = validate(doc_type, extracted);
    if (v.ok) {
      return {
        extracted_json: extracted,
        extraction_model: modelFor('balanced'),
        extraction_confidence: 0.9,
      };
    }
    console.warn(`[doc-extract] Sonnet validation failed for ${doc_type}: ${v.reason}`);
  } catch (err) {
    console.warn(`[doc-extract] Sonnet fallback failed for ${doc_type}:`, err.message);
  }

  console.warn(`[doc-extract] extraction failed for ${doc_type}: ${lastErr}`);
  return null;
}

export { CONTRACTS };
