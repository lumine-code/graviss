const { memberComponents } = require("./support/member-components");
const { validateResult, validateDescription } = require("../lib/validation");
const { normalizeViewDocument } = require("../lib/view-document");

function geometry() {
  return {
    nodes: [
      { id: 1, x: 0, y: 0, z: 0 },
      { id: 2, x: 4, y: 0, z: 0 },
    ],
    elements: [
      {
        id: "b",
        kind: "beam",
        nodeIds: [1, 2],
        localAxes: { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
      },
    ],
  };
}

function result() {
  return {
    kind: "memberDiagram",
    loadCaseId: 1,
    components: memberComponents(["N", "My"]),
    elements: [
      {
        id: "b",
        stations: [
          { x: 0, values: [-1000, 0] },
          { x: 2, values: [-1000, 2000] },
          { x: 2, values: [2000, 2000] },
          { x: 4, values: [2000, 0] },
        ],
      },
    ],
  };
}

describe("Source-defined member result contract", () => {
  it("accepts ordered one-sided limits without changing signs or values", () => {
    const field = result();
    expect(validateResult(field, geometry())).toBe(field);
    expect(field.elements[0].stations[1].values[0]).toBe(-1000);
    expect(field.elements[0].stations[2].values[0]).toBe(2000);
  });

  it("distinguishes an empty field from a field of measured zeroes", () => {
    const field = result();
    field.elements = [];
    expect(validateResult(field, geometry())).toBe(field);
    const zero = result();
    zero.elements[0].stations.forEach((station) => station.values.fill(0));
    expect(validateResult(zero, geometry())).toBe(zero);
  });

  it("accepts source-defined stress quantities, point reactions and missing values", () => {
    const field = result();
    field.components[0] = {
      id: "stress-top:steel",
      title: "Top flange stress",
      group: "Steel stresses",
      unit: "Pa",
      displayUnit: "MPa",
      displayFactor: 1e-6,
      plane: "z",
      directionSign: -1,
      interpolation: "point",
    };
    field.elements[0].stations[1].values[0] = null;
    expect(validateResult(field, geometry())).toBe(field);
    field.elements[0].stations.splice(1);
    expect(validateResult(field, geometry())).toBe(field);
  });

  for (const [name, mutate] of [
    ["empty component ID", (field) => (field.components[0].id = "")],
    ["duplicate components", (field) => (field.components[1].id = "N")],
    ["unknown members", (field) => (field.elements[0].id = "missing")],
    ["duplicate members", (field) => field.elements.push(field.elements[0])],
    ["missing components", (field) => field.elements[0].stations[0].values.pop()],
    ["nonfinite values", (field) => (field.elements[0].stations[0].values[0] = NaN)],
    ["invalid interpolation", (field) => (field.components[0].interpolation = "smooth")],
    ["invalid conversion", (field) => (field.components[0].displayFactor = 0)],
    ["overflowing converted values", (field) => (field.components[0].displayFactor = 1e308)],
    ["out-of-order stations", (field) => (field.elements[0].stations[1].x = 3)],
    ["off-member stations", (field) => (field.elements[0].stations[3].x = 5)],
    ["ambiguous triple stations", (field) => (field.elements[0].stations[3].x = 2)],
  ]) {
    it(`rejects ${name}`, () => {
      const field = result();
      mutate(field);
      expect(() => validateResult(field, geometry())).toThrowError(TypeError);
    });
  }

  it("requires known, right-handed local axes aligned with the member", () => {
    const mesh = geometry();
    mesh.elements[0].localAxes.x = [-1, 0, 0];
    expect(() => validateResult(result(), mesh)).toThrowError(/right-handed/);
    delete mesh.elements[0].localAxes;
    expect(() => validateResult(result(), mesh)).toThrowError(/localAxes/);
  });

  it("allows float32 endpoint roundoff and partial spans without extrapolation", () => {
    const field = result();
    field.elements[0].stations[0].x = 0.5;
    field.elements[0].stations.at(-1).x = 4.0000002;
    expect(validateResult(field, geometry())).toBe(field);
  });

  it("accepts force-only sources", () => {
    const description = {
      model: { id: "test", title: "Test", source: "Test", coordinateSystem: { upAxis: "z" } },
      capabilities: { geometry: true, results: { loadCases: true, memberDiagram: true } },
    };
    expect(validateDescription(description)).toBe(description);
  });

  it("retains valid diagram settings and drops an invalid results block", () => {
    const settings = {
      loadCaseId: 1,
      kind: "memberDiagram",
      component: "Mz",
      diagramScale: 0.001,
      diagramPlane: "z",
      diagramFlip: true,
      diagramFilled: false,
      diagramLabels: true,
    };
    const normalized = normalizeViewDocument({ graphics: [{ results: settings }] });
    expect(normalized.graphics[0].results).toEqual(settings);
    const invalid = normalizeViewDocument({
      graphics: [{ results: { ...settings, diagramScale: -1 } }],
    });
    expect(invalid.graphics[0].results).toBeUndefined();
  });
});
