#!/usr/bin/env node
/**
 * Month-end owner views: Monarch account totals + fill lots on RH/Coinbase.
 */
import { rebuildOwnerMonthViews } from '../lib/monarch-month-views.js';

rebuildOwnerMonthViews()
  .then((series) => {
    const gaps = series.filter((s) => Math.abs(s.gap) > 500);
    console.log(JSON.stringify({
      months: series.length,
      maxAbsGap: Math.max(0, ...series.map((s) => Math.abs(s.gap))),
      gaps: gaps.map((s) => ({ month: s.month, gap: Math.round(s.gap) })),
      last: series[series.length - 1],
    }, null, 2));
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
