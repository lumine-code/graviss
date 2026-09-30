describe("Graviss selection respects the element filter", () => {
  let renderer;
  let root;

  afterEach(() => {
    renderer?.destroy();
    root?.remove();
    renderer = null;
  });

  async function create(geometry) {
    root = document.createElement("div");
    root.className = "graviss";
    root.style.cssText = "position:fixed;inset:0;width:640px;height:480px";
    root.innerHTML = `<div class="host" style="width:640px;height:480px"></div>
      <canvas class="graviss-view-cube" style="width:64px;height:64px"></canvas>
      <svg class="graviss-axis-gizmo">${["x", "y", "z"].map((axis) => `<g data-gizmo-axis="${axis}"><line/><circle/><text/></g>`).join("")}</svg>`;
    jasmine.attachToDOM(root);
    const host = root.querySelector(".host");
    const { GravissRenderer } = require("../lib/renderer");
    const onSelectionChange = jasmine.createSpy("selection");
    renderer = await GravissRenderer.create(
      host,
      geometry,
      { onSelectionChange },
      { deferInitialRender: true, shellDeformationBackend: "cpu" },
    );
    renderer.requestRender = () => {};
    renderer.updateDepthRange = () => {};
    renderer.setSectionRendering(false);
    const THREE = renderer.THREE;
    renderer.camera = new THREE.PerspectiveCamera(40, 640 / 480, 0.1, 100);
    renderer.camera.position.set(0, 0, 10);
    renderer.camera.lookAt(0, 0, 0);
    renderer.camera.updateMatrixWorld(true);
    renderer.scene.updateMatrixWorld(true);
    renderer.raycaster.params.Line.threshold = 0.001;
    return renderer;
  }

  function geometry(kind) {
    return {
      nodes: [
        { id: 1, x: -1, y: 0, z: 0 },
        { id: 2, x: 1, y: 0, z: 0 },
        { id: 3, x: 0, y: 0, z: 2 },
        { id: 4, x: 1, y: 0, z: 2 },
      ],
      elements: [
        { id: "visible", kind: "beam", nodeIds: [1, 2] },
        {
          id: "excluded",
          kind,
          nodeIds: [3, 4],
          ...(kind === "spring" ? { stiffness: 1000 } : {}),
        },
      ],
      supports: [],
    };
  }

  function eventAt(point) {
    const projected = point.clone().project(renderer.camera);
    return { clientX: (projected.x + 1) * 320, clientY: (1 - projected.y) * 240 };
  }

  function rawHit(event) {
    renderer.pointerFromEvent(event);
    renderer.raycaster.setFromCamera(renderer.pointer, renderer.camera);
    return renderer.raycaster.intersectObjects(
      renderer.pickables.filter((mesh) => renderer.isObjectVisible(mesh)),
      false,
    )[0];
  }

  for (const kind of ["beam", "spring", "coupling"]) {
    it(`rejects a nearer collapsed excluded ${kind} for both exact selection and wheel depth`, async () => {
      const model = await create(geometry(kind));
      model.setElementFilter((entity) => entity.id === "visible");
      const event = { clientX: 320, clientY: 240 };
      const raw = rawHit(event);
      // The unfiltered THREE ray really does hit the collapsed point first.
      // No fake intersections stand in for the regression this protects.
      expect(model.resolveIntersection(raw)?.entity.id).toBe("excluded");
      expect(model.resolveIntersection(model.intersectionAt(event))?.entity.id).toBe("visible");
      expect(model.resolveIntersection(model.zoomIntersectionAt(event))?.entity.id).toBe("visible");
      model.pick(event);
      expect(model.selected?.entity.id).toBe("visible");
      expect(model.selected?.type).toBe("element");
    });
  }

  for (const kind of ["spring", "coupling"]) {
    it(`clears a real picked ${kind} when the element filter hides it`, async () => {
      const model = await create(geometry(kind));
      const connector = model.connectors[kind];
      const positions = connector.lines.geometry.getAttribute("position");
      const range = connector.entityRanges[0];
      let selected = false;
      for (let vertex = range.start; vertex < range.start + range.count; vertex += 2) {
        const first = new model.THREE.Vector3().fromBufferAttribute(positions, vertex);
        const second = new model.THREE.Vector3().fromBufferAttribute(positions, vertex + 1);
        if (first.equals(second)) continue;
        const event = eventAt(first.add(second).multiplyScalar(0.5));
        model.pick(event);
        if (model.selected?.entity.id === "excluded") {
          selected = true;
          break;
        }
      }
      expect(selected).toBe(true);
      expect(model.selected?.type).toBe(kind);
      model.setElementFilter((entity) => entity.id === "visible");
      expect(Boolean(model.selected)).toBe(false);
      expect(model.callbacks.onSelectionChange.calls.mostRecent().args).toEqual([null]);
    });
  }

  it("retains the active shell zoom proxy without entity metadata behind an excluded point", async () => {
    const model = await create({
      nodes: [
        { id: 1, x: -1, y: -1, z: 0 },
        { id: 2, x: 1, y: -1, z: 0 },
        { id: 3, x: 1, y: 1, z: 0 },
        { id: 4, x: -1, y: 1, z: 0 },
        { id: 5, x: 0, y: 0, z: 2 },
        { id: 6, x: 1, y: 0, z: 2 },
      ],
      elements: [
        { id: "surface", kind: "shell", nodeIds: [1, 2, 3, 4] },
        { id: "excluded", kind: "beam", nodeIds: [5, 6] },
      ],
      supports: [],
    });
    model.setElementFilter((entity) => entity.id === "surface");
    const hit = model.zoomIntersectionAt({ clientX: 320, clientY: 240 });
    expect(hit?.object === model.meshes.shells.userData.gravissZoomProxy).toBe(true);
    expect(hit?.point.z).toBeCloseTo(0, 8);
    model.pick({ clientX: 320, clientY: 240 });
    expect(model.selected?.entity.id).toBe("surface");
  });

  it("keeps a selected node when the filter changes the finite element set", async () => {
    const model = await create({
      nodes: [
        { id: 1, x: -1, y: 0, z: 0 },
        { id: 2, x: 1, y: 0, z: 0 },
      ],
      elements: [{ id: "member", kind: "beam", nodeIds: [1, 2] }],
      supports: [],
    });
    model.setVisibility("nodes", true);
    model.scene.updateMatrixWorld(true);
    model.pick(eventAt(new model.THREE.Vector3(-1, 0, 0)));
    expect(model.selected?.type).toBe("node");
    expect(model.selected?.entity.id).toBe(1);
    model.setElementFilter(() => false);
    expect(model.selected?.type).toBe("node");
    expect(model.selected?.entity.id).toBe(1);
  });
});
