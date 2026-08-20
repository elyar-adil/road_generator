// Waiting-area geometry. All the low-level curve/offset/trim/dash primitives
// now live in geometry.js; this module re-exports them so existing tests and
// imports keep working, and adds waiting-area-specific helpers if any.

export {
  buildDashedSegments,
  buildLeftTurnPath,
  offsetPolyline,
  polylineLength,
  pointAndTangentAtDistance,
  trimPolyline,
  trimPolylineByEnvelope as trimBeforeLaneEnvelope,
} from './geometry.js';