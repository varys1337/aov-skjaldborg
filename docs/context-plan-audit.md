# Context, claims, and source-effect plan audit

Date: 2026-11-02. Target: Foundry VTT v14.369+ and AoV 14.5.

This implements the seven Downloads plans as a continuation of the earlier
Desktop plans. The plans are design inputs; their API assertions and proposed
mechanics were checked against the local implementation, local AoV rule text,
and official v14 API. No AC5E, WM5E, or dnd5e runtime dependency was added.

The workspace has no usable Git HEAD or remote metadata: `.git` is empty.
The plans' named commit cannot be confirmed as this checkout's baseline.
Original file hashes and copies were saved before editing. The installed AoV
source reports version 14.5. The earlier `combat-plan-audit.md` remains the
historical report for the first batch; the claims and source-effect findings
below supersede its corresponding remaining-work notes.
Released compatibility metadata remains minimum 14.363 / verified 14.365;
this source patch does not falsely raise the verified version without a live
14.369 run. The requested implementation target is 14.369+.

## Decisions for all seven plans

| Plan | Finding and decision | Delivery status |
| --- | --- | --- |
| 01 Collision-aware forced movement | Knockback and throws still commit XY destinations without proving the entire trajectory. AoV specifies displacement but the available rule text does not define blocked/partial displacement. No live Foundry scene was available to validate native movement, guards, hooks, or endpoint behavior. | **NO-CHANGE to movement.** No pathfinder detours, collision damage, shortening, or new movement setting was invented. The two automation files change only for claims/effect identity. |
| 02 Authoritative action claims | Concurrent calls against the saved original queue started two attacks and spent ammunition twice. Existing request deduplication did not identify the logical row. | **Implemented with limits.** One persisted, GM-arbitrated claim per queue row/split prompt, exact result-card proof, bounded recovery of unstarted reservations, and atomic claimed ammunition/receipt writes. Real multi-client certification and all-or-nothing resource/card creation remain outstanding. |
| 03 Contextual condition modifiers | Evading already recorded `rangedAttackPenalty: -40` but missile calculation did not consume it. AoV combat rules p. 113 explicitly give that penalty. | **Implemented one verified rule.** Existing kernel provider, current Token Actor, activity/expiry checks, submitted payload and native adapter path. No defense stage or new expression engine. |
| 04 Assisted missile modifiers | Manual medium/long and melee division exist. Weapon `system.range` is numeric; the book describes approximate bands in meters. Item-to-scene measurement, token size/elevation, shooter ambiguity, and translating engagement records into the actual melee participant count are not established together. | **NO-CHANGE to suggestions.** Existing manual controls and percentages remain authoritative. Changes to the missile dialog implement plans 02, 03, and 07 only. |
| 05 Source-aware temporary effects | Grapple matching ignored stored Token identity. Evade refresh/deduplication matched the whole status family and could adopt/delete another source. | **Implemented narrow corrections.** Exact known grapple Token pair for lookup/upsert/cleanup; source-specific managed Evade refresh and expiry. Other effect families retain their established owners. |
| 06 Rule cadence and usage limits | Existing intent, DEX, scheduled action, reaction and phase ledgers already represent the relevant intervals. The reproduced duplicate is a source-action identity problem, addressed by plan 02. No separate missing usage rule was proven. | **NO-CHANGE to action economy.** No once-per-turn registry, cooldown, TTL-based use limit, or schema migration. |
| 07 Attribution and diagnostics | Kernel reports stopped at the dialog boundary and did not show the committed adapter value. | **Implemented opt-in local GM tracing** through existing performance diagnostics, with bounded primitive reports and no new app, public chat, document log, or render hook. |

## Evidence and rule authority

Local rule authority used:

- `C:/dev/aov/docs/core book/Age_of_Vikings_Part_5_Combat_FULL.md`:
  subsequent defenses at lines 287-354; split attacks at 382 onward;
  projectile ranges at 798; Shooting at Moving Targets at 848-860;
  Shooting into Melee at 867 onward; prone at 1176; grappling at 1213-1223;
  knockback at 1225-1243.
- `C:/dev/aov/docs/core book/CHA2038_Age_of_Vikings_Core_Rulebook_Corrections_FULL.md`:
  corrected subsequent-parry example at 185 and split example at 195.
  Wyrd's once-per-day correction at 197 is outside Skjaldborg's implemented
  combat-action workflows; it does not justify a new phase-use ledger.
- `C:/dev/aov/aov-system/system/apps/checks.mjs` and the current adapter establish
  the native combat-card workflow. A returned `started` means an attack card
  exists, rather than a completed opposed roll or damage application.

The saved pre-change modules were loaded into a disposable Node process.
No live world or persistent Actor was touched. Observed baseline:

| Scenario | Saved original | Corrected contract |
| --- | --- | --- |
| Two simultaneous queue resolvers for one row | 2 workflow starts, 2 spends, quantity 3 -> 1 | 1 workflow start, 1 spend |
| Grapple check with a different source Token sharing the same Actor | Matched the hold | Exact Token query rejects it |
| Evade refresh with two Token sources plus manual status | Existing broad status predicate could adopt a different source | Refresh A reuses A; B and manual status remain |
| Missile against a current declared evader | No Evading term in the chance formula | -40 before existing range/melee scaling |

## Persisted action protocol

Identity is `ChatMessage.<source id>#target-<entry index>` or
`ChatMessage.<source id>#split`. The source flags remain `targetQueue` and
`splitAttack`; old `resolved` booleans are still read and written. New optional
`actionClaims` data has version 1, the enabled combat's ID/logical round/phase,
and a bounded-by-source entries object. Each attempt stores its claimant,
attempt ID, subject identities, execution state and, when applicable, an exact
ammunition receipt. Unknown versions or malformed active claims fail closed.
Unresolved historical messages are adopted on their first explicit reservation;
there is no world-wide migration or automatic historical rewrite.

The selected active GM serializes source-message writes using the existing
authoritative queue module. Defense-card appends now use the same document
queue helper, replacing their previous private queue. Ammunition writes use
that queue keyed by the exact embedded Item UUID. A secondary GM routes claims
to the selected GM instead of independently authorizing them.

Authorization resolves the source and row on the GM, derives the Actor and
weapon from persisted data, checks the requesting user's Actor ownership and
source-message visibility, resolves exact targets, and validates current
combat context. It repeats subject/resource validation at execution and before
spending. A deleted exact Token cannot fall back to an Actor. Queue ammunition
is validated before reservation; split ammunition is validated once its form
selection is known. No client-supplied ownership assertion is trusted.

| Current state | Event | Result |
| --- | --- | --- |
| Pending | Valid reserve | Save claimed attempt before opening the native workflow |
| Claimed | Prompt closes/fails before execution | Release to pending; no spend |
| Claimed | Same row requested by another caller | Busy until release, inactive claimant, or 60-second lease expiry |
| Claimed | Execute without ammunition | Save executing before the action can run |
| Claimed | Execute with ammunition | Validate and retain claimed state until the resource batch |
| Claimed | Consume ammunition | One batch saves Item quantity and executing state plus receipt |
| Claimed | Resource batch cancelled | Neither spend nor receipt persists; reservation remains releasable |
| Executing | Repeated consume | Return saved receipt; no second spend |
| Executing | Release, timeout, disconnect, elapsed lease | Keep executing; automatic replay is unsafe |
| Claimed/executing | Exact result-card proof appears | Save committed with result IDs and render source resolved |
| Committed | Any later activation | Return recorded result; no roll, spend or reaction repeat |

Cards carry version/key/attempt proof **at creation**. Reconciliation matches
those exact fields, rather than recent timestamps or currently selected Actors.
Knockback, grapple attack, and grapple resistance initiation retain the same
proof where they serve as the actual start card. Separate rows and ordinary
attacks have separate identities. Two attacks aimed at the same Token are not
deduplicated into a single ammunition unit.

The ammunition/receipt operation uses official
[`foundry.documents.modifyBatch`](https://foundryvtt.com/api/v14/functions/foundry.documents.modifyBatch.html)
and documented
[`DatabaseUpdateOperation`](https://foundryvtt.com/api/v14/interfaces/foundry.abstract.types.DatabaseUpdateOperation.html)
fields. Cancellation or exception cancels the batch. That guarantee covers
the Item update and claim receipt, **not subsequent native card creation**.

### Recovery limits

| Failure | Protection and remaining limit |
| --- | --- |
| Source refresh fails after card creation | Creation-time proof survives; a later activation reconciles the source |
| Resource write confirmed, then card creation fails | Executing remains locked, with before/after quantity recorded. There is no automatic refund or reroll because a delayed card may still exist. A GM must inspect the exact source, receipt and result cards before correcting the world. |
| Split batch creates only some cards | Known cards commit the source; no whole-batch replay. Automatic completion/refund of missing targets is not implemented. |
| Handoff/reload after a durable claim | The next GM reads the claim and exact proof; fixture coverage passes |
| GM selection changes during a database operation | Authority is checked around writes, but no documented compare-and-swap/server fencing mechanism was established. In-flight handoff still needs real two-client testing. |
| Native attack-options prompt remains open past the lease | Another caller may reserve; the old attempt is rejected when it tries to execute |
| No active GM on a player client | No execution or spend |
| Direct normal missile attack | Retains its existing ammunition path. This patch does not make ordinary attacks or their competition for the same ammunition transactional with claimed attacks. |

This is cooperative client workflow arbitration with GM validation, not a new
server-side security system. It does not claim exactly-once execution for every
downstream damage/effect hook, or full cross-client/GM-handoff certification.

## Rule and snapshot matrix

| Rule/input | Subject/source | Evaluation and decision |
| --- | --- | --- |
| Prone / immobilized | Existing participant Actor/Token effects | Existing kernel and damage provider; formulas preserved |
| Aimed blow / equipment | Explicit per-target form choice and Item identity | Existing provider and native action adjustment; preserved |
| Mounted cap | Attacker effects and Ride Item | Existing cap before the attack additions; preserved |
| Evading target | Managed active Evade declaration, combat/expiry, exact known target Token | New attack provider reads current data during form-state evaluation and submission; missile only |
| Angular moving target | Trajectory/rule trigger not proven from current data | No automatic -20 addition |
| Manual range / Shooting into Melee | Submitted user choices | Existing scaling and rounding preserved; no inferred selection |
| Defense | Core AoV workflow | No new `prepareDefenseContext` consumer |

One exercised example is `(100 + 20 manual - 40 prone - 40 evading) * 0.5 / 2
= 10`. Switching to a second Token without that declaration yields 20.
Disabled, suppressed and expired declarations contribute zero, even if cleanup
has not yet run. A later valid declaration cannot be masked by an expired one.

The dialog captures these condition contributions on submit; the adapter
uses that payload and records its actual committed target. It does not
re-evaluate rule timing during the subsequent native prompt. Whether AoV wants
particular changes during that prompt to apply live remains unverified.
No new declaration-versus-resolution timing rule was invented.

## Effect ownership matrix

| Family | Owner and source identity | Refresh / cleanup / decision |
| --- | --- | --- |
| Grappled / immobilized | Actor effect; existing source/target Actor and Token UUIDs | Exact known Token pair now participates in eligibility, upsert and cleanup. Suppressed holds are ineligible but still discoverable for their own cleanup. Legacy ambiguous Token-less data is preserved, not silently adopted by an exact Token query. |
| Evading | Managed Actor effect; combat, combatant, Actor and Token identity | Same-source refresh only; duplicates removed only for that source. Manual statuses and other Token declarations survive. Expiry affects managed markers only, from their own recorded round/combat. |
| Engaged | Actor mirror of combatant-keyed records, existing Actor sync locks | Existing aggregate status ownership retained |
| Disengaging / reaction penalty | Existing combatant-driven Actor mirrors and round lifecycle | No new overlap or expiry policy introduced; multi-combatant shared-Actor interpretation remains outside this patch |
| Impaled / injury | Item-owned source-card/severity data | Prior batch's independent impalement fix and existing injury owner retained |
| Stun / knockback prone | Existing specialized status owner | No new collision, source-duration or damage rule |

Core applicability uses the existing helper around documented
[`ActiveEffect.active` / `isSuppressed`](https://foundryvtt.com/api/v14/classes/foundry.documents.ActiveEffect.html).
Suppression alone never authorizes deletion. No dnd5e duration/source schema
or generic effect manager was introduced.

## Cadence coverage

| Rule interval | Current owner | Decision |
| --- | --- | --- |
| Declared action/split within a logical round | Intent, DEX ledger, scheduled actions and resolution queue | Preserve legal split/repeated actions; no general once-per-turn cap |
| Subsequent parry/dodge penalties | `reactionCount`, reaction automation/effect reconciliation and round reset | Preserve existing configurable reaction accounting, without limiting defenses to one |
| One queued/split follow-up source | Source action claim and existing resolved marker | Corrected as idempotency, not a new AoV use allowance |
| Evade declaration through next logical round | Recorded Evade expiry and phase/round owner | Source identity corrected; no new cooldown |
| Knockback as an alternative action on DEX 1 | Existing declared-intent/DEX scheduling and specialized workflow | No independent cadence registry; broader enforcement is not certified by this audit |
| Wyrd once per day | Native/world time, outside implemented Skjaldborg actions | No combat-round substitute |

No independently verified missing usage limit justified another persisted
counter. Phase rollback/skip, out-of-band native actions and manual GM overrides
remain live-integration cases, rather than being declared universally enforced.

## Opt-in attribution

Use the existing performance-diagnostics or debug setting on the GM client,
reproduce the action there, then inspect
`game.aovSkjaldborg.diagnostics.combatRules()`.
The usual `diagnostics.performance.report()` includes the same local measure.
Player-initiated native cards are not remotely collected by this patch.

| Stage | Captured value | Storage and visibility |
| --- | --- | --- |
| Form submit | Base, additive components, range multiplier, melee divisor, existing rule reports | Transient payload; no new public provenance flag |
| Native options | Check bonus and native action adjustment | Local trace only when enabled on GM |
| Card creation succeeds | Final flat modifier, encumbrance, target number | Same local trace, marked committed-card |
| Later opposed roll/damage | Existing native card/automation ownership | Not claimed as newly traced end-to-end |

For the example above, the submitted chance is 10. Core bonus +5 and
encumbrance -5 give committed target 10 and flat modifier -85 against base 100.
These are distinct recorded fields; a preview is not relabeled as a final roll.

Reports admit only bounded primitive data and finite numbers; provider identity
and stage cannot be overwritten by a provider's returned data. The trace accepts
only registered provider IDs/stages and numeric/boolean contribution values.
Actor/Token/Item UUIDs, names, notes, effect descriptions, hidden documents and
full snapshots are omitted. No extra chat, flags, logs, hooks, or app is emitted.
The existing 50-sample client-local retention is reused.

A synthetic Node profile of 5,000 enabled recordings measured approximately
11.24 microseconds each including bounded storage on this machine. This is
fixture evidence, not a Foundry render/network benchmark. Default tracing
returns immediately, adds no UUID lookup or document traversal, and stores no
attribution. The gameplay condition provider performs its necessary synchronous
effect check; trace generation occurs once after successful card creation.

## Validation and delivery

The existing Node contract harness was extended; no separate test framework or
test files were added. Covered cases include concurrent full queue workflows,
two owners claiming one row, independent rows, release/reclaim, cancellation,
atomic-resource rejection, duplicate consumption, depleted/deleted resources,
missing exact targets, blind/whisper/ownership rejection, stale context/version,
late-card recovery under a new GM, secondary-GM routing, no-active-GM behavior,
same-Token split ammunition, scoped effect refresh, target changes, activity and
expiry, modifier order, opt-in privacy, bounded/cyclic reports, and retention.
Prior combat contracts remain included.

Validation commands:

- `npm run check:syntax`
- `AOV_SYSTEM_PATH=C:/dev/aov/aov-system npm run validate`
- `npm run test:contracts`

These are source/fixture checks. No local Foundry process was running and no
disposable v14.369 world or browser integration harness was configured.
Wall/door/gridless/large-Token scenes, actual GM/player visibility, network loss,
and in-flight GM handoff remain unexecuted. The official v14 documentation
currently labels its build 14.368; this does not certify a v14.369 runtime.
No release archive, publication, world migration, or commit was made.
All three checks passed: 120 modules parsed, 119 runtime modules reachable,
845 English localization keys checked, unchanged compiled styles, and eight
AoV 14.5 contract paths validated.

Changed files for this batch: `dialog-target-queue`, `authoritative-write-queue`,
`socket`, its schema/sanitizers, `aov-adapter`, knockback/grapple automation,
Evade status, rule kernel, attack/missile/grapple dialogs, `main`, English
localization, the existing module-tool harness, and this report. The diagnostics
application and all movement geometry implementation remain unchanged.

Originals, hashes, the baseline reproduction and profiling output are in
`C:/Users/Varys/.codex/visualizations/2026/11/02/01a19ab6-f3cd-7cf0-80eb-57422b6c1f4d/`.
`context-plan-changes.patch` contains only this batch and can be reviewed or
reversed together; restore the saved originals if subsequent edits make reverse
application unsafe. Reverse application was checked before delivery. The first
batch's changes are intentionally retained by that rollback. With a real Git
checkout, these changes can be committed and reverted as a unit.
