const { phaseOf } = require("../lib/animation");

const MODEL = {
  nodes: [
    { id: 1, x: 0, y: 0, z: 0 },
    { id: 2, x: 2, y: 0, z: 0 },
    { id: 3, x: 2, y: 1, z: 0 },
  ],
  elements: [{ id: "beam", kind: "beam", nodeIds: [1, 2] }],
  supports: [],
};

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("Graviss renderer viewport lifecycle", () => {
  let fixtures;

  beforeEach(() => {
    jasmine.useRealClock();
    fixtures = [];
  });

  afterEach(() => {
    for (const { renderer, element } of fixtures) {
      renderer?.destroy();
      element.remove();
    }
  });

  async function createFixture(left = 0) {
    const element = document.createElement("div");
    element.className = "graviss";
    Object.assign(element.style, {
      position: "fixed",
      left: `${left}px`,
      top: "0",
      width: "640px",
      height: "480px",
    });
    element.innerHTML = `
      <div class="graviss-canvas-host" style="width:640px;height:480px"></div>
      <div class="graviss-orbit-pivot" hidden></div>
      <div class="graviss-print-region" hidden></div>
      <canvas class="graviss-view-cube" style="position:absolute;right:0;top:0;width:64px;height:64px"></canvas>
      <div class="graviss-axis-gizmo" hidden>
        <svg viewBox="0 0 84 84">
          <g data-gizmo-axis="x"><line/><circle/><text>X</text></g>
          <g data-gizmo-axis="y"><line/><circle/><text>Y</text></g>
          <g data-gizmo-axis="z"><line/><circle/><text>Z</text></g>
        </svg>
      </div>
    `;
    jasmine.attachToDOM(element);
    const fixture = { element, host: element.querySelector(".graviss-canvas-host") };
    fixtures.push(fixture);
    const { GravissRenderer } = require("../lib/renderer");
    fixture.renderer = await GravissRenderer.create(fixture.host, MODEL);
    const renderer = fixture.renderer;
    await conditionPromise(
      () => renderer.isViewportDrawable(),
      "the attached viewport to be visible",
      2000,
    );
    expect(fixture.host.clientWidth).toBe(640);
    expect(fixture.host.clientHeight).toBe(480);
    renderer.setResult({
      kind: "displacement",
      loadCaseId: 1,
      components: 3,
      nodes: { ids: [2], values: [0, 0, 0.1] },
      extent: 0.1,
    });
    renderer.setDeformationScale(1);
    fixture.paints = spyOn(renderer.canvasRenderer, "render").and.callThrough();
    fixture.animation = renderer.getAnimation();
    fixture.animation.setCycle("pingPong");
    fixture.animation.setPeriod(2000);
    fixture.advances = spyOn(fixture.animation, "advance").and.callThrough();
    fixture.animation.start();
    await conditionPromise(
      () => fixture.advances.calls.count() >= 2,
      "the visible viewport to paint timed animation frames",
      2000,
    );
    return fixture;
  }

  function expectCurrentClock(fixture, startedAt) {
    expect(fixture.animation.running).toBe(true);
    expect(fixture.animation.startedAt).toBe(startedAt);
    const timestamp = fixture.advances.calls.mostRecent().args[0];
    const phase = phaseOf(
      fixture.animation.cycle,
      (timestamp - startedAt) / fixture.animation.period,
    );
    expect(fixture.renderer.getDeformation().phase).toBeCloseTo(phase, 9);
  }

  it("suspends hidden paints and resumes the running animation on its existing clock", async () => {
    const fixture = await createFixture();
    const { renderer, host, paints, advances, animation } = fixture;
    const startedAt = animation.startedAt;
    host.style.display = "none";
    await conditionPromise(
      () => !renderer.viewportVisible,
      "the display-none viewport to suspend",
      2000,
    );
    const paintCount = paints.calls.count();
    const advanceCount = advances.calls.count();
    const hiddenPhase = renderer.getDeformation().phase;
    renderer.requestRender();
    renderer.flushRender();
    renderer.paintFrame(performance.now());
    await wait(150);
    expect(paints.calls.count()).toBe(paintCount);
    expect(advances.calls.count()).toBe(advanceCount);
    expect(renderer.renderFrame).toBeNull();
    expect(animation.running).toBe(true);
    expect(animation.startedAt).toBe(startedAt);
    expect(renderer.getDeformation().phase).toBe(hiddenPhase);

    host.style.display = "";
    await conditionPromise(
      () => renderer.isViewportDrawable() && advances.calls.count() > advanceCount,
      "the shown viewport to resume timed frames",
      2000,
    );
    expect(paints.calls.count()).toBeGreaterThan(paintCount);
    expectCurrentClock(fixture, startedAt);
  }, 10000);

  it("rejects paints immediately after detachment and resumes after reconnection", async () => {
    const fixture = await createFixture();
    const { renderer, element, paints, advances, animation } = fixture;
    const startedAt = animation.startedAt;
    const paintCount = paints.calls.count();
    const advanceCount = advances.calls.count();
    element.remove();
    expect(renderer.isViewportDrawable()).toBe(false);
    renderer.requestRender();
    renderer.flushRender();
    renderer.paintFrame(performance.now());
    await conditionPromise(
      () => !renderer.viewportVisible,
      "the detached viewport to suspend",
      2000,
    );
    await wait(120);
    expect(paints.calls.count()).toBe(paintCount);
    expect(advances.calls.count()).toBe(advanceCount);
    expect(animation.running).toBe(true);
    expect(animation.startedAt).toBe(startedAt);

    jasmine.attachToDOM(element);
    await conditionPromise(
      () => renderer.isViewportDrawable() && advances.calls.count() > advanceCount,
      "the reconnected viewport to resume timed frames",
      2000,
    );
    expect(paints.calls.count()).toBeGreaterThan(paintCount);
    expectCurrentClock(fixture, startedAt);
  }, 10000);

  it("keeps both visible viewports animating when only one canvas has focus", async () => {
    const first = await createFixture();
    const second = await createFixture(Math.min(320, Math.max(0, window.innerWidth - 640)));
    const firstCount = first.advances.calls.count();
    const secondCount = second.advances.calls.count();
    first.renderer.canvasRenderer.domElement.focus();
    expect(document.activeElement).toBe(first.renderer.canvasRenderer.domElement);
    expect(document.activeElement).not.toBe(second.renderer.canvasRenderer.domElement);
    await conditionPromise(
      () =>
        first.advances.calls.count() >= firstCount + 2 &&
        second.advances.calls.count() >= secondCount + 2,
      "both visible renderers to keep advancing regardless of canvas focus",
      2000,
    );
    expect(first.renderer.isViewportDrawable()).toBe(true);
    expect(second.renderer.isViewportDrawable()).toBe(true);
    expect(first.animation.running).toBe(true);
    expect(second.animation.running).toBe(true);
  }, 10000);
});
