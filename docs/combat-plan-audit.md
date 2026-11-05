# Combat reliability plans: implementation audit

Date: 2026-11-02. Scope: the seven supplied discovery/implementation plans.

This report distinguishes implemented corrections from work that did not clear
the plans' evidence gates. It is not a Foundry v14.369 runtime certification.

## Baseline and evidence

- This directory contains module 0.6.0. Its manifest still declares Foundry
  minimum 14.363 and verified 14.365, and AoV minimum 14.4 and verified 14.5.
  Compatibility metadata was not raised without runtime evidence.
- `.git` is an empty directory. Git cannot identify a checkout SHA or report
  initial tracked modifications. The SHA in the supplied plans cannot be
  established for this copy. Original copies of every edited existing file
  were saved outside the module before edits; their SHA-256 hashes were saved.
- The available neighboring AoV source at `C:/dev/aov/aov-system` declares
  version 14.5. Its eight integration paths pass the repository's validator.
  This establishes source availability, not an active running world's version.
- No connected Foundry scene or multi-client v14.369 session was available.
  The official v14 reference retrieved during this work identifies itself as
  version 14.368 Stable. No v14.369-specific behavior is inferred from that.
- The current test runner is `tools/module-tool.mjs`; the old
  `tools/regression-tests.mjs` named in the plans is absent. Current `npm run ci`
  runs validation and contracts; it does not rebuild CSS.
- The linked conversation was read. Its assistant answers are returned as
  content-reference placeholders, so the supplied Markdown files and current
  local source provide the actionable details.

The initial syntax, validation and contract checks passed. Initial validation
skipped the optional AoV contract until `AOV_SYSTEM_PATH` was supplied.

## Decisions for the six adaptations

Plan 01 is the discovery gate represented by this report, rather than a seventh
feature. The following decisions cover plans 02 through 07.

| Topic | Observed gap and evidence | Severity / workflow | Narrow implementation | Prerequisites and verification | Rollback / decision |
| --- | --- | --- | --- | --- | --- |
| A. Combat writes | `applyMovementDexResults`, `buildResolutionQueue` and `refreshImmediateResolutionActions` saved state before a separate initiative write. A failed second write retained the new ledger and old initiative. | High: phase ranking and tracker consistency | Put each Combatant's state and changed initiative in the same embedded update; preserve the existing transaction helper, queue locks and initiative options. | Disposable failure fixtures and existing contracts pass. Native hook/turn behavior still needs live verification. | Restore `resolution-queue.mjs`. **GO for coalescing only**; no cross-document atomicity claim. |
| B. Action/target resolution | A duplicate socket envelope reported success before the first request settled; a split prompt completed on `show()`; legacy queued missile cancellation spent ammunition. | High: duplicated or misleading action outcomes, lost resources | Replay real request outcomes/errors; retain active requests until settled; reject changed data under the same request id; guard repeated local dialog submission; complete split prompts from saved cards; move legacy queued ammunition consumption after attack-options acceptance; reject missing exact target Tokens and invalid local access. | Cancellation, duplicate delivery, long-running request, failure and split-refresh fixtures pass. Persistent GM-side action identity and atomic resource/card commitment remain prerequisites for full exactly-once behavior. | Restore socket, dialogs, target queue and adapter together. **PARTIAL GO**; full cross-client exactly-once acceptance is not met. |
| C. Active Effects | Suppressed grapple holds matched as usable; cancelled deletion counted as success; inactive expired Evade effects were skipped; two independent impales on one Item overwrote the first source. | High: rules eligibility and effect provenance | Reuse `effectIsActive` for grapple eligibility, allow inactive owned effects to be found for cleanup/upsert, respect deletion outcomes, expire Evade from its own recorded round, and identify impales by committed damage message/card. | Disabled, suppressed, unrelated source, cancelled deletion, expiry and independent-impale fixtures pass. | Restore the four affected effect files. **GO for these defects**; broader lifecycle/ownership changes remain gated. |
| D. Combat context | Melee `_readFormState` fell back to an old weapon object after that embedded Item disappeared. | Medium: submitting stale equipment | Use the current owned Item lookup; disable and reject submission when the weapon is missing. | Actual form-state method is exercised with a deleted-weapon fixture. | Restore `attack-roll-dialog.mjs`. **GO for stale equipment only**; no rule timing or formula change. |
| E. Combat chat provenance | A split prompt lacked exact links to original and follow-up cards, making recovery after a failed prompt update ambiguous. | Medium: split-action recovery/debugging | Add primitive ids/UUIDs to existing module flags; write the follow-up source link at card creation; reconcile the prompt using exact source identity. | Multiple target Token ids, missing sources and failed prompt update/recovery fixtures pass. | Restore adapter, queue and both dialogs together. **GO for split provenance only**; native damage-message attribution is unchanged. |
| F. Level-aware forced movement | Knockback uses XY offsets; throw candidates are two-dimensional. Source inspection alone does not prove native collision/surface behavior in a configured v14.369 scene. | Potentially high, not reproduced in a live scene | No movement implementation or setting added. | Requires the actual scene fixtures and AoV policy described below. | **NO-GO / deferred**. Existing movement behavior and markers remain intact. |

## Reproductions against the original source

The saved original modules were loaded into a separate, disposable Node process
with document fixtures. Relative imports were redirected to the local module;
no live world or persistent actor data was used. Observed original outcomes:

| Controlled scenario | Original outcome | Corrected contract expectation |
| --- | --- | --- |
| Movement projection's second embedded update throws | Two writes; new ledger remained saved, initiative remained 20 | A single write contains both values; rejection propagates |
| ActiveEffect deletion returns `undefined` | `safeDeleteActiveEffect` returned `true` | Return `false` |
| Matching grapple is system-suppressed | Treated as a usable hold | Excluded from rules eligibility; retained for ownership lookup |
| Disabled Evade has reached its recorded expiry round | Not considered expired | Expire by recorded round, independently of temporary activity |
| Two damage cards impale the same location | One effect; only the second source survived | Two independent effects; repeating one card updates only its own effect |
| Split dialog merely opens | Source prompt marked resolved | Source remains pending until an attack card exists |
| Queued missile core attack options are cancelled | Ammunition quantity changed from 3 to 2 | Quantity remains 3 and the queue entry remains pending |
| Duplicate arrives while first socket operation is pending | Duplicate reported `accepted: true`; original later returned `accepted: false, cancelled: true` | Both deliveries reflect cancellation, with a duplicate marker on replay |

## Action ownership and remaining failure windows

The existing adapter's `started` result means it created an AoV combat card.
It does not mean the opposed attack roll or downstream damage has finished.
Split prompts now complete at that existing card-commit boundary, rather than
when a dialog opens. Defender prompting and later AoV resolution retain their
existing owners.

Current path: submitted AppV2 form -> socket facade's combat workflow helper ->
AoV adapter attack-options prompt -> combat card creation -> defender-owner
prompt -> GM-authoritative defense-card append -> existing reaction handling.
Knockback and grapple retain their specialized card and follow-up paths.

| Failure window | Current protection / limit |
| --- | --- |
| Same socket envelope delivered twice | Authorized requests share the actual pending operation; outcomes/errors are replayed. Request data comparison includes timestamps. Replays are marked duplicate so they cannot independently trigger reaction consumption. |
| Socket prompt lasts longer than 60 seconds | Active entries do not expire; the existing 60-second retention begins after settlement. This is a request cache, not persistent action history. |
| Same request id reused with changed action data | Rejected before a second execution. Each delivery is authenticated and authorized before replay. |
| Repeated clicks on the same open attack/missile dialog | An in-flight submission guard prevents a second local submission. The guard is always released on return or error. |
| Legacy queued missile cancelled before card creation | Uses the existing batch facade's post-prompt `beforeCreate`; no ammunition spend occurs on this cancellation path. |
| Legacy queue's exact Token was deleted | Rejects the entry before ammunition/workflow effects; it cannot silently substitute an Actor-only target. |
| Queue control used without local Actor ownership/message update permission | Rejected before resource/workflow work. This local check supplements native document permissions; it is not a new GM-side action-commit protocol. |
| Split dialog opens, closes or cancels | Opening does not complete the source prompt. |
| Split card commits but refreshing its prompt fails | The card already contains the exact source id. Later submission reconciles that link before starting another workflow. Historical resolved prompts remain resolved. |
| Two clients submit the same pending queue/split action simultaneously | **Still unresolved.** Different request ids and different app instances are not covered by the envelope cache or local guard. |
| Ammunition update succeeds, then native card creation/metadata attachment fails | **Still unresolved.** Main missile batches and legacy queues still have a resource/card failure boundary. No unsafe automatic refund or blind retry was introduced. |
| GM handover, disconnect, reload during an unrecorded commit | **Not validated.** In-memory request caches do not establish a durable claim. |

Full plan 03 needs a stable identity for source message plus target entry, a
persisted GM-authoritative claim, and a verified resource/card commit boundary.
Those are not represented as complete by this patch. A local mutex or the
current TTL cache must not be used as evidence of cross-client exactly-once
behavior.

## Effect ownership and rule context

| Effect family | Parent / source of truth | Existing lifecycle owner and this patch's boundary |
| --- | --- | --- |
| Engaged | Actor mirror with Combatant-keyed engagement records | `engagement-status.mjs` retains its Actor locks, deduplication and cleanup; unchanged |
| Disengaging | Actor mirror of Combatant disengagement | `disengagement.mjs`; unchanged |
| Evading | Actor, module `evade` metadata and recorded logical expiry round | `evade-status.mjs`; inactive effects still expire from their own metadata; unrelated combat ids are preserved |
| Reaction penalty | Actor, Combatant reaction count | `reaction-penalty-effects.mjs`; unchanged; shared-Actor/multiple-Combatant policy is not redesigned |
| Grappled / immobilized | Actor, existing source/target pair metadata | `grapple-automation.mjs`; activity and ownership lookup are distinguished within the existing matcher |
| Prone from knockback / stun | Actor, specialized status metadata | Existing knockback/stun paths remain unchanged; shared deletion-result handling is corrected |
| Impaled | Hit-location or equipment Item, damage message and card index | `damage-effect-tracking.mjs`; independent committed sources are preserved |
| Injury threshold | Hit-location Item, threshold severity | Existing severity reconciliation remains unchanged |

Suppression is treated as ineligibility for application, not general permission
to delete effects. Deletion helpers respect the documented undefined result
when no deletion occurred. These distinctions follow the official
[v14 ActiveEffect reference](https://foundryvtt.com/api/v14/classes/foundry.documents.ActiveEffect.html).

| Rule/input | Observed evaluation path | Decision |
| --- | --- | --- |
| Prone / immobilized | Shared kernel reads participant effects in dialog form-state preparation; serialized context is consumed by the adapter | Preserve current timing and formulas |
| Aimed location / equipment | Per-target form choices become attack-scoped payload data | Preserve choices and Item identities |
| Mounted caps / missile range / shooting into melee | Existing form-state calculations and adapter payload | Preserve calculations |
| Selected damage profile | Dialog-scoped selection; no live Item-source mutation | Preserve existing behavior |
| Melee weapon identity | Current embedded Item lookup at submit | Reject deleted Items instead of using stale objects |
| Token versus Actor identity | Target snapshots retain separate UUIDs | Preserve separation; prefer the resolved queued Token's Actor |
| Defense context | Core AoV adapter/defense workflow | Do not call the unused kernel defense stage for symmetry |

Whether conditions changing during a native AoV prompt must be re-evaluated at
resolution is not established here. No declaration/resolution timing was
invented. Live changes to effects, equipment, targets and movement still need
the specified AoV integration scenarios.

## Chat compatibility

Existing module flags are extended with optional primitive data:

- New split prompts record `splitAttack.sourceMessageIds` for the original cards.
- Follow-up cards record `combatCardBatch.sourceMessageId`, `actorUuid`,
  `targetActorUuid` and `targetTokenUuid` at creation.
- Completed split prompts record `splitAttack.resultMessageIds`.

Old cards require no migration. No native AoV message schema, ChatMessage
subtype, audience mode, report recipient policy or background-delivery policy
was replaced. The existing chat helper and render hook remain in use. Flags and
document updates are public APIs in the
[v14 ChatMessage reference](https://foundryvtt.com/api/v14/classes/foundry.documents.ChatMessage.html).

Existing recent-message matching for other native damage workflows is still a
known provenance limitation. This patch does not claim that every attack,
defense and damage chain can now be traced without ambiguity.

## Reused facilities and dependencies

The implementation reuses `DocumentTransaction`, `combatantStateUpdateData`,
the immediate-resolution queue lock, authoritative Combatant queues, socket
schema/authorization, the existing result normalizers, `valuesMeaningfullyEqual`,
`effectIsActive`, `safeDeleteActiveEffect`, the status upsert helpers,
`startDialogCombatWorkflowBatch`, `createModuleChatMessage`, existing AppV2
dialogs, and the current contract runner. No second transaction manager, rule
registry, effect engine or UI framework was introduced.

The coalesced Combatant patch and effect fixes are independent. Split completion
depends on adapter creation-time provenance, so the adapter, target queue and
both attack/missile dialogs should be deployed or rolled back together. Full
cross-client action commitment must precede any broader outcome-summary UI.
Level-aware forced movement remains independent and gated by scene evidence.

The alternatives for plan 02 were considered explicitly:

1. Coalescing state and initiative on the same existing Combatant removes the
   reproduced second-write failure with the smallest change; this was selected.
2. The documented
   [modifyBatch API](https://foundryvtt.com/api/v14/functions/foundry.documents.modifyBatch.html)
   can cancel an entire independent-operation batch on cancellation/error, but
   operations cannot consume an earlier operation's result. No general batch
   layer was added for callers that do not need it.
3. Combat state/phase transitions and operations dependent on completed movement
   remain sequential. This patch does not make a whole phase transactional.

## Forced movement feasibility gate

Knockback's `moveTokenAway` and grapple's `candidateThrowDestinations` still use
the existing 2D path. Their `movementExecution` markers and engagement follow-up
remain unchanged. No automatic elevation, falling, collision damage, distance
conversion or new setting was introduced.

The official APIs expose
[Scene surfaces](https://foundryvtt.com/api/v14/classes/foundry.documents.Scene.html)
and [Token movement constraints](https://foundryvtt.com/api/v14/classes/foundry.canvas.placeables.Token.html).
Their existence does not establish an AoV forced-movement policy or prove this
module's behavior in a configured scene.

Before implementation, verify an actual v14.369 scene with no surfaces, a flat
surface, stairs/open edges across two levels, a blocking wall, an unsupported
destination, a different-level Token, gridless movement, diagonals, large Tokens,
scene edges and hidden/disabled Regions. Record document position/elevation,
movement hooks, engagement, phase state and GM/player agreement. Preserve the
existing default until a narrow opt-in correction passes those fixtures.

## Validation and remaining runtime acceptance

Automated checks passed after implementation:

- `npm run check:syntax`: 120 module files parse.
- `npm run validate` with `AOV_SYSTEM_PATH=C:/dev/aov/aov-system`: 119 reachable
  runtime modules, 842 English keys, matching release CSS, AoV 14.5 / eight
  integration paths.
- `npm run test:contracts`: existing contracts plus the new combat failure,
  cancellation, effect, equipment, split provenance, local repeated-submit,
  request-replay, long-request TTL and reaction-replay fixtures.

No new test framework or test file was created. These fixtures do not implement
Foundry's database, hook lifecycle, permissions, AppV2 renderer or scene engine.
No live v14.369 multi-client, compendium, unlinked-token mutation, native hook
cancellation or Levels/Surfaces validation was performed. GM handover,
simultaneous clients, detached chat visibility, pending workflow reload and
combat end/restart remain runtime acceptance work. No production verification
or release was claimed.

## Rollback

There is no actor/combatant schema migration and no automatic world-data cleanup.
New optional chat flags can remain if the code is rolled back.

Original files and their hashes are at:

`C:/Users/Varys/.codex/visualizations/2026/11/02/01a19ab6-f3cd-7cf0-80eb-57422b6c1f4d/combat-plan-backup`

To restore this workspace before further edits, copy the following original
files from that directory to the same relative paths in the module, then reload
Foundry and rerun the existing validation. Preserve any later edits separately
before overwriting files.

- `scripts/combat/resolution-queue.mjs`
- `scripts/socket.mjs`
- `scripts/compat/active-effects.mjs`
- `scripts/combat/grapple-automation.mjs`
- `scripts/combat/evade-status.mjs`
- `scripts/combat/damage-effect-tracking.mjs`
- `scripts/combat/dialog-target-queue.mjs`
- `scripts/adapter/aov-adapter.mjs`
- `scripts/apps/attack-roll-dialog.mjs`
- `scripts/apps/missile-roll-dialog.mjs`
- `tools/module-tool.mjs`

The audit document itself may be retained as a record. No commit, push, release
package, dependency installation or production-world write was performed.
