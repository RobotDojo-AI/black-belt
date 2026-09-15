// Display metadata for health markers whose source imports do not carry
// target/reference ranges. Values come from existing health context/config notes.

const CANONICAL_BY_IMPORTED_ID = {
  bilirubin_total: 'bilirubin',
  bun_creatinine_ratio: 'bun_creat_ratio',
  calcium_24_hr: 'urine_calcium_24hr',
  carbon_dioxide_total: 'carbon_dioxide',
  chloride_serum: 'chloride',
  copper_serum_or_plasma: 'copper',
  creatinine_serum_or_plasma: 'creatinine',
  crp_mg_dl: 'hscrp',
  co2: 'carbon_dioxide',
  co2_total: 'carbon_dioxide',
  egfr_ckd_epi_2021: 'egfr',
  eosinophils: 'eos_absolute',
  immunoglobulin_a_qn_serum: 'iga',
  immunoglobulin_g_qn_serum: 'igg',
  immunoglobulin_m_qn_serum: 'igm',
  ldl_c_nih_calc: 'ldl',
  lymphocytes_absolute: 'lymph_abs',
  neutrophils_absolute: 'anc',
  plasma_zinc: 'zinc',
  sex_horm_binding_glob_serum: 'shbg',
  testosterone_serum: 'testosterone',
  testosterone_total_lc_ms: 'testosterone',
};

const METADATA_BY_ID = {
  anc: { refLow: 1500, refHigh: 7800, target: 2000, direction: 'higher', cellCountScale: true },
  apob: { refHigh: 80, target: 80, direction: 'lower' },
  arsenic: { forceRefLow: null, direction: 'lower' },
  alt: { forceRefLow: null, direction: 'lower' },
  ast: { forceRefLow: null, direction: 'lower' },
  baso_absolute: { refLow: 0, refHigh: 0.2, direction: 'range' },
  basos: { refLow: 0, refHigh: 2, direction: 'range' },
  bilirubin: { forceRefLow: null, refHigh: 1.2, direction: 'lower' },
  body_fat: { refHigh: 20, target: 15, direction: 'lower' },
  calcium_serum: { refLow: 8.6, refHigh: 10.2, target: 9.5, direction: 'range' },
  copper: { refLow: 70, refHigh: 140, target: 100, direction: 'range' },
  creatinine: { refHigh: 1.27, target: 1.0, direction: 'lower' },
  egfr: { refLow: 60, target: 90, direction: 'higher' },
  eos: { refLow: 0, refHigh: 8, direction: 'range' },
  eos_absolute: { refLow: 0, refHigh: 500, direction: 'range', cellCountScale: true },
  ferritin: { refHigh: 150, target: 100, direction: 'lower' },
  free_testosterone: { refLow: 1.5, refHigh: 4.2, target: 2.2, direction: 'range' },
  free_testosterone_ng_dl: { refLow: 5, refHigh: 21, direction: 'range' },
  free_testosterone_pg_ml: { refLow: 8.7, refHigh: 25.1, direction: 'range' },
  glucose: { refLow: 70, refHigh: 100, target: 90, direction: 'range' },
  hba1c: { forceRefLow: null, forceRefHigh: 5.7, target: 5.2, direction: 'lower' },
  hdl: { refLow: 39, target: 60, direction: 'higher' },
  hscrp: { refHigh: 1.0, target: 0.5, direction: 'lower' },
  iga: { refLow: 90, refHigh: 386, target: 180, direction: 'range' },
  igg: { refLow: 603, refHigh: 1613, target: 1000, direction: 'range' },
  igm: { refLow: 20, refHigh: 172, target: 80, direction: 'range' },
  ldl: { refHigh: 100, target: 70, direction: 'lower' },
  lead: { forceRefLow: null, direction: 'lower' },
  non_hdl: { refHigh: 100, target: 100, direction: 'lower' },
  lymph_abs: { refLow: 850, refHigh: 3900, target: 1500, direction: 'higher', cellCountScale: true },
  oura_activity_score: { refLow: 75, target: 85, direction: 'higher' },
  eight_sleep_deep_sleep: { refLow: 60, target: 90, direction: 'higher' },
  eight_sleep_hrv: { target: 60, direction: 'higher' },
  eight_sleep_quality: { refLow: 80, target: 85, direction: 'higher' },
  eight_sleep_rem_sleep: { refLow: 60, target: 90, direction: 'higher' },
  eight_sleep_rhr: { refHigh: 70, target: 55, direction: 'lower' },
  eight_sleep_score: { refLow: 80, target: 85, direction: 'higher' },
  eight_sleep_total_sleep: { refLow: 7, refHigh: 9, target: 8, direction: 'range' },
  oura_deep_sleep: { refLow: 60, target: 90, direction: 'higher' },
  oura_efficiency: { refLow: 85, target: 90, direction: 'higher' },
  oura_hrv: { target: 60, direction: 'higher' },
  oura_readiness: { refLow: 80, target: 85, direction: 'higher' },
  oura_rem_sleep: { refLow: 60, target: 90, direction: 'higher' },
  oura_rhr: { refHigh: 70, target: 55, direction: 'lower' },
  oura_sleep_score: { refLow: 80, target: 85, direction: 'higher' },
  oura_spo2: { refLow: 95, target: 98, direction: 'higher' },
  oura_steps: { target: 10000, direction: 'higher' },
  oura_total_sleep: { refLow: 7, refHigh: 9, target: 8, direction: 'range' },
  respiratory_rate: { refLow: 12, refHigh: 20, target: 15, direction: 'range' },
  shbg: { refLow: 16.5, refHigh: 55.9, target: 35, direction: 'range' },
  spo2: { refLow: 95, target: 98, direction: 'higher' },
  steps: { target: 10000, direction: 'higher' },
  testosterone: { refLow: 300, refHigh: 1000, target: 700, direction: 'higher' },
  total_chol: { forceRefLow: null, target: 150, direction: 'lower' },
  triglycerides: { forceRefLow: null, target: 70, direction: 'lower' },
  urine_calcium_24hr: { refHigh: 320, target: 250, direction: 'lower' },
  vitamin_d: { refLow: 50, refHigh: 60, target: 55, direction: 'range' },
  vldl_cholesterol_cal: { refHigh: 40, target: 15, direction: 'lower' },
  zinc: { refLow: 60, refHigh: 130, target: 90, direction: 'range' },

  // Mycotoxin panels encode tier thresholds as low/high bands in source files.
  // Clinically and visually these are lower-is-better exposures: zero/non-detect
  // is valid data, not a physiologic placeholder to hide.
  aflatoxin_m1: { forceRefLow: null, direction: 'lower' },
  chaetoglobosin_a: { forceRefLow: null, direction: 'lower' },
  citrinin: { forceRefLow: null, direction: 'lower' },
  citrinin_dihydrocitrinone_dhc: { forceRefLow: null, direction: 'lower' },
  enniatin_b: { forceRefLow: null, direction: 'lower' },
  gliotoxin: { forceRefLow: null, direction: 'lower' },
  mycophenolic_acid: { forceRefLow: null, direction: 'lower' },
  ochratoxin_a: { forceRefLow: null, direction: 'lower' },
  roridin_e: { forceRefLow: null, direction: 'lower' },
  sterigmatocystin: { forceRefLow: null, direction: 'lower' },
  verrucarin_a: { forceRefLow: null, direction: 'lower' },
  zearalenone: { forceRefLow: null, direction: 'lower' },
};

const DISPLAY_NAME_BY_ID = {
  a_g_ratio: 'A/G Ratio',
  alp: 'Alkaline Phosphatase',
  alt: 'ALT',
  anc: 'Absolute Neutrophils',
  apob: 'ApoB',
  arsenic: 'Arsenic',
  ast: 'AST',
  baso_absolute: 'Basophils (Absolute)',
  basos: 'Basophils',
  bilirubin: 'Total Bilirubin',
  body_fat: 'Body Fat',
  bun: 'BUN',
  bun_creat_ratio: 'BUN/Creatinine Ratio',
  calcium_serum: 'Calcium',
  carbon_dioxide: 'Carbon Dioxide',
  chloride: 'Chloride',
  copper: 'Copper',
  creatinine: 'Creatinine',
  dheas: 'DHEA-S',
  egfr: 'eGFR',
  eos: 'Eosinophils',
  eos_absolute: 'Eosinophils (Absolute)',
  ferritin: 'Ferritin',
  free_testosterone: 'Free Testosterone',
  free_testosterone_ng_dl: 'Free Testosterone',
  free_testosterone_pg_ml: 'Free Testosterone',
  globulin: 'Globulin',
  glucose: 'Glucose',
  hba1c: 'HbA1c',
  hematocrit: 'Hematocrit',
  hemoglobin: 'Hemoglobin',
  hdl: 'HDL Cholesterol',
  hscrp: 'hs-CRP',
  immature_granulocytes: 'Immature Granulocytes',
  iron: 'Iron',
  iron_sat: 'Iron Saturation',
  ldl: 'LDL Cholesterol',
  lead: 'Lead',
  lpa: 'Lp(a)',
  lymph_abs: 'Lymphocytes (Absolute)',
  lymphs: 'Lymphocytes',
  mch: 'MCH',
  mchc: 'MCHC',
  mcv: 'MCV',
  monocytes: 'Monocytes',
  monocytes_absolute: 'Monocytes (Absolute)',
  mpv: 'MPV',
  non_hdl: 'Non-HDL Cholesterol',
  oura_deep_sleep: 'Deep Sleep',
  oura_efficiency: 'Sleep Efficiency',
  oura_hrv: 'HRV',
  oura_readiness: 'Readiness',
  oura_rem_sleep: 'REM Sleep',
  oura_rhr: 'Resting Heart Rate',
  oura_sleep_score: 'Sleep Score',
  oura_steps: 'Steps',
  oura_total_sleep: 'Total Sleep',
  platelets: 'Platelets',
  potassium: 'Potassium',
  protein_total: 'Total Protein',
  rbc: 'RBC',
  rdw: 'RDW',
  respiratory_rate: 'Respiratory Rate',
  shbg: 'SHBG',
  sodium: 'Sodium',
  spo2: 'SpO2',
  steps: 'Steps',
  testosterone: 'Testosterone',
  tibc: 'TIBC',
  total_chol: 'Total Cholesterol',
  triglycerides: 'Triglycerides',
  tsh: 'TSH',
  urine_calcium_24hr: '24-Hour Urine Calcium',
  vitamin_d: 'Vitamin D',
  vldl_cholesterol_cal: 'VLDL Cholesterol',
  wbc: 'WBC',
  weight: 'Weight',
  zinc: 'Zinc',
};

export function healthMarkerMetadataSignature() {
  return JSON.stringify({
    canonicalByImportedId: CANONICAL_BY_IMPORTED_ID,
    displayNameById: DISPLAY_NAME_BY_ID,
    metadataById: METADATA_BY_ID,
  });
}

function normalizeName(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function canonicalFromName(marker) {
  const name = normalizeName(marker.name);
  if (name === 'ldl c nih calc' || name === 'ldl chol calc nih') return 'ldl';
  if (name === 'bun creatinine ratio' || name === 'bun creat ratio') return 'bun_creat_ratio';
  if (name === 'carbon dioxide total') return 'carbon_dioxide';
  if (name === 'co2' || name === 'co2 total') return 'carbon_dioxide';
  if (name === 'chloride serum') return 'chloride';
  if (name === 'calcium 24 hr') return 'urine_calcium_24hr';
  if (name === 'neutrophils absolute') return 'anc';
  if (name === 'lymphocytes absolute') return 'lymph_abs';
  if (name === 'egfr ckd epi 2021') return 'egfr';
  if (name === 'eosinophils' || name === 'eosinophils absolute' || name === 'eos absolute') return 'eos_absolute';
  if (name === 'bilirubin total') return 'bilirubin';
  if (name === 'crp mg dl') return 'hscrp';
  if (name === 'copper serum or plasma') return 'copper';
  if (name === 'plasma zinc') return 'zinc';
  if (name === 'sex horm binding glob serum') return 'shbg';
  if (name === 'testosterone total lc ms' || name === 'testosterone serum') return 'testosterone';
  if (name === 'immunoglobulin a qn serum') return 'iga';
  if (name === 'immunoglobulin g qn serum') return 'igg';
  if (name === 'immunoglobulin m qn serum') return 'igm';
  if (name === 'creatinine serum or plasma') return 'creatinine';
  return null;
}

export function canonicalHealthMarkerId(marker) {
  return CANONICAL_BY_IMPORTED_ID[marker.id] || canonicalFromName(marker) || marker.id;
}

function isThousandCellUnit(unit) {
  return /(?:x10e3|10\*3|10\^3|k)\/?u?l/i.test(unit || '');
}

function scaleMetadataValue(value, marker, meta, fromMetadata) {
  if (value == null || !fromMetadata || !meta.cellCountScale || !isThousandCellUnit(marker.unit)) return value;
  return value / 1000;
}

export function enrichHealthMarker(marker) {
  const canonicalId = canonicalHealthMarkerId(marker);
  const meta = METADATA_BY_ID[canonicalId] || METADATA_BY_ID[marker.id] || {};
  const displayName = DISPLAY_NAME_BY_ID[canonicalId] || DISPLAY_NAME_BY_ID[marker.id] || null;
  const sourceName = marker.sourceName || marker.source_name || marker.originalName || marker.name || null;
  const hasMarkerRefLow = marker.ref_low != null;
  const hasMarkerRefHigh = marker.ref_high != null;
  const hasMarkerTarget = marker.target != null;
  const forcedRefLow = Object.prototype.hasOwnProperty.call(meta, 'forceRefLow');
  const forcedRefHigh = Object.prototype.hasOwnProperty.call(meta, 'forceRefHigh');
  const rawRefLow = forcedRefLow ? meta.forceRefLow : hasMarkerRefLow ? marker.ref_low : meta.refLow ?? null;
  const rawRefHigh = forcedRefHigh ? meta.forceRefHigh : hasMarkerRefHigh ? marker.ref_high : meta.refHigh ?? null;
  const rawTarget = hasMarkerTarget ? marker.target : meta.target ?? null;
  return {
    ...marker,
    canonicalId,
    name: displayName || marker.name,
    sourceName: displayName && displayName !== marker.name ? sourceName : marker.sourceName || marker.source_name || null,
    ref_low: scaleMetadataValue(rawRefLow, marker, meta, forcedRefLow || !hasMarkerRefLow),
    ref_high: scaleMetadataValue(rawRefHigh, marker, meta, forcedRefHigh || !hasMarkerRefHigh),
    target: scaleMetadataValue(rawTarget, marker, meta, !hasMarkerTarget),
    direction: meta.direction || 'range',
  };
}
