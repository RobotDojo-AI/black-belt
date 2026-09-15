/**
 * lib/referral/ontologies.js — st_b879a361
 *
 * Per-company-type role ontology. Regex patterns evaluate in order; first
 * match wins. The classifier (lib/referral/role-classify.js) dispatches on
 * companyType resolved from canonical-domains.js#classifyDomain.
 *
 * BUCKET PRIORITY (ASCENDING):
 *   0 founder   1 c-level   2 vp   3 engineering   4 design   5 business   99 excluded
 *
 * EXCLUDED ALWAYS WINS: marketing / growth / customer success / HR / recruiting /
 * PR / comms / brand are excluded regardless of seniority. Function-first,
 * level-second — per scope AC 8 "function-first exclusion".
 *
 * ORDERING matters: more-specific patterns must come BEFORE more-generic
 * ones inside a bucket (e.g., 'Senior Software Engineer' before 'Engineer').
 *
 * CASE INSENSITIVE: all patterns use the /i flag. Title strings are not
 * lowered before match — we keep original case in case future patterns rely
 * on it, but /i handles the case-insensitive match.
 *
 * Unknown company type falls back to STARTUP ontology (most permissive).
 */

export const BUCKET_PRIORITY = {
  founder:     0,
  'c-level':   1,
  vp:          2,
  engineering: 3,
  design:      4,
  business:    5,
  excluded:    99,
};

// Patterns that exclude the title regardless of seniority. Run BEFORE bucket
// patterns. The body and brand "X Manager" forms (Marketing Manager, Brand
// Manager) match both this list and the business bucket — exclusion wins.
const EXCLUDED_PATTERNS = [
  /\b(?:Chief\s+)?Marketing(?:\s+Officer)?\b/i,
  /\bVP\s+Marketing\b/i,
  /\bHead\s+of\s+(?:Growth|Marketing|Brand|Communications|PR|Press|HR|People|Talent|Recruiting)\b/i,
  /\bMarketing\s+(?:Manager|Director|Lead|Specialist)\b/i,
  /\bGrowth\s+(?:Manager|Marketer|Hacker)\b/i,
  /\bBrand\s+(?:Manager|Director|Lead)\b/i,
  /\bCustomer\s+(?:Success|Support|Experience|Service)\b/i,
  /\bSupport\s+(?:Engineer|Lead|Manager)\b/i,
  /\b(?:HR|Human\s+Resources)\s+(?:Manager|Director|Lead|Generalist|Partner)\b/i,
  /\bRecruiter\b/i,
  /\bRecruiting\s+(?:Manager|Lead|Coordinator)\b/i,
  /\bTalent\s+(?:Acquisition|Manager|Partner|Lead)\b/i,
  /\bPR\s+Manager\b/i,
  /\bCommunications?\s+(?:Manager|Director|Lead|Specialist)?\b/i,
  /\bPublic\s+Relations\b/i,
  /\bInvestor\s+Relations\b/i,
];

// ─── STARTUP ────────────────────────────────────────────────────────────

const STARTUP = {
  founder: [
    /\bCo[\s-]?founder\b/i,
    /\bCofounder\b/i,
    /\bFounder\b/i,
    /\bFounding\s+(?:Engineer|Designer|Member)\b/i,
  ],
  'c-level': [
    /\bCEO\b/i,
    /\bCTO\b/i,
    /\bCOO\b/i,
    /\bCFO\b/i,
    /\bCIO\b/i,
    /\bCPO\b/i,
    /\bCMO\b/i, // marketing C-level still appears here but EXCLUDED runs first
    /\bChief\s+(?:Product|Technology|Executive|Operating|Financial|Information|People|Revenue|Design|Security|Data|of\s+Staff)\s+Officer\b/i,
    /\bChief\s+of\s+Staff\b/i,
  ],
  vp: [
    /\bVP\b/i,
    /\bSVP\b/i,
    /\bEVP\b/i,
    /\bVice\s+President\b/i,
    /\bSenior\s+Vice\s+President\b/i,
    /\bHead\s+of\s+(?:Engineering|Design|Product|Operations|Data|Platform|Infrastructure|Security|Research|AI|ML)\b/i,
  ],
  engineering: [
    /\b(?:Senior|Staff|Principal|Distinguished|Lead)\s+(?:Software\s+)?Engineer\b/i,
    /\bSoftware\s+Engineer\b/i,
    /\bSite\s+Reliability\s+Engineer\b/i,
    /\bSRE\b/i,
    /\bDevOps\s+Engineer\b/i,
    /\bSolutions?\s+Architect\b/i,
    /\bEngineering\s+(?:Manager|Lead|Director)\b/i,
    /\bDirector\s*(?:,|\sof)\s*Engineering\b/i,
    /\bData\s+(?:Engineer|Scientist)\b/i,
    /\bML\s+Engineer\b/i,
    /\bMachine\s+Learning\s+Engineer\b/i,
    /\bResearch\s+(?:Engineer|Scientist)\b/i,
    /\bDeveloper\b/i,
    /\bEngineer\b/i, // generic catch — last
  ],
  design: [
    /\bProduct\s+Designer\b/i,
    /\b(?:Senior|Lead|Principal|Staff)\s+Designer\b/i,
    /\bDesign\s+(?:Lead|Director|Manager)\b/i,
    /\bDirector\s*(?:,|\sof)\s*Design\b/i,
    /\bUX\s+(?:Designer|Researcher|Lead)\b/i,
    /\bUI\s+Designer\b/i,
    /\bDesigner\b/i, // generic catch — last
  ],
  business: [
    /\bDirector\s*(?:,|\sof)\s*Operations\b/i,
    /\bBusiness\s+Development\b/i,
    /\bStrategy\s*(?:\s*&|\s+and)\s*Operations\b/i,
    /\bGeneral\s+Manager\b/i,
    /\b(?:Senior|Group)\s+Product\s+Manager\b/i,
    /\bProduct\s+Manager\b/i,
    /\bPartnerships?\s+(?:Lead|Manager|Director)\b/i,
    /\bAccount\s+Executive\b/i,
    /\bSales\s+(?:Manager|Lead|Director)\b/i,
    /\bSales\s+Engineer\b/i,
    /\bSales\b/i,
    /\bOperations\s+(?:Manager|Lead|Director)\b/i,
  ],
};

// ─── BIG-TECH ───────────────────────────────────────────────────────────

const BIGTECH = {
  founder: [
    // Big-tech rarely has "founders" but if a title says so, honor it.
    /\bCo[\s-]?founder\b/i,
    /\bFounder\b/i,
  ],
  'c-level': [
    /\bCEO\b/i,
    /\bCTO\b/i,
    /\bCIO\b/i,
    /\bEVP\b/i,
    /\bChief\s+\w+\s+Officer\b/i,
  ],
  vp: [
    /\bSVP\b/i,
    /\bSenior\s+Vice\s+President\b/i,
    /\bVice\s+President\b/i,
    /\bVP\b/i,
    /\bGeneral\s+Manager\b/i,
    /\bGM\b/i,
    /\bDistinguished\s+(?:Engineer|Scientist)\b/i,
    /\bFellow\b/i,
    /\bSenior\s+Principal\s+Engineer\b/i,
    /\bSenior\s+Director\b/i,
  ],
  engineering: [
    /\b(?:Senior|Staff|Principal|Lead)\s+Software\s+Engineer\b/i,
    /\bSoftware\s+Engineer\b/i,
    /\bEngineering\s+Manager\b/i,
    /\bSenior\s+Engineering\s+Manager\b/i,
    /\bDirector\s*(?:,|\sof)\s*Engineering\b/i,
    /\bResearch\s+(?:Engineer|Scientist)\b/i,
    /\bData\s+(?:Engineer|Scientist)\b/i,
    /\bML\s+Engineer\b/i,
    /\bEngineer\b/i,
  ],
  design: [
    /\bProduct\s+Designer\b/i,
    /\b(?:Senior|Principal|Lead|Staff)\s+Designer\b/i,
    /\bDesign\s+Director\b/i,
    /\bUX\s+(?:Designer|Researcher)\b/i,
    /\bDesigner\b/i,
  ],
  business: [
    /\b(?:Senior|Group)\s+(?:Product\s+)?Manager\b/i,
    /\bProduct\s+Manager\b/i,
    /\bSenior\s+PM\b/i,
    /\bGroup\s+PM\b/i,
    /\bTechnical\s+Program\s+Manager\b/i,
    /\bTPM\b/i,
    /\bProgram\s+Manager\b/i,
    /\bOperations\s+Manager\b/i,
    /\bStrategy\s+Manager\b/i,
  ],
};

// ─── VC ────────────────────────────────────────────────────────────────

const VC = {
  founder: [
    /\bFounding\s+Partner\b/i,
  ],
  'c-level': [
    /\bManaging\s+Partner\b/i,
    /\bGeneral\s+Partner\b/i,
    /\bManaging\s+Director\b/i,
    /\bGP\b/i,
    /\bMP\b/i,
  ],
  vp: [
    /\bVenture\s+Partner\b/i,
    /\bOperating\s+Partner\b/i,
    /\bPartner\b/i,
  ],
  engineering: [
    /\bEngineer\s+in\s+Residence\b/i,
    /\bEIR\b/i,
  ],
  design: [
    /\bDesigner\s+in\s+Residence\b/i,
  ],
  business: [
    /\bPrincipal\b/i,
    /\bVP\s+Investments\b/i,
    /\bSenior\s+Associate\b/i,
    /\bAssociate\b/i,
    /\bAnalyst\b/i,
    /\bInvestor\b/i,
    /\bPlatform\s+Lead\b/i,
  ],
};

export const ROLE_PATTERNS = {
  startup: STARTUP,
  bigTech: BIGTECH,
  vc:      VC,
};

export { EXCLUDED_PATTERNS };
