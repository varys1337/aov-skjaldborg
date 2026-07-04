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
 * @property {string} version Module state schema version.
 * @property {SkjaldborgIntent} intent Current declaration made by the combatant owner or GM.
 * @property {SkjaldborgMovementPlan} movement Recorded Foundry v14 movement plan summary.
 * @property {SkjaldborgEngagementState} engagement Current close-combat engagement state.
 * @property {SkjaldborgDisengagementState} disengagement Current declared disengagement state.
 * @property {SkjaldborgRuneMagicState} runeMagic Current Rune Script combat tracking state.
 * @property {SkjaldborgDexLedger|null} dexLedger Last calculated DEX ledger.
 * @property {SkjaldborgPlanningInitiative} planningInitiative Live Planning initiative tracking state.
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
 * @property {SkjaldborgDelayIntent} delay Optional delayed DEX target.
 * @property {{enabled: boolean, text: string}} waitInterrupt Optional wait-to-interrupt condition.
 * @property {number} splitCount Number of split attacks to schedule.
 * @property {number|null} fixedRank Optional fixed DEX rank.
 * @property {boolean} runeCarryover Whether this action is a rune-script carryover.
 */

/**
 * @typedef {object} SkjaldborgRuneMagicState
 * @property {"none"|"carving"|"ready"|"failed"|"disrupted"|"resolved"|"ritual"} status Rune Script combat lifecycle.
 * @property {string|null} itemUuid Source magic Item UUID.
 * @property {string|null} itemId Owned magic Item id.
 * @property {string} itemType Source magic Item type.
 * @property {string} itemName Source magic Item name.
 * @property {number} runeCount Rune Script rune count.
 * @property {number} mpCost Magic point cost summary.
 * @property {number} maxEffects Rune Script maximum effects.
 * @property {number} dexPenalty DEX-rank delay applied when the galdur is sung.
 * @property {number|null} startedRound Logical round in which carving began.
 * @property {number|null} readyRound Logical round in which singing becomes available.
 * @property {object[]} targetRefs Serialized selected targets.
 * @property {boolean} resistance Whether selected targets should resist with POW.
 * @property {number} [flatMod] Flat modifier applied to the Rune Magic or Seiðr check.
 * @property {string} [customModifierReason] Optional reason label for the flat modifier.
 * @property {string|null} [craftMode] Selected Rune Script craft mode.
 * @property {number|null} [customCraftTarget] Manual custom Craft target value.
 * @property {string|null} craftSkillId Selected Craft skill Item id.
 * @property {string|null} craftMessageId AoV Craft roll chat message id.
 * @property {string|null} castMessageId AoV Rune Magic roll chat message id.
 * @property {string|null} eventMessageId Module tracking chat message id.
 * @property {string[]} [resistanceMessageIds] Linked AoV Resistance card message ids.
 * @property {string} notes GM-facing tracking notes.
 * @property {number} updatedAt Epoch timestamp of the latest state write.
 */

/**
 * @typedef {object} SkjaldborgDelayIntent
 * @property {boolean} enabled Whether this combatant has declared a Delay action.
 * @property {number|null} targetDex DEX rank the delayed action is moving to.
 * @property {string|null} targetCombatantId Combatant id being waited on, for interrupt-style delays.
 * @property {"before"|"after"|""} position Requested ordering around the target combatant.
 * @property {number|null} tiebreakerInt INT or synthetic tiebreaker used by the resolution queue.
 */

/**
 * @typedef {object} SkjaldborgReadiedWeapons
 * @property {string|null} right Right-hand readied weapon Item id.
 * @property {string|null} left Left-hand readied weapon Item id.
 * @property {boolean} unlimited NPC-only flag allowing all carried weapons to count as available.
 */

/**
 * @typedef {object} SkjaldborgShieldCover
 * @property {string} shieldId Readied shield-like weapon Item id.
 * @property {string[]} locationIds Actor hit-location Item ids covered by passive shield use.
 */

/**
 * @typedef {object} SkjaldborgShieldwallOption
 * @property {boolean} enabled Whether shieldwall state is declared for manual adjudication.
 */

/**
 * @typedef {object} SkjaldborgTwoWeaponFightingOption
 * @property {boolean} enabled Whether automated same-target full-skill two-weapon mode is declared.
 * @property {string} primaryWeaponId Weapon Item id associated with the primary chance allocation.
 * @property {string} secondaryWeaponId Weapon Item id associated with the secondary chance allocation.
 * @property {number} primaryChance Allocated attack chance for the primary weapon.
 * @property {number} secondaryChance Allocated attack chance for the secondary weapon.
 */

/**
 * @typedef {object} SkjaldborgCombatOptions
 * @property {SkjaldborgTwoWeaponFightingOption} twoWeaponFighting Two-weapon attack option state.
 * @property {SkjaldborgShieldCover} shieldCover Passive shield cover declaration.
 * @property {SkjaldborgShieldwallOption} shieldwall Shieldwall declaration state.
 */

/**
 * @typedef {object} SkjaldborgTwoWeaponAttackMetadata
 * @property {boolean} enabled Whether the attack payload includes a second weapon attack.
 * @property {string|null} primaryWeaponUuid Primary weapon UUID.
 * @property {string|null} secondaryWeaponUuid Secondary weapon UUID.
 * @property {number|null} secondaryDexRank Rounded-up half DEX rank for the second attack.
 * @property {"same-target-full-skill"|"multi-target-half-skill"|""} mode Automated two-weapon mode.
 * @property {number} primarySkill Primary weapon skill total emitted for deterministic adjudication.
 * @property {number} secondarySkill Secondary weapon skill total emitted for deterministic adjudication.
 * @property {number} primaryWeaponChance Allocated primary attack chance used for the submitted attack.
 * @property {number} secondaryWeaponChance Allocated secondary attack chance used for the submitted attack.
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
 * @typedef {object} SkjaldborgDisengagementState
 * @property {"none"|"retreat"|"flee"|"knockback"} method Disengagement method.
 * @property {"none"|"declared"|"complete"} status Disengagement lifecycle status.
 * @property {string[]} partnerIds Partner combatant ids declared for this disengagement.
 * @property {string|null} opportunityAttackerId Backward-compatible selected Flee opportunity attacker.
 * @property {string[]} opportunityAttackerIds Selected Flee opportunity attackers.
 * @property {"one"|"all"} opportunityMode Flee opportunity selection mode.
 */


/**
 * @typedef {object} SkjaldborgPlanningInitiative
 * @property {number|null} logicalRound Logical round for which the live projection is valid.
 * @property {number|null} baselineInitiative AoV DEX.INT initiative at the start of Planning.
 * @property {number} externalAdjustment DEX-rank delta introduced outside the declaration ledger.
 * @property {number|null} projectedInitiative Last initiative projected or observed in the tracker.
 * @property {number} updatedAt Epoch timestamp of the latest live Planning update.
 */

/**
 * @typedef {object} SkjaldborgDexLedger
 * @property {string} combatantId Combatant document id.
 * @property {string|null} actorId Actor document id.
 * @property {number} baseDex Actor base DEX used for the calculation.
 * @property {number} int Actor INT used for tiebreaking.
 * @property {number} mov Actor movement allowance used for display and validation.
 * @property {number} distance DEX-eligible measured travelled distance; zero until movement reaches a terminal state.
 * @property {number} movementUnits Eligible travelled 3 m / 10 ft movement units after rounding; zero before terminal movement.
 * @property {number} movementPenalty DEX penalty from terminal measured movement; zero while only planned or executing.
 * @property {number} planningAdjustment External DEX adjustment captured during live Planning.
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
