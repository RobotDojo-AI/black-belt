# Data Pipeline Boring Contract

Robot Dojo's data pipeline is boring when a user can import messy personal data, chat soon after install, and trust that background work steadily turns raw records into useful memory without breaking chat, losing vectors, silently misrouting data, or requiring operator babysitting.

Speed is not the first optimization. The order is correctness, idempotence, observability, recovery, then throughput.

## User Value

A new user can drop in messy data and get useful chat quickly. The system may be degraded while catch-up work runs, but degradation is bounded, visible, and repaired by the pipeline. Background work must never make foreground chat feel broken.

## Throughput Posture

There are two different speed goals.

First-use speed is user-facing. A new install should prioritize recent, high-signal, and directly named data first, create bounded local evidence, and make chat useful before the full historical backfill is done.

The first-use readiness bar is not "all chunks are embedded." It is "after ingest and classification, a directly named item can reach chat through bounded local evidence while its chunk is still pending embedding." If this fails, fix the import, classification, local search, entity-card, or chat-context path; do not hide the gap by making the historical backfill lane bigger.

Historical-backfill speed is operational. It drains at the safest intensity that preserves one effective writer, foreground-chat priority, source/vector consistency, and durable handoff. A raw embedding throughput benchmark is not a launch metric if it causes chat stalls, vector races, or silent retrieval degradation.

Acceleration is allowed only when status asks for it or when the explicit foreground and memory gates prove it is safe. If `status_action.kind=wait` and `memory_headroom.can_add_lane_by_rss=false`, adding lanes is forbidden even when the ETA feels too slow. A steady falling trend plus a wait action means the drain is healthy; impatience is not an operator signal.

## Architecture Contract

### DP-1: Single owner, single writer, durable handoff

Every pipeline stage has exactly one active owner, exactly one write authority, a durable result file or status row, and rerun-safe behavior. A stage may retry, resume, or no-op, but it must not depend on an operator remembering where it stopped.

Proof surfaces:
- `scripts/qa/boring-data-pipeline-audit.js`
- `scripts/migration/run-embedding-drain-guarded.mjs`
- `scripts/migration/run-post-embedding-drain-pipeline.mjs`
- `scripts/qa/data-pipeline-status.js`
- `tests/data-pipeline-boring-audit.test.js`
- `tests/drain-personal-embeddings-contract.test.js`
- `tests/data-pipeline-status-contract.test.js`
- `tests/migration.test.js`

### Stage Ownership Ledger

The status step id is the ownership boundary. A stage is boring only if this table stays true.

| Status step | Owner | Write authority | Durable proof / handoff | Rerun rule |
| --- | --- | --- | --- | --- |
| `drain_personal_backlog` | Guarded embedding-drain wrapper | `scripts/migration/drain-personal-embeddings.mjs` | drain hold, guarded log, `embedding-drain-handoff.json` at zero | Resume the guarded drain; never start a second embedding writer |
| `post_drain_writer_quiescence` | Post-drain watcher | `scripts/migration/run-post-embedding-drain-pipeline.mjs` | `post-embedding-drain-pipeline.json` writer-hold and quiescence checks | Re-run watcher from status; do not manually acquire competing holds |
| `backup_slot_clearance` | Post-drain watcher | Backup slot checks inside `scripts/migration/run-post-embedding-drain-pipeline.mjs` | status `preflight_backup_slot` and `backup_slot` evidence | Wait or rerun watcher; do not launch backup directly |
| `post_drain_preflight` | Post-drain watcher | `scripts/qa/post-drain-preflight.js` | `post-drain-preflight.json` command, dependency, projection, and ANN-source checks | Re-run strict preflight at zero backlog |
| `backup_live_dbs` | Post-drain watcher | `scripts/backup-dispatcher.js` through the watcher | `post-drain-gcs-backup-result.json` strict clone snapshot evidence | Re-run only after writer quiescence and slot clearance |
| `reclassify_chunks` | Post-drain watcher | `scripts/ingest/05-reclassify-chunks.js` | `post-drain-reclassify-result.json` | Resume sliced reclassification through watcher; no manual `chunks.topic` update |
| `split_vector_repair` | Post-drain watcher | `scripts/migration/repair-split-vec-orphans.mjs` and `scripts/qa/check-vec-orphans.js` | `post-drain-split-vector-repair-result.json` and `post-drain-vec-orphan-check.json` | Re-run repair and parity check together |
| `source_topic_metadata_repair` | Post-drain watcher | `scripts/repair-source-topic-metadata.js` | `post-drain-source-topic-metadata-repair.json` | Re-run after reclassification and vector repair |
| `topic_context_regen` | Post-drain watcher | `scripts/maintenance-phases.js` topic-context phase | watcher step history and regenerated topic context files | Re-run only after source quiescence and zero backlog |
| `global_ann_rebuild` | Post-drain watcher | `scripts/build-global-hnsw.js` | `post-drain-global-hnsw-result.json` and status retrieval sentinel | Re-run rebuild until ANN source projection is clean |
| `memory_routing_repair` | Post-drain watcher | `scripts/repair-memory-routing.js` | `post-drain-memory-routing-repair-result.json` | Re-run before memory refocus |
| `memory_refocus` | Post-drain watcher | `scripts/refocus-memory-routing.js` | `post-drain-memory-refocus-result.json` | Resume sliced refocus until below threshold |
| `memory_recalc` | Post-drain watcher | `scripts/memory-recalc.js` | `post-drain-memory-recalc-result.json` | Re-run globally after memory routing/refocus changes |
| `post_memory_topic_context_regen` | Post-drain watcher | `scripts/maintenance-phases.js` post-memory topic-context phase | watcher step history and regenerated topic context files | Re-run only after memory recalc |
| `routing_residue_audit` | Post-drain watcher | `scripts/qa/routing-residue-audit.js` | `post-drain-routing-residue-audit.json` | Fix first blocker, then rerun strict status |
| `final_writer_release_and_backlog` | Post-drain watcher | `scripts/migration/run-post-embedding-drain-pipeline.mjs` | writer-hold release, final backlog, and post-proof quiescence checks | Release only after final proof and verify backlog remains zero |
| `final_product_proof` | Post-drain watcher | `scripts/qa/launch-stoplight.js` row-mode proof | durable launch-stoplight snapshot with required green rows, data-plane boundary payload, and browser entity-card payload | Re-run row-mode proof; do not close without `close_goal` |

### DP-2: Unknown data never defaults to Personal

Unknown, ambiguous, import-container, or weakly classified data starts in `uncategorized` or `needs-routing`. `personal` is a meaningful topic, not a catch-all. Moving records out of an unresolved state requires evidence.

Proof surfaces:
- `lib/topic-routing-policy.js`
- `lib/migrations/104_uncategorized_needs_routing.sql`
- `scripts/repair-memory-routing.js`
- `scripts/ingest/05-reclassify-chunks.js`
- `scripts/qa/routing-residue-audit.js`
- `tests/topic-routing-policy.test.js`
- `tests/reclassify-launch-contract.test.js`
- `tests/routing-residue-audit.test.js`

### DP-3: Topic movement preserves retrieval

Moving a chunk's topic means preserving the whole retrieval graph: chunk row, source metadata, vector table row, ANN/HNSW rebuild state, topic context, and memory projection. Manual `chunks.topic` updates are forbidden because they split the graph.

Proof surfaces:
- `scripts/ingest/05-reclassify-chunks.js`
- `scripts/migration/repair-split-vec-orphans.mjs`
- `scripts/qa/check-vec-orphans.js`
- `scripts/repair-source-topic-metadata.js`
- `scripts/build-global-hnsw.js`
- `tests/topic-lifecycle-vector-parity.test.js`
- `tests/source-topic-metadata-repair.test.js`
- `tests/ann/global-index-launch-contract.test.js`

### DP-4: Background embeddings yield to chat

Embedding work is opportunistic. It pauses, throttles, self-stops, or resumes instead of competing with foreground chat. A yielded drain is healthy when the owner process and hold are alive.

Proof surfaces:
- `scripts/migration/drain-personal-embeddings.mjs`
- `scripts/chunk-embed-daemon.mjs`
- `lib/rag/work-order.js`
- `lib/rag/embed.js`
- `lib/rag/lane-pool.js`
- `lib/request-observer.js`
- `scripts/qa/data-pipeline-status.js`
- `tests/drain-personal-embeddings-contract.test.js`
- `tests/embed-value-order.test.js`
- `tests/embed-value-rank.test.js`
- `tests/embed-batch.test.js`
- `tests/sync-foreground-yield-contract.test.js`
- `tests/data-pipeline-status-contract.test.js`

### DP-5: Degraded retrieval is visible and repaired

Chat may use bounded fallback while vectors or ANN artifacts are unavailable, but it must record the degraded state and the post-drain chain must rebuild the missing retrieval layer. Silent success is a bug.

Operator proof must show why degraded retrieval is bounded during active drain: ANN state, vector projection mode, whether stale vector counts were skipped for active-drain speed, source projection lag, whether lag is within the allowed active-drain window, and missing/malformed vector counts. A bare `global_ann_ready=false` is not enough evidence.

Source-bound chat must distinguish "full document/vector retrieval was unavailable" from "no local evidence exists." Bounded local entity and memory context is valid evidence for the facts it directly states: entity existence, identifiers, relationship tier, interaction counts, recency, and generated entity summaries. It is not evidence for deeper message/document details that are not in the bounded context.

Proof surfaces:
- `lib/chat.js`
- `lib/chat-context.js`
- `lib/rag/retrieve.js`
- `scripts/qa/data-pipeline-status.js`
- `scripts/qa/launch-stoplight.js`
- `scripts/migration/run-post-embedding-drain-pipeline.mjs`
- `tests/ann/global-index-launch-contract.test.js`
- `tests/chat/basic-chat-context-orchestration.test.js`
- `tests/chat/do-no-harm.test.js`
- `tests/routing-fallback-guard.test.js`

### DP-6: Status asks for action only when action is real

Expected in-progress states are informational. Operator action is required only for blockers or warnings with an actual intervention. A healthy drain should produce a wait cadence, not an endless inspect loop.

During a one-lane drain, zero child lane processes can still be healthy when the guarded worker is the sole live in-process writer. Status must classify that as effective capacity when the hold owner is alive and the run is moving, yielding to foreground chat, or inside a bounded warmup window. Child-lane count alone is not operator-action evidence.

Compact status JSON must expose `memory_headroom` directly: system pressure, available memory, drain RSS ceiling, drain RSS headroom, projected RSS with one more lane, and the lane recommendation. Operators and agents should not scrape prose to decide whether memory is narrow.

`memory_headroom` must separate memory health from process visibility. During bounded guarded respawn, memory evidence can remain usable while the drain process is briefly invisible; status must expose `drain_process_visible=false` and `respawn_grace=true` instead of implying memory pressure.

High compression is not a blocker by itself. When `memory_headroom.pressure=high_compression`, `memory_headroom.ok=true`, and `status_action.kind=wait`, status must keep the operator in wait mode and the audit must make clear that compression is why acceleration stays forbidden.

Compact status and audit output must expose `code_freshness` directly: drain wrapper, drain worker, resident embed daemon, embed daemon stale-file count, post-drain runner, and all-current state. Stale code is actionable only when the stale process is live and owned by the current stage; during bounded respawn or non-held states the operator rule still controls.

Compact status JSON must also expose live movement counters under `live_progress`: current pending count, current-run start pending, current-run completed from the DB, latest/in-pass rates, observed sample ETA, representative flag, and the reason ETA is not authoritative. Operators should trust movement plus `status_action` before treating a noisy ETA as a problem.

The audit must expose `drain_movement`: current live-progress state, ETA-unavailable reason, current-run completion count, hold-alive proof, effective writer mode, whether the longer trend is moving, wait-only state, `warmup_no_sample`, `stall_signal`, and reason. `fresh_no_progress` with `warmup_no_rate_sample_yet`, a live hold, an effective writer, and `status_action.kind=wait` is a warmup/no-sample state, not a stall.

Compact status and audit output must expose a bounded `work_order_topics` head plus `work_order_ordering`. The queue proof is `priority_desc_email_share_asc_pending_asc`: higher-value topics first, email-heavy bulk later on ties, and smaller equal-priority backlogs first. "Most important first" must be a visible status fact, not an inference from the embedding daemon's code.

The audit must expose `speed_posture`: historical-repair mode, user speed goal, backfill speed goal, normal-user path, pending count, trend/sample rate, trend/sample ETA, `can_add_lane_by_rss`, whether the current state is wait-only, whether acceleration is explicitly allowed, and the reason. `user_speed_goal=fast_first_use`, `backfill_speed_goal=safe_historical_repair`, `normal_user_path=bounded_local_evidence_before_full_vector_backfill`, and `raw_throughput_launch_metric=false` keep raw embedding speed from masquerading as launch readiness. A long ETA is not an acceleration signal by itself; acceleration is allowed only when the operator rule explicitly permits a lane/throughput action.

Compact status JSON must expose a read-only `trend` computed from bounded status history, durable launch-stoplight progress snapshots, and the current live count. Trend answers whether pending has fallen over the requested monitoring window; if that window has too few samples, status may use the last known progress point but must mark `basis=extended_last_known_progress`. Zero-pending trend samples are trusted only when they are terminal or completion-backed; a failed zero followed by a quick large rebound is filtered as implausible history. Trend ETA must expose `representative` and `representative_reason` so a tiny early window cannot look authoritative. Trend is not an acceleration trigger unless `status_action` also asks for action.

Post-drain preflight can produce active-drain projection gaps while the writer is still adding vectors and memory evidence. ANN-source vector races and memory-refocus projections that are only stale because the drain is active must stay visible as expected wait-state warnings. They become blockers only after zero backlog or when live residue exceeds launch thresholds.

ETA reporting has three tiers. `effective_eta` is authoritative only when the live drain sample is representative or the stoplight ETA is fresh. `non_authoritative_sample_*` is allowed during a small in-pass sample so the operator can see the current slope without treating it as a promise or action trigger. `trend` is longer-horizon orientation from historical snapshots and current pending count; it can explain a steady drain but cannot by itself demand retuning, and its ETA remains non-authoritative until `representative=true`.

The audit must expose warning details in text mode: total warning count, whether all warnings are expected while draining, whether operator action is required, action names, and warning codes. A warning with `expected_while_draining=true` and `operator_action_required=false` is not an inspect instruction.

The audit must expose post-drain watcher readiness while draining: watcher status/freshness, strict preflight state, ANN-source lag/within-lag, and memory refocus after/threshold. A red preflight during active drain is acceptable only when the line shows it is deferred evidence the watcher will rerun at zero backlog. If readiness was captured under an older drain hold, warning code `post_drain_readiness_stale_hold_snapshot` with action `trust_live_hold` means the current live hold is authoritative and the operator should still wait. If ANN-source lag exceeds the active-drain window, warning code `post_drain_ann_source_lag_active_drain` with action `wait_for_zero_backlog_strict_preflight` means the strict preflight will rerun at zero backlog; `ann_within_lag=false` is not permission to rebuild ANN during active embedding writes.

Proof surfaces:
- `scripts/qa/boring-data-pipeline-audit.js`
- `scripts/qa/data-pipeline-status.js`
- `tests/data-pipeline-boring-audit.test.js`
- `tests/data-pipeline-status-contract.test.js`

### DP-7: Final proof is end-to-end

Completion requires product proof across the whole chain: import -> classify -> embed -> retrieve -> chat answer -> browser/product check. A green unit test is not enough for launch completion.

The data-plane proof must exercise the import boundary, not only pre-seeded chat rows. It writes a synthetic ambiguous import, routes it through `drop-folder processOne -> classifyFile -> routeGeneric -> drop_folder_files`, and proves unknown data starts uncategorized/not Personal with `unknown_started_uncategorized` plus `unknown_not_personal` before any final proof can count. The required live boundaries are `db`, `passive_jobs`, `import_classification`, `raw_source`, `search`, `embedding`, `first_use_context`, `semantic_retrieval`, `entity_enrichment`, and `chat_context`.

The final product proof must store the data-plane boundary payload, not only the row status. The post-drain runner must persist `data_plane_proof` and `data_plane_proof_verdict`, and completion is blocked unless the durable verdict shows no missing boundaries, no non-green boundaries, `import_classification=true`, and `first_use_context=true`.

The `first_use_context` boundary proves the launch value separate from full historical backfill: a freshly written proof chunk remains pending for embeddings, but bounded local context still reaches chat through the product context path. If pending local rows cannot enter chat context before vector/ANN catch-up finishes, the data plane is not launch-good even if the eventual semantic proof would pass later.

During active embedding drain, launch stoplight rows may be green for "safe to wait" when exact ANN/data-plane proof is deferred by the drain hold. Those rows do not count as DP-7 completion evidence. Final proof can count only after row evidence has no `active_drain_block`, no `blocked_by_active_embedding_drain`, and no exact-proof-deferred marker.

The browser product proof must include a seeded source-bound local entity-card turn, not only a generic visible assistant answer. It must cover "is X in my entity network?", direct "find X in my entity network", and negative-premise "why isn't X in my entity network?" language. This catches the failure where degraded retrieval or a slow entity lookup makes chat say there is no evidence for a person/company/place that exists in the local network.

The final product proof must also prove the foreground app process is running current chat/runtime code. `local_readiness` is not green merely because `/api/server-health` answered; it must compare the live app process start time against the proof-critical files for chat, entity cards, admin data-plane proof, and the browser spec. A stale desktop process is a red proof row, because source-fixed/browser-stale is a launch failure.

The final `browser_product_proof` row must carry durable `browser_entity_card_proof` evidence. A generic green browser row is not enough: the stored proof must show the browser spec list included `scripts/qa/tests/chat-browser-real-turn.spec.js`, the Playwright result passed, and the spec contract contained the seeded local entity-card test name, source-bound seed marker, network-existence question, direct-find question, negative-premise wording, and expected local-network answer.

Proof surfaces:
- `scripts/qa/launch-stoplight.js`
- `scripts/migration/run-post-embedding-drain-pipeline.mjs`
- `scripts/qa/data-pipeline-status.js`
- `launch-stoplight` row `browser_product_proof`
- `scripts/qa/live-data-plane-proof.js`
- `lib/data-plane-proof.js` required boundaries `REQUIRED_DATA_PLANE_BOUNDARIES`, `import_classification`, `unknown_started_uncategorized`, `unknown_not_personal`
- `scripts/qa/tests/first-session-launch.spec.js`
- `scripts/qa/tests/chat-browser-real-turn.spec.js`
- `scripts/qa/tests/chat-path-matrix.spec.js`
- `tests/live-data-plane-proof-cli.test.js`
- `tests/browser-warm-launch-contract.test.js`
- `tests/data-pipeline-status-contract.test.js`

## Failure-Mode Matrix

| Failure mode | User impact | Detection | Required recovery |
| --- | --- | --- | --- |
| Two writers embed or mutate routing at once | Chat slows, vectors race, state becomes hard to trust | Pause-hold owner, launchd wrapper, post-drain lock, status blocker | Stop the extra writer; resume through the owned stage |
| Unknown data falls into `personal` | User sees polluted Personal context and weak chat memory | Routing residue audit, topic-routing tests, reclassify fallback checks | Repair metadata/links, then reclassify through pipeline-owned movement |
| Manual topic update splits chunk/vector/context state | Retrieval misses or returns stale context | Vector parity audit, split-vector orphan repair, source-topic metadata repair | Rebuild through reclassify + split-vector repair + context regen |
| Embeddings compete with chat | First chat feels slow or broken | Foreground activity signal, drain yield status, TTFT tests | Yield, throttle, or self-stop; never add lanes while foreground is active |
| ANN/vector artifacts are missing | Retrieval quality degrades | Status `global_ann` state, launch stoplight retrieval sentinel | Mark degraded, use bounded fallback, rebuild ANN post-drain |
| Detached ANN rebuild starts during active drain | Chat and inline entity recognition stall while HNSW reads the live DB beside the embedding writer | ANN spawn decision returns `embedding_backlog_pending:*`, active-drain status keeps `global_ann` degraded, and `tests/ann/global-index-freshness.test.js` covers pending-backlog deferral | Defer detached ANN repair while embeddings remain pending; let bounded fallback serve chat and let the post-drain owner rebuild HNSW after source quiescence |
| Active-drain stale-vector audit is mistaken for missing proof | Operator runs vector repair while embeddings are still writing | `stale_vectors_skipped=true`, warning code `active_drain_vector_audit_deferred`, and post-drain vector parity checks | Treat skipped stale-vector count as deferred audit evidence; run full vector audit only after source quiescence |
| Source-bound chat ignores local entity evidence during degraded retrieval | User asks "use my data", "find X in my entity network", or "why isn't X in my entity network?" and receives a false no-evidence answer for a known person/company/place | Source-bound chat orchestration tests, do-no-harm entity-network regression, and browser local entity-card proof | Inject bounded local entity/memory evidence for directly stated entity facts while keeping unavailable document/vector details explicit |
| Status treats expected drain states as emergencies | Operator babysitting and wasted build resources | Structured warning details and `status_action` | Reclassify expected states as info; preserve blockers for real intervention |
| Concurrent boot records the same SQL migration twice | Status and launch checks fail on a migration-ledger uniqueness error while the data itself is healthy | `tests/migration.test.js` concurrent file-DB boot proof and DB-health ledger readability | Acquire the migration writer slot, re-check the ledger inside the transaction, and record idempotently |
| Concurrent boot hits a SQLite lock before migration ownership exists | A healthy install or status probe can fail before it reaches the durable ledger, making the operator think the pipeline is broken | `tests/migration.test.js` initial WAL-pragma lock proof | Open the DB with the configured timeout and retry boot PRAGMAs through bounded `SQLITE_BUSY` windows before running migrations |
| Live status probe times out before JSON | A healthy drain is reported as unknown or broken because SQLite writer contention delayed the probe | `qa:data-pipeline` fallback marker `latest_summary_json_after_primary_status_failure`, fresh status snapshot, and `tests/data-pipeline-boring-audit.test.js` timeout regression | Use the fresh `--latest-summary-json` snapshot only when the primary probe produced no JSON. Mixed stdout or red JSON is not eligible for this fallback |
| Guarded drain respawn or warmup is misread as zero capacity | Operator restarts a healthy writer or starts a competing writer | Effective capacity mode, live hold owner, bounded warmup, sole-writer process evidence, and audit `drain_movement.stall_signal=false` | Wait when effective mode is `single_in_process_writer`; inspect only after the bounded warmup/progress proof fails |
| Code freshness drift is hidden during active drain | Operator cannot tell whether changed files require a restart or are harmless until the next owned process starts | `code_freshness`, live hold state, process ownership, and status blockers for stale live processes | Show the drift in audit output; restart only when status reports a stale live owned process as a blocker |
| Stale launch stoplight is treated as live drain truth | Operator refreshes proof, retunes, or starts work from old evidence while the writer is active | Warning code `stoplight_stale_active_drain` and action `use_live_drain_status` | Treat stale stoplight as active-drain info; trust live drain status until zero backlog |
| Stale post-drain readiness snapshot is treated as watcher failure | Operator restarts the watcher or runs post-drain repair while the current drain hold is healthy | Warning code `post_drain_readiness_stale_hold_snapshot` and action `trust_live_hold` | Trust the live drain hold; readiness snapshots are re-evaluated at zero backlog |
| Active-drain ANN-source lag is treated as post-drain failure | Operator rebuilds ANN while embeddings are still writing because `ann_within_lag=false` looks red | Warning code `post_drain_ann_source_lag_active_drain`, action `wait_for_zero_backlog_strict_preflight`, and wait-only status | Wait for zero backlog; the watcher reruns strict preflight and owns ANN rebuild after source quiescence |
| Disk floor is ignored or repaired unsafely | Drain churns, chat/OS stability degrades, or the only recovery copy is deleted | Status blocker `disk_free_below_floor` with operator action `free_disk_space` | Free cache/generated artifacts first; never delete live DB/WAL/vector files or an unverified local backup |
| Active-drain preflight projection is treated as post-drain truth | Operator reruns repairs or edits data while the writer is still changing evidence | Warning detail codes for active ANN-source race and memory-refocus projection | Keep it as wait-state until zero backlog; rerun strict preflight after the writer is quiet |
| Memory-refocus projection is treated as live residue | Operator edits memory links while the projection is explicitly post-drain-only | `memory_after`/`memory_threshold`, live needs-routing memory count, and warning code `post_drain_memory_refocus_projection_active_drain` | Wait for zero backlog; let the watcher rerun strict preflight and own memory refocus |
| Small live ETA sample is treated as authoritative | Operator retunes a healthy drain based on noisy early-pass math | `effective_eta.authoritative_eta_source` versus `non_authoritative_sample_*` fields | Use sample ETA for orientation only; action comes from representative ETA, blockers, or explicit status action |
| Speed frustration causes unsafe lane retuning | Chat slows, memory pressure rises, or a second writer races the drain because raw embedding throughput became the target | `status_action.kind`, `memory_headroom.can_add_lane_by_rss`, foreground signal, and falling `trend` | Keep the current intensity when status says wait; improve future first-use prioritization rather than accelerating a live historical repair |
| High memory compression is mistaken for a failure | Operator restarts or retunes a healthy drain while the OS is compressed but status is still green | `memory_headroom.pressure`, `memory_headroom.ok`, `can_add_lane_by_rss`, and wait-only `speed_posture` | Treat high compression as caution; wait unless status asks for a concrete intervention |
| First-use context waits for full vector backfill | New users import data but chat feels empty until the historical queue finishes | `first_use_context` boundary with a pending proof chunk, FTS/search proof, and product context proof | Feed bounded local search/entity/memory evidence into chat immediately; keep full vector/ANN proof as the final intelligence ceiling |
| False zero-pending trend sample is treated as completion | Operator closes the goal or starts post-drain work while live backlog still exists | Trend zero-rebound filter, live DB pending count, completion candidate backlog check | Filter implausible zero bridges; trust live DB and `status_action`, then rerun strict status at cadence |
| Post-drain handoff is stale or replayed | Backup/reclassify chain runs on wrong state | Handoff freshness, launchd clearance, watcher lock, step history | Reject stale handoff; rerun guarded drain or watcher from durable state |
| Backup runs after mutation or without clone snapshots | Recovery point is untrustworthy | Post-drain ordered step history, backup evidence checks | Block mutation until strict clone DB backup passes |
| CLI-only proof is treated as product proof | Launch confidence is false because the browser/login/chat path was never exercised | Required `browser_product_proof` row and real browser specs | Run the post-drain row-mode product proof; CLI tests are contract evidence only |
| Final proof skips import classification | Browser chat passes, but messy imports can still default to Personal or bypass source indexing | Durable `data_plane_proof` and `data_plane_proof_verdict`, `REQUIRED_DATA_PLANE_BOUNDARIES`, `import_classification`, `unknown_started_uncategorized`, `unknown_not_personal`, and the drop-folder classification path evidence | Block completion until live data-plane proof shows ambiguous imports start uncategorized/not Personal and raw source, search, embedding, semantic retrieval, entity enrichment, and chat context boundaries are green |
| Active-drain exact proof deferral is counted as final proof | DP-7 closes while ANN/data-plane proof was explicitly skipped because the embedding drain was active | Final audit rejects green final product rows containing `active_drain_block`, `blocked_by_active_embedding_drain`, or exact-proof-deferred markers | Keep status in wait/monitor; rerun final product proof after zero backlog and source quiescence |
| Generic browser proof is counted as entity-card proof | DP-7 closes even though chat never proved it can answer source-bound entity-network questions from local evidence | Durable `browser_entity_card_proof` evidence on the `browser_product_proof` row | Re-run the browser product proof until the seeded local entity-card turn passes and the final row stores the marker evidence |
| Final proof is narrow | System looks green but product flow or source-bound entity chat fails | Launch stoplight row-mode proof, browser specs, data-plane boundary proof, and seeded local entity-card turn | Rerun full product proof after repair chain completes |

## Launch/Post-Drain Runbook

Operator-facing runbook: `docs/data-pipeline-launch-runbook.md`

1. During active drain, use:
   `npm run qa:data-pipeline`

2. For a raw status refresh, use:
   `node scripts/qa/data-pipeline-status.js --summary-json --respect-cadence --strict`

   If the audit's primary status subprocess times out before emitting any JSON, it may fall back to `--latest-summary-json` only when the cached snapshot is fresh and was produced by current status code. This fallback must be visible as `fallback_used=true` and `fallback_source=latest_summary_json_after_primary_status_failure`. Mixed stdout or red JSON is not eligible for this fallback.

3. Human and automation loops must obey the audit's structured `operator_rule` before doing anything else. `operator_rule.action=wait` means no intervention; its `forbidden_actions` list is binding.

   When action is required, audit output must expose the full operator envelope: allowed actions, deferred actions, suppressed unsafe actions, and forbidden actions. The first allowed action is the only action to take before rerunning strict status.

   Audit text must print `dp7_steps` with launch-contract status, counts, next step, pending step IDs, and blocked step IDs. Post-drain progress is not operator-visible if the owner has to open raw JSON to see which stage is pending.

4. JSON status modes must emit machine-readable JSON on stdout. Human chatter, boot notices, and incidental diagnostics belong on stderr or in text mode so automation never has to guess where the payload starts.

   Compact status JSON must expose `memory_headroom` directly, including system pressure, available memory, drain RSS headroom, projected RSS with one more lane, and the current lane recommendation.

   If the drain is in bounded respawn grace, `memory_headroom` may be healthy while `drain_process_visible=false`; the grace fields explain why this is still wait-only.

   If `memory_headroom.pressure=high_compression` while `memory_headroom.ok=true`, treat it as a conservative throughput signal. It does not override the operator rule or authorize a lane change.

   Compact status JSON must expose `live_progress` and `trend` directly so a steady long drain reads as moving even when the point ETA is noisy or not yet representative. The trend history is bounded runtime evidence; it must not grow without limit or become a disk-pressure source.

5. If status says `kind=wait`, do not inspect logs, restart services, retune lanes, start a second writer, or edit data/topics. The pipeline is healthy and the next check time is authoritative.

   If status reports zero child lanes but effective mode `single_in_process_writer`, treat the drain as healthy. The guarded worker is embedding in-process or warming up under the sole writer hold; do not restart it unless status changes to an actionable warning or blocker.

   If status reports active-drain ANN-source or memory-refocus preflight projections, treat them as wait-state warnings when `operator_action_required=false`. The writer is still changing the evidence; strict preflight reruns at zero backlog.

   If status reports `stoplight_stale_active_drain`, treat the stale launch stoplight as informational. Live drain status is authoritative until zero backlog; do not refresh stoplight proof, retune lanes, or start post-drain work from old evidence.

   If retrieval shows `stale_vectors_skipped=true` while status says wait, treat it as deferred audit evidence. The active drain uses a shape-only vector projection for speed; full stale-vector audit and repair belong after source quiescence.

   If `post_drain.memory_refocus_projection.after` is above threshold while live needs-routing memory is within threshold and status says wait, treat it as post-drain-only projection evidence. Do not edit memory links manually; the watcher reruns strict preflight and owns memory refocus after zero backlog.

   Source-bound chat can still answer from bounded local entity and memory context while vector/ANN retrieval is degraded. That context is evidence for facts it directly states: entity existence, identifiers, relationship tier, interaction counts, recency, and generated entity summaries. If the user asks for deeper message/document details not present in that bounded context, the answer must say document/vector retrieval did not return that detail yet.

   Detached ANN/HNSW repair must not start while embeddings remain pending. If the ANN artifact is missing during active drain, chat uses bounded fallback and status stays degraded; the post-drain watcher owns the full rebuild after source quiescence.

   If status reports `non_authoritative_sample_*` ETA fields, use them only as a live slope. Do not retune, restart, or escalate unless `status_action` asks for it or `effective_eta.authoritative_eta_source` is present and crosses the configured threshold.

   If status reports `trend`, use it only as orientation over the historical window. A falling trend explains progress; it does not authorize acceleration without `status_action`. A zero-pending point does not mean complete unless it is terminal or completion-backed; failed zeros that quickly rebound are status noise.

6. If status says `kind=watch` with `watch_post_drain_watcher_start` or `kind=monitor` with `monitor_post_drain_step`, observe the named post-drain step only. Do not manually start backup, reclassification, context regeneration, ANN rebuild, or final proof; the watcher owns the sequence.

7. If status says `kind=inspect_warning`, inspect only the named warning action. Do not start a second embedding writer, edit data/topics, or repair unrelated services. Confirm the current hold and launchd wrapper before any cleanup.

8. If status says `kind=fix_blocker`, fix the first blocker only. Re-run strict status afterward. Do not proceed to backup, reclassify, context regeneration, ANN rebuild, start another writer, or edit data/topics while any blocker remains.

   If the first blocker is `free_disk_space`, reclaim cache, generated, or other non-live artifacts first. Do not delete live DB files, live WAL files, vector stores, or the only local backup unless a verified cloud or alternate backup for that exact data exists. If later blocker actions include restarting the embedding drain or wrapper, treat them as deferred: free disk, rerun strict status, then follow the refreshed first action only if it still appears.

9. When pending embeddings reach zero, the guarded drain writes `embedding-drain-handoff.json` and clears its temporary launchd label. The post-drain watcher consumes that handoff.

10. The post-drain watcher must complete in order: writer quiescence, backup slot clearance, strict backup, chunk reclassification, split-vector repair, source-topic metadata repair, topic context regeneration, global ANN rebuild, memory routing repair, memory refocus, memory recalc, post-memory context regeneration, routing residue audit, final writer release, and final product proof.

   CLI tests are contract evidence only; they never replace the post-drain browser/login/chat product proof.

   The final product proof must store the live `data_plane_proof` payload and `data_plane_proof_verdict`. A green `data_pipeline_invariants` row without the boundary payload is not close evidence.

   Browser chat proof must include the seeded source-bound local entity-card turn, not only a generic visible answer.

   The `browser_product_proof` row must store `browser_entity_card_proof` evidence; a green row without that marker is rejected by status and audit. The seeded turn set must cover network-existence, direct-find, and negative-premise wording so "why isn't X in my entity network?" cannot become a false absence claim for an entity that exists locally.

11. Completion is valid only when `npm run qa:data-pipeline:complete` exits 0 and `data-pipeline-status.js --summary-json --strict` reports `complete=true`, `ok=true`, all required live backlog counters present and zero, `status_action.kind=close_goal`, launch-contract `ok=true`, green `final_writer_release_and_backlog`, and a green `final_product_proof` row set containing `local_readiness`, `login_session`, `private_chat`, `chat_open_daemon_quiet`, `chat_stall_recovery`, `browser_product_proof`, `foreground_activity_signal`, `data_pipeline_invariants`, and `retrieval_sentinel`.

   Audit text must print `dp7_backlog` before the close bar, with `zero`, `missing`, `invalid`, `nonzero`, and every required live counter value. `backlog_zero=false` without named counters is not sufficient operator evidence.

   The audit `dp7_backlog` line reports `zero=true`, `missing=none`, `invalid=none`, and `nonzero=none` only when completion is eligible to continue to the product-proof and close-goal checks.

   The audit `dp7_product_proof` line must report `data_plane=true`, `data_plane_missing=none`, `data_plane_non_green=none`, `import_classification=true`, `first_use_context=true`, `data_plane_verdict=true`, `data_plane_verdict_missing=none`, `data_plane_verdict_non_green=none`, `import_classification_verdict=true`, and `first_use_context_verdict=true`. A green product row without visible live data-plane boundary evidence and a stored passing verdict is not sufficient close evidence.

   The final product proof stores `data_plane_proof` and `data_plane_proof_verdict`.

   Browser chat proof includes the seeded source-bound local entity-card turn.

   The browser proof covers network-existence, direct-find, and negative-premise wording.

   The final durable `browser_product_proof` row carries `browser_entity_card_proof.ok=true`.

12. Completion audits have no skip path. `--require-complete` must not be combined with `--skip-contract-tests`; final closure has to rerun the contract, invariant, DP-7 safe, status, and product-proof gates.

13. `--skip-contract-tests` is fixture-only. It is never valid operator proof; strict audits with skipped checks must report attention required and mark invariants not proved.

## Automated Proof Map

| Invariant | Primary automated checks |
| --- | --- |
| DP-1 | `node --test tests/drain-personal-embeddings-contract.test.js tests/data-pipeline-status-contract.test.js tests/migration.test.js` |
| DP-2 | `node --test tests/topic-routing-policy.test.js tests/reclassify-launch-contract.test.js tests/routing-residue-audit.test.js` |
| DP-3 | `node --test tests/topic-lifecycle-vector-parity.test.js tests/source-topic-metadata-repair.test.js tests/ann/global-index-launch-contract.test.js` |
| DP-4 | `node --test tests/drain-personal-embeddings-contract.test.js tests/embed-value-order.test.js tests/embed-value-rank.test.js tests/embed-batch.test.js tests/sync-foreground-yield-contract.test.js tests/data-pipeline-status-contract.test.js` |
| DP-5 | `node --test tests/ann/global-index-launch-contract.test.js tests/routing-fallback-guard.test.js tests/chat/basic-chat-context-orchestration.test.js tests/chat/do-no-harm.test.js` |
| DP-6 | `node --test tests/data-pipeline-status-contract.test.js` |
| DP-7 | Post-drain runner exact row command: `scripts/qa/launch-stoplight.js --row private_chat --row chat_open_daemon_quiet --row chat_stall_recovery --row browser_product_proof --row data_pipeline_invariants --row retrieval_sentinel`; those requested rows must dependency-expand to the expected green row set: `local_readiness`, `login_session`, `private_chat`, `chat_open_daemon_quiet`, `chat_stall_recovery`, `browser_product_proof`, `foreground_activity_signal`, `data_pipeline_invariants`, and `retrieval_sentinel`; browser row proof from `scripts/qa/tests/first-session-launch.spec.js`, `scripts/qa/tests/chat-browser-real-turn.spec.js`, and `scripts/qa/tests/chat-path-matrix.spec.js`; `scripts/qa/tests/chat-browser-real-turn.spec.js` must include a seeded source-bound local entity-card turn, not only a generic visible answer; final `browser_product_proof` row evidence must include `browser_entity_card_proof.ok=true`; live data-plane proof from `lib/data-plane-proof.js` must require `REQUIRED_DATA_PLANE_BOUNDARIES` covering `db`, `passive_jobs`, `import_classification`, `raw_source`, `search`, `embedding`, `first_use_context`, `semantic_retrieval`, `entity_enrichment`, and `chat_context`, `first_use_context` must prove pending local rows reach chat before vector backfill, and `import_classification` must prove `unknown_started_uncategorized`, `unknown_not_personal`, and `drop-folder processOne -> classifyFile -> routeGeneric -> drop_folder_files`; plus `node --test tests/data-plane-proof.test.js tests/specs/admin-data-plane-proof.test.js tests/live-data-plane-proof-cli.test.js tests/browser-warm-launch-contract.test.js tests/chat/entity-context-cards.test.js` |

One-command safe audit:
`npm run qa:data-pipeline`

That safe audit runs the contract checks and the DP-1 through DP-6 invariant groups above, then combines them with cadence-safe live status. It does not run final browser/product proof while the drain is still active. CLI tests are contract evidence only; they never replace the post-drain browser/login/chat product proof.

Completion audit:
`npm run qa:data-pipeline:complete`

## Remaining Risks Ranked By User Impact

1. **Post-drain final product proof has not completed on the live backlog yet.** Impact: launch confidence stays bounded until zero backlog triggers backup, reclassification, ANN rebuild, and browser/product proof. Retires when strict completion status reports `status_action.kind=close_goal`, `launch_contract.ok=true`, all required backlog counters are zero, and `npm run qa:data-pipeline:complete` exits 0.
2. **ANN is currently degraded during active drain.** Impact: chat can fall back safely, but retrieval quality is below the final ceiling until post-drain rebuild. Retires when status reports `retrieval.global_ann_ready=true`, clean source projection, no stale-vector blockers, and the final retrieval sentinel row is green.
3. **Long-tail embeddings are sensitive to memory pressure.** Impact: drain duration is choppy; guarded self-restarts are correct but can look like instability if status wording regresses. Retires when pending embeddings reach zero and the post-drain watcher consumes a fresh handoff without requiring a second writer, unsafe lane retune, or manual data edit.
4. **Semantic residue after reclassification is probabilistic.** Impact: `needs-routing` can be small and auditable, but only a resolution review plus product sampling can prove it is not hiding important memory. Retires when routing residue audit shows Personal contains only true personal-general material, needs-routing is below threshold with named unresolved residue, and memory refocus/recalc have regenerated projections.
5. **Browser/product proof depends on real installed state.** Impact: CLI tests can prove contracts, but final launch confidence still needs the real product path after the repair chain finishes. Retires when the durable `browser_product_proof` row stores real Playwright pass evidence, `browser_entity_card_proof.ok=true`, data-plane proof/verdict payloads are green, and no exact proof was deferred by active drain.

## Operator Rule

If the status surface says wait, wait. If it says watch or monitor, observe only the named post-drain step. If it says inspect, inspect only the named warning. If it says fix, fix only the first blocker. Any manual DB edit, second writer, skipped handoff, or manual post-drain shortcut makes the pipeline interesting again.

## Owner Prompt Pattern

Use outcome and invariant language, not subsystem-task language. The prompt should ask the agent to own the full user value and prove the chain, not to locally optimize embeddings, parallelization, topics, or chat speed.

Preferred prompt:

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

Deliver:
- architecture contract
- failure-mode matrix
- runbook
- automated invariant checks
- production/product proof
- ranked remaining risks
```

Avoid prompts framed as "fix embeddings", "parallelize the drain", "move Personal to uncategorized", or "make chat faster" unless they are nested under the boring-pipeline goal. Those prompts are valid local repairs, but they are not the product outcome.
