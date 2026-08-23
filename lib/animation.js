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
  thereAndBack: (t) => 1 - Math.abs(1 - 2 * t),
  ramp: (t) => t,
  sweep: (t) => t,
});

const CYCLE_IDS = Object.freeze(Object.keys(CYCLES));

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

const DEFAULT_PERIOD = 2000;

class Animation {
  // `onFrame(phase, index)` is handed where the cycle has got to, and for a
  // sweep which of the selected cases it has reached. `requestFrame` is the
  // renderer's own scheduler, so the animation never draws and never decides
  // when a frame happens.
  constructor({ onFrame, requestFrame, now = () => performance.now() }) {
    this.onFrame = onFrame;
    this.requestFrame = requestFrame;
    this.now = now;
    this.cycle = "thereAndBack";
    this.period = DEFAULT_PERIOD;
    this.count = 1;
    this.running = false;
    this.startedAt = 0;
    this.pausedPhase = 0;
  }

  setCycle(cycle) {
    if (CYCLES[cycle]) this.cycle = cycle;
    return this.cycle;
  }

  // How long one full swing takes. Shorter is faster; a period of nothing would
  // divide by zero, so it is held above a floor rather than refused.
  setPeriod(period) {
    if (Number.isFinite(period) && period > 0) this.period = Math.max(50, period);
    return this.period;
  }

  // How many cases a sweep steps through. Anything else ignores it.
  setCount(count) {
    this.count = Number.isFinite(count) && count > 0 ? Math.floor(count) : 1;
    return this.count;
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
    this.pausedPhase = this.fractionAt(this.now());
    this.running = false;
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
    const index =
      this.cycle === "sweep" ? Math.min(this.count - 1, Math.floor(fraction * this.count)) : 0;
    // A sweep holds each case still and steps between them, so its phase is
    // full rather than swinging.
    const phase = this.cycle === "sweep" ? 1 : phaseOf(this.cycle, fraction);
    this.onFrame(phase, index);
    this.requestFrame();
    return true;
  }
}

module.exports = { Animation, CYCLES, CYCLE_IDS, DEFAULT_PERIOD, defaultCycle, phaseOf };
