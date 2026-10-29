const { FRAME_MODEL, TestSession } = require("./support/test-model");

describe("Graviss pane-item metadata", () => {
  let main, views;

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    main = (await lumine.packages.activatePackage("graviss")).mainModule;
    views = [];
  });

  afterEach(async () => {
    for (const view of views) view.destroy();
    await lumine.packages.deactivatePackage("graviss");
  });

  const values = (sections, id) =>
    Object.fromEntries(
      (sections.find((section) => section.id === id)?.rows || []).map(({ id, value }) => [
        id,
        value,
      ]),
    );

  async function loadedView() {
    const model = {
      ...FRAME_MODEL,
      loadCases: [
        { id: 1, title: "Dead load", kind: "linear" },
        { id: 2, title: "First mode", kind: "eigenmode" },
      ],
    };
    const session = new TestSession(model);
    spyOn(session, "describe").and.callThrough();
    spyOn(session, "getGeometry").and.callThrough();
    spyOn(session, "getLoadCases").and.callThrough();
    const viewDocument = main.createViewDocument({ fallbackData: model.viewDocument });
    const view = main.createViewer(session, { viewDocument });
    views.push(view);
    view.element.style.position = "absolute";
    view.element.style.inset = "0";
    jasmine.attachToDOM(view.element);
    await conditionPromise(() => !view.loading, "the model to finish loading");
    expect(view.renderer).not.toBeNull();
    return { view, session, model };
  }

  it("inspects a new view without starting a model read or creating a renderer", async () => {
    const view = main.provideLauncher().create();
    views.push(view);
    await conditionPromise(() => !view.loading);
    spyOn(view, "load").and.callThrough();
    spyOn(view.session, "describe").and.callThrough();
    spyOn(view.session, "getGeometry").and.callThrough();

    const metadata = view.getMetadata();
    expect(values(metadata, "graviss-view")).toEqual({
      title: "Untitled",
      state: "unmodified",
      graphics: 1,
      "active-graphic": "Graphic 1",
    });
    expect(metadata.map(({ id }) => id)).toEqual(["graviss-view"]);
    expect(view.renderer).toBeNull();
    expect(view.load).not.toHaveBeenCalled();
    expect(view.session.describe).not.toHaveBeenCalled();
    expect(view.session.getGeometry).not.toHaveBeenCalled();
  });

  it("reports real loaded geometry and source details without another source request", async () => {
    const { view, session } = await loadedView();
    const before = [
      session.describe.calls.count(),
      session.getGeometry.calls.count(),
      session.getLoadCases.calls.count(),
    ];
    const metadata = view.getMetadata();
    expect(values(metadata, "graviss-view").graphics).toBe(3);
    expect(values(metadata, "graviss-model")).toEqual({
      title: FRAME_MODEL.title,
      id: "frame",
      source: "Spec fixture",
      "up-axis": "Z",
      handedness: "right",
      "load-cases": 2,
    });
    expect(values(metadata, "graviss-geometry")).toEqual({
      nodes: 15,
      elements: 18,
      members: 18,
      shells: 0,
      supports: 6,
      sections: 0,
    });
    expect([
      session.describe.calls.count(),
      session.getGeometry.calls.count(),
      session.getLoadCases.calls.count(),
    ]).toEqual(before);
  });

  it("invalidates changed graphics and result indexes while ignoring camera and result presentation", async () => {
    const { view, model } = await loadedView();
    const changed = jasmine.createSpy("metadata changed");
    const subscription = view.onDidChangeMetadata(changed);
    view.addGraphic();
    expect(changed).toHaveBeenCalled();
    expect(values(view.getMetadata(), "graviss-view").graphics).toBe(4);
    changed.calls.reset();
    view.updateCamera(view.renderer.captureCameraState());
    view.setDeformationScale(3);
    expect(changed).not.toHaveBeenCalled();

    model.loadCases = [...model.loadCases, { id: 3, title: "Wind", kind: "linear" }];
    await view.readLoadCases();
    expect(changed).toHaveBeenCalled();
    expect(values(view.getMetadata(), "graviss-model")["load-cases"]).toBe(3);
    subscription.dispose();
    changed.calls.reset();
    view.addGraphic();
    expect(changed).not.toHaveBeenCalled();
  });

  it("honors cancellation and releases metadata observers when the view is destroyed", async () => {
    const view = main.provideLauncher().create();
    views.push(view);
    await conditionPromise(() => !view.loading);
    const controller = new AbortController();
    controller.abort();
    expect(() => view.getMetadata({ signal: controller.signal })).toThrow();
    const observer = view.onDidChangeMetadata(() => {});
    spyOn(observer, "dispose").and.callThrough();
    view.destroy();
    expect(observer.dispose).toHaveBeenCalled();
    expect(view.getMetadata()).toEqual([]);
    expect(() => view.onDidChangeMetadata(() => {}).dispose()).not.toThrow();
  });
});
