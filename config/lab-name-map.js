// Shared lab name → marker ID mapping
// Used by all health importers: import-fhir.js, import-pdf-labs.js,
// import-pdf-labs-batch.js, and extract-all-pdfs.js.
// Add new mappings HERE — never in individual importers.
//
// Keys are lowercase. Values are marker IDs or null (explicitly skipped).

export const LAB_NAME_MAP = {
  // ── CBC ──────────────────────────────────────────────
  'wbc': 'wbc', 'white blood cell count': 'wbc', 'white blood cells': 'wbc',
  'leukocytes': 'wbc',
  'rbc': 'rbc', 'red blood cell count': 'rbc', 'red blood cells': 'rbc',
  'hemoglobin': 'hemoglobin', 'hgb': 'hemoglobin',
  'hematocrit': 'hematocrit', 'hct': 'hematocrit',
  'mcv': 'mcv', 'mean corpuscular volume': 'mcv', 'mean cell volume': 'mcv',
  'erythrocyte mean corpuscular volume': 'mcv',
  'platelet count': 'platelets', 'plt': 'platelets', 'platelets': 'platelets',

  // ── Immune / Inflammation ────────────────────────────
  'neutrophils (absolute)': 'anc', 'abs neutrophils': 'anc', 'neutrophil': 'anc',
  'neutrophils': 'anc', 'neutrophils, absolute': 'anc', 'absolute neutrophil count': 'anc',
  'neutrophils.num': 'anc', 'neutrophils absolute': 'anc', 'neutrophil absolute calculated': 'anc',
  'neutrophils  absolute': 'anc',
  'immature granulocytes': null, 'immature grans': null,
  'lymphocytes (absolute)': 'lymph_abs', 'abs lymphocytes': 'lymph_abs',
  'lymphocytes': 'lymph_abs', 'lymphocytes, absolute': 'lymph_abs', 'lymphs (absolute)': 'lymph_abs',
  'absolute lymphocyte count': 'lymph_abs', 'lymphocytes.num': 'lymph_abs',
  'lymphocyte absolute calculated': 'lymph_abs',
  'eosinophils (absolute)': 'eos_absolute', 'abs eosinophils': 'eos_absolute',
  'eosinophils': 'eos_absolute', 'eos (absolute)': 'eos_absolute',
  'eosinophils.num': 'eos_absolute', 'absolute eosinophil count': 'eos_absolute',
  'eosinophils, absolute': 'eos_absolute', 'eos (absolute value)': 'eos_absolute',
  'c3': 'c3', 'complement c3': 'c3', 'c3 complement': 'c3', 'c3,serum': 'c3',
  'c4': 'c4', 'complement c4': 'c4', 'c4 complement': 'c4', 'complement component 4': 'c4',
  'iga': 'iga', 'immunoglobulin a': 'iga', 'immunoglobulin a, qn, serum': 'iga',
  'igg': 'igg', 'immunoglobulin g': 'igg', 'immunoglobulin g, qn, serum': 'igg',
  'igm': 'igm', 'immunoglobulin m': 'igm', 'immunoglobulin m, qn, serum': 'igm',
  'aso': 'aso_titer', 'anti-streptolysin o': 'aso_titer', 'aso titer': 'aso_titer',
  'antistreptolysin o ab': 'aso_titer',
  'hs-crp': 'hscrp', 'c-reactive protein': 'hscrp', 'crp': 'hscrp', 'crp (mg/dl)': 'hscrp',
  'c-reactive protein, cardiac': 'hscrp', 'c-reactive protein, high sensitivity': 'hscrp',
  'high sensitivity c-reactive protein': 'hscrp', 'c reactive protein': 'hscrp',
  'c-reactive protein, quant': 'hscrp',
  'sed rate': 'esr', 'esr': 'esr', 'sedimentation rate': 'esr',
  'erythrocyte sedimentation rate': 'esr', 'sedimentation rate-westergren': 'esr',
  'adalimumab level': 'adalimumab_level', 'adalimumab drug level': 'adalimumab_level',

  // ── Metabolic ────────────────────────────────────────
  'glucose': 'glucose', 'glucose, serum': 'glucose', 'glucose,serum': 'glucose',
  'glucose, plasma': 'glucose', 'glucose in serum': 'glucose',
  'bun': 'bun', 'blood urea nitrogen': 'bun', 'urea nitrogen': 'bun',
  'creatinine': 'creatinine', 'creatinine, serum': 'creatinine', 'creatinine,serum': 'creatinine',
  'creatinine, serum or plasma': 'creatinine',
  'creatinine in serum': 'creatinine',
  'egfr': 'egfr', 'gfr': 'egfr', 'egfr if nonafr. am.': 'egfr',
  'egfr (ckd-epi 2021)': 'egfr',
  'egfr non-afr. american': 'egfr', 'estimated glomerular filtration rate': 'egfr',
  'glomerular filtration rate': 'egfr', 'e-gfr': 'egfr',
  'glom filt rate, est': 'egfr',
  'sodium': 'sodium', 'potassium': 'potassium',
  'calcium': 'calcium_serum', 'calcium, serum': 'calcium_serum', 'calcium in serum': 'calcium_serum',
  'total protein': 'protein_total', 'protein, total': 'protein_total', 'protein, total, serum': 'protein_total',
  'protein': 'protein_total', 'protein.total': 'protein_total',
  'albumin': 'albumin', 'albumin, serum': 'albumin',
  'globulin': 'globulin', 'globulin, total': 'globulin',
  'bilirubin, total': 'bilirubin', 'total bilirubin': 'bilirubin', 'bilirubin': 'bilirubin',
  'bilirubin,total': 'bilirubin',
  'bilirubin.total': 'bilirubin', 'bilirubin total': 'bilirubin',
  'alkaline phosphatase': 'alp', 'alp': 'alp', 'alkaline phosphatase, s': 'alp',
  'alk phos': 'alp',
  'alt': 'alt', 'alt (sgpt)': 'alt', 'alanine aminotransferase': 'alt', 'sgpt': 'alt',
  'ast': 'ast', 'ast (sgot)': 'ast', 'aspartate aminotransferase': 'ast', 'sgot': 'ast',
  'ggt': 'ggt', 'gamma glutamyl transferase': 'ggt',
  'hba1c': 'hba1c', 'hemoglobin a1c': 'hba1c', 'a1c': 'hba1c',
  'glycated hemoglobin': 'hba1c',
  'uric acid': 'uric_acid',
  'phosphorus': 'phosphorus',
  'insulin': 'insulin',

  // ── Iron ─────────────────────────────────────────────
  'iron': 'iron', 'iron, serum': 'iron', 'iron,serum': 'iron',
  'ferritin': 'ferritin', 'ferritin, serum': 'ferritin',
  'iron saturation': 'iron_sat', '% saturation': 'iron_sat', 'iron sat': 'iron_sat',
  'transferrin saturation': 'iron_sat',
  'iron bind.cap.(tibc)': 'tibc', 'tibc': 'tibc', 'iron binding capacity': 'tibc',
  'total iron-binding capacity': 'tibc',
  'iron bind cap (tibc)': 'tibc', 'iron bind cap': 'tibc',
  'iron binding capacity (tibc)': 'tibc',
  'copper': 'copper', 'copper, serum': 'copper', 'copper, serum or plasma': 'copper',
  'zinc': 'zinc', 'zinc, serum': 'zinc', 'plasma zinc': 'zinc',

  // ── Lipids ───────────────────────────────────────────
  'cholesterol, total': 'total_chol', 'total cholesterol': 'total_chol', 'cholesterol': 'total_chol',
  'cholesterol.total': 'total_chol',
  'ldl cholesterol': 'ldl', 'ldl-c': 'ldl', 'ldl chol calc': 'ldl',
  'ldl-c (nih calc)': 'ldl',
  'ldl cholesterol calc': 'ldl', 'ldl calculated': 'ldl',
  'cholesterol in ldl': 'ldl',
  'hdl cholesterol': 'hdl', 'hdl-c': 'hdl', 'hdl': 'hdl',
  'cholesterol in hdl': 'hdl',
  'triglycerides': 'triglycerides', 'triglyceride': 'triglycerides',
  'apolipoprotein b': 'apob', 'apo b': 'apob', 'apolipoprotein b, serum': 'apob',
  'lipoprotein (a)': 'lpa', 'lp(a)': 'lpa', 'lipoprotein(a)': 'lpa',
  'lipoprotein (a), serum': 'lpa',
  'omega-3 index': 'omega3_index', 'omega 3 index': 'omega3_index',

  // ── Thyroid / Hormones ───────────────────────────────
  'tsh': 'tsh', 'thyroid stimulating hormone': 'tsh', 'thyroid stimulating hormon': 'tsh',
  'thyrotropin': 'tsh',
  'free t4': 'free_t4', 'free thyroxine': 'free_t4', 't4, free (direct)': 'free_t4',
  'vitamin d, 25-hydroxy': 'vitamin_d', 'vitamin d': 'vitamin_d', '25-oh vitamin d': 'vitamin_d',
  '25-hydroxyvitamin d': 'vitamin_d', 'vitamin d, 25-oh, total': 'vitamin_d',
  'vitamin b12': 'b12', 'b12': 'b12',
  'folate': 'folate', 'folic acid': 'folate', 'folate (folic acid), serum': 'folate',
  'folate, serum': 'folate',
  'homocysteine': 'homocysteine', 'homocysteine, plasma': 'homocysteine',
  'homocyst(e)ine': 'homocysteine',
  'testosterone': 'testosterone', 'testosterone, total': 'testosterone',
  'testosterone, serum': 'testosterone',
  'testosterone,total,lc/ms': 'testosterone',
  '% free testosterone': 'free_testosterone', 'free testosterone %': 'free_testosterone',
  'free testosterone': 'free_testosterone_pg_ml', 'free testosterone(direct)': 'free_testosterone_pg_ml',
  'free testosterone (direct)': 'free_testosterone_pg_ml',
  'dhea-s': 'dheas', 'dhea sulfate': 'dheas', 'dhea-sulfate': 'dheas',
  'dhea-sulfate 01': 'dheas',
  'shbg': 'shbg', 'sex horm binding glob': 'shbg', 'sex hormone binding globulin': 'shbg',
  'sex horm binding glob, serum': 'shbg',
  'cortisol': 'cortisol',
  'pth': 'pth', 'parathyroid hormone': 'pth', 'pth, intact': 'pth',
  'parathyroid hormone, intact': 'pth',

  // ── Misc ─────────────────────────────────────────────
  'vitamin b6': 'b6',
  'creatine kinase': 'creatine_kinase', 'creatine kinase,total': 'creatine_kinase',
  'weight': 'weight',

  // ── Urine (24hr) ────────────────────────────────────
  // WHY: FHIR DiagnosticReport files emit "calcium, urine 24hr" as the literal display
  // string. Without these "*, urine 24hr" / "*, urine, 24 hour" entries, the FHIR
  // importer auto-creates a duplicate marker (`calcium__urine_24hr`) parallel to the
  // canonical `urine_calcium_24hr`, splitting the data and breaking specimen routing.
  'urine calcium': 'urine_calcium_24hr', 'ca 24': 'urine_calcium_24hr',
  'calcium, urine': 'urine_calcium_24hr', 'calcium urine': 'urine_calcium_24hr',
  'calcium, urine 24hr': 'urine_calcium_24hr',
  'calcium, 24 hr.': 'urine_calcium_24hr',
  'calcium, urine, 24 hour': 'urine_calcium_24hr',
  'calcium 24 hour urine': 'urine_calcium_24hr',
  '24-hour urine calcium': 'urine_calcium_24hr',
  'urine oxalate': 'urine_oxalate_24hr', 'ox 24': 'urine_oxalate_24hr',
  'oxalate, urine': 'urine_oxalate_24hr', 'oxalate urine': 'urine_oxalate_24hr',
  'oxalate, urine 24hr': 'urine_oxalate_24hr',
  'oxalate, urine, 24 hour': 'urine_oxalate_24hr',
  'urine citrate': 'urine_citrate_24hr', 'cit 24': 'urine_citrate_24hr',
  'citrate, urine': 'urine_citrate_24hr', 'citrate urine': 'urine_citrate_24hr',
  'citrate, urine 24hr': 'urine_citrate_24hr',
  'citrate, urine, 24 hour': 'urine_citrate_24hr',
  'urine uric acid': 'urine_uric_24hr', 'ua 24': 'urine_uric_24hr',
  'uric acid urine': 'urine_uric_24hr', 'uric acid, urine': 'urine_uric_24hr',
  'uric acid, urine 24hr': 'urine_uric_24hr',
  'uric acid, urine, 24 hour': 'urine_uric_24hr',
  'na 24': 'urine_sodium_24hr', 'urine sodium': 'urine_sodium_24hr',
  'sodium, urine': 'urine_sodium_24hr',
  'sodium, urine 24hr': 'urine_sodium_24hr',
  'sodium, urine, 24 hour': 'urine_sodium_24hr',
  'magnesium, ur (24 hr)': 'urine_magnesium_24hr', 'urine magnesium': 'urine_magnesium_24hr',
  'magnesium, urine': 'urine_magnesium_24hr',
  'magnesium, urine 24hr': 'urine_magnesium_24hr',
  'magnesium, urine, 24 hour': 'urine_magnesium_24hr',

  // ── PDF extraction variants (numbered suffixes) ─────
  'wbc a, 01': 'wbc', 'rbc a, 01': 'rbc',
  'hemoglobin a, 01': 'hemoglobin', 'hematocrit a, 01': 'hematocrit',
  'mcv a, 01': 'mcv', 'platelets a, 01': 'platelets',
  'neutrophils (absolute) a, 01': 'anc', 'lymphs (absolute) a, 01': 'lymph_abs',
  'eos (absolute) a, 01': 'eos_absolute',
  'glucose a, 01': 'glucose', 'bun a, 01': 'bun',
  'creatinine a, 01': 'creatinine', 'sodium a, 01': 'sodium', 'potassium a, 01': 'potassium',
  'calcium a, 01': 'calcium_serum', 'total protein a, 01': 'protein_total',
  'albumin a, 01': 'albumin', 'globulin a, 01': 'globulin',
  'bilirubin total a, 01': 'bilirubin', 'ast a, 01': 'ast', 'alt a, 01': 'alt',
  'alkaline phosphatase a, 01': 'alp',
  'hemoglobin a1c 01': 'hba1c',
  'wbc 01': 'wbc', 'rbc 01': 'rbc', 'hemoglobin 01': 'hemoglobin',
  'hematocrit 01': 'hematocrit', 'mcv 01': 'mcv', 'platelets 01': 'platelets',
  'neutrophils (absolute) 01': 'anc', 'lymphs (absolute) 01': 'lymph_abs',
  'eos (absolute) 01': 'eos_absolute',
  'cholesterol, total 01': 'total_chol', 'triglycerides 01': 'triglycerides',
  'hdl cholesterol 01': 'hdl',
  'ldl chol. (direct)': 'ldl', 'ldl chol (direct)': 'ldl',
  'ldl chol calc (nih)': 'ldl',
  'c3 complement level': 'c3', 'c4 complement level': 'c4',
  'neutrophil absolute calculated': 'anc',

  // ── Explicitly skipped ──────────────────────────────
  // Percentages
  'neutrophils %': null, 'neutrophils, %': null,
  'lymphocytes %': null, 'lymphocytes, %': null, 'lymphs (%)': null,
  'monocytes %': null, 'monocytes, %': null,
  'eosinophils %': null, 'eosinophils, %': null, 'eos (%)': null,
  'basophils %': null, 'basophils, %': null, 'baso (%)': null,

  // Monocytes / basophils (absolute)
  'monocytes': null, 'monocytes (absolute)': null, 'abs monocytes': null, 'monocytes, absolute': null,
  'absolute monocyte count': null, 'monocytes absolute': null,
  'basophils': null, 'basophils (absolute)': null, 'abs basophils': null,
  'basophils, absolute': null, 'baso (absolute)': null,
  'absolute basophil count': null, 'basophils absolute': null, 'baso(absolute)': null,

  // Relative counts (FHIR)
  'relative eosinophil count': null, 'relative lymphocyte count': null,
  'relative monocyte count': null, 'relative basophil count': null,

  // Derived CBC
  'mch': null, 'mean corpuscular hemoglobin': null, 'mean cell hemoglobin': null,
  'mchc': null, 'mean corpuscular hemoglobin concentration': null, 'mean corpuscular hemoglobin conc': null,
  'rdw': null, 'rdw-cv': null, 'rdw-sd': null, 'red cell distribution width': null,
  'mpv': null, 'mean platelet volume': null,
  'mean platelet volume (fl) by automated count': null,
  'immature platelet fraction': null,
  'immature platelet fraction, absolute': null, 'immature platelet fraction, %': null,
  'nrbc': null, 'nucleated rbc': null, 'nucleated rbc,absolute': null, 'nucleated red blood cells %': null,
  'granulocytes, immature %': null, 'granulocytes immature, absolute': null,
  'granulocytes immature , absolute': null,

  // Ratios / derived
  'anion gap': null,
  'a/g ratio': 'a_g_ratio', 'albumin/globulin ratio': 'a_g_ratio',
  'bilirubin, direct': null, 'direct bilirubin': null, 'bilirubin direct': null,
  'bilirubin, indirect': null,
  'carbon dioxide': 'carbon_dioxide', 'co2': 'carbon_dioxide',
  'co2 total': 'carbon_dioxide', 'co2, total': 'carbon_dioxide',
  'carbon dioxide, total': 'carbon_dioxide',
  'chloride': 'chloride',
  'ldl/hdl ratio': null, 'vldl cholesterol cal': 'vldl_cholesterol_cal',
  'vldl cholesterol': 'vldl_cholesterol_cal',
  'chol/hdlc ratio': null, 'chol/hdl ratio': null,
  'bun/creatinine ratio': 'bun_creat_ratio', 'bun/creat ratio': 'bun_creat_ratio',
  'uibc': null,
  'inr': null, 'prothrombin time': null,

  // eGFR race-adjusted (skip)
  'egfr if afr. am.': null, 'egfr if african am.': null, 'egfr african american': null,
  'e-gfr, african american': null, 'egfr, african american': null,
  'if african-american': null,
  'egfr mdrd african american': null, 'egfr mdrd non african american': null,
  'egfr (ckd-epi) upper limit': null, 'egfr (ckd-epi) lower limit': null,

  // Urinalysis / misc
  'specific gravity': null, 'ph': null,
  'specific gravity, urine': null, 'ph, urine': null,
  'white blood cells, urine': null,

  // Vitals (FHIR)
  'pulse': null, 'spo2': null, 'respirations': null, 'temperature': null,
  'height': null, 'bmi (calculated)': null, 'ideal body weight (ibw) (kg)': null,

  // PDF numbered-suffix skips
  'neutrophils a, 01': null, 'lymphs a, 01': null, 'eos a, 01': null,
  'monocytes a, 01': null, 'basos a, 01': null,
  'monocytes (absolute) a, 01': null, 'baso (absolute) a, 01': null,
  'immature granulocytes a, 01': null, 'immature grans (abs) a, 01': null,
  'monocytes (absolute) 01': null,
  'neutrophils 01': null, 'lymphs 01': null, 'monocytes 01': null,
  'eos 01': null, 'basos 01': null,
  'baso (absolute) 01': null, 'immature granulocytes 01': null, 'immature grans (abs) 01': null,
  'mch 01': null, 'mchc 01': null, 'rdw 01': null,
  'mch a, 01': null, 'mchc a, 01': null, 'rdw a, 01': null,

  // Misc skips
  'lymphs': null, 'eos': null, 'basos': null, 'polys': null,
  'monos': null, 'immature grans (abs)': null,
  'monocytes(absolute)': null,
  // TB quantiferon, CD4/CD8 immune counts, misc urine ratios
  'quantiferon tb1 ag value': null, 'quantiferon tb2 ag value': null, 'quantiferon nil value': null,
  'absolute cd 4 helper': null, '% cd 4 pos. lymph.': null,
  'ph, 24 hr, urine': null, 'potassium, urine': null, 'sulfate, urine': null, 'urine volume (preserved)': null,

  // Urine 24hr derived / ratio metrics (not tracked as standalone markers)
  'creatinine, urine': null, 'calcium/creatinine ratio': null,
  'calcium/kg body weight': null, 'calcium phosphate saturation': null,
  'creatinine/kg body weight': null, 'uric acid saturation': null,
  'protein catabolic rate': null, 'urea nitrogen, urine': null,
  'ammonium, urine': null, 'calcium oxalate saturation': null,
  'chloride urine': null, 'phosphorus, urine': null,

  // IgE food allergy panels (not health markers)
  'urobilinogen,semi-qn': null,

  // ── PDF import additions (merged from extract-all-pdfs.js, import-pdf-labs.js) ──

  // Lipid aliases
  'lipoprotein a': 'lpa',
  'non-hdl cholesterol': 'non_hdl', 'non hdl cholesterol': 'non_hdl',
  'fasting glucose': 'glucose', 'blood glucose': 'glucose',
  'estimated gfr': 'egfr', 'gfr, estimated': 'egfr',
  'uric acid, serum': 'uric_acid',

  // Inflammation aliases
  'high sensitivity crp': 'hscrp', 'hcrp': 'hscrp',
  'crp, high sensitivity': 'hscrp', 'c-reactive protein, hs': 'hscrp',

  // CBC aliases
  'erythrocytes': 'rbc',

  // Liver aliases
  'gamma-glutamyl transferase': 'ggt',

  // Hormones
  'testosterone, free': 'free_testosterone_ng_dl',
  'free t3': 'free_t3', 'triiodothyronine (t3)': 't3', 't3': 't3',
  't4': 't4', 'thyroxine (t4)': 't4',
  'igf-1': 'igf1', 'igf1': 'igf1', 'insulin-like growth factor 1': 'igf1',
  'estradiol': 'estradiol',
  'lh': 'lh', 'fsh': 'fsh',
  'cortisol, am': 'cortisol',

  // Vitamins / minerals
  '25(oh)d': 'vitamin_d', '25-oh vitamin d3': 'vitamin_d',
  '25-oh vitamin d2': 'vitamin_d2',
  'cobalamin': 'b12',
  'magnesium': 'magnesium', 'magnesium, serum': 'magnesium',
  'selenium': 'selenium',

  // Autoimmune panel
  'rheumatoid factor': 'rheumatoid_factor', 'rf': 'rheumatoid_factor',
  'ana': 'ana', 'antinuclear antibodies': 'ana',
  'ana screen': 'ana', 'ana titer': 'ana',
  'anti-ccp': 'anti_ccp', 'cyclic citrullinated peptide': 'anti_ccp',
  'anti-dsdna': 'anti_dsdna', 'anti-rnp': 'anti_rnp',
  'anti-sm': 'anti_sm', 'anti-sm(smith)': 'anti_sm',
  'anti-thyroglobulin': 'anti_thyroglobulin',
  'anti-tpo ab': 'anti_tpo', 'anti-tpo': 'anti_tpo',
  'anti-cardiolipin igg': 'anti_cardiolipin_igg', 'anti-cardiolipin,igg': 'anti_cardiolipin_igg',
  'anti-cardiolipin igm': 'anti_cardiolipin_igm', 'anti-cardiolipin,igm': 'anti_cardiolipin_igm',

  // Cardiac / vascular
  'nt-probnp': 'nt_probnp', 'troponin': 'troponin',
  'apoa1': 'apoa1', 'apolipoprotein a1': 'apoa1', 'apolipoprotein a-1': 'apoa1',

  // Lipid subfractions
  'ldl-p': 'ldl_p', 'sdl-p': 'ldl_p', 'ldl particle number': 'ldl_p',
  'small ldl-p': 'small_ldl_p', 'ldl size': 'ldl_size',
  'hdl particle number': 'hdl_p',
  'vldl': null,

  // Fatty acid panel
  'aa:epa': 'aa_epa_ratio',
  'alpha-linolenic': 'ala', 'epa': 'epa', 'dha': 'dha', 'dpa': 'dpa',
  'arachidonic acid': 'aa', 'linoleic acid': 'linoleic',

  // Biologic drug monitoring
  'adalimumab': 'adalimumab_level',
  'anti-adalimumab': 'drug_adalimumab_antibody', 'anti-adalimumab antibody': 'drug_adalimumab_antibody',

  // Kidney / microalbumin
  'alb/creat ratio': 'alb_creatinine_ratio', 'albumin/creatinine ratio': 'alb_creatinine_ratio',
  'microalbumin': 'microalbumin', 'urine microalbumin': 'microalbumin',
  'urine creatinine, 24 hr': 'urine_creatinine_24hr',
  'urine volume, 24 hr': 'urine_volume_24hr',

  // ACE (autoimmune monitoring)
  'ace': 'ace_level', 'angiotensin-converting enzyme': 'ace_level',

  // Heavy metals panel
  'lead': 'lead', 'mercury': 'mercury', 'arsenic': 'arsenic',
  'cadmium': 'cadmium', 'aluminum': 'aluminum', 'antimony': 'antimony',

  // CD4/CD8 immune panel
  'cd4 helper': 'cd4_count', 'absolute cd4': 'cd4_count',
  'cd4': 'cd4_count', 'cd4 count': 'cd4_count', '% cd4': 'cd4_pct',
  'cd8': 'cd8_count', 'cd4/cd8 ratio': 'cd4_cd8_ratio',

  // Body composition / vitals (from PDF executive health reports)
  'bmi': 'bmi', 'body mass index': 'bmi',
  'waist': 'waist', 'waist circumference': 'waist', 'waist in': 'waist',
  'body fat': 'body_fat', 'body fat %': 'body_fat', '% body fat': 'body_fat',
  'body fat percentage': 'body_fat', 'percent body fat': 'body_fat',
  'bone mineral density': 'bmd', 'bmd': 'bmd',
  't-score': 'bmd_tscore', 'z-score': 'bmd_zscore',
  'blood pressure systolic': 'bp_systolic', 'systolic': 'bp_systolic', 'systolic bp': 'bp_systolic',
  'blood pressure diastolic': 'bp_diastolic', 'diastolic': 'bp_diastolic', 'diastolic bp': 'bp_diastolic',
  'heart rate': 'pulse', 'resting heart rate': 'pulse',
  'height in': 'height', 'height cm': 'height',
  'weight lbs': 'weight', 'weight kg': 'weight',
  'urine ph': 'urine_ph', '24 hour urine ph': 'urine_ph', 'urine ph 24 hr': 'urine_ph',
};
// Note: IgE allergy entries (f002-ige milk, f017-ige hazelnut, etc.) are not
// in LAB_NAME_MAP — they fall through as unmapped and are auto-staged or auto-created.
