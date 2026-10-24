const { ViewCube } = require("../lib/view-cube");
const { loadThreeRuntime } = require("../lib/three-runtime");

describe("Graviss view cube rendering", () => {
  let THREE;
  let canvas;
  let cube;

  beforeAll(async () => {
    ({ THREE } = await loadThreeRuntime());
  });

  beforeEach(() => {
    canvas = document.createElement("canvas");
    Object.assign(canvas.style, { width: "120px", height: "120px" });
    jasmine.attachToDOM(canvas);
    cube = new ViewCube(THREE, canvas);
  });

  afterEach(() => {
    cube?.destroy();
    canvas?.remove();
  });

  function pointerFor(viewId) {
    const region = cube.displayTargets
      .get(viewId)
      .displayObjects.find((object) => object.parent.name === "top-face");
    const point = region.getWorldPosition(new THREE.Vector3()).project(cube.camera);
    const bounds = canvas.getBoundingClientRect();
    return {
      clientX: bounds.left + ((point.x + 1) / 2) * bounds.width,
      clientY: bounds.top + ((1 - point.y) / 2) * bounds.height,
    };
  }

  it("keeps invisible faces, edges, and corners pickable without drawing their highlights", () => {
    expect(cube.pickTargets.every((object) => !object.visible)).toBe(true);
    expect(cube.renderer.info.render.calls).toBe(13);
    for (const [viewId, part] of [
      ["top", "face"],
      ["top-front", "edge"],
      ["top-front-right", "corner"],
    ]) {
      const pointer = pointerFor(viewId);
      expect(cube.pick(pointer)?.viewId).toBe(viewId);
      cube.handlePointerMove(pointer);
      expect(cube.hoveredView).toBe(viewId);
      expect(canvas.dataset.hoverPart).toBe(part);
      expect(cube.displayTargets.get(viewId).displayObjects.every((object) => object.visible)).toBe(
        true,
      );
      cube.handlePointerLeave();
      expect(cube.pickTargets.every((object) => !object.visible)).toBe(true);
      expect(cube.renderer.info.render.calls).toBe(13);
    }
  });

  it("preserves selected highlights when rotating and clears a hover only once", () => {
    cube.setSelection("front");
    const paintTargets = spyOn(cube, "paintTargets").and.callThrough();
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(10, -8, 6);
    camera.lookAt(0, 0, 0);
    cube.update(camera.quaternion);
    expect(paintTargets).not.toHaveBeenCalled();
    expect(cube.displayTargets.get("front").displayObjects.every((object) => object.visible)).toBe(
      true,
    );
    cube.update(new THREE.Quaternion());
    cube.handlePointerMove(pointerFor("top"));
    paintTargets.calls.reset();
    camera.position.set(10, -7, 6);
    camera.lookAt(0, 0, 0);
    cube.update(camera.quaternion);
    expect(paintTargets.calls.count()).toBe(1);
    expect(cube.hoveredView).toBeNull();
    expect(cube.displayTargets.get("top").displayObjects.every((object) => !object.visible)).toBe(
      true,
    );
    expect(cube.displayTargets.get("front").displayObjects.every((object) => object.visible)).toBe(
      true,
    );
    camera.position.set(10, -6, 6);
    camera.lookAt(0, 0, 0);
    cube.update(camera.quaternion);
    expect(paintTargets.calls.count()).toBe(1);
  });
});
