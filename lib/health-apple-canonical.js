/**
 * Canonical Apple Health metric names, aggregation, and unit conversion.
 *
 * XML (HKQuantityTypeIdentifier*) and Health Auto Export (snake_case names)
 * must land on the same marker id with the same unit. Used by the XML importer
 * and the daily JSON/REST importer.
 */

export const APPLE_SOURCE = 'apple-health';

const ALIASES = {
  step_count: { marker: 'steps', agg: 'sum', unit: 'count' },
  steps: { marker: 'steps', agg: 'sum', unit: 'count' },
  resting_heart_rate: { marker: 'oura_rhr', agg: 'avg', unit: 'count/min', priority: true },
  heart_rate: { marker: 'heart_rate', agg: 'avg', unit: 'count/min' },
  heart_rate_variability: { marker: 'oura_hrv', agg: 'avg', unit: 'ms' },
  heart_rate_variability_sdnn: { marker: 'oura_hrv', agg: 'avg', unit: 'ms' },
  hrv: { marker: 'oura_hrv', agg: 'avg', unit: 'ms' },
  sdnn: { marker: 'oura_hrv', agg: 'avg', unit: 'ms' },
  body_mass: { marker: 'weight', agg: 'last', unit: 'lb' },
  weight_body_mass: { marker: 'weight', agg: 'last', unit: 'lb' },
  weight: { marker: 'weight', agg: 'last', unit: 'lb' },
  oxygen_saturation: { marker: 'spo2', agg: 'avg', unit: '%' },
  blood_oxygen_saturation: { marker: 'spo2', agg: 'avg', unit: '%' },
  spo2: { marker: 'spo2', agg: 'avg', unit: '%' },
  respiratory_rate: { marker: 'respiratory_rate', agg: 'avg', unit: 'count/min' },
  body_fat_percentage: { marker: 'body_fat', agg: 'last', unit: '%' },
  body_fat: { marker: 'body_fat', agg: 'last', unit: '%' },
  blood_glucose: { marker: 'glucose', agg: 'avg', unit: 'mg/dL' },
  glucose: { marker: 'glucose', agg: 'avg', unit: 'mg/dL' },
  sleep_analysis: { marker: 'apple_sleep_total', agg: 'sum', unit: 'hours' },
  sleep: { marker: 'apple_sleep_total', agg: 'sum', unit: 'hours' },
  total_sleep: { marker: 'apple_sleep_total', agg: 'sum', unit: 'hours' },
  walking_running_distance: { marker: 'distance_walking_running', agg: 'sum', unit: 'mi' },
  walking_plus_running_distance: { marker: 'distance_walking_running', agg: 'sum', unit: 'mi' },
  distance_walking_running: { marker: 'distance_walking_running', agg: 'sum', unit: 'mi' },
  active_energy: { marker: 'active_energy_burned', agg: 'sum', unit: 'kcal' },
  active_energy_burned: { marker: 'active_energy_burned', agg: 'sum', unit: 'kcal' },
  basal_energy_burned: { marker: 'basal_energy_burned', agg: 'sum', unit: 'kcal' },
  cycling_distance: { marker: 'distance_cycling', agg: 'sum', unit: 'mi' },
  distance_cycling: { marker: 'distance_cycling', agg: 'sum', unit: 'mi' },
  stair_speed_up: { marker: 'stair_ascent_speed', agg: 'avg', unit: 'ft/s' },
  stair_ascent_speed: { marker: 'stair_ascent_speed', agg: 'avg', unit: 'ft/s' },
  stair_speed_down: { marker: 'stair_descent_speed', agg: 'avg', unit: 'ft/s' },
  stair_descent_speed: { marker: 'stair_descent_speed', agg: 'avg', unit: 'ft/s' },
  six_minute_walking_test_distance: { marker: 'six_minute_walk_test_distance', agg: 'last', unit: 'm' },
  six_minute_walk_test_distance: { marker: 'six_minute_walk_test_distance', agg: 'last', unit: 'm' },
  walking_step_length: { marker: 'walking_step_length', agg: 'avg', unit: 'in' },
  walking_double_support_percentage: { marker: 'walking_double_support_percentage', agg: 'avg', unit: '%' },
  walking_asymmetry_percentage: { marker: 'walking_asymmetry_percentage', agg: 'avg', unit: '%' },
  apple_walking_steadiness: { marker: 'apple_walking_steadiness', agg: 'avg', unit: '%' },
  height: { marker: 'height', agg: 'last', unit: 'in' },
  time_in_daylight: { marker: 'time_in_daylight', agg: 'sum', unit: 'min' },
  apple_exercise_time: { marker: 'apple_exercise_time', agg: 'sum', unit: 'min' },
  apple_stand_time: { marker: 'apple_stand_time', agg: 'sum', unit: 'min' },
  apple_stand_hour: { marker: 'apple_stand_hour', agg: 'sum', unit: 'count' },
};

export const MARKER_UNITS = {
  steps: 'count',
  oura_rhr: 'count/min',
  heart_rate: 'count/min',
  oura_hrv: 'ms',
  weight: 'lb',
  spo2: '%',
  respiratory_rate: 'count/min',
  body_fat: '%',
  glucose: 'mg/dL',
  apple_sleep_total: 'hours',
  apple_sleep_deep: 'min',
  apple_sleep_rem: 'min',
  distance_walking_running: 'mi',
  active_energy_burned: 'kcal',
  basal_energy_burned: 'kcal',
  distance_cycling: 'mi',
  stair_ascent_speed: 'ft/s',
  stair_descent_speed: 'ft/s',
  six_minute_walk_test_distance: 'm',
  walking_step_length: 'in',
  walking_double_support_percentage: '%',
  walking_asymmetry_percentage: '%',
  apple_walking_steadiness: '%',
  height: 'in',
  time_in_daylight: 'min',
};

const HK_TYPE_MAP = {
  HKQuantityTypeIdentifierStepCount: ALIASES.step_count,
  HKQuantityTypeIdentifierHeartRate: ALIASES.heart_rate,
  HKQuantityTypeIdentifierRestingHeartRate: ALIASES.resting_heart_rate,
  HKQuantityTypeIdentifierHeartRateVariabilitySDNN: ALIASES.heart_rate_variability_sdnn,
  HKQuantityTypeIdentifierBodyMass: ALIASES.body_mass,
  HKQuantityTypeIdentifierOxygenSaturation: ALIASES.oxygen_saturation,
  HKQuantityTypeIdentifierRespiratoryRate: ALIASES.respiratory_rate,
  HKQuantityTypeIdentifierBodyFatPercentage: ALIASES.body_fat_percentage,
  HKQuantityTypeIdentifierBloodGlucose: ALIASES.blood_glucose,
};

export function normalizeAppleName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function snakeFromHkType(type) {
  return String(type || '')
    .replace(/^HK(?:Quantity|Category|Correlation)TypeIdentifier/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

function defaultAgg(slug) {
  if (/step_length|stride|steadiness/.test(slug)) return 'avg';
  if (/(?:^|_)(count|steps?|flights?|energy|distance|water|caffeine|exercise|stand|time_in)(?:_|$)/.test(slug)) {
    return 'sum';
  }
  if (/(weight|body_mass|fat|height|waist|bmi|lean)/.test(slug)) return 'last';
  return 'avg';
}

export function configForAppleMetric(nameOrType, units = '') {
  if (HK_TYPE_MAP[nameOrType]) {
    return { ...HK_TYPE_MAP[nameOrType], units: units || HK_TYPE_MAP[nameOrType].unit };
  }
  const slug = nameOrType && String(nameOrType).startsWith('HK')
    ? snakeFromHkType(nameOrType)
    : normalizeAppleName(nameOrType);
  if (ALIASES[slug]) {
    const a = ALIASES[slug];
    return { ...a, units: units || a.unit };
  }
  const agg = defaultAgg(slug);
  return {
    marker: slug || 'unknown_metric',
    agg,
    units: units || MARKER_UNITS[slug] || '',
  };
}

function unitNorm(units) {
  return String(units || '').toLowerCase().replace(/\s+/g, '');
}

export function convertAppleValue(marker, value, units) {
  const n = Number(value);
  if (!Number.isFinite(n)) return n;
  const u = unitNorm(units);

  if (marker === 'weight' && /\bkg\b/.test(u)) return n * 2.20462262;
  if (marker === 'glucose' && (u.includes('mmol') || u.includes('mmol/l'))) return n * 18.0182;

  if (marker === 'height') {
    if (u.includes('cm')) return n / 2.54;
    if (u.includes('m') && !u.includes('cm') && n < 3) return (n * 100) / 2.54;
    if (u.includes('ft') || u.includes('feet') || (n >= 4 && n <= 8 && !u.includes('in'))) return n * 12;
    return n;
  }

  if (marker === 'walking_step_length') {
    if (u.includes('mm') || n > 400) return n / 25.4;
    if (u.includes('cm') || (n > 50 && n <= 400)) return n / 2.54;
    if (u === 'm' || u.includes('meter')) return n * 39.3701;
    return n;
  }

  if (marker === 'distance_walking_running' || marker === 'distance_cycling') {
    if (u.includes('km')) return n * 0.621371;
    if ((u === 'm' || u.includes('meter')) && n > 50) return n * 0.000621371;
    return n;
  }

  if ((marker === 'body_fat' || marker === 'spo2') && n > 0 && n <= 1) return n * 100;
  if (marker === 'walking_double_support_percentage' && n > 0 && n <= 1) return n * 100;
  if (marker === 'apple_walking_steadiness' && n > 0 && n <= 1) return n * 100;
  // XML stores 0–1 fractions; HAE already sends 0–100. Values ≤0.2 are fractions.
  if (marker === 'walking_asymmetry_percentage' && n > 0 && n <= 0.2) return n * 100;

  if (marker === 'apple_sleep_total' || marker === 'oura_total_sleep') {
    if (u.includes('min') || n > 16) return n / 60;
    return n;
  }
  if ((marker === 'apple_sleep_deep' || marker === 'apple_sleep_rem') && u.includes('hour')) {
    return n * 60;
  }
  if (marker === 'time_in_daylight' && (u.includes('hour') || u.includes('hr'))) return n * 60;

  return n;
}

export function roundAppleValue(marker, value, agg) {
  const n = Number(value);
  if (!Number.isFinite(n)) return n;
  if (agg === 'sum' && !/sleep|energy|distance/.test(marker)) return Math.round(n);
  if (marker === 'steps' || marker === 'flights_climbed' || marker === 'apple_stand_hour' || marker === 'workout_count') {
    return Math.round(n);
  }
  return Math.round(n * 10) / 10;
}

export function sleepSamplesFromPoint(point, units = '') {
  if (point == null || typeof point !== 'object') return [];
  const out = [];
  const total = Number(point.totalSleep ?? point.asleep);
  const qty = Number(point.qty);
  const hours = Number.isFinite(total)
    ? convertAppleValue('apple_sleep_total', total, units || 'hour')
    : (Number.isFinite(qty) && qty > 1.5 ? convertAppleValue('apple_sleep_total', qty, units) : null);
  if (hours != null && hours > 0 && hours < 16) {
    out.push({ marker: 'apple_sleep_total', qty: hours, units: 'hours', agg: 'sum' });
  }
  const deep = Number(point.deep);
  if (Number.isFinite(deep) && deep > 0) {
    out.push({
      marker: 'apple_sleep_deep',
      qty: convertAppleValue('apple_sleep_deep', deep, units.includes('hour') ? 'hour' : 'min'),
      units: 'min',
      agg: 'sum',
    });
  }
  const rem = Number(point.rem);
  if (Number.isFinite(rem) && rem > 0) {
    out.push({
      marker: 'apple_sleep_rem',
      qty: convertAppleValue('apple_sleep_rem', rem, units.includes('hour') ? 'hour' : 'min'),
      units: 'min',
      agg: 'sum',
    });
  }
  return out;
}

export const ALIAS_MARKERS = {
  walking_running_distance: 'distance_walking_running',
  active_energy: 'active_energy_burned',
  cycling_distance: 'distance_cycling',
  stair_speed_up: 'stair_ascent_speed',
  stair_speed_down: 'stair_descent_speed',
  six_minute_walking_test_distance: 'six_minute_walk_test_distance',
};
