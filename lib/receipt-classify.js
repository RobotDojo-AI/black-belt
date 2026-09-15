/**
 * Receipt classifier — maps sender domains and subject patterns to a
 * receipts.yaml category. Deterministic only: receipts come from a small
 * set of known merchants, so pattern-matching is sufficient.
 *
 * Returns { category, merchant, platform } or null.
 */

const DOMAIN_RULES = [
  // Amazon — differentiate staples vs generic vs pharmacy vs fresh
  { domain: /@(amazon\.com|marketplace\.amazon\.com)$/i, category: 'amazon_staples', platform: 'amazon', merchant: 'Amazon' },
  { domain: /@pharmacypackage\.amazon\.com$/i,           category: 'rx_delivery',    platform: 'amazon_pharmacy', merchant: 'Amazon Pharmacy' },
  { domain: /@amazonfresh|@wholefoods/i,                 category: 'grocery_delivery', platform: 'amazon', merchant: 'Whole Foods / Amazon Fresh' },
  // Grocery delivery
  { domain: /@instacart\.com$/i,    category: 'grocery_delivery', platform: 'instacart', merchant: 'Instacart' },
  { domain: /@freshdirect\.com$/i,  category: 'grocery_delivery', platform: 'direct',    merchant: 'FreshDirect' },
  { domain: /@wegmans\.com$/i,      category: 'grocery_delivery', platform: 'direct',    merchant: 'Wegmans' },
  { domain: /@misfitsmarket\.com$/i,category: 'perishables',      platform: 'direct',    merchant: 'Misfits Market' },
  // Food delivery
  { domain: /@doordash\.com$/i, category: 'food_delivery', platform: 'doordash', merchant: 'DoorDash' },
  { domain: /@ubereats\.com$/i, category: 'food_delivery', platform: 'ubereats', merchant: 'Uber Eats' },
  { domain: /@uber\.com$/i,     category: 'travel',        platform: 'direct',   merchant: 'Uber' },
  { domain: /@grubhub\.com$/i,  category: 'food_delivery', platform: 'grubhub',  merchant: 'Grubhub' },
  { domain: /@seamless\.com$/i, category: 'food_delivery', platform: 'seamless', merchant: 'Seamless' },
  { domain: /@caviar\.com$/i,   category: 'food_delivery', platform: 'caviar',   merchant: 'Caviar' },
  // Rx
  { domain: /@capsulecare\.com$/i, category: 'rx_delivery', platform: 'capsule', merchant: 'Capsule' },
  { domain: /@pillpack\.com$/i,    category: 'rx_delivery', platform: 'direct',  merchant: 'PillPack' },
  // Utilities
  { domain: /@(pseg|coned|nationalgrid|duke-energy|pge|sce|delmarva|pepco)\.com$/i, category: 'utilities', platform: 'direct', merchant: 'Utility' },
  { domain: /@(comcast|xfinity|spectrum|verizon|att)\.com$/i, category: 'utilities', platform: 'direct', merchant: 'Internet/Cable' },
  // Travel
  { domain: /@(delta|united|aa|southwest|jetblue|alaska)\.com$/i, category: 'travel', platform: 'direct', merchant: 'Airline' },
  { domain: /@(marriott|hilton|hyatt|ihg|choicehotels|booking|airbnb|vrbo|expedia)\.com$/i, category: 'travel', platform: 'direct', merchant: 'Lodging' },
  { domain: /@lyft\.com$/i, category: 'travel', platform: 'direct', merchant: 'Lyft' },
  // Entertainment
  { domain: /@(ticketmaster|stubhub|seatgeek|axs|eventbrite)\.com$/i, category: 'entertainment', platform: 'direct', merchant: 'Tickets' },
  { domain: /@(netflix|spotify|hulu|apple|disneyplus)\.com$/i,        category: 'entertainment', platform: 'direct', merchant: 'Streaming' },
];

// Subject patterns — confirm we're looking at a receipt vs a notification.
const RECEIPT_SUBJECTS = [
  /\border\s+(?:confirmation|placed|summary)/i,
  /\byour\s+(?:order|receipt|delivery)/i,
  /\bship(?:ped|ment\s+confirmation)/i,
  /\bdelivery\s+(?:confirmation|notification)/i,
  /\bpayment\s+(?:received|confirmation)/i,
  /\breceipt\s+for/i,
  /\bthanks?\s+for\s+your\s+order/i,
];

/**
 * Classify a receipt by sender domain and subject. Returns
 * { category, merchant, platform, subject_matched } or null.
 */
export function classifyReceipt({ sender_email, subject }) {
  if (!sender_email) return null;
  const rule = DOMAIN_RULES.find(r => r.domain.test(sender_email));
  if (!rule) return null;

  const subject_matched = RECEIPT_SUBJECTS.some(re => re.test(subject || ''));
  // For domain-locked merchants (Amazon, Instacart, DoorDash etc.) we still
  // require a receipt-like subject to filter out account notifications.
  if (!subject_matched) return null;

  return {
    category: rule.category,
    merchant: rule.merchant,
    platform: rule.platform,
    subject_matched: true,
  };
}

// Amazon — differentiate staples vs generic items once the body is parsed.
// Heuristic: if >50% of items are paper/cleaning/pantry/personal_care → staples.
export function inferAmazonCategory(items = []) {
  if (!items.length) return 'amazon_staples';
  const staple = items.filter(i => {
    const c = (i.category || '').toLowerCase();
    return ['pantry','cleaning','paper','personal_care','baby','pet'].includes(c);
  }).length;
  return staple / items.length >= 0.5 ? 'amazon_staples' : 'other';
}
