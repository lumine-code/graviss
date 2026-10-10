const { GravissRenderer } = require("../lib/renderer");
const { loadThreeRuntime } = require("../lib/three-runtime");

const AXIAL = {
  id: "N",
  title: "Axial force",
  group: "Internal forces",
  unit: "N",
  displayUnit: "kN",
  displayFactor: 0.001,
  plane: "y",
  directionSign: 1,
};
const MOMENT = {
  id: "Mz",
  title: "Bending moment z",
  group: "Internal forces",
  unit: "N·m",
  displayUnit: "kN·m",
  displayFactor: 0.001,
  plane: "y",
  directionSign: -1,
};

describe("Graviss member-diagram result rendering", () => {
  let runtime;
  let renderer;

  beforeAll(async () => {
    runtime = await loadThreeRuntime();
  });
  afterEach(() => {
    renderer?.memberDiagram?.dispose();
    renderer?.scene.traverse((object) => {
      object.geometry?.dispose();
      if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose());
      else object.material?.dispose();
    });
    renderer?.frameRateMeter.dispose();
    renderer = null;
  });

  function create(prepare = null) {
    const { THREE, OrbitControls, ...wideLines } = runtime;
    const geometry = {
      nodes: [
        { id: 1, x: 0, y: 0, z: 0 },
        { id: 2, x: 4, y: 0, z: 0 },
        { id: 3, x: 8, y: 0, z: 0 },
      ],
      elements: [
        { id: "a", kind: "beam", nodeIds: [1, 2] },
        { id: "b", kind: "beam", nodeIds: [2, 3] },
      ].map((element) => ({ ...element, localAxes: { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] } })),
      supports: [],
    };
    prepare?.(geometry);
    renderer = new GravissRenderer({}, geometry, {}, THREE, OrbitControls, wideLines);
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
    renderer.colors.selected = new THREE.Color(0xffcc00);
    renderer.createModelGeometry();
    renderer.applyVisibility();
    renderer.setMemberDiagramOptions({ labels: false });
    return renderer;
  }

  function result() {
    return {
      kind: "memberDiagram",
      loadCaseId: 1,
      components: [AXIAL, MOMENT],
      elements: [
        {
          id: "a",
          stations: [
            { x: 0, values: [1000, -2000] },
            { x: 2, values: [1000, 2000] },
            { x: 2, values: [-500, 2000] },
            { x: 4, values: [-500, 0] },
          ],
        },
        {
          id: "b",
          stations: [
            { x: 0, values: [3000, 0] },
            { x: 4, values: [3000, 0] },
          ],
        },
      ],
    };
  }

  it("draws a force result on the undeformed model and stops displacement colour and animation", () => {
    const model = create();
    model.setResult({
      kind: "displacement",
      loadCaseId: 1,
      components: 3,
      nodes: { ids: [2], values: [0, 0, 1] },
    });
    model.setDeformationScale(1);
    model.setColorByDisplacement(true);
    model.getAnimation().start();
    model.setResult(result());
    expect(Array.from(model.nodePositions)).toEqual(Array.from(model.restPositions));
    expect(model.deformation.result).toBeNull();
    expect(model.colorByDisplacement).toBe(false);
    expect(model.getAnimation().running).toBe(false);
    model.getAnimation().start();
    expect(model.getAnimation().running).toBe(false);
    expect(model.setColorByDisplacement(true)).toBe(false);
    expect(model.getMemberDiagramSummary()).toEqual(
      jasmine.objectContaining({ min: -500, max: 3000, elementCount: 2, stationCount: 6 }),
    );
  });

  it("keeps all one-sided station data and resolves selections from diagram faces", () => {
    const model = create();
    model.setResult(result());
    const mesh = model.memberDiagram.pickables.find((object) => object.isMesh);
    const hit = model.resolveIntersection({ object: mesh, faceIndex: 0 });
    expect(hit.entity.id).toBe("a");
    model.setSelected(hit);
    expect(model.getMemberDiagramSummary().selected.stations).toEqual([
      { x: 0, value: 1000 },
      { x: 2, value: 1000 },
      { x: 2, value: -500 },
      { x: 4, value: -500 },
    ]);
    const oldGeometry = mesh.geometry;
    const dispose = spyOn(oldGeometry, "dispose").and.callThrough();
    model.setMemberDiagramOptions({ component: "Mz" });
    expect(dispose).toHaveBeenCalled();
    expect(model.selected.entity.id).toBe("a");
    expect(model.selected.object.geometry).not.toBe(oldGeometry);
    expect(model.getMemberDiagramSummary().directionSign).toBe(-1);
    expect(model.getMemberDiagramSummary().selected.stations[0].value).toBe(-2000);
  });

  it("intersects activity, element filtering and member-layer visibility in geometry and extrema", () => {
    const model = create();
    model.setResult({ ...result(), activeElementIds: ["a"] });
    expect(model.getMemberDiagramSummary().max).toBe(1000);
    expect(model.getMemberDiagramSummary().elementCount).toBe(1);
    model.setElementFilter((element) => element.id === "b");
    expect(model.getMemberDiagramSummary()).toEqual(
      jasmine.objectContaining({ empty: true, min: null, max: null }),
    );
    expect(model.memberDiagram.pickables.length).toBe(0);
    model.setElementFilter(null);
    model.setVisibility("members", false);
    expect(model.getMemberDiagramSummary().empty).toBe(true);
    model.setVisibility("members", true);
    expect(model.getMemberDiagramSummary().max).toBe(1000);
    model.setResult(null);
    expect(model.getMemberDiagramSummary()).toBeNull();
    expect(model.pickables.some((object) => object.userData.gravissMemberDiagram)).toBe(false);
  });

  it("fills only intervals with area and includes manually scaled ordinates in export bounds", () => {
    const model = create();
    const field = result();
    field.elements = [field.elements[0]];
    model.setMemberDiagramOptions({ scale: 0.01 });
    model.setResult(field);
    const fills = model.memberDiagram.pickables.filter((object) => object.isMesh);
    // Two rectangular intervals, four triangles; the x=2 jump has no area.
    expect(fills.reduce((sum, mesh) => sum + mesh.geometry.attributes.position.count, 0)).toBe(12);
    const bounds = model.visibleModelBounds();
    expect(bounds.max.y).toBe(10);
    expect(bounds.min.y).toBe(-5);
    model.setMemberDiagramOptions({ flip: true, filled: false });
    expect(model.visibleModelBounds().min.y).toBe(-10);
    expect(model.memberDiagram.pickables.every((object) => object.isLineSegments)).toBe(true);
    expect(model.getMemberDiagramSummary().min).toBe(-500);
  });

  it("disposes label textures on option changes and includes their camera-facing corners", () => {
    const model = create();
    model.camera = new model.THREE.OrthographicCamera(-20, 20, 20, -20, 0.1, 100);
    model.camera.position.set(0, 0, 10);
    model.camera.lookAt(0, 0, 0);
    model.camera.updateMatrixWorld(true);
    model.setResult(result());
    model.setMemberDiagramOptions({ labels: true });
    const label = model.memberDiagram.labels[0];
    const dispose = spyOn(label.material.map, "dispose").and.callThrough();
    let corners = 0;
    model.memberDiagram.forEachLabelCorner(model.camera, (point) => {
      expect(model.visibleModelBounds().containsPoint(point)).toBe(true);
      corners += 1;
    });
    expect(corners).toBe(model.memberDiagram.labels.length * 4);
    model.setMemberDiagramOptions({ labels: false });
    expect(dispose).toHaveBeenCalled();
    expect(model.memberDiagram.labels.length).toBe(0);
  });

  it("preserves typed element and node ids and normalizes supplied axis lengths", () => {
    // Numeric 1 and string "1" are distinct ids throughout the source contract.
    const model = create((geometry) => {
      geometry.nodes[0].id = "1";
      geometry.nodes[2].id = 1;
      geometry.elements[0].id = 1;
      geometry.elements[0].nodeIds = ["1", 2];
      geometry.elements[1].id = "1";
      geometry.elements[1].nodeIds = [2, 1];
      geometry.elements[0].localAxes = { x: [2, 0, 0], y: [0, 3, 0], z: [0, 0, 4] };
    });
    model.setMemberDiagramOptions({ scale: 0.001 });
    const field = result();
    field.elements[0].id = 1;
    field.elements[1].id = "1";
    model.setResult(field);
    const records = model.memberDiagram.records;
    expect(records[0].origin).toEqual([0, 0, 0]);
    expect(records[1].origin).toEqual([4, 0, 0]);
    expect(records[0].point({ x: 2, value: 1000 })).toEqual([2, 1, 0]);
    model.memberDiagram.select("1");
    expect(model.getMemberDiagramSummary().selected.max).toBe(3000);
    model.memberDiagram.select(1);
    expect(model.getMemberDiagramSummary().selected.max).toBe(1000);
  });

  it("preserves the displayed result and options when finite values overflow GPU coordinates", () => {
    const model = create();
    const field = result();
    model.setMemberDiagramOptions({ scale: 0.001 });
    model.setResult(field);
    const diagram = model.memberDiagram;
    const pickables = model.pickables.slice();
    const dispose = spyOn(diagram, "dispose").and.callThrough();
    expect(() => model.setMemberDiagramOptions({ scale: 1e300 })).toThrowError(RangeError);
    expect(model.memberDiagramOptions.scale).toBe(0.001);
    expect(model.memberDiagram === diagram).toBe(true);
    const impossible = result();
    impossible.elements[0].stations[0].values[0] = 1e100;
    impossible.activeElementIds = ["a"];
    expect(() => model.setResult(impossible)).toThrowError(RangeError);
    expect(model.memberDiagramResult).toBe(field);
    expect(model.activeElementIds).toBeNull();
    expect(model.pickables.length).toBe(pickables.length);
    expect(model.pickables.every((object, index) => object === pickables[index])).toBe(true);
    expect(model.memberDiagram === diagram).toBe(true);
    expect(dispose).not.toHaveBeenCalled();
    model.setVisibility("members", false);
    expect(() => model.setMemberDiagramOptions({ scale: 1e300 })).toThrowError(RangeError);
    model.setVisibility("members", true);
    expect(model.getMemberDiagramSummary().scale).toBe(0.001);
  });

  it("renders source-defined quantities in their own units without core registration", () => {
    const model = create();
    const quantity = {
      id: "custom-rotation",
      title: "Section rotation",
      group: "Local deformation",
      unit: "rad",
      displayUnit: "mrad",
      displayFactor: 1000,
      plane: "z",
      directionSign: -1,
    };
    model.setResult(
      {
        kind: "memberDiagram",
        loadCaseId: 1,
        components: [quantity],
        elements: [
          {
            id: "a",
            stations: [
              { x: 0, values: [0.001] },
              { x: 4, values: [-0.002] },
            ],
          },
        ],
      },
      { component: quantity.id, scale: 100 },
    );
    expect(model.getMemberDiagramSummary()).toEqual(
      jasmine.objectContaining({
        component: quantity.id,
        quantity,
        unit: "rad",
        displayUnit: "mrad",
        displayFactor: 1000,
        min: -0.002,
        max: 0.001,
        scale: 100,
        plane: "z",
        directionSign: -1,
      }),
    );
    expect(model.memberDiagram.records[0].point({ x: 4, value: -0.002 })).toEqual([4, 0, 0.2]);
    const damping = {
      ...quantity,
      id: "provider-damping",
      title: "Damping coefficient",
      unit: "N·s/m",
      displayUnit: "kN·s/m",
      displayFactor: 0.001,
    };
    model.setResult(
      {
        kind: "memberDiagram",
        loadCaseId: 1,
        components: [damping],
        elements: [
          {
            id: "a",
            stations: [
              { x: 0, values: [2000] },
              { x: 4, values: [4000] },
            ],
          },
        ],
      },
      { component: damping.id, scale: "auto" },
    );
    expect(model.getMemberDiagramSummary()).toEqual(
      jasmine.objectContaining({
        unit: "N·s/m",
        displayUnit: "kN·s/m",
        displayFactor: 0.001,
        min: 2000,
        max: 4000,
      }),
    );
  });

  it("leaves gaps unfilled, preserves missing station values and draws isolated ordinates", () => {
    const model = create();
    model.setResult({
      kind: "memberDiagram",
      loadCaseId: 1,
      components: [AXIAL],
      elements: [
        {
          id: "a",
          stations: [
            { x: 0, values: [1000] },
            { x: 1, values: [null] },
            { x: 2, values: [-500] },
            { x: 3, values: [null] },
            { x: 4, values: [null] },
          ],
        },
        {
          id: "b",
          stations: [
            { x: 0, values: [null] },
            { x: 4, values: [null] },
          ],
        },
      ],
    });
    expect(model.getMemberDiagramSummary()).toEqual(
      jasmine.objectContaining({
        min: -500,
        max: 1000,
        elementCount: 1,
        stationCount: 2,
        empty: false,
      }),
    );
    expect(model.memberDiagram.pickables.every((object) => object.isLineSegments)).toBe(true);
    expect(
      model.memberDiagram.pickables.reduce(
        (count, object) => count + object.geometry.attributes.position.count,
        0,
      ),
    ).toBe(4);
    model.memberDiagram.select("a");
    expect(model.getMemberDiagramSummary().selected.stations[1]).toEqual({ x: 1, value: null });
    model.memberDiagram.select("b");
    expect(model.getMemberDiagramSummary().selected.min).toBeNull();
    expect(model.getMemberDiagramSummary().selected.max).toBeNull();
    model.setElementFilter((element) => element.id === "b");
    expect(model.getMemberDiagramSummary()).toEqual(
      jasmine.objectContaining({ empty: true, min: null, max: null, stationCount: 0 }),
    );
  });

  it("commits the new result and final diagram options together", () => {
    const model = create();
    const oldResult = result();
    oldResult.elements[0].stations[0].values[0] = 1e30;
    model.setResult(oldResult, { scale: "auto" });
    // This scale cannot draw the old result, but is valid for the new one.
    const scale = 1e10;
    expect(() => model.setMemberDiagramOptions({ scale })).toThrowError(RangeError);
    model.setResult(result(), { scale, component: "Mz" });
    expect(model.getMemberDiagramSummary().component).toBe("Mz");
    expect(model.getMemberDiagramSummary().scale).toBe(scale);
    expect(model.memberDiagramOptions.scale).toBe(scale);
  });

  it("draws each point quantity as a separate ordinate without interpolation or fill", () => {
    const model = create();
    const quantity = {
      ...MOMENT,
      id: "hinge-reaction",
      title: "Hinge reaction",
      interpolation: "point",
    };
    model.setResult(
      {
        kind: "memberDiagram",
        loadCaseId: 1,
        components: [quantity],
        elements: [
          {
            id: "a",
            stations: [
              { x: 0, values: [1000] },
              { x: 1, values: [500] },
              { x: 2, values: [null] },
              { x: 3, values: [-750] },
              { x: 4, values: [0] },
            ],
          },
        ],
      },
      { component: quantity.id, scale: 0.001, filled: true, labels: true },
    );
    expect(model.getMemberDiagramSummary()).toEqual(
      jasmine.objectContaining({
        min: -750,
        max: 1000,
        stationCount: 4,
        labelsShown: 4,
        quantity,
      }),
    );
    expect(model.memberDiagram.pickables.every((object) => object.isLineSegments)).toBe(true);
    let vertices = 0;
    for (const object of model.memberDiagram.pickables) {
      const position = object.geometry.attributes.position;
      vertices += position.count;
      for (let vertex = 0; vertex < position.count; vertex += 2)
        expect(position.getX(vertex)).toBe(position.getX(vertex + 1));
    }
    expect(vertices).toBe(6);
    model.memberDiagram.select("a");
    expect(model.getMemberDiagramSummary().selected.stations[2]).toEqual({ x: 2, value: null });
  });

  it("falls back to the first component carrying samples when restoring an unknown quantity", () => {
    const model = create();
    model.setResult(
      {
        kind: "memberDiagram",
        loadCaseId: 1,
        components: [AXIAL, MOMENT],
        elements: [
          {
            id: "a",
            stations: [
              { x: 0, values: [null, 2] },
              { x: 4, values: [null, 4] },
            ],
          },
        ],
      },
      { component: "quantity-from-another-source" },
    );
    expect(model.getMemberDiagramSummary().component).toBe("Mz");
    expect(model.getMemberDiagramSummary().max).toBe(4);
  });

  it("restores saved graphic options atomically through the real view loading path", async () => {
    const { Emitter } = require("lumine");
    const GravissView = require("../lib/graviss-view");
    const model = create();
    const previous = result();
    previous.elements[0].stations[0].values[0] = 1e30;
    model.setResult(previous);
    let resolveRead;
    const viewer = Object.create(GravissView.prototype);
    Object.assign(viewer, {
      destroyed: false,
      renderer: model,
      geometry: model.geometry,
      result: previous,
      resultsState: { kind: "memberDiagram", component: "N", diagramLabels: false, loadCaseId: 1 },
      description: { capabilities: { results: { loadCases: true, memberDiagram: true } } },
      loadCases: [
        { id: 1, title: "Previous", kind: "linear" },
        { id: 2, title: "Next", kind: "linear" },
      ],
      resultRequest: 0,
      resultSelection: null,
      resultRead: null,
      emitter: new Emitter(),
      recordResultsState: jasmine.createSpy("recordResultsState"),
      session: {
        getResult: () =>
          new Promise((resolve) => {
            resolveRead = resolve;
          }),
      },
    });
    try {
      const pending = viewer.applyGraphicResults({
        kind: "memberDiagram",
        loadCaseId: 2,
        component: "N",
        diagramScale: 1e10,
        diagramLabels: false,
      });
      expect(model.memberDiagramResult === previous).toBe(true);
      expect(model.getMemberDiagramSummary().automatic).toBe(true);
      const next = { ...result(), loadCaseId: 2 };
      resolveRead(next);
      expect((await pending) === next).toBe(true);
      expect(viewer.result === next).toBe(true);
      expect(viewer.resultsError).toBeNull();
      expect(model.memberDiagramResult === next).toBe(true);
      expect(model.getMemberDiagramSummary().scale).toBe(1e10);
      expect(model.getMemberDiagramSummary().max).toBe(3000);
      expect(viewer.recordResultsState).not.toHaveBeenCalled();

      const validDiagram = model.memberDiagram;
      const invalidRead = viewer.applyGraphicResults({
        kind: "memberDiagram",
        loadCaseId: 1,
        component: "N",
        diagramScale: 1e10,
        diagramLabels: false,
      });
      resolveRead(previous);
      expect(await invalidRead).toBeNull();
      expect(viewer.resultsError instanceof RangeError).toBe(true);
      expect(viewer.result === next).toBe(true);
      expect(model.memberDiagram === validDiagram).toBe(true);
      expect(model.getMemberDiagramSummary().max).toBe(3000);
    } finally {
      viewer.cancelResultSelection();
      viewer.emitter.dispose();
    }
  });
});

describe("Graviss member-diagram WebGL export", () => {
  let renderer;
  let root;

  beforeEach(() => jasmine.useRealClock());
  afterEach(() => {
    renderer?.destroy();
    root?.remove();
  });

  it("renders signed diagrams and value labels in the exported PNG", async () => {
    root = document.createElement("div");
    root.className = "graviss";
    root.style.cssText = "position:absolute;inset:0;width:800px;height:500px";
    root.innerHTML = `<div class="host" style="width:800px;height:500px"></div>
      <canvas class="graviss-view-cube" style="width:80px;height:80px"></canvas>
      <svg class="graviss-axis-gizmo">${["x", "y", "z"].map((axis) => `<g data-gizmo-axis="${axis}"><line/><circle/><text/></g>`).join("")}</svg>`;
    jasmine.attachToDOM(root);
    renderer = await GravissRenderer.create(
      root.querySelector(".host"),
      {
        nodes: [
          { id: 1, x: 0, y: 0, z: 0 },
          { id: 2, x: 8, y: 0, z: 0 },
        ],
        elements: [
          {
            id: 1,
            kind: "beam",
            nodeIds: [1, 2],
            localAxes: { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
          },
        ],
        supports: [],
      },
      {},
      { deferInitialRender: true },
    );
    renderer.setResult({
      kind: "memberDiagram",
      loadCaseId: 1,
      components: [MOMENT],
      elements: [
        {
          id: 1,
          stations: [
            { x: 0, values: [-12000] },
            { x: 2, values: [0] },
            { x: 4, values: [18000] },
            { x: 6, values: [0] },
            { x: 8, values: [-8000] },
          ],
        },
      ],
    });
    renderer.setMemberDiagramOptions({ component: "Mz", scale: 0.0001 });
    renderer.setProjection("orthographic");
    renderer.setStandardView("top");
    renderer.setVisibility("axes", false);
    renderer.setAppearance("cloud");
    renderer.resumeRendering();
    const image = renderer.renderPrintImage(null, { maxEdge: 1000 });
    expect(image.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(image.width).toBeGreaterThan(0);
    const png = Buffer.from(image.dataUrl.split(",")[1], "base64");
    expect(png.length).toBeGreaterThan(3000);
    // Decode the actual export and verify both signed diagram colours, rather
    // than accepting a nonempty PNG containing only the structure/background.
    const decoded = new Image();
    decoded.src = image.dataUrl;
    await decoded.decode();
    const canvas = document.createElement("canvas");
    canvas.width = decoded.width;
    canvas.height = decoded.height;
    const context = canvas.getContext("2d");
    context.drawImage(decoded, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let red = 0;
    let blue = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] > pixels[index + 2] + 50) red += 1;
      if (pixels[index + 2] > pixels[index] + 50) blue += 1;
    }
    expect(red).toBeGreaterThan(100);
    expect(blue).toBeGreaterThan(100);
    if (process.env.GRAVISS_MEMBER_DIAGRAM_SMOKE_OUTPUT)
      require("node:fs").writeFileSync(process.env.GRAVISS_MEMBER_DIAGRAM_SMOKE_OUTPUT, png);
    renderer.setResult({
      ...renderer.memberDiagramResult,
      components: [{ ...MOMENT, interpolation: "point" }],
    });
    const pointImage = renderer.renderPrintImage(null, { maxEdge: 1000 });
    const pointPng = Buffer.from(pointImage.dataUrl.split(",")[1], "base64");
    expect(pointPng.length).toBeGreaterThan(3000);
    expect(renderer.getMemberDiagramSummary().labelsShown).toBe(5);
    expect(renderer.memberDiagram.pickables.every((object) => object.isLineSegments)).toBe(true);
    if (process.env.GRAVISS_MEMBER_DIAGRAM_SMOKE_OUTPUT)
      require("node:fs").writeFileSync(
        `${process.env.GRAVISS_MEMBER_DIAGRAM_SMOKE_OUTPUT}.points.png`,
        pointPng,
      );
  });
});
