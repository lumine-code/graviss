const DEFAULT_IDLE_MS = 500;
const DEFAULT_REPORT_INTERVAL_MS = 250;
const SMOOTHING_WEIGHT = 0.25;

class FrameRateMeter {
  constructor(onDidChange, options = {}) {
    this.onDidChange = onDidChange;
    this.idleMs = options.idleMs || DEFAULT_IDLE_MS;
    this.reportIntervalMs = options.reportIntervalMs || DEFAULT_REPORT_INTERVAL_MS;
    this.setTimer = options.setTimer || ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = options.clearTimer || ((timer) => clearTimeout(timer));
    this.lastFrameTime = null;
    this.lastReportTime = null;
    this.smoothedFps = null;
    this.reportedFps = null;
    this.idleTimer = null;
    this.disposed = false;
  }

  record(timestamp) {
    if (this.disposed || !Number.isFinite(timestamp)) return;
    if (this.lastFrameTime != null) {
      const elapsed = timestamp - this.lastFrameTime;
      if (elapsed > 0 && elapsed < this.idleMs) {
        const instantaneousFps = 1000 / elapsed;
        this.smoothedFps =
          this.smoothedFps == null
            ? instantaneousFps
            : this.smoothedFps * (1 - SMOOTHING_WEIGHT) + instantaneousFps * SMOOTHING_WEIGHT;
        if (
          this.lastReportTime == null ||
          timestamp - this.lastReportTime >= this.reportIntervalMs
        ) {
          this.publish(Math.max(1, Math.round(this.smoothedFps)));
          this.lastReportTime = timestamp;
        }
      } else {
        this.smoothedFps = null;
        this.lastReportTime = null;
        this.publish(null);
      }
    }
    this.lastFrameTime = timestamp;
    this.scheduleIdle();
  }

  scheduleIdle() {
    if (this.idleTimer != null) this.clearTimer(this.idleTimer);
    this.idleTimer = this.setTimer(() => {
      this.idleTimer = null;
      this.lastFrameTime = null;
      this.lastReportTime = null;
      this.smoothedFps = null;
      this.publish(null);
    }, this.idleMs);
  }

  publish(fps) {
    if (fps === this.reportedFps) return;
    this.reportedFps = fps;
    this.onDidChange?.(fps);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.idleTimer != null) this.clearTimer(this.idleTimer);
    this.idleTimer = null;
  }
}

module.exports = { FrameRateMeter };
