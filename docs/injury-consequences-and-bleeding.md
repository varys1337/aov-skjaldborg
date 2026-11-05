# R01 advisory rollback and retained automation groundwork

Date: 2026-11-03.

The injury-consequences advisory update has been rolled back. Its added panel,
localization, presentation helper, styles, advisory fixtures and preview were
removed. All seven modified source/development files were restored from their
verified pre-update copies. This note preserves the useful investigation only;
it adds no runtime feature.

The removed update created no incident ledger, exact damage-application receipt,
successful-treatment contract, persistent stabilization state, injury clock or
once-per-round damage processor. Its threshold checks produced explanatory text
from current documents and were not an automation foundation.

## Existing groundwork retained

These capabilities predate the advisory update and are preserved:

| Existing code | Useful foundation | Limit |
| --- | --- | --- |
| `scripts/combat/result-provenance.mjs` and the adapter's provenance writes | Exact source/card and participant identity on supported combat paths | Native damage application still lacks a committed source-to-Wound receipt. |
| `scripts/combat/damage-effect-tracking.mjs` | Pending applied-Item correlation, stored `appliedItemUuid`, location injury thresholds and source-scoped impalements | A unique matching Item is not authoritative proof of its originating damage card. A location's highest severity is not an individual injury identity. |
| `scripts/combat/authoritative-write-queue.mjs` | Serialized writes to exact documents on the authoritative client | Does not by itself establish cross-client exactly-once processing or a native application transaction. |
| `scripts/combat/state.mjs` and `phase-controller.mjs` | Persisted logical rounds and phase transitions | Hidden Bookkeeping may run after individual action outcomes; it cannot directly trigger once-per-round bleeding loss. Phases do not establish elapsed minutes. |
| `scripts/apps/combat-action-recovery.mjs` | Existing read-only recovery/evidence inspection | Does not create injury treatment or stabilization decisions. |

The six listed foundation files were hash-checked before and after rollback.
The adapter was restored to its pre-advisory copy, including its earlier
provenance implementation.

## Requirements before advanced injury automation

1. A supported native integration must commit the exact damage Message/card,
   target Actor/Token, location and created Wound identity, preserving relevant
   original single-blow damage. NPC totals need a separate explicit incident
   contract; they cannot be treated as individual Wounds.
2. Treatment needs per-injury outcomes that distinguish an attempt, successful
   bleeding control, healing and any required HP restoration. `system.treated`
   alone does not establish these outcomes.
3. Round-based processing needs an explicit logical-round boundary, durable
   duplicate protection and defined rewind/GM-handover behavior before writes.
4. Minute deadlines need a proven injury start time and campaign time policy.
   The head rescue rule's HP-pool ambiguity and the vital-location `>= 2x`
   heading versus `> 2x` body text also need explicit adjudication. Existing
   severity behavior was preserved by rollback.

These are prerequisites identified by the investigation, not newly implemented
features. Detailed source evidence for the provenance integration boundary is
retained in `docs/combat-result-provenance.md`.

## Restoration evidence

Original baseline: `C:/Temp/skjaldborg-injury-advisory-20261103-131012`, with
seven SHA-256 entries in `sha256.json`.

The removed advisory files and original long report are archived at
`C:/Temp/skjaldborg-rolled-back-advisory-20261103-151139` for reversibility.
The rebuilt distribution is `dist/aov-skjaldborg`. Rollback verification uses
exact baseline hashes, unchanged-foundation hashes, absence of advisory runtime
references and the builder's existing syntax/package validation. Contract tests
were restored to their baseline but were not rerun for this byte-exact rollback.

No installed module, live world, native Wound, HP value or ActiveEffect was
changed by the advisory update or this rollback.
