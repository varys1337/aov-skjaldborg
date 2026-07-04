import { ENGAGEMENT_STATUS } from "../constants.mjs";

export function uniquePartnerIds(ids = []) {
  return Array.from(new Set((ids ?? []).filter(Boolean)));
}

export function addEngagementPartner(engagement = {}, partnerId) {
  const partnerIds = uniquePartnerIds([...(engagement?.partnerIds ?? []), partnerId]);
  return {
    ...engagement,
    status: partnerIds.length ? ENGAGEMENT_STATUS.ENGAGED : ENGAGEMENT_STATUS.NONE,
    engaged: partnerIds.length > 0,
    partnerIds,
    reason: partnerIds.length ? (engagement?.reason || "opposing-reach") : (engagement?.reason || "")
  };
}

export function removeEngagementPartners(engagement = {}, partnerIdsToRemove = [], reason = "disengaged") {
  const remove = new Set(uniquePartnerIds(partnerIdsToRemove));
  const partnerIds = uniquePartnerIds(engagement?.partnerIds ?? []).filter(id => !remove.has(id));
  return {
    ...engagement,
    status: partnerIds.length ? ENGAGEMENT_STATUS.ENGAGED : ENGAGEMENT_STATUS.NONE,
    engaged: partnerIds.length > 0,
    partnerIds,
    reason: partnerIds.length ? engagement?.reason : reason
  };
}
