describe("Graviss concrete source lifetimes", () => {
  let main, viewers, model, TestSession, pointerListeners;
  beforeEach(async () => {
    jasmine.useRealClock();
    for (const method of ["openPath", "openExternal", "openApplication", "showItemInFolder"])
      spyOn(lumine.shell, method).and.resolveTo();
    spyOn(lumine.application, "openWindow").and.resolveTo();
    jasmine.attachToDOM(lumine.workspace.getElement());
    const pack = await lumine.packages.activatePackage("graviss");
    main = pack.mainModule;
    const support = require("./support/test-model");
    TestSession = support.TestSession;
    model = {
      id: "owned-lifetime",
      title: "Owned lifetime model",
      format: "Owned audit",
      createGeometry: support.createFrameGeometry,
    };
    viewers = [];
    pointerListeners = [];
  });
  afterEach(async () => {
    for (const viewer of viewers) viewer.destroy();
    for (const [name, callback, capture] of pointerListeners)
      window.removeEventListener(name, callback, capture);
    await lumine.packages.deactivatePackage("graviss");
  });
  async function open(session = new TestSession(model)) {
    const viewer = main.createViewer(session, { shellDeformationBackend: "cpu" });
    viewers.push(viewer);
    await lumine.workspace.open(viewer);
    await conditionPromise(
      () => !viewer.loading && viewer.renderer,
      "the real owned model/renderer",
    );
    const viewport = viewer.element.querySelector(".graviss-viewport");
    viewport.style.width = "800px";
    viewport.style.height = "400px";
    viewer.renderer.viewportVisibility.refresh();
    viewer.renderer.resize();
    return viewer;
  }

  it("removes the actual global pointer listeners when destroyed during a print-region drag", async () => {
    const viewer = await open();
    const viewport = viewer.element.querySelector(".graviss-viewport");
    viewport.style.width = "800px";
    viewport.style.height = "400px";
    viewer.renderer.resize();
    const bounds = viewport.getBoundingClientRect();
    expect(bounds.width).toBeGreaterThan(0);
    spyOn(window, "addEventListener").and.callThrough();
    spyOn(window, "removeEventListener").and.callThrough();
    viewport.dispatchEvent(
      new PointerEvent("pointerdown", {
        button: 0,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
        clientX: bounds.left + 20,
        clientY: bounds.top + 20,
      }),
    );
    pointerListeners = window.addEventListener.calls
      .allArgs()
      .filter(([name]) => ["pointermove", "pointerup", "pointercancel"].includes(name));
    expect(pointerListeners.map(([name]) => name)).toEqual([
      "pointermove",
      "pointerup",
      "pointercancel",
    ]);
    viewer.destroy();
    for (const [name, callback, capture] of pointerListeners) {
      expect(window.removeEventListener).toHaveBeenCalledWith(name, callback, capture);
    }
    expect(viewer.element.isConnected).toBe(false);
  });

  it("does not combine an obsolete description with a newly adopted source's geometry", async () => {
    let complete;
    const first = new TestSession({ ...model, id: "source-a", title: "Source A" });
    const description = await first.describe();
    first.describe = () =>
      new Promise((resolve) => {
        complete = resolve;
      });
    const second = new TestSession({ ...model, id: "source-b", title: "Source B" });
    const geometry = await second.getGeometry();
    let completeGeometry;
    spyOn(second, "describe").and.callThrough();
    spyOn(second, "getGeometry").and.callFake(
      () =>
        new Promise((resolve) => {
          completeGeometry = resolve;
        }),
    );
    const viewer = main.createViewer(first, { shellDeformationBackend: "cpu" });
    viewers.push(viewer);
    await lumine.workspace.open(viewer);
    const publications = [];
    const subscription = viewer.onDidLoadModel(({ description }) =>
      publications.push(description.model.id),
    );
    try {
      viewer.adoptSession(second);
      complete(description);
      await conditionPromise(
        () => second.getGeometry.calls.count() > 0,
        "the adopted source geometry read",
      );
      expect(second.describe).toHaveBeenCalledTimes(1);
      expect(second.getGeometry).toHaveBeenCalledTimes(1);
      expect(viewer.description.model.id).toBe("source-b");
      viewer.destroy();
      completeGeometry(geometry);
      await conditionPromise(() => !viewer.loading, "the retired old load to settle");
      expect(publications).toEqual([]);
    } finally {
      completeGeometry?.(geometry);
      subscription.dispose();
    }
  });

  it("does not render a frame after an actual animation observer destroys its viewer", async () => {
    const viewer = await open();
    const renderer = viewer.renderer;
    // The native observer can still report the earlier zero-sized test pane.
    // Isolate frame dispatch after checking real positive canvas dimensions.
    expect(renderer.host.clientWidth).toBeGreaterThan(0);
    expect(renderer.host.clientHeight).toBeGreaterThan(0);
    spyOn(renderer, "isViewportDrawable").and.returnValue(true);
    const render = spyOn(renderer.canvasRenderer, "render").and.callThrough();
    const subscription = viewer.onDidChangeAnimationPosition(() => viewer.destroy());
    try {
      renderer.getAnimation().start();
      expect(() => renderer.paintFrame(performance.now())).not.toThrow();
      expect(renderer.destroyed).toBe(true);
      expect(render).not.toHaveBeenCalled();
    } finally {
      subscription.dispose();
    }
  });

  it("retires the renderer before a region completion callback reenters destroy", async () => {
    const viewer = await open();
    const renderer = viewer.renderer;
    const dispose = spyOn(renderer.canvasRenderer, "dispose").and.callThrough();
    const complete = jasmine
      .createSpy("owned region completion")
      .and.callFake(() => renderer.destroy());
    expect(renderer.beginRegionSelection(complete)).toBe(true);
    expect(() => renderer.destroy()).not.toThrow();
    expect(complete).toHaveBeenCalledOnceWith(null);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("loads a live adopted source and keeps its normal animation event usable", async () => {
    const viewer = await open();
    spyOn(viewer, "showError").and.callThrough();
    const oldCube = viewer.renderer.viewCube.canvas;
    const label = oldCube.getAttribute("aria-label");
    const second = new TestSession({ ...model, id: "live-b", title: "Live B" });
    const loaded = jasmine.createSpy("live source publication");
    const subscription = viewer.onDidLoadModel(loaded);
    try {
      viewer.adoptSession(second);
      await conditionPromise(
        () => !viewer.loading && viewer.description?.model.id === "live-b",
        "the current source to finish",
      );
      expect(viewer.showError)
        .withContext(viewer.showError.calls.mostRecent()?.args[0]?.stack ?? "no source error")
        .not.toHaveBeenCalled();
      expect(loaded).toHaveBeenCalledTimes(1);
      expect(viewer.renderer.viewCube.canvas).not.toBe(oldCube);
      expect(viewer.renderer.viewCube.canvas.getAttribute("aria-label")).toBe(label);
      expect(viewer.renderer.viewCube.renderer.getContext().isContextLost()).toBe(false);
      expect(lumine.tooltips.findTooltips(viewer.renderer.viewCube.canvas).length).toBe(1);
      const position = jasmine.createSpy("live animation event");
      const animationSubscription = viewer.onDidChangeAnimationPosition(position);
      try {
        viewer.renderer.getAnimation().seek(0.5);
        expect(position).toHaveBeenCalledWith(0.5);
      } finally {
        animationSubscription.dispose();
      }
    } finally {
      subscription.dispose();
    }
  });

  it("ignores an obsolete description rejection and preserves the adopted live source", async () => {
    let reject;
    const first = new TestSession(model);
    first.describe = () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      });
    const viewer = main.createViewer(first, { shellDeformationBackend: "cpu" });
    viewers.push(viewer);
    await lumine.workspace.open(viewer);
    spyOn(viewer, "showError").and.callThrough();
    const second = new TestSession({ ...model, id: "after-error", title: "After error" });
    viewer.adoptSession(second);
    reject(new Error("Owned obsolete source error"));
    await conditionPromise(
      () => !viewer.loading && viewer.renderer,
      "the current source after an obsolete error",
    );
    expect(viewer.showError).not.toHaveBeenCalled();
    expect(viewer.description.model.id).toBe("after-error");
  });
});
