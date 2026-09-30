const { CompositeDisposable, Emitter } = require("lumine");

function resultFor(loadCaseId) {
  return {
    kind: "displacement",
    loadCaseId,
    components: 3,
    nodes: { ids: [1], values: [0, 0, 0.01] },
    extent: 0.01,
  };
}

// Exercise the view's real document and results-state methods without a WebGL
// context. The renderer's actual clock method forwards position callbacks in
// exactly the same way that a viewport does; only drawing buffers are replaced.
function createViewer(
  graphics = [{ results: { loadCaseId: 1 } }, { results: { loadCaseId: 3 } }],
  { loaded = true } = {},
) {
  const GravissView = require("../lib/graviss-view");
  const { GravissRenderer } = require("../lib/renderer");
  const { GravissViewDocument } = require("../lib/view-document");
  const viewer = Object.create(GravissView.prototype);
  const viewDocument = new GravissViewDocument({ data: { graphics } });
  const frames = [];
  let time = 0;
  let deformation = null;
  const renderer = {
    callbacks: {
      onAnimationPositionChange: (position) =>
        viewer.emitter.emit("did-change-animation-position", position),
    },
    getAnimation: GravissRenderer.prototype.getAnimation,
    getDeformation: () => deformation,
    setResult: jasmine.createSpy("setResult").and.callFake((result) => {
      if (!result && !deformation) return null;
      deformation ||= {
        phase: 1,
        scale: 1,
        automatic: true,
        get factor() {
          return this.phase * this.scale;
        },
      };
      deformation.result = result;
      return deformation;
    }),
    setDeformationPhase: jasmine.createSpy("phase").and.callFake((phase) => {
      if (deformation) deformation.phase = phase;
      frames.push(phase);
    }),
    setDeformationScale: jasmine.createSpy("scale").and.callFake((scale) => {
      if (deformation) {
        deformation.scale = scale;
        deformation.automatic = false;
      }
    }),
    setAutomaticScale: jasmine.createSpy("automatic scale"),
    setColorByDisplacement: jasmine.createSpy("colours"),
    requestRender: jasmine.createSpy("requestRender"),
    destroy: jasmine.createSpy("destroyRenderer"),
  };
  Object.assign(viewer, {
    destroyed: false,
    renderer,
    viewDocument,
    graphics: viewDocument.getData().graphics,
    activeGraphicIndex: 0,
    geometry: { nodes: [{ id: 1, x: 0, y: 0, z: 0 }], elements: [] },
    loadCases: [
      { id: 1, title: "Positive", kind: "linear" },
      { id: 3, title: "Swing", kind: "eigenmode" },
    ],
    resultsState: {
      loadCaseId: 1,
      scale: "auto",
      cycle: null,
      period: null,
      cyclePosition: null,
      playing: false,
      colorByDisplacement: false,
    },
    result: loaded ? resultFor(1) : null,
    resultsError: null,
    failedLoadCaseId: null,
    resultRequest: 0,
    resultRead: null,
    resultSelection: null,
    emitter: new Emitter(),
    subscriptions: new CompositeDisposable(),
    element: document.createElement("div"),
    session: {
      getResult: jasmine
        .createSpy("getResult")
        .and.callFake(async ({ loadCaseId }) => resultFor(loadCaseId)),
      dispose: jasmine.createSpy("disposeSession"),
    },
  });
  viewer.subscriptions.add(
    viewDocument.onDidChange(({ data }) => {
      viewer.graphics = data.graphics;
    }),
  );
  renderer.setResult(viewer.result);
  const animation = renderer.getAnimation();
  animation.now = () => time;
  for (const method of ["seek", "start", "stop", "setPeriod", "setCycle"])
    spyOn(animation, method).and.callThrough();
  spyOn(viewer, "recordResultsState").and.callThrough();
  viewer.applyResultsState(viewer.resultsState, { record: false });
  return {
    viewer,
    renderer,
    animation,
    viewDocument,
    frames,
    at: (next) => {
      time = next;
      return next;
    },
  };
}

describe("Graviss animation view state", () => {
  let fixture;

  beforeEach(() => {
    jasmine.useRealClock();
    fixture = createViewer();
  });

  afterEach(() => {
    fixture.viewer.destroy();
  });

  it("seeks, pauses and saves the requested cycle position including its endpoints", () => {
    const { viewer, renderer, animation, viewDocument } = fixture;
    viewer.toggleAnimation();
    viewer.setAnimationPosition(0.75);
    expect(animation.running).toBe(false);
    expect(viewer.getAnimationPosition()).toBe(0.75);
    expect(renderer.getDeformation().phase).toBeCloseTo(0.5, 9);
    expect(viewDocument.getStoredData().graphics[0].results.cyclePosition).toBe(0.75);
    viewer.setAnimationPosition(4);
    expect(viewer.getAnimationPosition()).toBe(1);
    expect(renderer.getDeformation().phase).toBe(0);
    expect(viewDocument.getStoredData().graphics[0].results.cyclePosition).toBe(1);
    viewer.setAnimationPosition(-1);
    expect(viewer.getAnimationPosition()).toBe(0);
    const saved = viewDocument.serialize().data;
    viewer.setAnimationPosition(Number.NaN);
    expect(viewDocument.serialize().data).toEqual(saved);
  });

  it("freezes the presented frame and resumes it without an immediate jump", () => {
    const { viewer, renderer, animation, viewDocument, frames, at } = fixture;
    viewer.setAnimationPeriod(1000);
    viewer.setAnimationPosition(0.25);
    viewer.toggleAnimation();
    animation.advance(at(250));
    expect(viewer.getAnimationPosition()).toBeCloseTo(0.5, 9);
    expect(renderer.getDeformation().phase).toBe(1);
    at(400);
    viewer.toggleAnimation();
    expect(viewer.getAnimationPosition()).toBeCloseTo(0.5, 9);
    expect(viewDocument.getStoredData().graphics[0].results.cyclePosition).toBeCloseTo(0.5, 9);
    expect(viewer.resultsState.playing).toBe(false);
    at(1000);
    const frameCount = frames.length;
    viewer.toggleAnimation();
    expect(frames.length).toBe(frameCount);
    expect(renderer.getDeformation().phase).toBe(1);
    animation.advance(at(1250));
    expect(viewer.getAnimationPosition()).toBeCloseTo(0.75, 9);
    expect(renderer.getDeformation().phase).toBeCloseTo(0.5, 9);
  });

  it("changes running amplification, period and colours without seeking the clock", () => {
    const { viewer, renderer, animation, frames, at } = fixture;
    viewer.setAnimationPeriod(1000);
    viewer.setAnimationPosition(0.25);
    viewer.toggleAnimation();
    animation.advance(at(100));
    const phase = renderer.getDeformation().phase;
    const frameCount = frames.length;
    animation.seek.calls.reset();
    at(150);
    viewer.setDeformationScale(10);
    viewer.setAnimationPeriod(2000);
    viewer.toggleColorByDisplacement();
    expect(animation.seek).not.toHaveBeenCalled();
    expect(frames.length).toBe(frameCount);
    expect(renderer.getDeformation().phase).toBe(phase);
    expect(renderer.getDeformation().factor).toBeCloseTo(phase * 10, 9);
    expect(viewer.getAnimationPosition()).toBeCloseTo(0.35, 9);
    expect(animation.fractionAt(150)).toBeCloseTo(0.4, 9);
    expect(renderer.setColorByDisplacement).toHaveBeenCalledWith(true);
    animation.advance(at(350));
    expect(viewer.getAnimationPosition()).toBeCloseTo(0.5, 9);
    expect(renderer.getDeformation().phase).toBe(1);
  });

  it("keeps a paused position through controls and interprets it under the selected cycle", () => {
    const { viewer, renderer, animation } = fixture;
    viewer.setAnimationPosition(0.75);
    viewer.setDeformationScale(2);
    viewer.setAnimationPeriod(750);
    viewer.toggleColorByDisplacement();
    expect(viewer.getAnimationPosition()).toBe(0.75);
    expect(renderer.getDeformation().phase).toBeCloseTo(0.5, 9);
    viewer.setAnimationCycle("pingPong");
    expect(animation.cycle).toBe("pingPong");
    expect(viewer.getAnimationPosition()).toBe(0.75);
    expect(renderer.getDeformation().factor).toBe(-2);
    viewer.setAnimationCycle("default");
    expect(animation.cycle).toBe("thereAndBack");
    expect(viewer.resultsState.cycle).toBeNull();
    expect(viewer.getAnimationPosition()).toBe(0.75);
  });

  it("restores old paused graphics at the full positive shape without writing a default position", async () => {
    const { viewer, renderer, viewDocument } = fixture;
    const original = viewDocument.serialize().data;
    const fileState = viewDocument.getFileState();
    await viewer.applyGraphicResults(viewer.activeGraphic.results);
    expect(viewer.getAnimationPosition()).toBe(0.5);
    expect(renderer.getDeformation().phase).toBe(1);
    viewer.activeGraphicIndex = 1;
    await viewer.applyGraphicResults(viewer.activeGraphic.results);
    expect(viewer.getAnimationPosition()).toBe(0.25);
    expect(renderer.getDeformation().phase).toBe(1);
    expect(viewDocument.serialize().data).toEqual(original);
    expect(viewDocument.getFileState()).toBe(fileState);
    expect(viewer.recordResultsState).not.toHaveBeenCalled();
  });

  it("restores each graphic's saved position and playback without mutating either graphic", async () => {
    fixture.viewer.destroy();
    fixture = createViewer([
      { results: { loadCaseId: 1, cyclePosition: 0.5, playing: false } },
      {
        results: {
          loadCaseId: 3,
          cyclePosition: 0.75,
          playing: true,
          period: 1000,
        },
      },
    ]);
    const { viewer, renderer, animation, viewDocument, at } = fixture;
    const original = viewDocument.serialize().data;
    await viewer.applyGraphicResults(viewer.activeGraphic.results);
    expect(viewer.getAnimationPosition()).toBe(0.5);
    expect(animation.running).toBe(false);
    viewer.activeGraphicIndex = 1;
    at(1000);
    await viewer.applyGraphicResults(viewer.activeGraphic.results);
    expect(animation.running).toBe(true);
    expect(viewer.getAnimationPosition()).toBe(0.75);
    expect(renderer.getDeformation().phase).toBe(-1);
    animation.advance(at(1125));
    expect(viewer.getAnimationPosition()).toBeCloseTo(0.875, 9);
    viewer.activeGraphicIndex = 0;
    await viewer.applyGraphicResults(viewer.activeGraphic.results);
    expect(viewer.getAnimationPosition()).toBe(0.5);
    expect(animation.running).toBe(false);
    expect(renderer.getDeformation().phase).toBe(1);
    expect(animation.period).toBe(2000);
    expect(viewDocument.serialize().data).toEqual(original);
  });

  it("restores saved playback before the first result's initial frame", async () => {
    fixture.viewer.destroy();
    fixture = createViewer(
      [{ results: { loadCaseId: 3, cyclePosition: 0.75, playing: true, period: 1000 } }],
      { loaded: false },
    );
    const { viewer, renderer, animation, viewDocument, frames, at } = fixture;
    const original = viewDocument.serialize().data;
    await viewer.applyGraphicResults(viewer.activeGraphic.results);
    expect(viewer.getAnimationPosition()).toBe(0.75);
    expect(renderer.getDeformation().phase).toBe(-1);
    expect(animation.running).toBe(true);
    expect(frames).toEqual([-1]);
    expect(viewDocument.serialize().data).toEqual(original);
    animation.advance(at(250));
    expect(viewer.getAnimationPosition()).toBe(0);
    expect(renderer.getDeformation().phase).toBe(0);
  });

  it("restores saved playback after System cleared an existing deformation engine", async () => {
    fixture.viewer.destroy();
    fixture = createViewer([
      { results: { loadCaseId: 1 } },
      { results: { loadCaseId: 3, cyclePosition: 0.75, playing: true } },
    ]);
    const { viewer, renderer, animation, viewDocument } = fixture;
    await viewer.selectLoadCase(null);
    expect(renderer.getDeformation().result).toBeNull();
    const original = viewDocument.serialize().data;
    viewer.activeGraphicIndex = 1;
    await viewer.applyGraphicResults(viewer.activeGraphic.results);
    expect(viewer.getAnimationPosition()).toBe(0.75);
    expect(renderer.getDeformation().phase).toBe(-1);
    expect(animation.running).toBe(true);
    expect(viewDocument.serialize().data).toEqual(original);
  });

  it("restores a first saved result after its failed read is retried", async () => {
    fixture.viewer.destroy();
    fixture = createViewer(
      [{ results: { loadCaseId: 3, cyclePosition: 0.75, playing: true, period: 1000 } }],
      { loaded: false },
    );
    const { viewer, renderer, animation } = fixture;
    let attempts = 0;
    viewer.session.getResult.and.callFake(async ({ loadCaseId }) => {
      if (++attempts === 1) throw new Error("temporary read failure");
      return resultFor(loadCaseId);
    });
    await viewer.applyGraphicResults(viewer.activeGraphic.results);
    expect(viewer.getResultLoadState().failedLoadCaseId).toBe(3);
    expect(viewer.getAnimationPosition()).toBeNull();
    await viewer.retryLoadCase();
    expect(viewer.resultsError).toBeNull();
    expect(viewer.getAnimationPosition()).toBe(0.75);
    expect(renderer.getDeformation().phase).toBe(-1);
    expect(animation.running).toBe(true);
    expect(viewer.session.getResult).toHaveBeenCalledTimes(2);
  });

  it("upgrades a shared pending read to the latest graphic's saved playback position", async () => {
    fixture.viewer.destroy();
    fixture = createViewer(
      [
        { results: { loadCaseId: 3, cyclePosition: 0.25, playing: true } },
        { results: { loadCaseId: 3, cyclePosition: 0.75, playing: true } },
      ],
      { loaded: false },
    );
    const { viewer, renderer, animation, viewDocument } = fixture;
    const original = viewDocument.serialize().data;
    const first = viewer.selectLoadCase(3, { record: false });
    expect(viewer.resultSelection.restorePosition).toBe(false);
    viewer.activeGraphicIndex = 1;
    const latest = viewer.applyGraphicResults(viewer.activeGraphic.results);
    expect(viewer.resultSelection.restorePosition).toBe(true);
    const [firstResult, latestResult] = await Promise.all([first, latest]);
    expect(firstResult).toBe(latestResult);
    expect(viewer.session.getResult).toHaveBeenCalledTimes(1);
    expect(viewer.getAnimationPosition()).toBe(0.75);
    expect(renderer.getDeformation().phase).toBe(-1);
    expect(animation.running).toBe(true);
    expect(viewDocument.serialize().data).toEqual(original);
  });

  it("starts old playing graphics with no saved position at zero without writing one", async () => {
    fixture.viewer.destroy();
    fixture = createViewer(
      [
        { results: { loadCaseId: 1, playing: true } },
        { results: { loadCaseId: 3, playing: true } },
      ],
      { loaded: false },
    );
    const { viewer, renderer, animation, viewDocument } = fixture;
    const original = viewDocument.serialize().data;
    for (const index of [0, 1]) {
      viewer.activeGraphicIndex = index;
      await viewer.applyGraphicResults(viewer.activeGraphic.results);
      expect(viewer.getAnimationPosition()).toBe(0);
      expect(renderer.getDeformation().phase).toBe(0);
      expect(animation.running).toBe(true);
    }
    expect(viewDocument.serialize().data).toEqual(original);
    expect(viewer.recordResultsState).not.toHaveBeenCalled();
  });

  it("forwards frame position callbacks without recording document changes", () => {
    const { viewer, animation, viewDocument, at } = fixture;
    viewer.setAnimationPeriod(1000);
    viewer.setAnimationPosition(0.25);
    viewer.toggleAnimation();
    const changed = jasmine.createSpy("animation position");
    viewer.onDidChangeAnimationPosition(changed);
    viewer.recordResultsState.calls.reset();
    const update = spyOn(viewDocument, "update").and.callThrough();
    const text = viewDocument.getSourceBuffer().getText();
    const saved = viewDocument.serialize().data;
    animation.advance(at(250));
    animation.advance(at(500));
    expect(changed.calls.allArgs()).toEqual([[0.5], [0.75]]);
    expect(viewer.recordResultsState).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(viewDocument.getSourceBuffer().getText()).toBe(text);
    expect(viewDocument.serialize().data).toEqual(saved);
    expect(viewer.resultsState.cyclePosition).toBe(0.25);
  });

  it("clears a saved position and playback when System replaces the displayed result", async () => {
    const { viewer, renderer, animation, viewDocument } = fixture;
    viewer.setAnimationPosition(0.75);
    viewer.toggleAnimation();
    await viewer.selectLoadCase(null);
    expect(viewer.getAnimationPosition()).toBeNull();
    expect(viewer.result).toBeNull();
    expect(viewer.resultsState.cyclePosition).toBeNull();
    expect(viewer.resultsState.playing).toBe(false);
    expect(animation.running).toBe(false);
    expect(renderer.getDeformation().phase).toBe(0);
    expect(viewDocument.getStoredData().graphics[0].results).toBeUndefined();
    const saved = viewDocument.serialize().data;
    viewer.setAnimationPosition(0.5);
    expect(viewDocument.serialize().data).toEqual(saved);
  });
});
