const {
  memberDiagramDirection,
  memberDiagramLabelIndices,
  memberDiagramOptions,
  memberDiagramSegments,
  formatMemberDiagram,
  stationPoint,
} = require("../lib/member-diagram");

describe("Graviss member diagram mathematics", () => {
  const stations = (...rows) => rows.map(([x, value]) => ({ x, value }));

  it("splits a signed linear interval exactly at zero", () => {
    const segments = memberDiagramSegments(stations([0, -2], [3, 4]));
    expect(segments).toEqual([
      { a: { x: 0, value: -2 }, b: { x: 1, value: 0 }, sign: -1 },
      { a: { x: 1, value: 0 }, b: { x: 3, value: 4 }, sign: 1 },
    ]);
  });

  it("preserves both sides of a point-force jump without spreading it over an interval", () => {
    const segments = memberDiagramSegments(stations([0, 10], [2, 10], [2, -5], [4, -5]));
    expect(segments.length).toBe(4);
    expect(segments[1]).toEqual({ a: { x: 2, value: 10 }, b: { x: 2, value: 0 }, sign: 1 });
    expect(segments[2]).toEqual({ a: { x: 2, value: 0 }, b: { x: 2, value: -5 }, sign: -1 });
    expect(segments[3].a).toEqual({ x: 2, value: -5 });
  });

  it("does not invent curves, samples or member-end values for a partial result", () => {
    const values = stations([1, 2], [2, 8], [3, 4]);
    expect(memberDiagramSegments(values)).toEqual([
      { a: values[0], b: values[1], sign: 1 },
      { a: values[1], b: values[2], sign: 1 },
    ]);
  });

  it("uses source-defined plane and polarity, with explicit display-plane overrides", () => {
    const momentZ = { id: "Mz", plane: "y", directionSign: -1 };
    const arbitrary = { id: "provider-specific-quantity", plane: "z", directionSign: 1 };
    expect(memberDiagramDirection(momentZ)).toEqual({ plane: "y", directionSign: -1 });
    expect(memberDiagramDirection(arbitrary)).toEqual({ plane: "z", directionSign: 1 });
    expect(memberDiagramDirection(momentZ, "y")).toEqual({ plane: "y", directionSign: 1 });
    expect(memberDiagramDirection(arbitrary, "auto", true)).toEqual({
      plane: "z",
      directionSign: -1,
    });
  });

  it("places stations from the first node in the supplied rolled and reversed local frame", () => {
    const axes = { x: [0, 0, -1], y: [1, 0, 0], z: [0, -1, 0] };
    expect(stationPoint([3, 4, 5], axes, { x: 2, value: 1000 }, 0.002, "y", 1)).toEqual([5, 4, 3]);
    expect(stationPoint([3, 4, 5], axes, { x: 2, value: 1000 }, 0.002, "z", -1)).toEqual([3, 6, 3]);
    expect(stationPoint([3, 4, 5], axes, { x: 2, value: 1000 }, 0.002, "z", -1, true)).toEqual([
      3, 4, 3,
    ]);
  });

  it("retains endpoints, interior extrema and one-sided jump labels", () => {
    const values = stations([0, 0], [1, 3], [2, 8], [3, 2], [3, -2], [4, -1], [5, 0]);
    expect(memberDiagramLabelIndices(values)).toEqual([0, 2, 3, 4, 6]);
  });

  it("keeps zero and constant fields defined and rejects invalid display scales", () => {
    expect(memberDiagramSegments(stations([0, 0], [2, 0])).length).toBe(1);
    for (const scale of [0, -1, NaN, Infinity, "1"])
      expect(() => memberDiagramOptions({ scale })).toThrow();
    expect(memberDiagramOptions({ scale: 0.001 }).scale).toBe(0.001);
    expect(memberDiagramOptions({ scale: "auto" }).scale).toBe("auto");
  });

  it("finds zero crossings without overflowing finite extreme values", () => {
    const segments = memberDiagramSegments(stations([0, -1e308], [2, 1e308]));
    expect(segments[0].b.x).toBe(1);
  });

  it("breaks runs at missing values and labels isolated known stations", () => {
    const values = stations([0, 5], [1, null], [2, -2], [3, null], [4, null]);
    expect(memberDiagramSegments(values)).toEqual([]);
    expect(memberDiagramLabelIndices(values)).toEqual([0, 2]);
    expect(memberDiagramLabelIndices(stations([0, null], [1, null]))).toEqual([]);
    expect(memberDiagramSegments(stations([0, 2], [1, 4], [2, null], [3, 6]))).toEqual([
      { a: { x: 0, value: 2 }, b: { x: 1, value: 4 }, sign: 1 },
    ]);
  });

  it("formats any source quantity with its stated display conversion", () => {
    expect(formatMemberDiagram(0.0012, 1000)).toBe("+1.2");
    expect(formatMemberDiagram(-2500, 0.001)).toBe("-2.5");
    expect(formatMemberDiagram(0.2, 1)).toBe("+0.2");
    expect(
      memberDiagramOptions({ component: "arbitrary/source-specific-quantity" }).component,
    ).toBe("arbitrary/source-specific-quantity");
  });

  it("never interpolates point quantities and labels every known point", () => {
    const values = stations([0, 5], [1, 3], [2, 2], [3, null], [4, 0], [5, -1]);
    expect(memberDiagramSegments(values, "point")).toEqual([]);
    expect(memberDiagramLabelIndices(values, "point")).toEqual([0, 1, 2, 4, 5]);
    expect(memberDiagramSegments(values, "linear").length).toBeGreaterThan(0);
  });
});
