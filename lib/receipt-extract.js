/**
 * Receipt extractor — structured extraction from order confirmation bodies.
 * Priority: delivery_address (the gold signal for residency) + amount + items.
 *
 * Model: Haiku. Deterministic shortcuts first (Amazon "Ship to", DoorDash
 * "Delivery address") so we skip LLM on easy receipts.
 */

// INTELLIGENCE_TIER: extraction — structured extraction from order-
// confirmation bodies (delivery address, amount, items); a closed schema,
// not freeform prose.
export const INTELLIGENCE_TIER = 'extraction';

import { llmCreate } from './llm-gateway.js';
import { extractAddresses } from './address-patterns.js';
import { modelFor } from './model-lane.js';

const CURRENCY_RE = /\$([0-9]+(?:,[0-9]{3})*(?:\.[0-9]{2})?)/;

function parseDollars(str) {
  if (!str) return null;
  const m = str.match(CURRENCY_RE);
  if (!m) return null;
  return Math.round(parseFloat(m[1].replace(/,/g, '')) * 100);
}

function firstAddress(text) {
  const addrs = extractAddresses(text || '');
  if (!addrs.length) return null;
  const a = addrs[0];
  return { line1: a.street, city: a.city, region: a.state, postal_code: a.zip, country: 'US' };
}

/**
 * Best-effort deterministic extraction for the common case.
 * Returns a partial receipt object; unknown fields are null.
 */
export function extractReceiptDeterministic(text, { category, merchant, platform }) {
  const delivery_address = firstAddress(text);

  // Total amount: look for "Order total", "Total", "Grand total"
  const totalMatch = text.match(/\b(?:order\s+total|grand\s+total|total(?:\s+charged)?)[:\s]*(\$[\d.,]+)/i);
  const total_cents = totalMatch ? parseDollars(totalMatch[1]) : null;

  // Order date: look for "Order placed" / "Order date" / Amazon "Placed"
  const dateMatch = text.match(/\b(?:order\s+(?:placed|date|on)|placed\s+on)[:\s]*([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i);
  const order_date = dateMatch ? new Date(dateMatch[1]).toISOString() : null;

  if (!delivery_address && !total_cents) return null;

  return {
    category, merchant, platform,
    order_date,
    total_amount_cents: total_cents,
    currency: 'USD',
    delivery_address,
    items: [],
  };
}

const EXTRACT_PROMPT = `You extract structured data from a purchase receipt email.
Return STRICT JSON with these keys (use null when unknown):
- order_date (ISO 8601)
- total_amount_cents (integer, USD cents)
- currency (ISO 4217, default USD)
- subtotal_cents, tax_cents, tip_cents, shipping_cents, discount_cents (integers or null)
- delivery_address: {"line1":"...", "line2":"...", "city":"...", "region":"XX", "postal_code":"#####", "country":"US"}
- billing_address: same shape or null
- payment_card_last4 (4 digits max, or null)
- items: list of {"name":"...", "quantity":1, "unit":"ea", "unit_price_cents":int, "line_total_cents":int, "category":"..."}
- is_gift: boolean (true if gift message / separate recipient / different delivery address than usual)
- order_id_external (merchant order id, or null)

Rules:
- All amounts as integer CENTS (e.g., $12.99 → 1299).
- Addresses follow the shape above. If a block is missing, return null.
- Never invent data. If a field is not present, return null.
- items[*].category ∈ {pantry, produce, dairy, meat, seafood, frozen, bakery, beverage, alcohol, cleaning, paper, personal_care, baby, pet, rx, otc, prepared_meal, electronics, clothing, household, office, gift, other}`;

/**
 * Extract receipt fields. Returns { extracted, extraction_model, extraction_confidence }
 * or null on failure.
 */
export async function extractReceipt(text, classification) {
  const det = extractReceiptDeterministic(text, classification);
  if (det && det.delivery_address && det.total_amount_cents) {
    return { extracted: det, extraction_model: 'deterministic', extraction_confidence: 0.75 };
  }

  const snippet = text.slice(0, 8000);
  try {
    const resp = await llmCreate({
      model: modelFor('fast'),
      max_tokens: 1500,
      system: EXTRACT_PROMPT,
      messages: [{ role: 'user', content: `Merchant: ${classification.merchant}\nCategory: ${classification.category}\n\n${snippet}` }],
    }, 'receipt-extract');
    const body = resp.content.map(b => b.text || '').join('');
    const json = body.replace(/```json\s*|\s*```/g, '').trim();
    const parsed = JSON.parse(json);

    // Merge into classification to produce the final shape.
    const merged = {
      category: classification.category,
      merchant: classification.merchant,
      platform: classification.platform,
      ...parsed,
    };

    // Invariant: payment_card_last4 is last-4 only.
    if (merged.payment_card_last4 && String(merged.payment_card_last4).replace(/\D/g, '').length > 4) {
      merged.payment_card_last4 = String(merged.payment_card_last4).slice(-4);
    }

    return { extracted: merged, extraction_model: modelFor('fast'), extraction_confidence: 0.8 };
  } catch (err) {
    console.warn('[receipt-extract] failed:', err.message);
    return null;
  }
}
