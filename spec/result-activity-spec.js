const { GravissRenderer } = require("../lib/renderer");
const { loadThreeRuntime } = require("../lib/three-runtime");
const { validateResult } = require("../lib/validation");

describe("Graviss load-case element activity", () => {
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

  function create() {
    const axes = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    const geometry = {
      nodes: [
        { id: 1, x: 0, y: 0, z: 0 },
        { id: 2, x: 1, y: 0, z: 0 },
        { id: 3, x: 1, y: 1, z: 0 },
        { id: 4, x: 0, y: 1, z: 0 },
        { id: 5, x: 10, y: 0, z: 0 },
        { id: 6, x: 11, y: 0, z: 0 },
        { id: 7, x: 11, y: 1, z: 0 },
        { id: 8, x: 10, y: 1, z: 0 },
        { id: 9, x: 0, y: 0, z: 2 },
      ],
      elements: [
        { id: "beam-a", kind: "beam", nodeIds: [1, 2], sectionId: 1 },
        { id: "beam-b", kind: "beam", nodeIds: [5, 6], sectionId: 1 },
        { id: "shell-a", kind: "shell", nodeIds: [1, 2, 3, 4], thickness: 0.2 },
        { id: "shell-b", kind: "shell", nodeIds: [5, 6, 7, 8], thickness: 0.2 },
        { id: "spring-a", kind: "spring", nodeIds: [3], direction: [0, 0, 1] },
        { id: "spring-b", kind: "spring", nodeIds: [7], direction: [0, 0, 1] },
        { id: "coupling-a", kind: "coupling", nodeIds: [2, 3] },
        { id: "coupling-b", kind: "coupling", nodeIds: [6, 7] },
      ].map((element) => ({ ...element, localAxes: axes })),
      supports: [
        { id: "support-a", nodeId: 1 },
        { id: "support-b", nodeId: 5 },
        { id: "support-alone", nodeId: 9 },
      ],
      sections: [
        {
          id: 1,
          shape: { kind: "rectangle", width: 0.2, height: 0.3 },
          ineffective: [
            {
              points: [
                [-0.1, -0.15],
                [0, -0.15],
                [0, 0.15],
                [-0.1, 0.15],
              ],
            },
          ],
        },
      ],
    };
    const { THREE, OrbitControls, ...wideLines } = runtime;
    renderer = new GravissRenderer({}, geometry, {}, THREE, OrbitControls, wideLines, {
      shellDeformationBackend: "cpu",
    });
    renderer.requestRender = () => {};
    renderer.updateDepthRange = () => {};
    renderer.scene = new THREE.Scene();
    renderer.worldUp = new THREE.Vector3(0, 0, 1);
    renderer.modelYAxis = new THREE.Vector3(0, 1, 0);
    renderer.colors = Object.fromEntries(
      ["element", "shell", "node", "support", "spring", "coupling", "ineffective"].map((key) => [
        key,
        new THREE.Color(0xffffff),
      ]),
    );
    renderer.colors.selected = new THREE.Color(0xff0000);
    renderer.createModelGeometry();
    renderer.applyVisibility();
    return renderer;
  }

  const activeA = ["beam-a", "shell-a", "spring-a", "coupling-a"];
  const activeB = ["beam-b", "shell-b", "spring-b", "coupling-b"];

  function field(activeElementIds, loadCaseId = 1) {
    // Fixed endpoints can have no displacement rows and still be active.
    return {
      kind: "displacement",
      loadCaseId,
      components: 3,
      nodes: { ids: [], values: [] },
      ...(activeElementIds == null ? {} : { activeElementIds }),
    };
  }

  function expectedShell(index) {
    const state = renderer.shellState;
    const mesh = renderer.meshes.shells;
    expect(state.activeElementIndices).toEqual([index]);
    expect(state.geometry.drawRange.count).toBe(state.prepared[index].indexCount);
    expect(state.edgeGeometry.instanceCount).toBe(state.prepared[index].edgeCount);
    expect(mesh.userData.gravissZoomProxy.geometry.drawRange.count).toBe(
      state.zoomEntityRanges[index].count,
    );
  }

  function connectorLength(kind, index) {
    const connector = renderer.connectors[kind];
    const positions = connector.lines.geometry.getAttribute("position");
    const range = connector.entityRanges[index];
    let length = 0;
    for (let vertex = range.start; vertex < range.start + range.count; vertex += 2) {
      length += Math.hypot(
        positions.getX(vertex + 1) - positions.getX(vertex),
        positions.getY(vertex + 1) - positions.getY(vertex),
        positions.getZ(vertex + 1) - positions.getZ(vertex),
      );
    }
    return length;
  }

  it("filters every element layer, its endpoints and supports while preserving standalone nodes", () => {
    const model = create();
    model.setResult(validateResult(field(activeA), model.geometry));
    for (const mesh of model.pickables.filter(
      (object) => object.userData.visibilityKey === "members",
    )) {
      expect(mesh.count).toBe(1);
    }
    expect(model.memberContours.every((object) => object.geometry.instanceCount === 1)).toBe(true);
    expectedShell(0);
    expect(connectorLength("spring", 0)).toBeGreaterThan(0);
    expect(connectorLength("spring", 1)).toBe(0);
    expect(connectorLength("coupling", 0)).toBeGreaterThan(0);
    expect(connectorLength("coupling", 1)).toBe(0);
    expect(model.localAxes.geometry.drawRange.count).toBe(activeA.length * 6);
    expect(model.nodeMesh.count).toBe(5);
    expect(Array.from(model.nodeMesh.userData.gravissInstanceToEntityIndex).slice(0, 5)).toEqual([
      0, 1, 2, 3, 8,
    ]);
    expect(model.supportMesh.count).toBe(2);
    expect(Array.from(model.supportMesh.userData.gravissInstanceToEntityIndex).slice(0, 2)).toEqual(
      [0, 2],
    );
    expect(model.keepsNode(1)).toBe(true);
    expect(model.keepsNode(5)).toBe(false);
    expect(model.elementCounts().get("beam")).toEqual({ total: 2, shown: 1 });
  });

  it("intersects the user's filter, swaps load cases and restores topology after clearing the result", () => {
    const model = create();
    const filter = (element) => element.kind !== "spring";
    model.setElementFilter(filter);
    model.setResult(field(activeA));
    expect(model.getElementFilter()).toBe(filter);
    expect(model.keepsElement(model.geometry.elements[4])).toBe(false);
    model.setResult(field(activeB, 2));
    expectedShell(1);
    expect(model.nodeMesh.count).toBe(5);
    expect(Array.from(model.nodeMesh.userData.gravissInstanceToEntityIndex).slice(0, 5)).toEqual([
      4, 5, 6, 7, 8,
    ]);
    expect(model.localAxes.geometry.drawRange.count).toBe(3 * 6);
    model.setDeformationScale(0);
    model.setDeformationPhase(0);
    expect(model.keepsNode(1)).toBe(false);
    model.setResult(null);
    expect(model.activeElementIds).toBeNull();
    expect(model.nodeMesh.count).toBe(9);
    expect(model.supportMesh.count).toBe(3);
    expect(model.shellState.activeElementIndices).toEqual([0, 1]);
    expect(model.elementCounts().get("spring").shown).toBe(0);
    model.setElementFilter(null);
    expect(model.elementCounts().get("spring").shown).toBe(2);
  });

  it("keeps an empty activity set empty across section and deformation topology rebuilds", () => {
    const model = create();
    const result = field([]);
    result.components = 6;
    result.elements = [
      {
        id: "beam-a",
        stations: [
          { x: 0, u: [0, 0, 0] },
          { x: 1, u: [0, 0, 0] },
        ],
      },
    ];
    model.setResult(result);
    for (const sectionRendering of [false, true]) {
      model.setSectionRendering(sectionRendering);
      expect(model.memberInstances.every((placement) => placement.drawn === 0)).toBe(true);
      expect(model.shellState.geometry.drawRange.count).toBe(0);
      expect(model.shellState.edgeGeometry.instanceCount).toBe(0);
      expect(model.meshes.shells.userData.gravissZoomProxy.geometry.drawRange.count).toBe(0);
      expect(model.localAxes.geometry.drawRange.count).toBe(0);
      expect(model.nodeMesh.count).toBe(1);
      expect(model.supportMesh.count).toBe(1);
    }
    model.setResult(field(null, 2));
    expect(model.nodeMesh.count).toBe(9);
    expect(model.memberInstances[0].drawn).toBe(2);
    expect(model.localAxes.geometry.drawRange.count).toBe(8 * 6);
  });

  it("resolves compacted node and support hits and clears selections hidden by a new load case", () => {
    const model = create();
    model.setResult(field(activeB));
    const node = model.resolveIntersection({ object: model.nodeMesh, instanceId: 0 });
    expect(node.entity.id).toBe(5);
    const support = model.resolveIntersection({ object: model.supportMesh, instanceId: 1 });
    expect(support.entity.id).toBe("support-alone");
    model.setSelected(node);
    model.setResult(field(activeA));
    expect(model.selected).toBeNull();
    model.setSelected(model.resolveIntersection({ object: model.nodeMesh, instanceId: 0 }));
    model.setElementFilter(() => false);
    expect(model.selected.entity.id).toBe(1);
  });

  it("raycasts only active symbol instances and refuses inactive collapsed member hits", () => {
    const model = create();
    const THREE = model.THREE;
    const ray = new THREE.Raycaster(new THREE.Vector3(10, 0, 4), new THREE.Vector3(0, 0, -1));
    ray.params.Line.threshold = 0.001;
    model.setResult(field(activeB));
    model.scene.updateMatrixWorld(true);
    const nodeHit = ray.intersectObject(model.nodeMesh, false)[0];
    const supportHit = ray.intersectObject(model.supportMesh, false)[0];
    expect(model.resolveIntersection(nodeHit).entity.id).toBe(5);
    expect(model.resolveIntersection(supportHit).entity.id).toBe("support-b");
    model.setResult(field(activeA));
    model.scene.updateMatrixWorld(true);
    expect(ray.intersectObject(model.nodeMesh, false)).toEqual([]);
    expect(ray.intersectObject(model.supportMesh, false)).toEqual([]);
    model.setSectionRendering(false);
    model.scene.updateMatrixWorld(true);
    const inactiveHits = ray.intersectObject(model.memberLines, false);
    expect(inactiveHits.length).toBeGreaterThan(0);
    expect(model.resolveIntersection(inactiveHits[0]).entity.id).toBe("beam-b");
    expect(inactiveHits.some((hit) => model.keepsIntersection(hit))).toBe(false);
    model.setResult(field(activeB));
    model.scene.updateMatrixWorld(true);
    expect(
      ray.intersectObject(model.memberLines, false).some((hit) => model.keepsIntersection(hit)),
    ).toBe(true);
  });

  it("moves a retained standalone node's selection colour to its compacted slot", () => {
    const model = create();
    model.setSelected(model.resolveIntersection({ object: model.nodeMesh, instanceId: 8 }));
    model.setResult(field(activeB));
    expect(model.selected.entity.id).toBe(9);
    const color = new model.THREE.Color();
    model.nodeMesh.getColorAt(4, color);
    expect(color.equals(model.colors.selected)).toBe(true);
    model.nodeMesh.getColorAt(0, color);
    expect(color.equals(model.colors.node)).toBe(true);
  });

  it("exports the active local-axis draw range instead of its stale inactive tail", () => {
    const model = create();
    model.setVisibility("members", false);
    model.setVisibility("shells", false);
    model.setVisibility("supports", false);
    model.setVisibility("localAxes", true);
    model.setResult(field(activeA));
    const THREE = model.THREE;
    model.camera = new THREE.OrthographicCamera(-20, 20, 20, -20, 0.1, 100);
    model.camera.position.set(0, 0, 10);
    model.camera.lookAt(0, 0, 0);
    model.camera.updateMatrixWorld(true);
    const points = [];
    model.forEachModelScreenPoint((x, y) => points.push([x, y]));
    expect(points.length).toBe(activeA.length * 6);
    expect(Math.max(...points.map(([x]) => x))).toBeLessThan(0.1);
    expect(model.visibleModelBounds().max.x).toBeLessThan(2);
    model.setVisibility("localAxes", false);
    model.setVisibility("members", true);
    model.setSectionRendering(false);
    points.length = 0;
    model.forEachModelScreenPoint((x, y) => points.push([x, y]));
    expect(points.length).toBe(2);
    expect(Math.max(...points.map(([x]) => x))).toBeLessThan(0.1);
  });
});
