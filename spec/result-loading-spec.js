const { CompositeDisposable, Emitter } = require("lumine");
const { Animation } = require("../lib/animation");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function resultFor(loadCaseId) {
  return {
    kind: "displacement",
    loadCaseId,
    components: 3,
    nodes: { ids: [1], values: [0, 0, loadCaseId / 1000] },
    extent: loadCaseId / 1000,
  };
}

// The queue does not need WebGL. Use the real view methods, results-state
// handling and events, with a deferred source and the renderer's narrow API.
function createViewer() {
  const GravissView = require("../lib/graviss-view");
  const viewer = Object.create(GravissView.prototype);
  const reads = new Map();
  const metrics = { active: 0, maximum: 0 };
  const animation = new Animation({
    onFrame: (phase) => renderer.setDeformationPhase(phase),
    requestFrame: () => {},
    now: () => 0,
  });
  for (const method of ["setCycle", "setPeriod", "start", "stop", "seek"])
    spyOn(animation, method).and.callThrough();
  let displayed = null;
  const renderer = {
    setResult: jasmine.createSpy("setResult").and.callFake((result) => {
      displayed = result;
    }),
    setAutomaticScale: jasmine.createSpy("setAutomaticScale"),
    setDeformationScale: jasmine.createSpy("setDeformationScale"),
    setColorByDisplacement: jasmine.createSpy("setColorByDisplacement"),
    setDeformationPhase: jasmine.createSpy("setDeformationPhase"),
    getDeformation: () => (displayed ? { result: displayed } : null),
    getAnimation: () => animation,
    destroy: jasmine.createSpy("destroyRenderer"),
  };
  Object.assign(viewer, {
    destroyed: false,
    renderer,
    geometry: { nodes: [{ id: 1, x: 0, y: 0, z: 0 }], elements: [] },
    loadCases: [
      { id: 1, title: "A", kind: "linear" },
      { id: 2, title: "B", kind: "linear" },
      { id: 3, title: "C", kind: "eigenmode" },
    ],
    resultsState: {
      loadCaseId: null,
      scale: "auto",
      cycle: null,
      period: null,
      cyclePosition: null,
      playing: false,
      colorByDisplacement: false,
    },
    result: null,
    resultsError: null,
    failedLoadCaseId: null,
    resultRequest: 0,
    resultRead: null,
    resultSelection: null,
    emitter: new Emitter(),
    subscriptions: new CompositeDisposable(),
    element: document.createElement("div"),
    recordResultsState: jasmine.createSpy("recordResultsState"),
    session: {
      getResult: jasmine.createSpy("getResult").and.callFake(({ loadCaseId }) => {
        const read = deferred();
        reads.set(loadCaseId, read);
        metrics.active += 1;
        metrics.maximum = Math.max(metrics.maximum, metrics.active);
        return read.promise.finally(() => {
          metrics.active -= 1;
        });
      }),
      dispose: jasmine.createSpy("disposeSession"),
    },
  });
  return { viewer, renderer, animation, reads, metrics };
}

async function flushReads() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Graviss result loading", () => {
  let fixture;

  beforeEach(() => {
    jasmine.useRealClock();
    fixture = createViewer();
  });

  afterEach(() => {
    fixture.viewer.destroy();
  });

  it("reads only the latest pending case and discards old fields before validation", async () => {
    const { viewer, renderer, reads, metrics } = fixture;
    const changed = jasmine.createSpy("did-change-results");
    viewer.onDidChangeResults(changed);
    const first = viewer.selectLoadCase(1);
    const skipped = viewer.selectLoadCase(2);
    const latest = viewer.selectLoadCase(3);
    await expectAsync(first).toBeResolvedTo(null);
    await expectAsync(skipped).toBeResolvedTo(null);
    expect(viewer.session.getResult.calls.allArgs()).toEqual([
      [{ loadCaseId: 1, kind: "displacement" }],
    ]);
    const validateOld = jasmine.createSpy("validate old field").and.throwError("obsolete field");
    reads.get(1).resolve(Object.defineProperty({}, "kind", { get: validateOld }));
    await flushReads();
    expect(validateOld).not.toHaveBeenCalled();
    expect(renderer.setResult).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledTimes(3);
    expect(viewer.getResultLoadState()).toEqual({
      pendingLoadCaseId: 3,
      displayedLoadCaseId: null,
      failedLoadCaseId: null,
      error: null,
    });
    expect(reads.has(2)).toBe(false);
    const result = resultFor(3);
    reads.get(3).resolve(result);
    await expectAsync(latest).toBeResolvedTo(result);
    expect(metrics.maximum).toBe(1);
    expect(viewer.result).toBe(result);
    expect(viewer.resultsState.loadCaseId).toBe(3);
    expect(renderer.setResult.calls.allArgs()).toEqual([[result]]);
    expect(viewer.recordResultsState).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(4);
    expect(viewer.getResultLoadState()).toEqual({
      pendingLoadCaseId: null,
      displayedLoadCaseId: 3,
      failedLoadCaseId: null,
      error: null,
    });
  });

  it("shares an in-flight case and records only the latest caller's choice", async () => {
    const { viewer, reads } = fixture;
    const first = viewer.selectLoadCase(1);
    const same = viewer.selectLoadCase("1", { record: false });
    expect(viewer.session.getResult).toHaveBeenCalledTimes(1);
    const result = resultFor(1);
    reads.get(1).resolve(result);
    await expectAsync(first).toBeResolvedTo(result);
    await expectAsync(same).toBeResolvedTo(result);
    expect(viewer.recordResultsState).not.toHaveBeenCalled();
  });

  it("reuses the running case when the latest choice returns to it", async () => {
    const { viewer, reads } = fixture;
    const first = viewer.selectLoadCase(1);
    const skipped = viewer.selectLoadCase(2);
    const latest = viewer.selectLoadCase(1);
    const result = resultFor(1);
    reads.get(1).resolve(result);
    await expectAsync(first).toBeResolvedTo(null);
    await expectAsync(skipped).toBeResolvedTo(null);
    await expectAsync(latest).toBeResolvedTo(result);
    expect(viewer.session.getResult).toHaveBeenCalledTimes(1);
  });

  it("shares repeated choices of the pending case without starting another read", async () => {
    const { viewer, reads, metrics } = fixture;
    const first = viewer.selectLoadCase(1);
    const pending = viewer.selectLoadCase(2);
    const same = viewer.selectLoadCase(2);
    reads.get(1).resolve(resultFor(1));
    await flushReads();
    const result = resultFor(2);
    reads.get(2).resolve(result);
    await expectAsync(first).toBeResolvedTo(null);
    await expectAsync(pending).toBeResolvedTo(result);
    await expectAsync(same).toBeResolvedTo(result);
    expect(viewer.session.getResult).toHaveBeenCalledTimes(2);
    expect(metrics.maximum).toBe(1);
  });

  it("ignores a superseded rejection and continues with the final case", async () => {
    const { viewer, reads, renderer } = fixture;
    const first = viewer.selectLoadCase(1);
    const latest = viewer.selectLoadCase(3);
    reads.get(1).reject(new Error("old case failed"));
    await flushReads();
    expect(viewer.resultsError).toBeNull();
    expect(renderer.setResult).not.toHaveBeenCalled();
    const result = resultFor(3);
    reads.get(3).resolve(result);
    await expectAsync(first).toBeResolvedTo(null);
    await expectAsync(latest).toBeResolvedTo(result);
  });

  it("reports a current failure and permits a subsequent retry", async () => {
    const { viewer, reads } = fixture;
    const previous = viewer.selectLoadCase(2);
    const displayed = resultFor(2);
    reads.get(2).resolve(displayed);
    await previous;
    const changed = jasmine.createSpy("did-change-results");
    viewer.onDidChangeResults(changed);
    const failed = viewer.selectLoadCase(1);
    expect(viewer.getResultLoadState()).toEqual({
      pendingLoadCaseId: 1,
      displayedLoadCaseId: 2,
      failedLoadCaseId: null,
      error: null,
    });
    const error = new Error("case failed");
    reads.get(1).reject(error);
    await expectAsync(failed).toBeResolvedTo(null);
    expect(viewer.resultsError).toBe(error);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(viewer.result).toBe(displayed);
    expect(viewer.getResultLoadState()).toEqual({
      pendingLoadCaseId: null,
      displayedLoadCaseId: 2,
      failedLoadCaseId: 1,
      error,
    });
    const retry = viewer.retryLoadCase();
    expect(viewer.getResultLoadState()).toEqual({
      pendingLoadCaseId: 1,
      displayedLoadCaseId: 2,
      failedLoadCaseId: null,
      error: null,
    });
    const result = resultFor(1);
    reads.get(1).resolve(result);
    await expectAsync(retry).toBeResolvedTo(result);
    expect(viewer.resultsError).toBeNull();
    expect(viewer.session.getResult).toHaveBeenCalledTimes(3);
    expect(changed).toHaveBeenCalledTimes(4);
    expect(viewer.getResultLoadState()).toEqual({
      pendingLoadCaseId: null,
      displayedLoadCaseId: 1,
      failedLoadCaseId: null,
      error: null,
    });
  });

  it("reports validation errors only for the currently selected field", async () => {
    const { viewer, reads } = fixture;
    const latest = viewer.selectLoadCase(1);
    reads.get(1).resolve({ kind: "invalid" });
    await expectAsync(latest).toBeResolvedTo(null);
    expect(viewer.resultsError.message).toContain('result.kind must be "displacement"');
    expect(viewer.result).toBeNull();
  });

  it("preserves controls changed while a field is pending and emits their settled state", async () => {
    const { viewer, reads, animation, renderer } = fixture;
    const latest = viewer.selectLoadCase(3);
    viewer.setDeformationScale(10);
    viewer.setAnimationPeriod(750);
    viewer.toggleAnimation();
    const changed = jasmine.createSpy("settled state").and.callFake(() => {
      expect(viewer.resultsState.loadCaseId).toBe(3);
      expect(viewer.resultsState.playing).toBe(true);
      expect(viewer.result.loadCaseId).toBe(3);
      expect(viewer.getResultLoadState().pendingLoadCaseId).toBeNull();
      expect(viewer.getResultLoadState().displayedLoadCaseId).toBe(3);
    });
    viewer.onDidChangeResults(changed);
    reads.get(3).resolve(resultFor(3));
    await latest;
    expect(renderer.setDeformationScale).toHaveBeenCalledWith(10);
    expect(animation.setPeriod).toHaveBeenCalledWith(750);
    expect(animation.start).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("clears the case immediately and never starts the obsolete pending read", async () => {
    const { viewer, reads, renderer } = fixture;
    const first = viewer.selectLoadCase(1);
    const pending = viewer.selectLoadCase(2);
    viewer.resultsError = new Error("previous error");
    viewer.toggleAnimation();
    await expectAsync(viewer.selectLoadCase(null)).toBeResolvedTo(null);
    expect(viewer.resultsState.loadCaseId).toBeNull();
    expect(viewer.resultsState.playing).toBe(false);
    expect(viewer.resultsState.cyclePosition).toBeNull();
    expect(viewer.resultsError).toBeNull();
    expect(renderer.setResult.calls.allArgs()).toEqual([[null]]);
    expect(viewer.getResultLoadState()).toEqual({
      pendingLoadCaseId: null,
      displayedLoadCaseId: null,
      failedLoadCaseId: null,
      error: null,
    });
    reads.get(1).resolve(resultFor(1));
    await flushReads();
    await expectAsync(first).toBeResolvedTo(null);
    await expectAsync(pending).toBeResolvedTo(null);
    expect(viewer.session.getResult).toHaveBeenCalledTimes(1);
    expect(viewer.result).toBeNull();
  });

  it("cancels queued results when a graphic has no load case", async () => {
    const { viewer, reads, renderer } = fixture;
    const first = viewer.selectLoadCase(1);
    const pending = viewer.selectLoadCase(2);
    expect(viewer.applyGraphicResults({ scale: 100, playing: true })).toBeNull();
    reads.get(1).resolve(resultFor(1));
    await flushReads();
    await expectAsync(first).toBeResolvedTo(null);
    await expectAsync(pending).toBeResolvedTo(null);
    expect(viewer.session.getResult).toHaveBeenCalledTimes(1);
    expect(viewer.resultsState.scale).toBe(100);
    expect(viewer.resultsState.playing).toBe(false);
    expect(renderer.setResult.calls.allArgs()).toEqual([[null]]);
  });

  it("settles pending callers on destruction and ignores the late completion", async () => {
    const { viewer, reads, renderer } = fixture;
    const first = viewer.selectLoadCase(1);
    const pending = viewer.selectLoadCase(2);
    viewer.destroy();
    await expectAsync(first).toBeResolvedTo(null);
    await expectAsync(pending).toBeResolvedTo(null);
    const validateLate = jasmine.createSpy("validate late field").and.throwError("closed");
    reads.get(1).resolve(Object.defineProperty({}, "kind", { get: validateLate }));
    await flushReads();
    expect(validateLate).not.toHaveBeenCalled();
    expect(renderer.setResult).not.toHaveBeenCalled();
    expect(viewer.session.getResult).toHaveBeenCalledTimes(1);
    expect(viewer.session.dispose).toHaveBeenCalledTimes(1);
    await expectAsync(viewer.selectLoadCase(3)).toBeResolvedTo(null);
  });

  it("discards the old session's completion before reading the adopted session", async () => {
    const { viewer, reads, renderer } = fixture;
    const oldSession = viewer.session;
    const first = viewer.selectLoadCase(1);
    const queued = viewer.selectLoadCase(2);
    const nextRead = deferred();
    const session = {
      describe: async () => ({}),
      getGeometry: async () => viewer.geometry,
      getResult: jasmine.createSpy("new session result").and.returnValue(nextRead.promise),
      dispose: jasmine.createSpy("new session dispose"),
    };
    // Scene loading is separate from the result queue. Adoption still uses its
    // real lifecycle method and must cancel every old selection immediately.
    spyOn(viewer, "load");
    expect(viewer.adoptSession(session)).toBe(true);
    await expectAsync(first).toBeResolvedTo(null);
    await expectAsync(queued).toBeResolvedTo(null);
    expect(oldSession.dispose).toHaveBeenCalledTimes(1);
    const latest = viewer.selectLoadCase(3);
    expect(session.getResult).not.toHaveBeenCalled();
    const validateOld = jasmine.createSpy("old session validation").and.throwError("obsolete");
    reads.get(1).resolve(Object.defineProperty({}, "kind", { get: validateOld }));
    await flushReads();
    expect(validateOld).not.toHaveBeenCalled();
    expect(renderer.setResult).not.toHaveBeenCalled();
    expect(session.getResult).toHaveBeenCalledTimes(1);
    const result = resultFor(3);
    nextRead.resolve(result);
    await expectAsync(latest).toBeResolvedTo(result);
    expect(viewer.result).toBe(result);
  });

  it("does not apply an old field to a replacement scene", async () => {
    const { viewer, reads, renderer } = fixture;
    const first = viewer.selectLoadCase(1);
    const replacement = { ...renderer, setResult: jasmine.createSpy("replacement result") };
    viewer.renderer = replacement;
    const latest = viewer.selectLoadCase(3);
    const validateOld = jasmine.createSpy("old scene validation").and.throwError("obsolete");
    reads.get(1).resolve(Object.defineProperty({}, "kind", { get: validateOld }));
    await flushReads();
    expect(validateOld).not.toHaveBeenCalled();
    expect(renderer.setResult).not.toHaveBeenCalled();
    const result = resultFor(3);
    reads.get(3).resolve(result);
    await expectAsync(first).toBeResolvedTo(null);
    await expectAsync(latest).toBeResolvedTo(result);
    expect(replacement.setResult.calls.allArgs()).toEqual([[result]]);
  });

  it("discards a retried index from an adopted session before validation or restoring graphics", async () => {
    const { viewer, renderer } = fixture;
    const indexRead = deferred();
    viewer.description = { capabilities: { results: { loadCases: true } } };
    viewer.session.getLoadCases = jasmine.createSpy("old index").and.returnValue(indexRead.promise);
    viewer.graphics = [{ results: { loadCaseId: 3 } }];
    viewer.activeGraphicIndex = 0;
    const retried = viewer.retryLoadCase();
    const session = {
      describe: async () => ({}),
      getGeometry: async () => viewer.geometry,
      getResult: jasmine.createSpy("new result"),
      dispose: jasmine.createSpy("new dispose"),
    };
    spyOn(viewer, "load");
    viewer.adoptSession(session);
    const replacement = { ...renderer, setResult: jasmine.createSpy("replacement result") };
    viewer.renderer = replacement;
    const loadCases = [{ id: 3, title: "New model", kind: "eigenmode" }];
    const result = resultFor(3);
    viewer.loadCases = loadCases;
    viewer.result = result;
    const changed = jasmine.createSpy("new session results");
    viewer.onDidChangeResults(changed);
    const validateOld = jasmine.createSpy("old index validation").and.throwError("obsolete index");
    indexRead.resolve([Object.defineProperty({ title: "Old model" }, "id", { get: validateOld })]);
    await expectAsync(retried).toBeResolvedTo(null);
    expect(validateOld).not.toHaveBeenCalled();
    expect(viewer.loadCases).toBe(loadCases);
    expect(viewer.result).toBe(result);
    expect(viewer.resultsError).toBeNull();
    expect(replacement.setResult).not.toHaveBeenCalled();
    expect(session.getResult).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });

  it("discards an index completed after destruction without validating or notifying", async () => {
    const { viewer } = fixture;
    const indexRead = deferred();
    viewer.description = { capabilities: { results: { loadCases: true } } };
    viewer.session.getLoadCases = jasmine.createSpy("index").and.returnValue(indexRead.promise);
    const index = viewer.readLoadCases();
    const changed = jasmine.createSpy("closed results");
    viewer.onDidChangeResults(changed);
    viewer.destroy();
    const validateLate = jasmine.createSpy("late index validation").and.throwError("closed");
    indexRead.resolve([
      Object.defineProperty({ title: "Late model" }, "id", { get: validateLate }),
    ]);
    await expectAsync(index).toBeResolvedTo(null);
    expect(validateLate).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    expect(viewer.loadCases).toEqual([]);
  });

  it("keeps the latest index retry when an earlier retry fails after it succeeded", async () => {
    const { viewer, reads } = fixture;
    const firstRead = deferred();
    const latestRead = deferred();
    viewer.description = { capabilities: { results: { loadCases: true } } };
    viewer.session.getLoadCases = jasmine
      .createSpy("index")
      .and.returnValues(firstRead.promise, latestRead.promise);
    viewer.graphics = [{ results: { loadCaseId: 3 } }];
    viewer.activeGraphicIndex = 0;
    const first = viewer.retryLoadCase();
    const latest = viewer.retryLoadCase();
    latestRead.resolve([{ id: 3, title: "Latest index", kind: "eigenmode" }]);
    await flushReads();
    const result = resultFor(3);
    reads.get(3).resolve(result);
    await expectAsync(latest).toBeResolvedTo(result);
    const changed = jasmine.createSpy("stale index failure");
    viewer.onDidChangeResults(changed);
    firstRead.reject(new Error("obsolete index failure"));
    await expectAsync(first).toBeResolvedTo(null);
    expect(viewer.loadCases.map(({ id }) => id)).toEqual([3]);
    expect(viewer.result).toBe(result);
    expect(viewer.resultsError).toBeNull();
    expect(viewer.session.getResult).toHaveBeenCalledTimes(1);
    expect(changed).not.toHaveBeenCalled();
  });
});
