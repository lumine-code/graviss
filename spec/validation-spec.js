const {
  FRAME_MODEL,
  SHELL_MODEL,
  TestSession,
  createFrameGeometry,
  createShellGeometry,
} = require("./support/test-model");
const {
  UNSIGNED_LOAD_CASE_KINDS,
  validateChangeEvent,
  validateDescription,
  validateGeometry,
  validateLoadCases,
  validateResult,
  validateSession,
} = require("../lib/validation");
const { geometryBounds } = require("../lib/renderer");

function createMain1Geometry() {
  return createFrameGeometry();
}

function createMain2Geometry() {
  return createShellGeometry();
}

describe("Graviss model validation", () => {
  it("accepts the portal-frame geometry and reports its bounds", () => {
    const geometry = createMain1Geometry();
    expect(validateGeometry(geometry)).toBe(geometry);
    expect(geometry.nodes.length).toBe(15);
    expect(geometry.elements.length).toBe(18);
    expect(geometry.supports.length).toBe(6);
    const bounds = geometryBounds(geometry);
    expect(bounds.min).toEqual([0, 0, 0]);
    expect(bounds.max).toEqual([8, 10, 7]);
    expect(bounds.center).toEqual([4, 5, 3.5]);
    expect(bounds.radius).toBeCloseTo(7.297, 3);
    // A portal frame has extent along all three axes, so there is no plane to
    // name and nothing to look at face on.
    expect(bounds.planeNormal).toBeNull();

    // Nor is there one when the nodes run in a straight line: a line lies in
    // infinitely many planes and none of them is the model's.
    const line = createMain1Geometry();
    for (const node of line.nodes) {
      node.y = 0;
      node.z = 0;
    }
    expect(geometryBounds(line).planeNormal).toBeNull();
  });

  it("accepts the 5k-node quadrilateral shell geometry", async () => {
    const geometry = createMain2Geometry();
    expect(validateGeometry(geometry)).toBe(geometry);
    expect(geometry.nodes.length).toBe(5041);
    expect(geometry.elements.length).toBe(4900);
    expect(
      geometry.elements.every(({ kind, nodeIds }) => kind === "shell" && nodeIds.length === 4),
    ).toBe(true);
    expect(geometry.supports.length).toBe(4);
    // Every node of a slab lies in one plane, and the axis it has no extent
    // along is that plane's normal — measured, so a source states nothing.
    expect(geometryBounds(geometry)).toEqual({
      min: [-20, -20, 0],
      max: [20, 20, 0],
      center: [0, 0, 0],
      radius: Math.hypot(40, 40) / 2,
      planeNormal: [0, 0, 1],
    });

    // A slab with any depth to it at all is a body, not a plane.
    const domed = createMain2Geometry();
    domed.nodes[12].z = 0.001;
    expect(geometryBounds(domed).planeNormal).toBeNull();

    const description = validateDescription(await new TestSession(SHELL_MODEL).describe());
    expect(description.capabilities.geometry.elementKinds).toEqual(["shell"]);

    description.capabilities.geometry.elementKinds = ["solid"];
    expect(() => validateDescription(description)).toThrowError(/unique supported kinds/);
  });

  it("rejects duplicate IDs, invalid coordinates, and missing references", () => {
    const duplicate = createMain1Geometry();
    duplicate.nodes[1].id = duplicate.nodes[0].id;
    expect(() => validateGeometry(duplicate)).toThrowError(/duplicates/);

    const invalidCoordinate = createMain1Geometry();
    invalidCoordinate.nodes[0].z = Infinity;
    expect(() => validateGeometry(invalidCoordinate)).toThrowError(/must be finite/);

    const missingReference = createMain1Geometry();
    missingReference.elements[0].nodeIds[0] = "missing";
    expect(() => validateGeometry(missingReference)).toThrowError(/unknown node/);
  });

  it("rejects unsupported elements, malformed restraints, and zero-length members", () => {
    const unsupported = createMain1Geometry();
    unsupported.elements[0].kind = "solid";
    expect(() => validateGeometry(unsupported)).toThrowError(/kind must be one of/);

    const malformedSupport = createMain1Geometry();
    malformedSupport.supports[0].restraints = [true];
    expect(() => validateGeometry(malformedSupport)).toThrowError(/six booleans/);

    const zeroLength = createMain1Geometry();
    zeroLength.elements[0].nodeIds[1] = zeroLength.elements[0].nodeIds[0];
    expect(() => validateGeometry(zeroLength)).toThrowError(/zero length/);

    const zeroArea = createMain2Geometry();
    zeroArea.elements[0].nodeIds = [1, 2, 3, 2];
    expect(() => validateGeometry(zeroArea)).toThrowError(/zero area|repeats shell nodes/);
  });

  it("accepts trusses and cables as members, and holds them to two nodes of some length", async () => {
    const description = validateDescription(await new TestSession(FRAME_MODEL).describe());
    for (const kind of ["truss", "cable"]) {
      const geometry = createMain1Geometry();
      geometry.elements[0].kind = kind;
      expect(validateGeometry(geometry)).toBe(geometry);

      // A provider says which kinds it reads, and these are two of them.
      description.capabilities.geometry.elementKinds = ["beam", kind];
      expect(validateDescription(description)).toBe(description);

      const oneNode = createMain1Geometry();
      oneNode.elements[0].kind = kind;
      oneNode.elements[0].nodeIds = [oneNode.elements[0].nodeIds[0]];
      expect(() => validateGeometry(oneNode)).toThrowError(new RegExp(`2 node IDs for a ${kind}`));

      // The zero-length refusal is the members' own, not the beam's: a member
      // of no length has no axis to orient its section about.
      const zeroLength = createMain1Geometry();
      zeroLength.elements[0].kind = kind;
      zeroLength.elements[0].nodeIds[1] = zeroLength.elements[0].nodeIds[0];
      expect(() => validateGeometry(zeroLength)).toThrowError(/zero length/);
    }
  });

  it("validates section shapes, references, thickness, and local axes", () => {
    const geometry = createMain1Geometry();
    geometry.sections = [
      {
        id: "R1",
        name: "Rectangular section",
        area: 0.06,
        shape: { kind: "rectangle", width: 0.2, height: 0.3 },
      },
    ];
    geometry.elements[0].sectionId = "R1";
    geometry.elements[0].localAxes = {
      x: [0, 0, 1],
      y: [1, 0, 0],
      z: [0, 1, 0],
    };
    geometry.elements[1].thickness = 0.02;
    expect(validateGeometry(geometry)).toBe(geometry);

    geometry.elements[0].sectionId = "missing";
    expect(() => validateGeometry(geometry)).toThrowError(/unknown section/);
    geometry.elements[0].sectionId = "R1";
    geometry.sections[0].shape.width = 0;
    expect(() => validateGeometry(geometry)).toThrowError(/positive/);
    geometry.sections[0].shape.width = 0.2;
    geometry.sections.push({
      id: "P1",
      shape: {
        kind: "polygon",
        points: [
          [-0.1, -0.2],
          [0.1, -0.2],
          [0, 0.2],
        ],
      },
    });
    expect(validateGeometry(geometry)).toBe(geometry);
    geometry.sections[1].shape.points[2] = [0, Number.NaN];
    expect(() => validateGeometry(geometry)).toThrowError(/two finite coordinates/);

    // A composed section is several parts, each an outline with its own holes.
    geometry.sections[1].shape = {
      kind: "polygon",
      parts: [
        {
          points: [
            [-1, -0.12],
            [1, -0.12],
            [1, 0],
            [-1, 0],
          ],
          holes: [
            [
              [-0.5, -0.09],
              [0.5, -0.09],
              [0, -0.03],
            ],
          ],
        },
        {
          points: [
            [-0.13, 0],
            [0.13, 0],
            [0.16, 0.72],
            [-0.16, 0.72],
          ],
        },
      ],
    };
    expect(validateGeometry(geometry)).toBe(geometry);
    // Never both spellings at once.
    geometry.sections[1].shape.points = geometry.sections[1].shape.parts[0].points;
    expect(() => validateGeometry(geometry)).toThrowError(/not both/);
    delete geometry.sections[1].shape.points;
    geometry.sections[1].shape.parts[1].points = [[0, 0]];
    expect(() => validateGeometry(geometry)).toThrowError(/at least three/);
    geometry.sections.pop();

    // A thin-walled section is the plates it is built from, each a run of one
    // thickness, and every run has to go somewhere.
    geometry.sections.push({
      id: "T1",
      shape: {
        kind: "plates",
        plates: [
          { from: [0, -0.498], to: [0, 0.498], thickness: 0.01 },
          { from: [-0.13, 0.5065], to: [0.13, 0.5065], thickness: 0.017 },
        ],
      },
    });
    expect(validateGeometry(geometry)).toBe(geometry);
    geometry.sections[1].shape.plates[0].thickness = 0;
    expect(() => validateGeometry(geometry)).toThrowError(/thickness must be a positive/);
    geometry.sections[1].shape.plates[0].thickness = 0.01;
    geometry.sections[1].shape.plates[1].to = [-0.13, 0.5065];
    expect(() => validateGeometry(geometry)).toThrowError(/two different points/);
    geometry.sections[1].shape.plates[1].to = [0.13, Number.NaN];
    expect(() => validateGeometry(geometry)).toThrowError(/two finite coordinates/);
    geometry.sections[1].shape.plates = [];
    expect(() => validateGeometry(geometry)).toThrowError(/plates must be a non-empty array/);
    geometry.sections.pop();

    // The parts of a section that do not carry are plain areas in its own
    // plane, spelt exactly as a polygon's parts are.
    geometry.sections[0].ineffective = [
      {
        points: [
          [-0.1, -0.15],
          [0.1, -0.15],
          [0.1, -0.05],
          [-0.1, -0.05],
        ],
      },
    ];
    expect(validateGeometry(geometry)).toBe(geometry);
    geometry.sections[0].ineffective[0].points.pop();
    geometry.sections[0].ineffective[0].points.pop();
    expect(() => validateGeometry(geometry)).toThrowError(/at least three/);
    geometry.sections[0].ineffective = [];
    expect(() => validateGeometry(geometry)).toThrowError(/must be a non-empty array/);
    delete geometry.sections[0].ineffective;

    geometry.elements[0].localAxes.z = [0, 0, 0];
    expect(() => validateGeometry(geometry)).toThrowError(/must not be zero/);
  });

  it("requires every session method the contract makes mandatory", () => {
    expect(validateSession(new TestSession(FRAME_MODEL))).toEqual(jasmine.any(TestSession));

    for (const method of ["describe", "getGeometry", "dispose"]) {
      const incomplete = new TestSession(FRAME_MODEL);
      incomplete[method] = null;
      expect(() => validateSession(incomplete)).toThrowError(new RegExp(`${method}\\(\\)`));
    }

    const badObserver = new TestSession(FRAME_MODEL);
    badObserver.onDidChange = "soon";
    expect(() => validateSession(badObserver)).toThrowError(/onDidChange must be a function/);

    // Results are optional, so a session without them is whole; one that offers
    // them has to offer something callable.
    for (const method of ["getLoadCases", "getResult"]) {
      const withResults = new TestSession(FRAME_MODEL);
      withResults[method] = () => [];
      expect(validateSession(withResults)).toBe(withResults);
      withResults[method] = "later";
      expect(() => validateSession(withResults)).toThrowError(
        new RegExp(`${method} must be a function`),
      );
    }
  });

  it("reads a change scope of results, and no scope it does not know", () => {
    expect(validateChangeEvent({ scope: "results" })).toEqual({ scope: "results" });
    expect(validateChangeEvent({})).toEqual({ scope: "all" });
    expect(() => validateChangeEvent({ scope: "colours" })).toThrowError(/all, geometry, results/);
  });

  it("takes results and facets as capabilities a source may simply not have", async () => {
    const description = await new TestSession(FRAME_MODEL).describe();
    expect(validateDescription(description)).toBe(description);

    description.capabilities.results = { displacement: true, loadCases: true };
    description.capabilities.facets = true;
    expect(validateDescription(description)).toBe(description);
    description.capabilities.results.beamStations = true;
    expect(validateDescription(description)).toBe(description);

    // Stated as true, never as a boolean: a source that cannot answer is silent.
    description.capabilities.results.displacement = false;
    expect(() => validateDescription(description)).toThrowError(/displacement must be true/);
    description.capabilities.results = { displacement: true };
    expect(() => validateDescription(description)).toThrowError(/loadCases must be true/);
    delete description.capabilities.results;
    description.capabilities.facets = false;
    expect(() => validateDescription(description)).toThrowError(/facets must be true/);
  });

  it("holds a facet's values together, and holds an element to them", () => {
    const geometry = createMain1Geometry();
    geometry.facets = [
      { id: "group", title: "Group", values: [{ id: 11, title: "Deck" }, { id: 12 }] },
      { id: "set", title: "Selection set", multiple: true, values: [{ id: "a" }, { id: "b" }] },
    ];
    geometry.elements[0].number = 110001;
    geometry.elements[0].facetValues = { group: 11, set: ["a", "b"] };
    expect(validateGeometry(geometry)).toBe(geometry);

    // A facet nothing declared, a value it never listed, and a list where the
    // facet holds one.
    geometry.elements[0].facetValues = { storey: 1 };
    expect(() => validateGeometry(geometry)).toThrowError(/unknown facet/);
    geometry.elements[0].facetValues = { group: 99 };
    expect(() => validateGeometry(geometry)).toThrowError(/unknown value/);
    geometry.elements[0].facetValues = { group: [11, 12] };
    expect(() => validateGeometry(geometry)).toThrowError(/does not declare multiple/);
    geometry.elements[0].facetValues = { set: [] };
    expect(() => validateGeometry(geometry)).toThrowError(/non-empty array/);
    delete geometry.elements[0].facetValues;

    geometry.elements[0].number = "110001";
    expect(() => validateGeometry(geometry)).toThrowError(/number must be a finite number/);
    delete geometry.elements[0].number;

    geometry.facets[1].id = "group";
    expect(() => validateGeometry(geometry)).toThrowError(/duplicates/);
    geometry.facets = [{ id: "group", title: "", values: [] }];
    expect(() => validateGeometry(geometry)).toThrowError(/title must be a non-empty string/);
  });

  it("holds a displacement field to one value a component a node", () => {
    const geometry = createMain1Geometry();
    const nodes = geometry.nodes.length;
    const result = {
      kind: "displacement",
      loadCaseId: 101,
      components: 3,
      nodes: { values: new Float32Array(nodes * 3) },
      extent: 0.012,
    };
    expect(validateResult(result, geometry)).toBe(result);

    result.components = 6;
    expect(() => validateResult(result, geometry)).toThrowError(/6 components for each of/);
    result.components = 3;

    result.nodes.values = new Float32Array(nodes * 3).fill(Number.NaN);
    expect(() => validateResult(result, geometry)).toThrowError(/must be finite/);
    result.nodes.values = new Float32Array(nodes * 3);

    // A field that names its own nodes is measured against that list instead.
    result.nodes = { ids: [geometry.nodes[0].id], values: [1, 2, 3] };
    expect(validateResult(result, geometry)).toBe(result);

    result.kind = "force";
    expect(() => validateResult(result, geometry)).toThrowError(/must be "displacement"/);
    result.kind = "displacement";
    result.extent = -1;
    expect(() => validateResult(result, geometry)).toThrowError(/non-negative/);
  });

  it("takes the stations a member bends through, in its own frame", () => {
    const geometry = createMain1Geometry();
    const result = {
      kind: "displacement",
      loadCaseId: 101,
      components: 3,
      nodes: { values: new Float32Array(geometry.nodes.length * 3) },
      elements: [
        {
          id: geometry.elements[0].id,
          stations: [
            { x: 0, u: [0, 0, 0], phi: [0, 0, 0] },
            { x: 4, u: [0, 0, -0.01] },
          ],
        },
      ],
    };
    expect(validateResult(result, geometry)).toBe(result);

    result.elements[0].stations = [];
    expect(() => validateResult(result, geometry)).toThrowError(/non-empty array/);
    result.elements[0].stations = [{ u: [0, 0, 0] }];
    expect(() => validateResult(result, geometry)).toThrowError(/\.x must be finite/);
    result.elements[0].stations = [{ x: 0, u: [0, 0] }];
    expect(() => validateResult(result, geometry)).toThrowError(/three finite numbers/);
  });

  it("lists what a model was solved for, and what it only names", () => {
    const cases = [
      { id: 101, title: "self-weight", kind: "linear", actionType: "G_1", factor: 1 },
      { id: 192, title: "dead-load", hasResults: false },
      { id: 1, title: "1st mode", kind: "eigenmode" },
    ];
    expect(validateLoadCases(cases)).toBe(cases);
    // Only these two are animated about zero; the rest run up from it.
    expect(UNSIGNED_LOAD_CASE_KINDS.has("eigenmode")).toBe(true);
    expect(UNSIGNED_LOAD_CASE_KINDS.has("buckling")).toBe(true);
    expect(UNSIGNED_LOAD_CASE_KINDS.has("linear")).toBe(false);

    expect(() =>
      validateLoadCases([
        { id: 1, title: "a" },
        { id: 1, title: "b" },
      ]),
    ).toThrowError(/duplicates/);
    expect(() => validateLoadCases([{ id: 1, title: "" }])).toThrowError(/non-empty string/);
    expect(() => validateLoadCases([{ id: 1, title: "a", kind: "creep" }])).toThrowError(
      /kind must be one of/,
    );
    expect(() => validateLoadCases([{ id: 1, title: "a", factor: "1" }])).toThrowError(
      /factor must be a finite number/,
    );
  });

  it("accepts signed model up axes and rejects ambiguous coordinate systems", async () => {
    const description = await new TestSession(FRAME_MODEL).describe();
    description.model.coordinateSystem.upAxis = "-z";
    expect(validateDescription(description)).toBe(description);

    description.model.coordinateSystem.upAxis = "vertical";
    expect(() => validateDescription(description)).toThrowError(/signed X, Y, or Z axis/);
  });
});
