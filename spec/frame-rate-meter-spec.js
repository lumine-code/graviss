const { FrameRateMeter } = require("../lib/frame-rate-meter");

describe("Graviss frame-rate meter", () => {
  let timers;
  let nextTimerId;

  beforeEach(() => {
    timers = new Map();
    nextTimerId = 1;
  });

  it("reports smoothed active FPS and returns to idle without a render loop", () => {
    const updates = [];
    const meter = new FrameRateMeter((fps) => updates.push(fps), {
      idleMs: 500,
      reportIntervalMs: 250,
      setTimer: (callback) => {
        const id = nextTimerId++;
        timers.set(id, callback);
        return id;
      },
      clearTimer: (id) => timers.delete(id),
    });

    meter.record(1000);
    expect(updates).toEqual([]);
    meter.record(1016);
    expect(updates).toEqual([63]);
    meter.record(1032);
    expect(updates).toEqual([63]);
    meter.record(1288);
    expect(updates.length).toBe(2);
    expect(updates[1]).toBeGreaterThan(1);
    expect(updates[1]).toBeLessThan(63);

    [...timers.values()].at(-1)();
    expect(updates.at(-1)).toBeNull();
    meter.dispose();
  });

  it("cancels its pending idle timer when disposed", () => {
    const meter = new FrameRateMeter(() => {}, {
      setTimer: (callback) => {
        const id = nextTimerId++;
        timers.set(id, callback);
        return id;
      },
      clearTimer: (id) => timers.delete(id),
    });

    meter.record(1000);
    expect(timers.size).toBe(1);
    meter.dispose();
    expect(timers.size).toBe(0);
  });

  it("invokes browser timers without changing their receiver", () => {
    const meter = new FrameRateMeter(() => {});
    expect(() => meter.record(1000)).not.toThrow();
    meter.dispose();
  });
});
