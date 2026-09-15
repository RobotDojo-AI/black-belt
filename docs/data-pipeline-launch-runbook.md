# Data Pipeline Launch Runbook

Use this runbook when the data pipeline is draining embeddings, handing off to post-drain repair, or being evaluated for launch closure.

The operator goal is simple: do not make the pipeline interesting. Obey the structured status action before touching logs, services, lanes, or data.

## Source Of Truth

Primary command:

```sh
npm run qa:data-pipeline
```

Raw status:

```sh
node scripts/qa/data-pipeline-status.js --summary-json --respect-cadence --strict
```

Fresh cached status:

```sh
node scripts/qa/data-pipeline-status.js --latest-summary-json --strict
```

Completion command:

```sh
npm run qa:data-pipeline:complete
```

Use the status JSON as authoritative for phase, pending embeddings, active hold, services, `memory_headroom`, `live_progress`, `trend`, handoff, post-drain watcher state, and the next operator action.

JSON status commands must write only machine-readable JSON to stdout. Human diagnostics, boot notices, and incidental module output belong on stderr or in text mode.

Status and audit output must also show `code_freshness`. Stale code is an operator action only when status turns it into a blocker for a live owned process. During bounded respawn or non-held states, the operator rule still decides the action.

## Speed Read

Do not compare the live historical repair to a raw embedding benchmark. The launch goal is fast first-use plus safe background deepening, not maximum batch throughput.

If a new install needs faster perceived intelligence, fix first-use prioritization: recent, high-signal, and directly named data should become bounded local evidence quickly, then full embeddings backfill in the background.

The first-use readiness bar is not "all chunks are embedded." It is "after ingest and classification, a directly named item can reach chat through bounded local evidence while its chunk is still pending embedding." If this fails, fix the import, classification, local search, entity-card, or chat-context path; do not hide the gap by making the historical backfill lane bigger.

If an active historical drain feels slow, trust `status_action`, `memory_headroom`, foreground activity, and `trend`. When status says `wait` and `memory_headroom.can_add_lane_by_rss=false`, adding a lane is forbidden even if the ETA is frustrating. A falling trend with no operator action required is progress.

The audit's `speed_posture` line is the compact version of that decision. `user_speed_goal=fast_first_use`, `backfill_speed_goal=safe_historical_repair`, `normal_user_path=bounded_local_evidence_before_full_vector_backfill`, and `raw_throughput_launch_metric=false` mean normal installs should feel useful quickly while this live historical repair drains safely. `mode=historical_repair`, `wait_only=true`, and `acceleration_allowed=false` means the live drain is intentionally safe-slow. Do not turn a rate or ETA into a lane change unless `speed_posture.acceleration_allowed=true` and the operator rule explicitly allows that lane/throughput action.

If `npm run qa:data-pipeline` shows `fallback_used=true` with `fallback_source=latest_summary_json_after_primary_status_failure`, the primary status probe timed out before JSON and the audit used the fresh cached snapshot instead. This is valid only when the snapshot is fresh and produced by current status code. Mixed stdout or red JSON is still a real status failure; do not hide it with cached status.

`memory_headroom` separates memory health from drain-process visibility. During bounded respawn grace, `drain_process_visible=false` can still be healthy when `respawn_grace=true`; the action remains wait unless `status_action` changes.

`memory_headroom.pressure=high_compression` with `memory_headroom.ok=true` is a caution, not an emergency. It explains why the drain stays conservative. It does not authorize a restart, lane change, or second writer when `status_action.kind=wait`.

`code_freshness` separates changed files from required restarts. A stale live drain wrapper, held worker, resident embed daemon, or post-drain runner can block when status says so. A non-current file with `status_action.kind=wait` is visibility, not permission to restart.

When ETA is unavailable or marked non-authoritative, use `live_progress` and `trend` before assuming a stall. The compact JSON must show pending count, current-run completed count, observed sample rate/ETA, representative flag, the reason an ETA is not yet authoritative, and the read-only pending trend from bounded status history, durable progress snapshots, and the current live count. If the requested trend window has too few snapshots, status must mark the trend basis as `extended_last_known_progress` or `insufficient_history`. A zero-pending trend sample is trusted only when it is terminal or completion-backed; a failed zero sample followed by a quick large rebound is filtered as implausible history. Trend ETA is orientation until `trend.representative=true`.

Use the `drain_movement` line before interpreting `fresh_no_progress`. `warmup_no_sample=true` and `stall_signal=false` mean the current pass has no rate sample yet, but the live hold/effective writer evidence and status action say to wait. Do not restart or retune from `current_run_completed=0` alone.

Use the `work_order` line to answer whether embeddings are happening most important first. `sorted=true` with rule `priority_desc_email_share_asc_pending_asc` means the bounded queue head is ordered by value, with email-heavy bulk pushed later on ties. If sorted turns false, that is an observability failure to fix before tuning lanes.

Do not use `--skip-contract-tests` for operator proof. It is fixture-only; strict audits with skipped checks are attention-required by design.

When action is required, audit output must show the whole operator envelope: allowed actions, deferred actions, suppressed unsafe actions, and forbidden actions. The first allowed action is the only action to take before rerunning strict status.

The audit `warnings` line is informational when `expected_while_draining=true` and `operator_action=false`. For example, `post_drain_readiness_stale_hold_snapshot` with action `trust_live_hold` means the readiness snapshot predates the current drain hold; trust the live hold and wait.

Use the `dp7_steps` line to see the post-drain launch-contract counts, next step, and pending or blocked step IDs. If `blocked_ids=none` and operator action is `wait`, do not open logs just to learn which stage is pending.

## Action Table

| Status kind | Meaning | Allowed operator behavior | Forbidden behavior |
| --- | --- | --- | --- |
| `wait` | The active drain is healthy. | Wait until `recheck_after`. | Inspect logs, restart services, retune lanes, start another writer, edit data or topics. |
| `watch` | Drain is done or handoff is ready; watcher should begin. | Observe the named watcher start. | Manually run backup, reclassification, context regeneration, ANN rebuild, or proof. |
| `monitor` | Post-drain watcher owns an active step. | Observe only that named step. | Continue the chain manually or bypass the watcher. |
| `inspect_warning` | A warning needs bounded inspection. | Inspect only the named warning action. | Start a second writer, edit data/topics, or repair unrelated services. |
| `fix_blocker` | A blocker prevents progress. | Fix the first named blocker, then rerun strict status. | Start post-drain work, start another writer, or edit data/topics. |
| `close_goal` | Final proof is green. | Close the data-pipeline goal after complete audit passes. | Close if DP-7 or product proof is missing. |

If the first named blocker is `free_disk_space`, reclaim cache, generated, or other non-live artifacts first. Do not delete live DB files, live WAL files, vector stores, or the only local backup unless a verified cloud or alternate backup for that exact data exists. If later blocker actions include restarting the embedding drain or wrapper, treat them as deferred: free disk, rerun strict status, then follow the new first action only if it still appears.

## Active Drain Rules

During active drain:

1. There must be exactly one active embedding writer.
2. The hold must point to a live process.
3. Foreground chat has priority over drain throughput.
4. Narrow `memory_headroom.drain_rss_headroom_mb` is informational when the guard is active.
5. High compression with `memory_headroom.ok=true` is wait-state evidence, not a blocker.
6. The operator does not add lanes unless status explicitly requires that action.
7. Zero child lane processes is not automatically a stall. If status reports effective mode `single_in_process_writer`, the guarded worker is the live writer and the correct action is still wait.
8. A fresh respawn or warmup window is expected. Inspect only when status changes to `inspect_warning` or `fix_blocker`.
   If `drain_movement.warmup_no_sample=true` and `drain_movement.stall_signal=false`, the healthy action is still wait.
9. Active-drain post-drain preflight projection gaps are wait-state warnings when status says `operator_action_required=false`. ANN-source vector races and memory-refocus projections rerun at zero backlog; do not repair rows while the writer is still changing evidence.
10. Non-authoritative sample ETA is only a live slope. It answers "what if the current sample held" without becoming an action trigger. Use `effective_eta.authoritative_eta_source` or `status_action` for decisions.
11. Stale launch stoplight during active drain is informational when status reports `stoplight_stale_active_drain`. Live drain status is authoritative until zero backlog; do not refresh stoplight proof, retune lanes, or start post-drain work from old evidence.
12. Trend is orientation, not permission. A falling 48-hour trend explains why a noisy point ETA can stay steady while work is still draining; action still comes only from `status_action`. Treat trend ETA as non-authoritative when `trend.representative=false`. Treat zero-pending samples as real only when they are terminal or completion-backed; a failed zero followed by a quick large rebound is noise, not completion. The trend history is bounded runtime evidence and should never be expanded into an unbounded log.
13. Disk-floor blockers are safety stops, not data-pipeline failures. Free non-live disk, rerun strict status, then let the guarded wrapper respawn; do not manually restart the embedding drain unless the refreshed first action still says to.

Healthy active drain means `operator_action_required=false`, no blockers, and `status_action.kind=wait`. It is not permission to edit data, move topics, or repair rows manually.

When retrieval is degraded during active drain, inspect the retrieval line only as bounded evidence. `global_ann_ready=false` is expected until post-drain rebuild when the line also shows vector mode, source lag, the current `within_lag` value, and missing/malformed vector counts. `within_lag=false` during active drain is caution evidence only when status also emits an expected wait-state warning such as `post_drain_ann_source_lag_active_drain`. Repair still belongs to the post-drain watcher.

Detached ANN/HNSW repair must not start while embeddings remain pending. If the ANN artifact is missing during active drain, chat uses bounded fallback and status stays degraded; the post-drain watcher owns the full rebuild after source quiescence.

If retrieval shows `stale_vectors_skipped=true` while status says wait, treat it as deferred audit evidence. The active drain uses a shape-only vector projection for speed; full stale-vector audit and repair belong after source quiescence.

If `post_drain.memory_refocus_projection.after` is above threshold while live needs-routing memory is within threshold and status says wait, treat it as post-drain-only projection evidence. Do not edit memory links manually; the watcher reruns strict preflight and owns memory refocus after zero backlog.

Source-bound chat can still answer from bounded local entity and memory context while vector/ANN retrieval is degraded. That context is evidence for the facts it directly states: entity existence, identifiers, relationship tier, interaction counts, recency, and generated entity summaries. If the user asks for deeper message/document details not present in that bounded context, the answer must say document/vector retrieval did not return that detail yet.

When post-drain preflight is red during active drain, inspect the `post_drain` line as deferred readiness evidence. It should show watcher freshness, ANN-source lag and `ann_within_lag`, plus memory refocus `memory_after` and `memory_threshold`. Do not run post-drain repairs while the embedding writer is still active.

If warning code `post_drain_ann_source_lag_active_drain` appears while status says wait, treat `ann_within_lag=false` as active-drain drift, not repair permission. Do not rebuild ANN or refresh stoplight; strict preflight reruns at zero backlog and the watcher owns the rebuild.

If warning code `post_drain_readiness_stale_hold_snapshot` appears while status says wait, do not restart the watcher or run post-drain work. The snapshot is older than the active drain hold; the live hold is authoritative until zero backlog.

## Post-Drain Order

When pending embeddings reach zero, the guarded drain writes the durable handoff and the watcher owns the rest:

1. Confirm writer quiescence.
2. Wait for backup slot clearance.
3. Run strict backup.
4. Reclassify chunks through pipeline-owned movement.
5. Repair split-vector orphans.
6. Repair source topic metadata.
7. Regenerate topic contexts.
8. Rebuild global ANN/HNSW.
9. Repair memory routing.
10. Refocus needs-routing memory.
11. Recalculate memory projections.
12. Regenerate post-memory topic contexts.
13. Audit Personal and needs-routing residue.
14. Release final writer state.
15. Run final product proof.

No step is skipped because an earlier CLI test passed. CLI tests are contract evidence only; they never replace the post-drain browser/login/chat product proof. The watcher history is the proof surface.

Final proof also requires the live data-plane proof boundaries: `db`, `passive_jobs`, `import_classification`, `raw_source`, `search`, `embedding`, `first_use_context`, `semantic_retrieval`, `entity_enrichment`, and `chat_context`. The `import_classification` boundary must write an ambiguous import, route it through the drop-folder classifier, and prove the unknown file started uncategorized and not Personal before browser proof can close the goal. The `first_use_context` boundary must prove a freshly written pending-embedding row still reaches chat through bounded local context before vector backfill finishes.

The final product proof must store the live `data_plane_proof` payload and `data_plane_proof_verdict`. A green `data_pipeline_invariants` row without the boundary payload is not close evidence.

The browser chat proof must include both a generic visible assistant turn and a seeded source-bound entity-network turn. A seeded local entity-card question proves chat can answer "this person/company/place is in your network" from bounded local evidence even while vector/ANN retrieval had been degraded earlier in the drain. The seeded proof must cover "is X in my entity network?", "find X in my entity network", and "why isn't X in my entity network?" language.

The final `browser_product_proof` row must store `browser_entity_card_proof.ok=true`. A generic green browser row without the seeded entity-card marker is not close evidence.

## Completion Bar

The goal is complete only when all are true:

- `npm run qa:data-pipeline:complete` exits 0.
- Strict status reports `ok=true` and `complete=true`.
- Required live backlog counters are present and zero.
- The audit `dp7_backlog` line reports `zero=true`, `missing=none`, `invalid=none`, and `nonzero=none`.
- Status action is `close_goal`.
- Backlog and final writer release are green.
- Retrieval is not degraded.
- Live data-plane proof includes green `db`, `passive_jobs`, `import_classification`, `raw_source`, `search`, `embedding`, `first_use_context`, `semantic_retrieval`, `entity_enrichment`, and `chat_context` boundaries.
- The final product proof stores `data_plane_proof` and `data_plane_proof_verdict`.
- The audit `dp7_product_proof` line reports `data_plane=true`, `data_plane_missing=none`, `data_plane_non_green=none`, `import_classification=true`, `first_use_context=true`, `data_plane_verdict=true`, `data_plane_verdict_missing=none`, `data_plane_verdict_non_green=none`, `import_classification_verdict=true`, and `first_use_context_verdict=true`.
- Import classification proof shows ambiguous imports start uncategorized and not Personal.
- Final product proof includes green `local_readiness`, `login_session`, `private_chat`, `chat_open_daemon_quiet`, `chat_stall_recovery`, `browser_product_proof`, `foreground_activity_signal`, `data_pipeline_invariants`, and `retrieval_sentinel` rows.
- `local_readiness` proves the running foreground app process is current against the chat/runtime proof files; a stale desktop process is red even when server health answers.
- Green final product rows do not contain `active_drain_block`, `blocked_by_active_embedding_drain`, or exact-proof-deferred evidence.
- Browser chat proof includes the seeded source-bound local entity-card turn, not only a generic visible answer.
- Browser chat proof covers network-existence, direct-find, and negative-premise wording.
- The durable `browser_product_proof` row includes `browser_entity_card_proof.ok=true`.

Until then, the remaining state is normal background cleanup, not launch closure.

## Good Prompt

Use this shape when re-opening the work with an agent:

```text
Goal: make the Robot Dojo data pipeline boring.

User value: after install/import, chat works quickly, memory improves in the background, and the user never has to understand embeddings, topics, queues, vectors, or recovery.

Do not optimize speed first. Optimize correctness, idempotence, observability, and recovery.

Required outcome:
1. Every stage has one owner, one writer, one durable handoff, and can be rerun safely.
2. Unknown data starts uncategorized/needs-routing, never Personal by default.
3. Topic moves preserve chunks, metadata, vectors, ANN/HNSW, topic context, and memory projections.
4. Embedding work never competes with foreground chat.
5. Retrieval degradation is visible, bounded, and automatically repaired.
6. Status only asks for human action when action is truly required.
7. Prove it end to end in the real product: import -> classify -> embed -> retrieve -> chat -> browser check.
```

## Bad Prompts

These prompts produce brittle local fixes:

- "Fix embeddings."
- "Parallelize the drain."
- "Move all Personal to uncategorized."
- "Make chat faster."

Use the boring-pipeline prompt instead: own the invariant that messy data becomes useful memory without user-visible breakage or silent corruption.
