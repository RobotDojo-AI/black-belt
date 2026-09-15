/**
 * Phase 3 — Timeline: restore snapshotted interactions/groups/topics/edges.
 * Falls back to raw extraction from chunks/emails/calendar when snapshot is empty
 * (first-ever run or after --reset with no prior snapshot).
 *
 * WHY separate from Phase 2: restore must run AFTER people are resolved so
 * email→person_id and name→person_id maps reflect the newly resolved graph.
 *
 * WHY raw extraction fallback: the snapshot→restore pattern only works when
 * prior interactions exist. After a hard reset with empty source tables, or on
 * a fresh install before any sync, the snapshot will be empty. Raw extraction
 * reads from chunks (iMessage), calendar_events, and emails to populate
 * person_interactions from scratch. Uses INSERT OR IGNORE on source_id — safe
 * to run always; idempotent on subsequent incremental runs.
 */

/**
 * Extract interactions directly from raw source tables.
 * Called only when restore returned 0 interactions (empty snapshot).
 *
 * Sources:
 *   imessages (table)   → channel='imessage', direction='mutual'
 *   calendar_events     → channel='calendar', direction='mutual'
 *   emails              → channel='email', direction='inbound' (received) or 'outbound' (sent)
 *
 * Matching strategy:
 *   iMessage: imessages.handle → person_identifiers (email/phone), set-based join (E5)
 *   Calendar: attendee email → emailMap (skip owner emails)
 *   Email: sender_email → emailMap (inbound); skip newsletters + owner emails
 */
async function extractInteractionsFromRaw(db, log) {
  log('  Extracting interactions from raw sources (idempotent — safe on incremental runs)...');

  const { ownerEmails } = await import('../../lib/identity.js');

  // Build the email → person_id map used by the calendar arm below. iMessage
  // now joins person_identifiers set-based (E5), so the name/phone maps the old
  // chunk path needed are gone.
  const emailMap = new Map();
  for (const r of db.prepare(`SELECT value, person_id FROM person_identifiers WHERE type='email'`).all()) {
    emailMap.set(r.value.toLowerCase(), r.person_id);
  }

  const ownEmails = new Set((ownerEmails() || []).map(e => e.toLowerCase()));

  const insertInteraction = db.prepare(`
    INSERT OR IGNORE INTO person_interactions (person_id, channel, direction, date, source_id)
    VALUES (?, ?, ?, ?, ?)
  `);

  const stats = { imessage: 0, calendar: 0, emailIn: 0, emailOut: 0, skipped: 0 };

  // ── iMessage from the imessages table ─────────────────────────────────────
  // E5 (st_f1a40461): the prior path read iMessage chunk metadata, but those
  // chunks carry metadata='{}' so json_extract(...,'$.participant') was always
  // NULL and produced 0 interactions. Source the join directly from the
  // `imessages` table (53K rows; handle is E.164-normalized for phones, an
  // address for emails) joined to person_identifiers, split by handle_kind:
  //   email handles → match type='email' on LOWER(handle)
  //   all others    → match type='phone' on handle (already E.164)
  // person_identifiers has no 'imessage' type; phone values are E.164 matching
  // imessages.handle. Verified read-only on the live DB: 0 handles map to >1
  // person, source_id is 1:1, ~41K distinct interactions across ~1,500 contacts.
  // EXPLAIN uses idx_pid_type_value (MULTI-INDEX OR), ~150ms. 'mutual' because
  // imessages aggregates both directions per handle.
  const imRows = db.prepare(`
    SELECT pi.person_id AS pid, i.date AS date, i.source_id AS source_id
    FROM imessages i
    JOIN person_identifiers pi
      ON (i.handle_kind = 'email' AND pi.type = 'email' AND LOWER(i.handle) = pi.value)
       OR (i.handle_kind != 'email' AND pi.type = 'phone' AND i.handle = pi.value)
    WHERE i.date IS NOT NULL
  `).all();

  const IM_BATCH = 5000;
  let imBatch = [];
  const flushIm = () => {
    if (imBatch.length === 0) return;
    db.transaction(() => {
      for (const row of imBatch) {
        try {
          insertInteraction.run(row.pid, 'imessage', 'mutual', row.date, row.source_id);
          stats.imessage++;
        } catch { stats.skipped++; }
      }
    })();
    imBatch = [];
  };
  for (const row of imRows) {
    if (!row.pid || !row.date) { stats.skipped++; continue; }
    imBatch.push(row);
    if (imBatch.length >= IM_BATCH) flushIm();
  }
  flushIm();
  log(`  iMessage: ${stats.imessage} interactions (${stats.skipped} skipped)`);

  // ── Calendar from calendar_events ─────────────────────────────────────────
  // One interaction per (attendee, event) — deduped by 'calendar:<event_id>' source_id.
  // WHY skip cancelled: attendee data on cancelled events is noise.
  const calEvents = db.prepare(`
    SELECT id, start_time, attendees
    FROM calendar_events
    WHERE status != 'cancelled'
      AND attendees IS NOT NULL AND attendees NOT IN ('[]', '', 'null')
  `).all();

  let calSkipped = 0;
  const CAL_BATCH = 2000;
  let calBatch = [];
  const flushCal = () => {
    if (calBatch.length === 0) return;
    db.transaction(() => {
      for (const row of calBatch) {
        try {
          insertInteraction.run(row.pid, 'calendar', 'mutual', row.date, row.sourceId);
          stats.calendar++;
        } catch { calSkipped++; }
      }
    })();
    calBatch = [];
  };

  for (const ev of calEvents) {
    let emails;
    try { emails = JSON.parse(ev.attendees); } catch { continue; }
    if (!Array.isArray(emails) || emails.length === 0) continue;
    const date = ev.start_time?.slice(0, 10);
    if (!date) continue;

    for (const emailOrObj of emails) {
      // Attendees can be plain strings (old format) or {email, name, status} objects (Google API format)
      const raw = typeof emailOrObj === 'string' ? emailOrObj : emailOrObj?.email;
      const norm = raw?.toLowerCase()?.trim();
      if (!norm || ownEmails.has(norm)) { calSkipped++; continue; }
      const pid = emailMap.get(norm);
      if (!pid) { calSkipped++; continue; }
      // WHY include pid in source_id: one row per person-event pair.
      // source_id must be unique per row — event_id alone would collapse all attendees.
      calBatch.push({ pid, date, sourceId: `calendar:${ev.id}:${pid}` });
      if (calBatch.length >= CAL_BATCH) flushCal();
    }
  }
  flushCal();
  log(`  Calendar: ${stats.calendar} interactions (${calSkipped} skipped)`);

  // ── Email from emails table ───────────────────────────────────────────────
  // Received emails (sender = other person → inbound).
  // WHY JOIN with person_identifiers: pre-filters 350K → ~20K matched rows.
  // Using .all() on 350K rows loads too much memory. .iterate() with concurrent
  // write transactions fails ("busy executing query"). JOIN makes .all() safe.
  // source_id = email.id (raw hex) so deriveOrigin() JOIN on emails table works.
  const emailRows = db.prepare(`
    SELECT e.id as source_id, pi.person_id as pid, substr(e.received_at, 1, 10) as date
    FROM emails e
    INNER JOIN person_identifiers pi
      ON pi.type = 'email' AND LOWER(e.sender_email) = pi.value
    WHERE e.sender_email IS NOT NULL AND e.sender_email != ''
      AND e.is_newsletter = 0 AND e.list_unsubscribe IS NULL
    ORDER BY e.received_at DESC
  `).all();
  log(`  Email candidates from known senders: ${emailRows.length}`);

  // WHY batched (5000/tx): single large transactions trigger SIGKILL on macOS
  let emailSkipped = 0;
  const EMAIL_BATCH = 5000;
  let batch = [];
  const flushEmail = () => {
    if (batch.length === 0) return;
    db.transaction(() => {
      for (const row of batch) {
        try {
          insertInteraction.run(row.pid, 'email', 'inbound', row.date, row.source_id);
          stats.emailIn++;
        } catch { emailSkipped++; }
      }
    })();
    batch = [];
  };

  for (const row of emailRows) {
    if (!row.pid || !row.date) continue;
    batch.push(row);
    if (batch.length >= EMAIL_BATCH) flushEmail();
  }
  flushEmail();
  log(`  Email: ${stats.emailIn} inbound interactions (${emailSkipped} skipped)`);

  // ── Outbound email (thread-membership proxy) ──────────────────────────────
  // emails table has no to_addresses column. Proxy: if the owner sent in a thread
  // and a known entity also sent in that thread, the owner was communicating with them.
  // Owner email set: identity.js + accounts table (handles missing identity.json).
  const accountEmailRows = db.prepare(
    "SELECT DISTINCT LOWER(email) as email FROM accounts WHERE email IS NOT NULL"
  ).all().map(r => r.email);
  // E2 (st_f1a40461): sanitize out non-address placeholders. The accounts table
  // carries rows like workspace labels and synthetic 'imports:*' identifiers that
  // are not real owner addresses; including them in the owner IN-set would
  // misclassify mail. An owner address must contain '@' and not be a synthetic
  // import handle.
  const isOwnerAddress = (e) => typeof e === 'string' && e.includes('@')
    && !e.startsWith('imports:');
  const fullOwnerSet = new Set([...ownEmails, ...accountEmailRows].filter(isOwnerAddress));

  if (fullOwnerSet.size > 0) {
    const ownerList = [...fullOwnerSet];
    const ph = ownerList.map(() => '?').join(',');
    log(`  Outbound owner set (${ownerList.length}): ${ownerList.join(', ')}`);

    // E2: the prior form correlated emails e_out → emails e_in on thread_id
    // (EXPLAIN: SCAN e_in), an O(n²) self-join that did not return. Decompose
    // into the two-step owner-threads form mirroring the fast inbound template:
    //   1. owner_threads = MIN(owner's send date) per thread the owner sent in
    //   2. join every non-owner sender in those threads → outbound interaction
    // owner_date = MIN(owner send) per thread preserves the original date
    // semantics (MIN(e_out.received_at)), so last_seen/recency are unchanged.
    // EXPLAIN of step 2 uses idx_emails_thread + idx_pid_type_value (no SCAN
    // e_in). Verified read-only on the live DB: 3,500 owner threads, 2,963
    // outbound interactions, ~9s end-to-end.
    db.exec('DROP TABLE IF EXISTS _owner_threads');
    db.prepare(`
      CREATE TEMP TABLE _owner_threads AS
      SELECT thread_id, substr(MIN(received_at), 1, 10) AS owner_date
      FROM emails
      WHERE LOWER(sender_email) IN (${ph})
        AND thread_id IS NOT NULL
        AND is_newsletter = 0
      GROUP BY thread_id
    `).run(...ownerList);

    const outboundRows = db.prepare(`
      SELECT pi.person_id as pid,
             ot.owner_date as date,
             'outbound:email:' || e.thread_id || ':' || pi.person_id as source_id
      FROM emails e
      JOIN _owner_threads ot ON ot.thread_id = e.thread_id
      JOIN person_identifiers pi ON pi.type = 'email' AND LOWER(e.sender_email) = pi.value
      WHERE e.is_newsletter = 0
        AND e.list_unsubscribe IS NULL
        AND LOWER(e.sender_email) NOT IN (${ph})
      GROUP BY e.thread_id, pi.person_id
    `).all(...ownerList);
    db.exec('DROP TABLE IF EXISTS _owner_threads');
    log(`  Outbound email thread candidates: ${outboundRows.length}`);

    let outSkipped = 0;
    let outBatch = [];
    const flushOut = () => {
      if (outBatch.length === 0) return;
      db.transaction(() => {
        for (const row of outBatch) {
          try {
            insertInteraction.run(row.pid, 'email', 'outbound', row.date, row.source_id);
            stats.emailOut++;
          } catch { outSkipped++; }
        }
      })();
      outBatch = [];
    };

    for (const row of outboundRows) {
      if (!row.pid || !row.date) continue;
      outBatch.push(row);
      if (outBatch.length >= EMAIL_BATCH) flushOut();
    }
    flushOut();
    log(`  Email: ${stats.emailOut} outbound interactions (${outSkipped} skipped)`);
  } else {
    log('  Outbound email: skipped (no owner emails configured)');
  }

  const total = stats.imessage + stats.calendar + stats.emailIn + stats.emailOut;
  log(`  Raw total: ${total} interactions extracted`);
  return stats;
}

export async function phaseTimeline(log, { skipRestore = false } = {}) {
  log('\n=== Phase 3: Timeline (restore + places) ===');

  const [
    { restoreDerivedData },
    { extractCalendarPlaces },
    { default: db },
  ] = await Promise.all([
    import('../rebuild/phase-06-restore.js'),
    import('../../lib/calendar-extractor.js'),
    import('../../lib/db.js'),
  ]);

  // Restore interactions/groups/topics/edges from snapshot.
  // st_f1a40461: SKIP on --reset. A hard reset rebuilds interactions entirely
  // from raw (extractInteractionsFromRaw below), so restoring the snapshot is
  // redundant AND harmful — it re-injects whatever (possibly inflated/doubled)
  // interactions a prior botched run left in the snapshot, polluting the table
  // (observed: 557K rows when only 272K were extracted). The snapshot/restore
  // path exists for the no-reset incremental case only.
  let restoreStats = { interactions: 0, groups: 0, topics: 0, edges: 0 };
  if (skipRestore) {
    log('  Restore skipped (--reset: rebuilding interactions from raw, not snapshot)');
  } else {
    try {
      restoreStats = restoreDerivedData(log);
    } catch (err) {
      // E3 (st_f1a40461): only swallow the legitimate "snapshot tables absent"
      // case (first-ever run / post-reset with no prior snapshot). A real schema
      // error — e.g. a column drift like the old nonexistent `source_title` —
      // must fail LOUDLY so it is fixed, not silently masked as zero interactions.
      const msg = String(err?.message || '');
      const tablesAbsent = /no such table: tantei_\w+_snap/i.test(msg);
      if (tablesAbsent) {
        log(`  Restore skipped (snapshot tables absent — first run or post-reset): ${msg}`);
      } else {
        log(`  Restore FAILED with a schema error — rethrowing: ${msg}`);
        throw err;
      }
    }
  }

  // Always run raw extraction — INSERT OR IGNORE on source_id makes it idempotent.
  // For incremental runs, prior interactions are already in place (ignored by INSERT OR IGNORE).
  // For --reset runs, this populates from scratch. For first runs, this bootstraps.
  // WHY always (not just when snapshot empty): calendar and email sources may not have been
  // captured in prior snapshots (e.g., after fixing an extraction bug). Running always ensures
  // all sources are covered without requiring a manual --reset + double-run cycle.
  // st_f1a40461: do NOT swallow — a failed raw extraction means an empty/partial
  // interaction layer, the exact silent failure this story exists to kill.
  await extractInteractionsFromRaw(db, log);

  // Extract calendar places (creates place records + links to timeline events)
  let placeStats = { physical: 0, placesCreated: 0 };
  try {
    placeStats = extractCalendarPlaces();
    log(`  Calendar places: ${placeStats.physical} physical, ${placeStats.placesCreated} created`);
  } catch (err) {
    log(`  Calendar places: skipped (${err.message})`);
  }

  return { restoreStats, placeStats };
}
