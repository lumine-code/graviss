// Running a deformation through its cycle.
//
// Rendering is on demand, so this is a driver rather than a loop: it asks for a
// frame, is handed the timestamp of the one that was drawn, and asks for the
// next. Stopping is not cancelling anything - it is simply not asking again.

// Where in its swing a cycle is at a fraction `t` of one period.
//
// The default depends on what was solved for, and only one distinction matters:
// a mode shape has no sign. An eigenmode or a buckling mode is defined up to a
// factor, so it swings both ways about the undeformed model; a load case is a
// real state of the structure and runs from it up to itself.
const CYCLES = Object.freeze({
  pingPong: (t) => Math.sin(t * 2 * Math.PI),
  // Half a cosine swing: undeformed -> full -> undeformed. Unlike a triangle
  // wave it reaches every endpoint with zero velocity, so neither the turn at
  // the full shape nor the join between periods snaps direction.
  thereAndBack: (t) => (1 - Math.cos(t * 2 * Math.PI)) / 2,
});

const CYCLE_IDS = Object.freeze(Object.keys(CYCLES));
const DEFAULT_CYCLE_ID = "default";
const ANIMATION_MODE_IDS = Object.freeze([DEFAULT_CYCLE_ID, ...CYCLE_IDS]);

const UNSIGNED_KINDS = new Set(["eigenmode", "buckling"]);

// A mode swings about zero; everything else runs up from it.
function defaultCycle(loadCase) {
  return UNSIGNED_KINDS.has(loadCase?.kind) ? "pingPong" : "thereAndBack";
}

function phaseOf(cycle, t) {
  const shape = CYCLES[cycle] || CYCLES.thereAndBack;
  // Only the fractional part matters, and a negative elapsed time - a clock
  // that stepped backwards - is the start rather than an error.
  const fraction = Number.isFinite(t) ? ((t % 1) + 1) % 1 : 0;
  return shape(fraction);
}

// A deformation value occurs twice in a cycle. Keep the current direction so
// scrubbing a pose and resuming it does not reverse the construction's motion.
function positionForPhase(cycle, phase, currentPosition = 0) {
  const position = Number.isFinite(currentPosition) ? Math.min(1, Math.max(0, currentPosition)) : 0;
  if (!Number.isFinite(phase)) return position;
  if (cycle === "pingPong") {
    const angle = Math.asin(Math.min(1, Math.max(-1, phase))) / (2 * Math.PI);
    if (position > 0.25 && position < 0.75) return 0.5 - angle;
    if (angle < 0) return 1 + angle;
    return angle === 0 && position >= 0.75 ? 1 : angle;
  }
  const half = Math.acos(1 - 2 * Math.min(1, Math.max(0, phase))) / (2 * Math.PI);
  return position > 0.5 ? 1 - half : half;
}

const DEFAULT_PERIOD = 2000;

class Animation {
  // `onFrame(phase)` is handed where the cycle has got to. `requestFrame` is
  // the renderer's own scheduler, so the animation never draws and never
  // decides when a frame happens.
  constructor({ onFrame, requestFrame, now = () => performance.now() }) {
    this.onFrame = onFrame;
    this.requestFrame = requestFrame;
    this.now = now;
    this.cycle = "thereAndBack";
    this.period = DEFAULT_PERIOD;
    this.running = false;
    this.startedAt = 0;
    this.pausedPhase = 0;
    this.presentedFraction = null;
  }

  // The slider describes the model's presented frame, rather than a clock
  // that may already have moved on while the viewport was waiting to draw.
  get position() {
    return this.running
      ? (this.presentedFraction ?? this.fractionAt(this.now()))
      : this.pausedPhase;
  }

  setCycle(cycle) {
    if (CYCLES[cycle]) this.cycle = cycle;
    return this.cycle;
  }

  // How long one full swing takes. Shorter is faster; a period of nothing would
  // divide by zero, so it is held above a floor rather than refused.
  setPeriod(period) {
    if (Number.isFinite(period) && period > 0) {
      const next = Math.max(50, period);
      if (next === this.period) return this.period;
      // The start time encodes where a running cycle is. Replacing only its
      // denominator moves that point — often all the way back near zero — so
      // preserve the fraction and re-anchor the clock under the new tempo.
      if (this.running) {
        const timestamp = this.now();
        const fraction = this.fractionAt(timestamp);
        this.period = next;
        this.startedAt = timestamp - fraction * next;
      } else {
        this.period = next;
      }
    }
    return this.period;
  }

  start() {
    if (this.running) return this;
    this.running = true;
    // Resumes where it stopped rather than snapping back to the start, so
    // pausing to look at something does not lose the swing.
    this.startedAt = this.now() - this.pausedPhase * this.period;
    this.requestFrame();
    return this;
  }

  stop() {
    if (!this.running) return this;
    this.pausedPhase = this.position;
    this.running = false;
    return this;
  }

  // Seeking is a paused pose. Keep the upper endpoint as 1 for the control and
  // the saved document, even though both cycle functions wrap it back to zero.
  seek(fraction) {
    if (!Number.isFinite(fraction)) return this;
    const position = Math.min(1, Math.max(0, fraction));
    this.running = false;
    this.pausedPhase = position;
    this.presentedFraction = position;
    this.startedAt = this.now() - position * this.period;
    this.onFrame(phaseOf(this.cycle, position));
    return this;
  }

  toggle() {
    return this.running ? this.stop() : this.start();
  }

  // Back to the undeformed model, wherever the swing had got to.
  reset() {
    this.pausedPhase = 0;
    this.startedAt = this.now();
    return this;
  }

  fractionAt(timestamp) {
    const elapsed = timestamp - this.startedAt;
    const fraction = (elapsed / this.period) % 1;
    return fraction < 0 ? fraction + 1 : fraction;
  }

  // Called once per drawn frame with that frame's timestamp. Returns whether
  // the animation is still running, so a caller can stop scheduling.
  advance(timestamp) {
    if (!this.running) return false;
    const fraction = this.fractionAt(timestamp);
    this.presentedFraction = fraction;
    this.onFrame(phaseOf(this.cycle, fraction));
    this.requestFrame();
    return true;
  }
}

module.exports = {
  ANIMATION_MODE_IDS,
  Animation,
  CYCLES,
  CYCLE_IDS,
  DEFAULT_CYCLE_ID,
  DEFAULT_PERIOD,
  defaultCycle,
  phaseOf,
  positionForPhase,
};
