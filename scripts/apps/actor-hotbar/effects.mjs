import { DISPOSITION_PALETTES } from "./constants.mjs";

/**
 * Resolve the selected actor's authoritative Token disposition.
 *
 * The active Combatant Token is preferred during combat. Outside combat, the
 * currently controlled Token, a synthetic Token, the first active Token, and
 * finally the Actor prototype Token are considered in that order.
 *
 * @param {Actor|null} actor Current actor document.
 * @param {Combatant|null} combatant Current actor Combatant document.
 * @returns {{key: string, color: string, labelColor: string, labelWeight: number, glowSoft: string, glowStrong: string}}
 */
export function resolveDispositionPalette(actor, combatant) {
  const controlled = canvas?.tokens?.controlled?.find(token => {
    const tokenActor = token.actor;
    return tokenActor?.id === actor?.id || tokenActor?.baseActor?.id === actor?.id;
  }) ?? null;
  const activeToken = actor?.getActiveTokens?.(false, true)?.[0] ?? null;
  const tokenDocument = combatant?.token?.document
    ?? combatant?.token
    ?? controlled?.document
    ?? actor?.token
    ?? activeToken?.document
    ?? activeToken
    ?? actor?.prototypeToken
    ?? null;
  const disposition = Number(tokenDocument?.disposition);
  const dispositions = globalThis.CONST?.TOKEN_DISPOSITIONS ?? {};
  const friendly = Number(dispositions.FRIENDLY ?? 1);
  const neutral = Number(dispositions.NEUTRAL ?? 0);
  const hostile = Number(dispositions.HOSTILE ?? -1);
  const secret = Number(dispositions.SECRET ?? -2);

  if (disposition === friendly) return DISPOSITION_PALETTES.friendly;
  if (disposition === hostile) return DISPOSITION_PALETTES.hostile;
  if (disposition === secret) return DISPOSITION_PALETTES.secret;
  if (disposition === neutral) return DISPOSITION_PALETTES.neutral;
  return DISPOSITION_PALETTES.neutral;
}
