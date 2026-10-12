describe("Graviss pane copies", () => {
  let main, items, model, TestSession;

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    main = (await lumine.packages.activatePackage("graviss")).mainModule;
    const support = require("./support/test-model");
    TestSession = support.TestSession;
    model = support.FRAME_MODEL;
    items = [];
  });

  afterEach(async () => {
    for (const item of items) item.destroy();
    await lumine.packages.deactivatePackage("graviss");
  });

  it("retains one document and session while independently rendering and closing each view", async () => {
    const session = new TestSession(model);
    spyOn(session, "dispose").and.callThrough();
    const viewDocument = main.createViewDocument({ filePath: model.viewDocumentPath });
    const original = main.createViewer(session, {
      viewDocument,
      uri: model.viewDocumentPath,
      shellDeformationBackend: "cpu",
    });
    items.push(original);
    await lumine.workspace.open(original);
    await conditionPromise(() => original.renderer && !original.loading);
    const camera = original.renderer.captureCameraState();
    original.updateCamera(camera);
    const copy = original.copy();
    items.push(copy);
    expect(copy.viewDocument).toBe(viewDocument);
    expect(copy.session).toBe(session);
    expect(copy.element).not.toBe(original.element);
    expect(main.viewers.has(copy)).toBe(true);
    await lumine.workspace.open(copy);
    await conditionPromise(() => copy.renderer && !copy.loading);
    expect(copy.renderer).not.toBe(original.renderer);
    expect(copy.renderer.captureCameraState()).toEqual(camera);
    const copiedCamera = copy.renderer.captureCameraState();
    original.renderer.camera.position.x += 10;
    original.renderer.notifyCameraChange();
    expect(copy.renderer.captureCameraState()).toEqual(copiedCamera);
    original.destroy();
    expect(session.dispose).not.toHaveBeenCalled();
    expect(viewDocument.destroyed).toBe(false);
    expect(copy.renderer.destroyed).not.toBe(true);
    copy.destroy();
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(viewDocument.destroyed).toBe(true);
  });

  it("rejects an aborted copy without retaining its shared source", () => {
    const session = new TestSession(model);
    const original = main.createViewer(session, { shellDeformationBackend: "cpu" });
    items.push(original);
    const controller = new AbortController();
    controller.abort();
    expect(() => original.copy({ signal: controller.signal })).toThrow();
    expect(main.viewers.size).toBe(1);
  });
});
