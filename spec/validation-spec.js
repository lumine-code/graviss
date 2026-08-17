const {
  FRAME_MODEL,
  SHELL_MODEL,
  TestSession,
  createFrameGeometry,
  createShellGeometry,
} = require("./support/test-model");
const { validateDescription, validateGeometry, validateSession } = require("../lib/validation");
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
    expect(geometryBounds(geometry)).toEqual({
      min: [-20, -20, 0],
      max: [20, 20, 0],
      center: [0, 0, 0],
      radius: Math.hypot(40, 40) / 2,
    });

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
  });

  it("accepts signed model up axes and rejects ambiguous coordinate systems", async () => {
    const description = await new TestSession(FRAME_MODEL).describe();
    description.model.coordinateSystem.upAxis = "-z";
    expect(validateDescription(description)).toBe(description);

    description.model.coordinateSystem.upAxis = "vertical";
    expect(() => validateDescription(description)).toThrowError(/signed X, Y, or Z axis/);
  });
});
