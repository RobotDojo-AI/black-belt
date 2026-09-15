/**
 * Document Vault — high-value document discovery from email history.
 * Category-specific confidence: some categories need only sender match (banks, labs),
 * others need only subject match (tax forms, identity docs).
 * Scans emails table directly — structured fields beat RAG for categorization.
 */
import db from './db.js';

// ── Category definitions ──
// rule: 'sender' = sender domain alone is sufficient (e.g. chase.com is always financial)
//       'subject' = subject pattern alone is sufficient (e.g. W-2 is always tax)
//       'both' = require both sender + subject (noisy categories like education)

const CATEGORIES = {
  tax: {
    label: 'Tax', rule: 'subject',
    senders: ['turbotax.intuit.com','hrblock.com','taxact.com','irs.gov','tax.state.','revenue.state.','franchise.tax.'],
    subjects: [/\bw-?2\b/i, /\b1099\b/i, /\bk-?1\b/i, /\btax return\b/i, /\btax refund\b/i, /\btax document\b/i, /\btax form\b/i, /\bestimated tax\b/i, /\bfiling confirm/i],
    subcategories: ['w2','1099','k1','return','estimated','other'],
  },
  identity: {
    label: 'Identity', rule: 'subject',
    senders: ['state.gov','usps.com','dmv.','ssa.gov','uscis.gov','tsa.gov','cbp.dhs.gov'],
    subjects: [/\bpassport\b/i, /\bdriver.?s? license\b/i, /\breal id\b/i, /\bsocial security\b/i, /\bbirth certificate\b/i, /\bglobal entry\b/i, /\btsa pre/i, /\bvisa application\b/i],
    subcategories: ['passport','drivers-license','ssn','birth-cert','global-entry','visa','other'],
  },
  financial: {
    label: 'Financial', rule: 'sender',
    senders: [
      'chase.com','bankofamerica.com','wellsfargo.com','citi.com','citibank.com',
      'schwab.com','fidelity.com','vanguard.com','etrade.com','tdameritrade.com',
      'robinhood.com','wealthfront.com','betterment.com','sofi.com',
      'capitalone.com','discover.com','amex.com','americanexpress.com',
      'mercury.com','brex.com','ramp.com',
    ],
    subjects: [/\bstatement\b/i, /\baccount summary\b/i, /\bbalance\b/i, /\bpay stub\b/i, /\bpayroll\b/i, /\bdirect deposit\b/i, /\bloan\b/i, /\binvestment\b/i, /\byear[- ]?end\b/i],
    subcategories: ['bank-statement','investment','pay-stub','loan','credit-card','other'],
  },
  residence: {
    label: 'Residence', rule: 'sender',
    senders: [
      'pseg.com','coned.com','nationalgrid.com','duke-energy.com','pge.com','sce.com',
      'delmarva.com','pepco.com','comcast.com','xfinity.com','spectrum.com',
      'apartments.com','zillow.com','avalon','greystar.com','realpage.com','appfolio.com',
    ],
    subjects: [/\blease\b/i, /\brental agreement\b/i, /\brent (due|payment|receipt)\b/i, /\butility bill\b/i, /\belectric\b/i, /\bgas bill\b/i, /\bwater bill\b/i, /\bmortgage\b/i, /\bproperty tax\b/i, /\bhoa\b/i],
    subcategories: ['lease','utility','mortgage','property-tax','hoa','cable-internet','other'],
  },
  medical: {
    label: 'Medical', rule: 'sender',
    senders: [
      'questdiagnostics.com','labcorp.com','mychart.com','myquest.com',
      'onpatient.com','zocdoc.com','walgreens.com','cvs.com','express-scripts.com','optumrx.com',
    ],
    subjects: [/\blab result\b/i, /\btest result\b/i, /\bprescription\b/i, /\brx\b/i, /\bimmunization\b/i, /\bvaccin/i, /\bvisit summary\b/i, /\bblood ?work\b/i],
    subcategories: ['lab-results','prescription','immunization','visit-summary','other'],
  },
  insurance: {
    label: 'Insurance', rule: 'both',
    senders: [
      'geico.com','statefarm.com','allstate.com','progressive.com','usaa.com',
      'libertymutual.com','travelers.com','nationwide.com','farmers.com',
      'aetna.com','cigna.com','unitedhealthcare.com','anthem.com','bcbs.com',
      'metlife.com','prudential.com','lemonade.com',
    ],
    subjects: [/\bpolicy\b/i, /\binsurance (card|id|policy)\b/i, /\bpremium\b/i, /\bclaim\b/i, /\bcoverage\b/i, /\brenewal\b/i, /\bdeclarations\b/i, /\bbenefit/i],
    subcategories: ['health','auto','home','life','other'],
  },
  legal: {
    label: 'Legal', rule: 'both',
    senders: ['legalzoom.com','docusign.com','hellosign.com','incfile.com','sunbiz.org'],
    subjects: [/\bwill\b/i, /\btrust\b/i, /\bpower of attorney\b/i, /\bincorporat/i, /\barticles of/i, /\bllc\b/i, /\boperating agreement\b/i, /\bnda\b/i],
    subcategories: ['will-trust','incorporation','contract','other'],
  },
  employment: {
    label: 'Employment', rule: 'subject',
    senders: ['workday.com','adp.com','gusto.com','rippling.com','bamboohr.com','greenhouse.io','lever.co'],
    subjects: [/\boffer letter\b/i, /\bjob offer\b/i, /\bemployment (verif|agreement)\b/i, /\btermination\b/i, /\bseparation agreement\b/i, /\bstock option\b/i, /\bequity grant\b/i, /\brsu\b/i, /\bvesting\b/i],
    subcategories: ['offer-letter','verification','separation','equity','other'],
  },
};

// Account classification — reads label from accounts table (set via accounts UI).
// Falls back to domain heuristic when label is NULL.
const PERSONAL_DOMAINS = new Set(['gmail.com','icloud.com','yahoo.com','me.com','mac.com','outlook.com','hotmail.com','live.com']);

function buildAccountTypeMap() {
  const rows = db.prepare('SELECT id, label, email FROM accounts').all();
  const map = new Map();
  for (const row of rows) {
    if (row.label) {
      map.set(row.id, row.label);
    } else {
      const domain = row.email?.split('@')[1]?.toLowerCase() || '';
      map.set(row.id, PERSONAL_DOMAINS.has(domain) ? 'personal' : 'business');
    }
  }
  return map;
}

function classifyAccount(id, accountTypeMap) {
  return accountTypeMap.get(id) ?? (id?.startsWith('import-') ? 'business' : 'personal');
}

// DB setup
try {
  db.exec(`CREATE TABLE IF NOT EXISTS document_vault (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email_id TEXT NOT NULL, category TEXT NOT NULL, subcategory TEXT DEFAULT 'other',
    sender_email TEXT, subject TEXT, received_at TEXT,
    confidence REAL DEFAULT 0, account_type TEXT DEFAULT 'personal',
    metadata TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(email_id, category)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_vault_category ON document_vault(category)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_vault_date ON document_vault(received_at)`);
} catch { /* exists */ }
try { db.exec(`ALTER TABLE document_vault ADD COLUMN account_type TEXT DEFAULT 'personal'`); } catch { /* exists */ }

function inferSubcategory(cat, subject) {
  const s = subject.toLowerCase();
  if (cat === 'tax') {
    if (/w-?2/i.test(s)) return 'w2';
    if (/1099/.test(s)) return '1099';
    if (/k-?1/i.test(s)) return 'k1';
    if (/return|filing/i.test(s)) return 'return';
    if (/estimat/i.test(s)) return 'estimated';
  } else if (cat === 'financial') {
    if (/statement/i.test(s) && /bank|checking|saving/i.test(s)) return 'bank-statement';
    if (/invest|portfolio|brokerage/i.test(s)) return 'investment';
    if (/pay ?stub|payroll|direct deposit/i.test(s)) return 'pay-stub';
    if (/loan/i.test(s)) return 'loan';
    if (/credit card/i.test(s)) return 'credit-card';
  } else if (cat === 'insurance') {
    if (/health|medical|dental|vision/i.test(s)) return 'health';
    if (/auto|car|vehicle/i.test(s)) return 'auto';
    if (/home|renter|property/i.test(s)) return 'home';
    if (/life/i.test(s)) return 'life';
  } else if (cat === 'medical') {
    if (/lab|result|test/i.test(s)) return 'lab-results';
    if (/prescription|rx|refill/i.test(s)) return 'prescription';
    if (/vaccin|immuniz/i.test(s)) return 'immunization';
    if (/visit|summary/i.test(s)) return 'visit-summary';
  }
  return 'other';
}

/**
 * Scan emails for high-value documents. Category-specific confidence:
 * - 'sender' rule: sender match alone → confidence 0.8
 * - 'subject' rule: subject match alone → confidence 0.8
 * - 'both' rule: requires both → confidence 1.0
 * Any category with both sender+subject match → confidence 1.0
 */
export function scanForDocuments({ limit, verbose = false } = {}) {
  const log = verbose ? console.log.bind(console) : () => {};
  const t0 = Date.now();

  const sql = limit
    ? `SELECT id, subject, sender_email, received_at, account_id FROM emails WHERE subject IS NOT NULL ORDER BY received_at DESC LIMIT ?`
    : `SELECT id, subject, sender_email, received_at, account_id FROM emails WHERE subject IS NOT NULL ORDER BY received_at DESC`;
  const emails = limit ? db.prepare(sql).all(limit) : db.prepare(sql).all();
  log(`Scanning ${emails.length} emails...`);

  // Clear and rebuild
  db.prepare('DELETE FROM document_vault').run();
  const insert = db.prepare(`INSERT OR IGNORE INTO document_vault (email_id, category, subcategory, sender_email, subject, received_at, confidence, account_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const accountTypeMap = buildAccountTypeMap();

  let found = 0;
  const categoryCounts = {};

  db.transaction(() => {
    for (const email of emails) {
      const acctType = classifyAccount(email.account_id, accountTypeMap);
      if (!acctType) continue;
      const domain = email.sender_email?.split('@')[1]?.toLowerCase() || '';
      const subject = email.subject || '';

      for (const [cat, def] of Object.entries(CATEGORIES)) {
        const senderHit = def.senders.some(s => domain.includes(s));
        const subjectHit = def.subjects.some(re => re.test(subject));

        let confidence = 0;
        if (senderHit && subjectHit) confidence = 1.0;
        else if (def.rule === 'sender' && senderHit) confidence = 0.8;
        else if (def.rule === 'subject' && subjectHit) confidence = 0.8;
        // 'both' rule requires both — no single-signal match

        if (confidence >= 0.8) {
          insert.run(email.id, cat, inferSubcategory(cat, subject), email.sender_email, subject, email.received_at, confidence, acctType);
          found++;
          categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
        }
      }
    }
  })();

  return { found, categoryCounts };
}

export function getVaultByCategory(category, accountType = 'personal') {
  return db.prepare(`SELECT * FROM document_vault WHERE category = ? AND account_type = ? ORDER BY received_at DESC`).all(category, accountType);
}

export function getVaultSummary(accountType) {
  const sql = accountType
    ? `SELECT category, account_type, COUNT(*) as count, MIN(received_at) as earliest, MAX(received_at) as latest FROM document_vault WHERE account_type = ? GROUP BY category ORDER BY count DESC`
    : `SELECT category, account_type, COUNT(*) as count, MIN(received_at) as earliest, MAX(received_at) as latest FROM document_vault GROUP BY category, account_type ORDER BY count DESC`;
  return accountType ? db.prepare(sql).all(accountType) : db.prepare(sql).all();
}

export { CATEGORIES };
