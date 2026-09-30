const { GravissRenderer } = require("../lib/renderer");
const { loadThreeRuntime } = require("../lib/three-runtime");

describe("Graviss deformation work", () => {
  let runtime;
  let renderer;

  beforeAll(async () => {
    runtime = await loadThreeRuntime();
  });

  afterEach(() => {
    renderer?.scene.traverse((object) => {
      object.geometry?.dispose();
      if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose());
      else object.material?.dispose();
    });
    renderer?.frameRateMeter.dispose();
    renderer = null;
  });

  function create(geometry) {
    const { THREE, OrbitControls, ...wideLines } = runtime;
    renderer = new GravissRenderer({}, geometry, {}, THREE, OrbitControls, wideLines);
    renderer.requestRender = () => {};
    renderer.updateDepthRange = () => {};
    renderer.scene = new THREE.Scene();
    renderer.worldUp = new THREE.Vector3(0, 0, 1);
    renderer.modelYAxis = new THREE.Vector3(0, 1, 0);
    renderer.createModelGeometry();
    renderer.applyVisibility();
    return renderer;
  }

  function shells() {
    return {
      nodes: [
        { id: 1, x: 0, y: 0, z: 0 },
        { id: 2, x: 1, y: 0, z: 0 },
        { id: 3, x: 2, y: 0, z: 0 },
        { id: 4, x: 0, y: 1, z: 0 },
        { id: 5, x: 1, y: 1, z: 0 },
        { id: 6, x: 2, y: 1, z: 0 },
      ],
      elements: [
        {
          id: "A",
          kind: "shell",
          nodeIds: [1, 2, 5, 4],
          thickness: [0.2, 0.3, 0.3, 0.2],
          offset: 0.1,
        },
        {
          id: "B",
          kind: "shell",
          nodeIds: [2, 3, 6, 5],
          thickness: [0.3, 0.4, 0.4, 0.3],
          offset: 0.1,
        },
      ],
      supports: [],
    };
  }

  function result(nodes) {
    return {
      kind: "displacement",
      loadCaseId: 1,
      components: 6,
      nodes: {
        ids: nodes.map((node) => node.id),
        values: nodes.flatMap((node) => [
          0,
          0,
          node.x * node.y * 0.02,
          0.01 * node.y,
          0.01 * node.x,
          0,
        ]),
      },
      extent: 0.04,
    };
  }

  it("rebuilds thick shell topology and rest directors independently of the current phase", () => {
    const geometry = shells();
    const model = create(geometry);
    model.setResult(result(geometry.nodes));
    model.setDeformationScale(10);
    model.setDeformationPhase(0);
    const restNormals = Array.from(model.shellState.restNormals);
    const restPositions = Array.from(model.shellState.positions);
    const indices = Array.from(model.shellState.indexValues);
    for (const phase of [0.5, -0.5]) {
      model.setDeformationPhase(phase);
      const positions = Array.from(model.shellState.positions);
      model.setSectionRendering(false);
      model.setSectionRendering(true);
      expect(Array.from(model.shellState.restNormals)).toEqual(restNormals);
      expect(Array.from(model.shellState.indexValues)).toEqual(indices);
      expect(Array.from(model.shellState.positions)).toEqual(positions);
      model.setDeformationPhase(0);
      expect(Array.from(model.shellState.positions)).toEqual(restPositions);
    }
  });

  it("allocates one line segment for linear members and independent ranges for Hermite members", () => {
    const geometry = {
      nodes: [
        { id: 1, x: 0, y: 0, z: 0 },
        { id: 2, x: 1, y: 0, z: 0 },
        { id: 3, x: 2, y: 0, z: 0 },
      ],
      elements: [
        { id: "A", kind: "beam", nodeIds: [1, 2], lineInterpolation: "linear" },
        { id: "B", kind: "beam", nodeIds: [2, 3] },
      ],
      supports: [],
    };
    const model = create(geometry);
    const field = result(geometry.nodes);
    field.elements = geometry.elements.map((element) => ({
      id: element.id,
      stations: [
        { x: 0, u: [0, 0, 0], phi: [0.1, 0, 0.1], warping: 0.1 },
        { x: 1, u: [0, 0, 0], phi: [0.2, 0, -0.1], warping: 0.2 },
      ],
    }));
    model.setResult(field);
    model.setSectionRendering(false);
    expect(model.memberLines.userData.gravissLineSteps).toEqual([1, 8]);
    expect(model.memberLines.userData.gravissEntityRanges).toEqual([
      { start: 0, count: 2 },
      { start: 2, count: 16 },
    ]);
    expect(model.memberLines.geometry.getAttribute("position").count).toBe(18);
    model.setResult({ ...field, elements: [] });
    expect(model.memberLines.userData.gravissLineSteps).toEqual([1, 1]);
    expect(model.memberLines.geometry.getAttribute("position").count).toBe(4);
  });

  it("keeps local-axis buffers and materials while following the current element centre", () => {
    const geometry = shells();
    geometry.elements[0].localAxes = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    const model = create(geometry);
    model.setResult(result(geometry.nodes));
    model.setVisibility("localAxes", true);
    const object = model.localAxes;
    const buffer = object.geometry.getAttribute("position");
    const colors = object.geometry.getAttribute("color");
    const positions = Array.from(buffer.array);
    model.setDeformationPhase(-0.5);
    expect(model.localAxes).toBe(object);
    expect(model.localAxes.geometry.getAttribute("position")).toBe(buffer);
    expect(model.localAxes.geometry.getAttribute("color")).toBe(colors);
    expect(Array.from(buffer.array)).not.toEqual(positions);
    model.setSectionRendering(false);
    expect(model.localAxes).toBe(object);
  });

  it("does not rewrite a zero-scaled pose, but accepts a new rotational field", () => {
    const geometry = shells();
    const model = create(geometry);
    model.setResult(result(geometry.nodes));
    model.setDeformationScale(0);
    const update = spyOn(model, "updateShellSurface").and.callThrough();
    model.setDeformationPhase(-0.5);
    model.setDeformationPhase(0.5);
    expect(update).not.toHaveBeenCalled();
    const field = result(geometry.nodes);
    field.extent = 0;
    field.nodes.values = geometry.nodes.flatMap(() => [0, 0, 0, 0.1, 0, 0]);
    model.setResult(field);
    model.setDeformationScale(1);
    expect(update).toHaveBeenCalled();
    expect(model.shellState.positions[2]).not.toBe(0.2);
  });

  it("filters shell triangles, zoom and edges without recomputing hidden element surfaces", () => {
    const geometry = shells();
    const model = create(geometry);
    model.setResult(result(geometry.nodes));
    const hidden = model.shellState.prepared[0];
    const positions = model.shellState.positions;
    const before = Array.from(
      positions.subarray(hidden.vertexStart * 3, (hidden.vertexStart + hidden.vertexCount) * 3),
    );
    model.setElementFilter((element) => element.id === "B");
    const state = model.shellState;
    expect(state.activeElementIndices).toEqual([1]);
    expect(state.geometry.drawRange.count).toBe(state.prepared[1].indexCount);
    expect(state.edgeGeometry.instanceCount).toBe(state.prepared[1].edgeCount);
    expect(model.meshes.shells.userData.gravissZoomProxy.geometry.drawRange.count).toBe(
      state.zoomEntityRanges[1].count,
    );
    model.setDeformationPhase(-0.5);
    expect(
      Array.from(
        positions.subarray(hidden.vertexStart * 3, (hidden.vertexStart + hidden.vertexCount) * 3),
      ),
    ).toEqual(before);
    model.setElementFilter(null);
    expect(state.geometry.drawRange.count).toBe(state.indexValues.length);
    expect(state.activeElementIndices).toEqual([0, 1]);
  });

  it("does not rewrite hidden edge buffers until they are shown again", () => {
    const geometry = shells();
    const model = create(geometry);
    model.setResult(result(geometry.nodes));
    const edges = model.shellState.edgeBuffer;
    model.setVisibility("mesh", false);
    const before = Array.from(edges.array);
    const version = edges.version;
    model.setDeformationPhase(-0.5);
    expect(Array.from(edges.array)).toEqual(before);
    expect(edges.version).toBe(version);
    model.setVisibility("mesh", true);
    expect(Array.from(edges.array)).not.toEqual(before);
    expect(edges.version).toBeGreaterThan(version);
  });

  it("clears a selected shell that the filter removes", () => {
    const geometry = shells();
    const model = create(geometry);
    model.colors = {
      shell: new model.THREE.Color(0xffffff),
      selected: new model.THREE.Color(0xff0000),
    };
    model.setSelected({
      type: "element",
      entity: geometry.elements[0],
      entityIndex: 0,
      object: model.meshes.shells,
    });
    expect(model.selected.entity.id).toBe("A");
    model.setElementFilter((element) => element.id === "B");
    expect(model.selected).toBeNull();
  });
});
