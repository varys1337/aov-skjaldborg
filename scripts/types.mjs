/**
 * @typedef {object} SkjaldborgCombatState
 * @property {string} version Module state schema version.
 * @property {boolean} enabled Whether the full combat workflow is enabled for this Combat.
 * @property {"intent"|"movement"|"resolution"|"bookkeeping"} phase Current module phase.
 * @property {number} logicalRound Age of Vikings logical combat round.
 * @property {boolean} requireAllCommit Whether every capable combatant must commit/hold before Movement.
 * @property {{status: string, startedAt: number|null, completedAt: number|null, pendingCombatantIds: string[]}} movementRun Current Movement-phase automation run.
 * @property {SkjaldborgResolutionAction[]} resolutionQueue Ordered actions for the Resolution phase.
 * @property {SkjaldborgSimultaneousGroup[]} simultaneousGroups Exact DEX/INT ties that require simultaneous handling.
 * @property {object[]} bookkeepingLedger GM-facing archive of resolution results for the Bookkeeping phase.
 * @property {SkjaldborgResolutionAction[]} carryover Actions transferred into the next logical round.
 * @property {object[]} archivedRounds Previous logical-round summaries, capped by the state module.
 * @property {object|null} recoverySnapshot Last pre-transition snapshot used for manual recovery.
 * @property {number} updatedAt Epoch timestamp of the latest module-state write.
 */

/**
 * @typedef {object} SkjaldborgCombatantState
 * @property {SkjaldborgIntent} intent Current declaration made by the combatant owner or GM.
 * @property {SkjaldborgMovementPlan} movement Recorded Foundry v13 movement plan summary.
 * @property {SkjaldborgEngagementState} engagement Current close-combat engagement state.
 * @property {SkjaldborgDexLedger|null} dexLedger Last calculated DEX ledger.
 * @property {SkjaldborgResolutionAction[]} scheduledActions Actions created for this combatant.
 * @property {number} reactionCount Number of parry/dodge reactions used in the logical round.
 * @property {string} gmNotes Optional GM note text.
 * @property {string|null} activeGroupId Current simultaneous group marker, if any.
 * @property {number} updatedAt Epoch timestamp of the latest combatant-state write.
 */

/**
 * @typedef {object} SkjaldborgIntent
 * @property {"uncommitted"|"committed"|"held"} status Declaration state.
 * @property {string} actionCategory Rules category used to build scheduled actions.
 * @property {string} publicText Intent text visible in normal displays.
 * @property {string} privateText GM-only intent text.
 * @property {{drawWeapon: boolean, sheatheWeapon: boolean, surprised: boolean, fullMove: boolean}} modifiers DEX-affecting checkboxes.
 * @property {{enabled: boolean, targetDex: number|null}} delay Optional delayed DEX target.
 * @property {{enabled: boolean, text: string}} waitInterrupt Optional wait-to-interrupt condition.
 * @property {number} splitCount Number of split attacks to schedule.
 * @property {number|null} fixedRank Optional fixed DEX rank.
 * @property {boolean} runeCarryover Whether this action is a rune-script carryover.
 */

/**
 * @typedef {object} SkjaldborgMovementPlan
 * @property {string} mode Movement mode label.
 * @property {{x: number, y: number}|null} origin Starting top-left canvas position.
 * @property {{x: number, y: number}|null} destination Final top-left canvas position.
 * @property {{x: number, y: number}[]} route Preserved authored route in execution order.
 * @property {{x: number, y: number}[]} waypoints Recorded top-left canvas waypoints.
 * @property {number} distance Measured or manually entered distance in scene units.
 * @property {string} units Scene units at time of recording.
 * @property {boolean} manual Whether the distance is manually entered/confirmed.
 * @property {"none"|"planned"|"executing"|"completed"|"stopped"|"failed"} planStatus Movement plan status.
 * @property {number|null} startedAt Epoch timestamp when execution started.
 * @property {number|null} completedAt Epoch timestamp when execution completed or stopped.
 * @property {string} stoppedReason Machine-readable stop/failure reason.
 * @property {number} routeRevision Monotonic route-bank revision used to order asynchronous writes.
 * @property {string} routeId Correlation id shared by ruler-draft and final movement captures.
 * @property {string} captureSource Movement surface that produced the stored route.
 * @property {number} capturedAt Epoch timestamp of the route capture.
 * @property {boolean} draft Whether the route is an unfinished ruler preview and must not execute.
 */

/**
 * @typedef {object} SkjaldborgEngagementState
 * @property {"none"|"engaged"} status Engagement status.
 * @property {boolean} engaged Whether the combatant is engaged in close combat.
 * @property {string[]} partnerIds Partner combatant ids.
 * @property {number} reachUnits Engagement reach in grid units.
 * @property {string} reason Machine-readable engagement reason.
 */

/**
 * @typedef {object} SkjaldborgDexLedger
 * @property {string} combatantId Combatant document id.
 * @property {string|null} actorId Actor document id.
 * @property {number} baseDex Actor base DEX used for the calculation.
 * @property {number} int Actor INT used for tiebreaking.
 * @property {number} mov Actor movement allowance used for display and validation.
 * @property {number} distance Recorded movement distance.
 * @property {number} movementUnits 3 m / 10 ft movement units after rounding.
 * @property {number} movementPenalty DEX penalty from movement.
 * @property {{label: string, value: number}[]} modifiers Individual DEX modifiers.
 * @property {number} modifierTotal Sum of modifier values.
 * @property {number|null} fixedRank Optional fixed DEX rank.
 * @property {number} finalDex Final DEX rank before carryover handling.
 * @property {number|null} projectedInitiative Initiative projection written to the AoV tracker.
 * @property {boolean} preventedThisRound Whether DEX <= 0 prevents action this round.
 * @property {string} carryoverReason Localization key for carryover reason.
 * @property {string} actionCategory Scheduled action category.
 */

/**
 * @typedef {object} SkjaldborgResolutionAction
 * @property {string} id Stable action id within the combat round.
 * @property {string} combatantId Owning Combatant id.
 * @property {string|null} actorId Owning Actor id.
 * @property {string} actorName Display name.
 * @property {string} actionCategory Rules category.
 * @property {number} dex DEX rank used for ordering.
 * @property {number} int INT tiebreaker used for ordering.
 * @property {"pending"|"active"|"resolved"|"skipped"|"carryover"} status Resolution status.
 * @property {boolean} carryover Whether this action transfers to a later round.
 * @property {string} label Display label.
 * @property {string=} groupId Simultaneous group id for exact DEX/INT ties.
 */

/**
 * @typedef {object} SkjaldborgSimultaneousGroup
 * @property {string} id Group id.
 * @property {number} dex Shared DEX rank.
 * @property {number} int Shared INT value.
 * @property {string[]} actionIds Member action ids.
 * @property {"pending"|"active"|"resolved"|"skipped"|"carryover"} status Group status.
 */

export {};
