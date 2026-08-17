const {
  EXPORT_MAX_EDGE,
  EXPORT_MAX_PIXELS,
  MINIMUM_REGION_FRACTION,
  PRINT_MARGIN_FRACTION,
  resizePrintRegion,
  validateWorldFrustum,
  printPixelSize,
  printRegionForExtent,
  validatePrintRegion,
} = require("../lib/print-region");

describe("print regions", () => {
  it("margins the model by a fraction of its longer side", () => {
    expect(PRINT_MARGIN_FRACTION).toBe(0.02);

    // A long thin structure gets the same breathing room on both axes, rather
    // than a margin that vanishes across its short one.
    const region = printRegionForExtent({ width: 200, height: 10 });
    expect(region.width).toBeCloseTo(208, 9);
    expect(region.height).toBeCloseTo(18, 9);

    const square = printRegionForExtent({ width: 40, height: 40 });
    expect(square.width).toBeCloseTo(41.6, 9);
    expect(square.height).toBeCloseTo(41.6, 9);
  });

  it("refuses an extent that describes no area", () => {
    expect(() => printRegionForExtent({ width: 0, height: 5 })).toThrowError(/positive width/);
    expect(() => printRegionForExtent({ width: 5, height: Infinity })).toThrowError(
      /positive width/,
    );
    expect(() => printRegionForExtent({ width: 5, height: 5 }, -0.1)).toThrowError(/negative/);
    expect(() => validateWorldFrustum(null)).toThrowError(/positive width/);
  });

  it("holds the region as a view window, unbounded by any pane", () => {
    // The centre may be anywhere about the view axis and the extents any
    // positive size: the window is the view's, and the view does not end at
    // a pane.
    expect(validatePrintRegion({ center: [-1.5, 0.75], width: 4, height: 0.8 })).toEqual({
      center: [-1.5, 0.75],
      width: 4,
      height: 0.8,
    });

    // But it has to be a real rectangle about a real centre.
    expect(() => validatePrintRegion({ center: [0, 0], width: 0, height: 4 })).toThrowError(
      /view tangents/,
    );
    expect(() => validatePrintRegion({ center: [NaN, 0], width: 4, height: 4 })).toThrowError(
      /view tangents/,
    );
    expect(() => validatePrintRegion({ x: 0.1, y: 0.2, width: 0.5, height: 0.4 })).toThrowError(
      /view tangents/,
    );
  });

  it("exports at a resolution worth looking at, bounded by what fits", () => {
    // A square asks for four times the area of the edge limit, so the area cap
    // is what actually bounds the allocation.
    expect(EXPORT_MAX_EDGE).toBe(8192);
    const square = printPixelSize({ width: 10, height: 10 });
    expect(square.width).toBe(square.height);
    expect(square.width * square.height).toBeLessThanOrEqual(EXPORT_MAX_PIXELS + 1);
    expect(square.width).toBeGreaterThan(3500);

    // A long thin region reaches the edge limit instead.
    const strip = printPixelSize({ width: 400, height: 10 });
    expect(strip.width).toBe(EXPORT_MAX_EDGE);
  });

  it("keeps the region's shape in the raster it prints from", () => {
    const wide = printPixelSize({ width: 200, height: 50 }, { maxEdge: 4000, maxPixels: 1e9 });
    expect(wide.width).toBe(4000);
    expect(wide.height).toBe(1000);

    const tall = printPixelSize({ width: 50, height: 200 }, { maxEdge: 4000, maxPixels: 1e9 });
    expect(tall.width).toBe(1000);
    expect(tall.height).toBe(4000);

    // The area cap holds the buffer to something a context will allocate,
    // without distorting what it covers.
    const capped = printPixelSize({ width: 100, height: 100 }, { maxEdge: 4000, maxPixels: 1e6 });
    expect(capped.width).toBe(1000);
    expect(capped.height).toBe(1000);
    expect(capped.width / capped.height).toBeCloseTo(1, 9);
  });
});

describe("reshaping a print region", () => {
  const start = { x: 0.2, y: 0.2, width: 0.4, height: 0.4 };

  it("moves the whole frame when no handle is held", () => {
    expect(resizePrintRegion(start, null, { x: 0.1, y: -0.05 })).toEqual({
      x: 0.30000000000000004,
      y: 0.15000000000000002,
      width: 0.4,
      height: 0.4,
    });

    // Moving keeps its size and is free to leave the viewport: the frame
    // marks structure, and structure does not end at the pane.
    const pushed = resizePrintRegion(start, null, { x: 5, y: 5 });
    expect(pushed.width).toBeCloseTo(0.4, 9);
    expect(pushed.height).toBeCloseTo(0.4, 9);
    expect(pushed.x).toBeCloseTo(5.2, 9);
    expect(pushed.y).toBeCloseTo(5.2, 9);
  });

  it("moves only the edges a handle names", () => {
    const east = resizePrintRegion(start, "e", { x: 0.1, y: 0.3 });
    expect(east.x).toBeCloseTo(0.2, 9);
    expect(east.width).toBeCloseTo(0.5, 9);
    expect(east.height).toBeCloseTo(0.4, 9);

    // A west drag moves the left edge and takes the width with it, so the right
    // edge stays put.
    const west = resizePrintRegion(start, "w", { x: 0.1, y: 0 });
    expect(west.x).toBeCloseTo(0.30000000000000004, 9);
    expect(west.x + west.width).toBeCloseTo(0.6, 9);

    const corner = resizePrintRegion(start, "nw", { x: 0.1, y: 0.1 });
    expect(corner.x).toBeCloseTo(0.30000000000000004, 9);
    expect(corner.y).toBeCloseTo(0.30000000000000004, 9);
    expect(corner.x + corner.width).toBeCloseTo(0.6, 9);
    expect(corner.y + corner.height).toBeCloseTo(0.6, 9);
  });

  it("never lets an edge cross the one opposite it", () => {
    const collapsed = resizePrintRegion(start, "e", { x: -5, y: 0 });
    expect(collapsed.width).toBeCloseTo(MINIMUM_REGION_FRACTION, 9);

    const crossed = resizePrintRegion(start, "w", { x: 5, y: 0 });
    expect(crossed.width).toBeCloseTo(MINIMUM_REGION_FRACTION, 9);
    expect(crossed.x + crossed.width).toBeCloseTo(0.6, 9);

    // Growing past the viewport is allowed; only inversion is not.
    const stretched = resizePrintRegion(start, "se", { x: 5, y: 5 });
    expect(stretched.x + stretched.width).toBeCloseTo(5.6, 9);
    expect(stretched.y + stretched.height).toBeCloseTo(5.6, 9);

    expect(() => resizePrintRegion(null, "e", { x: 0 })).toThrowError(/viewport fractions/);
  });
});
