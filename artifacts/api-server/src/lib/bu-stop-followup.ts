// Backwards-compatible aliases for the existing B.E. threshold analysis.
// New collection code uses the generic post-close names directly.
export {
  POST_CLOSE_FOLLOWUP_MAX_HOUR as BU_STOP_FOLLOWUP_MAX_HOUR,
  POST_CLOSE_FOLLOWUP_FINAL_SAMPLE_GRACE_HOURS as BU_STOP_FOLLOWUP_FINAL_SAMPLE_GRACE_HOURS,
  getPostCloseFollowupHour as getBuStopFollowupHour,
  isPostCloseFollowupObservationEligible as isBuStopFollowupObservationEligible,
  calculatePostCloseMovePct as calculateBuStopMovePct,
} from "./post-close-followup.js";
