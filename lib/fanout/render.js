/**
 * fanout/render.js — the inline stdout string (PURE).
 *
 * renderInline turns a runFanout result into the text any coding agent surfaces
 * inline (agent-agnostic — it is just stdout). Order: (1) the answer, (2) the
 * compact verdict block, (3) the cost line, (4) the receipts path.
 */

function dollars(n) {
  return `$${(Number(n) || 0).toFixed(4)}`;
}

/**
 * @param {object} result - runFanout return
 * @returns {string}
 */
export function renderInline(result) {
  const lines = [];

  // (1) The synthesized / fallback answer.
  lines.push(result.answer || '(no answer)');
  lines.push('');

  // (2) Verdict block.
  lines.push('── Verdict ──');
  if (result.judgeUnavailable) {
    lines.push('Judge unavailable (unparseable output) — showing top raw answer, synthesis skipped.');
  } else {
    lines.push(`Judge: ${result.judgeProvider} (bias-guarded: blind + swapped-order average)`);
    for (let i = 0; i < (result.ranked || []).length; i++) {
      const r = result.ranked[i];
      const isOwn = r.provider === result.judgeProvider ? ' [judge’s own]' : '';
      lines.push(`  #${i + 1} ${r.provider} — ${Math.round(r.correctness)}/100${isOwn}`);
    }
    if (result.own) {
      if (result.own.excluded) lines.push("Judge's own answer: excluded from ranking (--exclude-own).");
      else if (result.own.rank) lines.push(`Judge's own answer ranked #${result.own.rank} of ${result.own.of}.`);
      else lines.push("Judge's own answer: not in the surviving pool.");
    }
    if (result.agreement != null) {
      lines.push(`Agreement: ${Math.round(result.agreement)}/100 (spread ${result.spread ?? '?'}).`);
    }
  }
  if (result.challenger && result.challenger.ran) {
    lines.push(`Challenger: ran — ${result.challenger.thesis || 'argument in receipts'}`);
  } else if (result.challenger) {
    lines.push(`Challenger: ${result.challenger.reason || 'skipped'}`);
  }
  if (result.synthesisFellBack) {
    lines.push(`Synthesis: fell back to top raw answer (${result.fallbackReason || 'no improvement'}).`);
  } else if (!result.judgeUnavailable) {
    lines.push('Synthesis: merged across the answers (provenance in receipts).');
  }
  lines.push('');

  // (3) Cost.
  lines.push(`Cost: ${dollars(result.totalDollars)} total`);
  for (const c of result.costLines || []) {
    const flag = c.priced ? '' : ' [unpriced — unknown model]';
    lines.push(`  ${c.provider || '?'} ${c.model} — ${dollars(c.dollars)}${flag}`);
  }
  lines.push('');

  // (4) Receipts path.
  lines.push(`Receipts: ${result.runDir}`);

  return lines.join('\n');
}
