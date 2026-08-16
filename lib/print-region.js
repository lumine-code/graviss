// A print region is the rectangle the user drew over the viewport, held as
// fractions of it so the same rectangle survives a resize. It stays where it
// was drawn; moving, rotating or zooming the camera changes what falls inside
// it, which is the whole point of composing through it.
//
// A world frustum — a centre, a width and a height in world units — is what an
// export finally needs, and the renderer works one out from the region against
// whatever the camera is showing at the time.

// Margin around the model when an image is framed to it.
const PRINT_MARGIN_FRACTION = 0.02;

function isFiniteExtent(extent) {
  return Boolean(extent) && extent.width > 0 && extent.height > 0;
}

function isFraction(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function validatePrintRegion(region, label = "A print region") {
  if (
    !region ||
    !isFraction(region.x) ||
    !isFraction(region.y) ||
    !(region.width > 0) ||
    !(region.height > 0) ||
    !isFraction(region.width) ||
    !isFraction(region.height) ||
    region.x + region.width > 1.0001 ||
    region.y + region.height > 1.0001
  ) {
    throw new RangeError(`${label} must be a rectangle inside the viewport, in fractions of it`);
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

function clampFraction(value, lowest = 0, highest = 1) {
  return Math.min(highest, Math.max(lowest, value));
}

// One gesture applied to a region: no handle moves the whole frame, a handle
// moves the edges it names. Everything stays inside the viewport and no edge
// may cross the one opposite it, so a drag can never invert or escape.
function resizePrintRegion(region, handle, delta) {
  const start = validatePrintRegion(region);
  const deltaX = Number.isFinite(delta?.x) ? delta.x : 0;
  const deltaY = Number.isFinite(delta?.y) ? delta.y : 0;
  if (!handle) {
    return {
      ...start,
      x: clampFraction(start.x + deltaX, 0, 1 - start.width),
      y: clampFraction(start.y + deltaY, 0, 1 - start.height),
    };
  }

  const next = { ...start };
  if (handle.includes("w")) {
    next.x = clampFraction(start.x + deltaX, 0, start.x + start.width - MINIMUM_REGION_FRACTION);
    next.width = start.x + start.width - next.x;
  }
  if (handle.includes("e")) {
    next.width = clampFraction(start.width + deltaX, MINIMUM_REGION_FRACTION, 1 - start.x);
  }
  if (handle.includes("n")) {
    next.y = clampFraction(start.y + deltaY, 0, start.y + start.height - MINIMUM_REGION_FRACTION);
    next.height = start.y + start.height - next.y;
  }
  if (handle.includes("s")) {
    next.height = clampFraction(start.height + deltaY, MINIMUM_REGION_FRACTION, 1 - start.y);
  }
  return next;
}

// A rectangle cut down to the viewport it is a fraction of. A frame taken from
// the structure reaches past the edges whenever the structure does, and a
// region is only ever a piece of the view, so the part that hangs over is
// dropped rather than treated as a mistake. Nothing left inside means the
// structure is off screen entirely, which is for the caller to report.
function clipPrintRegion(region) {
  if (!region) return null;
  const left = clampFraction(region.x);
  const top = clampFraction(region.y);
  const right = clampFraction(region.x + region.width);
  const bottom = clampFraction(region.y + region.height);
  const width = right - left;
  const height = bottom - top;
  if (!(width >= MINIMUM_REGION_FRACTION) || !(height >= MINIMUM_REGION_FRACTION)) return null;
  return { x: left, y: top, width, height };
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
  clipPrintRegion,
  PRINT_MARGIN_FRACTION,
  resizePrintRegion,
  validateWorldFrustum,
  printPixelSize,
  printRegionForExtent,
  validatePrintRegion,
};
