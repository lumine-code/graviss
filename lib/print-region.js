// A print region is an unambiguous plotting area: a rectangle in metres on
// the plane through the camera target, its centre offset along the camera's
// right and up axes. Stated that way it names the same piece of the structure
// in any pane, at any window size, and from a batch render that never had a
// window at all — which fractions of a viewport never could. On screen it is
// derived, not stored: the overlay is projected from the world rectangle
// against the camera every frame, so resizing the pane moves the frame to
// keep marking what it marks.
//
// Gestures still happen in viewport fractions — a drag is a screen thing —
// and are converted to metres at the moment they are written down.

// Margin around the model when an image is framed to it.
const PRINT_MARGIN_FRACTION = 0.02;

function isFiniteExtent(extent) {
  return Boolean(extent) && extent.width > 0 && extent.height > 0;
}

function validatePrintRegion(region, label = "A print region") {
  if (
    !region ||
    !Number.isFinite(region.right) ||
    !Number.isFinite(region.up) ||
    !Number.isFinite(region.width) ||
    !Number.isFinite(region.height) ||
    !(region.width > 0) ||
    !(region.height > 0)
  ) {
    throw new RangeError(`${label} must be a rectangle on the target plane, in metres`);
  }
  return { right: region.right, up: region.up, width: region.width, height: region.height };
}

// The viewport-fraction rectangle a gesture works in. Free to reach past the
// viewport: a region larger than the pane is a pane showing less of it, not
// an error.
function validateViewportRegion(region, label = "A viewport region") {
  if (
    !region ||
    !Number.isFinite(region.x) ||
    !Number.isFinite(region.y) ||
    !(region.width > 0) ||
    !(region.height > 0)
  ) {
    throw new RangeError(`${label} must be a rectangle in viewport fractions`);
  }
  return { x: region.x, y: region.y, width: region.width, height: region.height };
}

function validateWorldFrustum(frustum, label = "A world frustum") {
  if (
    !isFiniteExtent(frustum) ||
    !Number.isFinite(frustum.width) ||
    !Number.isFinite(frustum.height)
  ) {
    throw new RangeError(`${label} requires a positive width and height`);
  }
  const validated = { width: frustum.width, height: frustum.height };
  if (frustum.center) validated.center = [...frustum.center];
  return validated;
}

// The margin is a fraction of the longer side, so a long thin structure gets
// the same visual breathing room on both axes instead of a margin that
// vanishes across its short one.
function printRegionForExtent(extent, marginFraction = PRINT_MARGIN_FRACTION) {
  const { width, height, center } = validateWorldFrustum(extent, "A model extent");
  if (!(marginFraction >= 0)) throw new RangeError("A print margin fraction cannot be negative");
  const margin = Math.max(width, height) * marginFraction;
  const region = { width: width + margin * 2, height: height + margin * 2 };
  if (center) region.center = center;
  return region;
}

// The smallest frame worth having; below it the handles overlap each other.
const MINIMUM_REGION_FRACTION = 0.04;

// One gesture applied to a viewport-fraction region: no handle moves the
// whole frame, a handle moves the edges it names. No edge may cross the one
// opposite it, so a drag can never invert — but nothing confines the frame to
// the viewport, because the frame marks structure, and structure does not end
// at the pane.
function resizePrintRegion(region, handle, delta) {
  const start = validateViewportRegion(region);
  const deltaX = Number.isFinite(delta?.x) ? delta.x : 0;
  const deltaY = Number.isFinite(delta?.y) ? delta.y : 0;
  if (!handle) {
    return { ...start, x: start.x + deltaX, y: start.y + deltaY };
  }

  const next = { ...start };
  if (handle.includes("w")) {
    next.x = Math.min(start.x + deltaX, start.x + start.width - MINIMUM_REGION_FRACTION);
    next.width = start.x + start.width - next.x;
  }
  if (handle.includes("e")) {
    next.width = Math.max(start.width + deltaX, MINIMUM_REGION_FRACTION);
  }
  if (handle.includes("n")) {
    next.y = Math.min(start.y + deltaY, start.y + start.height - MINIMUM_REGION_FRACTION);
    next.height = start.y + start.height - next.y;
  }
  if (handle.includes("s")) {
    next.height = Math.max(start.height + deltaY, MINIMUM_REGION_FRACTION);
  }
  return next;
}

// The long side of an exported image, unless the context cannot allocate a
// buffer that wide. Generous, because an image is exported to be looked at
// closely or dropped into a document, and rendering one is a one-shot cost.
const EXPORT_MAX_EDGE = 8192;
// Total pixels, which is what actually bounds the allocation: a square at the
// edge limit would ask for four times this.
const EXPORT_MAX_PIXELS = 1.6e7;

// Pixels for the raster, capped on the long side and on total area. The cap
// keeps a wide region from asking for a buffer no GL context will allocate,
// and the aspect is preserved so the region is never distorted.
function printPixelSize(
  frustum,
  { maxEdge = EXPORT_MAX_EDGE, maxPixels = EXPORT_MAX_PIXELS } = {},
) {
  const { width, height } = validateWorldFrustum(frustum);
  if (!(maxEdge >= 1) || !(maxPixels >= 1)) {
    throw new RangeError("Print pixel limits must be positive");
  }
  const aspect = width / height;
  let pixelWidth = aspect >= 1 ? maxEdge : maxEdge * aspect;
  let pixelHeight = aspect >= 1 ? maxEdge / aspect : maxEdge;
  const area = pixelWidth * pixelHeight;
  if (area > maxPixels) {
    const scale = Math.sqrt(maxPixels / area);
    pixelWidth *= scale;
    pixelHeight *= scale;
  }
  return {
    width: Math.max(1, Math.round(pixelWidth)),
    height: Math.max(1, Math.round(pixelHeight)),
  };
}

module.exports = {
  EXPORT_MAX_EDGE,
  EXPORT_MAX_PIXELS,
  MINIMUM_REGION_FRACTION,
  PRINT_MARGIN_FRACTION,
  resizePrintRegion,
  validateWorldFrustum,
  printPixelSize,
  printRegionForExtent,
  validatePrintRegion,
  validateViewportRegion,
};
