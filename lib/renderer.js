const { prepareShellTopology } = require("./shell-topology");
const { createShellGpuBackend } = require("./shell-gpu");
const {
  prepareShellSurfaceTangents,
  shellCoonsPosition,
  writeSampledShellNormals,
  writeShellSurface,
  updateShellNormalsFromRotations,
  updateShellNormals,
  writeShellProxy,
} = require("./shell-deformation");
const { APPEARANCE_IDS, appearanceDefinition } = require("./appearance");
const { Animation } = require("./animation");
const { STOPS, sampleColorScale } = require("./color-scale");
const { Deformation } = require("./deformation");
const {
  DEFAULT_MEMBER_DIAGRAM_OPTIONS,
  MemberDiagram,
  memberDiagramOptions,
} = require("./member-diagram");
const {
  cameraViewDefinition,
  cameraViewIdForDirection,
  perspectiveDistanceForHeight,
  perspectiveVisibleHeight,
  sphereFitDistance,
  validateCameraState,
} = require("./camera-navigation");
const { OrientationGizmo } = require("./orientation-gizmo");
const {
  EXPORT_MAX_EDGE,
  PRINT_MARGIN_FRACTION,
  printPixelSize,
  validatePrintRegion,
} = require("./print-region");
const { FrameRateMeter } = require("./frame-rate-meter");
const { canonicalDirectionToModel, coordinateSystemDefinition } = require("./coordinate-system");
const { LINE_ELEMENT_KINDS } = require("./validation");
const { loadThreeRuntime } = require("./three-runtime");
const { ViewCube } = require("./view-cube");
const { ViewportVisibility } = require("./viewport-visibility");
const resolveThemeColor = require("./theme-color");

const CAMERA_SCROLL_SETTLE_MS = 180;
const FILTERED_ENTITY_TYPES = new Set(["element", "spring", "coupling"]);
// How flat a model has to be to count as a plane: an extent along one global
// axis under a millionth of the model's longest. That is far below anything a
// structure is modelled to and far above the noise in coordinates a source
// stored at single precision, and every plane system writes an exact zero.
const PLANAR_EXTENT_FRACTION = 1e-6;
// The three views a plane is looked at from. A plan is seen from above and an
// elevation from the front, so a plane's normal is turned to whichever of
// these it lies along rather than to its opposite.
const PLANE_VIEW_IDS = Object.freeze(["top", "front", "right"]);
// How far behind a planar model its grid stands, as a fraction of the model's
// radius. Drawn in the plane itself it would tie with anything meshed flat
// there and win, ruling the grid across the slab it is meant to sit under.
const GRID_PLANE_CLEARANCE = 0.02;
const ZERO_MEMBER_ROTATION = Object.freeze([0, 0, 0]);
const CAMERA_VIEW_ANIMATION_MS = 360;
const CAMERA_PAN_FRACTION = 0.06;
const CAMERA_ROTATION_STEP = Math.PI / 12;
const CAMERA_ZOOM_SCALE = 0.82;
const CAMERA_POLE_OFFSET = 2e-6;
// A floor under the camera-to-target distance: a hundredth of the model, and
// never nearer than a few near planes. Zoom scales that distance geometrically
// rather than subtracting from it, so without a floor it decays towards zero
// and never reaches it — the camera ends up microns from its target and orders
// of magnitude inside a near plane fixed when the view was framed, with every
// surface it was approaching clipped away and nothing left in front of it to
// move against. Every gesture still works there, and all of them look stuck.
const MINIMUM_ORBIT_DISTANCE_FRACTION = 0.01;
// A symbol's radius is a real length in metres, so what it says is what it
// measures. Left alone it takes a size from the model — everything drawn as a
// mark rather than as structure is sized from that one number, so one control
// moves nodes, supports, springs and couplings together.
const SYMBOL_SIZE_DIVISOR = 500;
// A graded background is the appearance's own colour carried towards a cool
// tint above the horizon and a warm one below it. Hue is what tells up from
// down here: light and shade alone say only which end is brighter, and a
// viewport that can be turned under its model needs the stronger signal. The
// tints are shared by every scheme and the colour under them is not, so Cloud
// and Midnight each grade from what they already are.
const SKY_TINT = 0x6fa8dc;
const GROUND_TINT = 0x9c6b4f;
const BACKGROUND_GRADIENT_LIFT = 0.42;
const BACKGROUND_GRADIENT_DROP = 0.3;
// Enough segments for the grade to be smooth on a sphere the whole view sits
// inside. It carries no detail, only a direction.
const SKY_SEGMENTS = [32, 16];
// The rest of the family, as multiples of that radius, keeping the proportions
// the fixed sizes had.
const SUPPORT_RADIUS = 2.6;
const SUPPORT_HEIGHT = 4.5;
const SUPPORT_STANDOFF = 2.35;
// Nothing at all up to a metre: zero puts every mark away, and past a metre a
// symbol is no longer a mark on a structure but a shape in front of it.
const SYMBOL_SIZE_RANGE = [0, 1];
// A spring that acts along its axis is drawn as the helix it is: this many
// turns across the middle of its length, at this many segments each, with the
// ends left straight so it still reads as joining what it joins.
const SPRING_TURNS = 4;
const SPRING_SEGMENTS = 8;
const SPRING_BODY = 0.62;
// A spring that acts about its axis is drawn as a turn about it: a ring at the
// middle of its length, in the plane it rotates in.
const SPRING_RING_SEGMENTS = 24;
// A complete axial helix: two straight ends around its sampled coil.
const SPRING_SEGMENT_BUDGET = SPRING_TURNS * SPRING_SEGMENTS + 2;
// How much of the gap to whatever is under the pointer one notch of the wheel
// closes. Measured against that surface rather than against the camera target,
// so the pace is right whether the wheel is over the near flange or the far
// abutment, and the approach is asymptotic: the surface is never passed. An
// orthographic camera has no gap to close, so the same fraction narrows the
// framing it draws through instead — one notch, one ratio, either projection.
const ZOOM_NOTCH_FRACTION = 0.2;
// How long the camera takes to settle on what a notch asked for. This is a
// time constant, not a duration: the remaining gap is closed by the same
// proportion every frame, so a notch arriving mid-flight retargets from
// wherever the camera has got to, with no run to restart and no seam.
const ZOOM_SETTLE_MS = 90;
// Close enough to have arrived. A thousandth of the remaining gap is under a
// pixel at any distance, because the gap is measured as a ratio.
const ZOOM_SETTLE_EPSILON = 1e-3;
// A frame gap longer than this is a stall, not slow motion. Easing across it
// would arrive in one visible jump, so it is spent as an ordinary frame.
const ZOOM_MAXIMUM_FRAME_MS = 64;
// Two aims within a twentieth of a degree are the same aim, so a wheel held
// still compounds its notches instead of chasing a camera already moving.
const ZOOM_SAME_AIM = 0.9999;
// How far an orthographic framing may be wound in and out, as a multiple of
// the model's own radius. A framing narrower than the near limit is finer than
// the coordinates it draws, and one wider than the far limit has lost the
// model in the middle of an empty screen; both are places a wheel can reach in
// a second and neither shows anything. Perspective has the same floor and
// ceiling in `controls.minDistance` and `maxDistance`.
const FRUSTUM_MINIMUM_FRACTION = 1e-4;
const FRUSTUM_MAXIMUM_FACTOR = 1e4;
// The depth range is rebuilt from where the camera is rather than from where it
// was framed, so flying in does not clip what is being approached and flying
// out does not lose the far side of the model. The ratio is what a depth buffer
// can carry before coplanar surfaces start fighting.
const MAXIMUM_DEPTH_RATIO = 1e4;
// A rotation this small is not one. cos(angle / 2) within 1e-12 of 1 is an
// angle under 3e-6 radians, where one pixel of drag is 2π/clientHeight — about
// 1e-2. So this rejects only the floating-point wobble a pan or a dolly leaves
// behind from rebuilding the camera offset through spherical coordinates.
const ORBIT_PIVOT_ROTATION_EPSILON = 1e-12;
// Below this a drag is a click, not a rectangle.
const MINIMUM_REGION_PIXELS = 8;
// Enough for the centre to settle; a fourth pass moves it by nothing visible.
const PROJECTED_EXTENT_PASSES = 4;
// Past this a silhouette costs more than the tighter frame is worth, and the
// corners of the model's bounds stand in instead.
const MODEL_SILHOUETTE_POINT_BUDGET = 400_000;
// Boundary detection is a one-shot render before an export or an explicit
// auto-frame. This is fine enough to locate its silhouette within a pixel while
// keeping the readback small beside the final image, which may reach 16 MP.
const MODEL_BOUNDARY_MAX_EDGE = 1024;
// A fit leaves a small deliberate border around the projected structure. The
// old spherical fit left the radius of a long bridge above and below it, which
// could reduce the model to less than half the viewport even though its actual
// projection was a shallow strip.
const MODEL_FIT_FILL_FRACTION = 0.9;

// The global axis a model has no extent along, when it has exactly one — the
// normal of the plane every node of it lies in. Two of the three axes must
// have extent or there is no plane to name: a straight run of nodes lies in
// infinitely many and a single node in all of them.
//
// Measured rather than declared, because the measurement is the thing that
// matters and a declaration could only ever agree with it. A plane frame, a
// grillage and a slab meshed flat are all drawn best face on, whatever the
// source that read them calls the system they came from.
function planeNormalOf(min, max) {
  const extents = min.map((value, index) => max[index] - value);
  const longest = Math.max(...extents);
  if (!(longest > 0)) return null;
  const flat = extents.map((extent) => extent <= longest * PLANAR_EXTENT_FRACTION);
  const axis = flat.indexOf(true);
  if (axis < 0 || flat.lastIndexOf(true) !== axis) return null;
  const normal = [0, 0, 0];
  normal[axis] = 1;
  return normal;
}

// What is drawn when a graphic says nothing about it. Stated once, because a
// viewer restoring a graphic has to put back every switch the last one moved
// and not merely the ones the new one names - a second copy of this list is how
// a switch gets left where the previous graphic had it.
const DEFAULT_VISIBILITY = Object.freeze({
  members: true,
  shells: true,
  nodes: false,
  supports: true,
  mesh: true,
  grid: false,
  axes: true,
  localAxes: false,
  springs: true,
  couplings: true,
});

// How finely a member is drawn along its own length once there is something to
// bend it. One step at rest, because a straight member has nothing to say
// between its ends and every extra ring is vertices nobody sees.
const MEMBER_BEND_STEPS = 8;
// Four intervals retain the bilinear Q4 displacement field as a smooth sampled
// surface instead of exposing the triangles used to draw it. Results with
// shell rotations get that denser layout because their independent directors
// also turn the element's thickness between the translated corner nodes.
const SHELL_RESULT_STEPS = 4;

// The bow a member takes between its two ends, evaluated on the card. Its cubic
// uses the same end translations and the same first-order rotational derivative
// as a Hermite beam, but its handles are bounded tangent directions of a fixed
// reference length. That distinction vanishes with the result factor and is
// what stops an intentionally huge display factor turning an infinitesimal
// rotation into an unbounded handle and then into a loop. Only the deviation
// from the chord is added here: the instance matrix already spans the moved end
// nodes. A single uniform says how far, so a frame still changes one number.
const MEMBER_BEND_CHUNK = `
  #ifdef GRAVISS_BEND
  if (gravissBendFactor != 0.0) {
    float instanceLength = length(instanceMatrix[0].xyz);
      float bendLength = abs(instanceBendLength);
    if (bendLength > 0.0 && instanceLength > 0.0) {
      float xi = clamp(transformed.x + 0.5, 0.0, 1.0);
      float xi2 = xi * xi;
      float xi3 = xi2 * xi;
      float ry0 = instanceBendR.x;
      float rz0 = instanceBendR.y;
      float ry1 = instanceBendR.z;
      float rz1 = instanceBendR.w;
      vec3 currentX = instanceMatrix[0].xyz / instanceLength;
      vec3 currentY = instanceMatrix[1].xyz;
      vec3 currentZ = instanceMatrix[2].xyz;
      vec3 tangent = currentX;
      vec3 centreShift = vec3(0.0);
      if (instanceBendLength > 0.0) {
        vec3 originalX = normalize(cross(instanceBendY, instanceBendZ));

        // A linear result stores infinitesimal rotations. Multiplying those
        // angles directly into Hermite tangent lengths makes the handles grow
        // without a bound and a highly amplified member loops over itself. The
        // same rotations used as finite directions have the identical first
        // derivative at zero and remain unit vectors at every display factor.
        vec2 bend0 = vec2(ry0, rz0) * gravissBendFactor;
        vec2 bend1 = vec2(ry1, rz1) * gravissBendFactor;
        vec3 tangent0 = normalize(
          originalX + instanceBendY * bend0.y - instanceBendZ * bend0.x
        );
        vec3 tangent1 = normalize(
          originalX + instanceBendY * bend1.y - instanceBendZ * bend1.x
        );
        vec3 chord = instanceMatrix[0].xyz;
        float handle = bendLength / 3.0;
        vec3 control0 = tangent0 * handle;
        vec3 control1 = chord - tangent1 * handle;
        float oneMinusXi = 1.0 - xi;
        vec3 curve =
          3.0 * oneMinusXi * oneMinusXi * xi * control0 +
          3.0 * oneMinusXi * xi2 * control1 +
          xi3 * chord;
        vec3 curveDerivative =
          3.0 * oneMinusXi * oneMinusXi * control0 +
          6.0 * oneMinusXi * xi * (control1 - control0) +
          3.0 * xi2 * (chord - control1);
        tangent = length(curveDerivative) > 1e-7 ? normalize(curveDerivative) : currentX;
        centreShift = curve - chord * xi;
      }

      // Start with the section as the instance chord placed it, turn it onto
      // the curve tangent, then apply its own twist about that tangent. Unlike
      // a small-angle cross product this keeps the section rigid at x1000 too.
      vec3 offset = currentY * transformed.y + currentZ * transformed.z;
      vec3 aligned = offset;
      vec3 alignAxis = cross(currentX, tangent);
      float alignSine = length(alignAxis);
      float alignCosine = clamp(dot(currentX, tangent), -1.0, 1.0);
      if (alignSine > 1e-7) {
        alignAxis /= alignSine;
        aligned =
          offset * alignCosine +
          cross(alignAxis, offset) * alignSine +
          alignAxis * dot(alignAxis, offset) * (1.0 - alignCosine);
      } else if (alignCosine < 0.0) {
        aligned = -offset + 2.0 * currentY * dot(currentY, offset);
      }
      float twist = mix(instanceBendA.w, instanceBendB.w, xi) * gravissBendFactor;
      float twistSine = sin(twist);
      float twistCosine = cos(twist);
      aligned =
        aligned * twistCosine +
        cross(tangent, aligned) * twistSine +
        tangent * dot(tangent, aligned) * (1.0 - twistCosine);
      centreShift += aligned - offset;

      // Unit warping is in m2 and phi-w in 1/m, so their product is a
      // displacement along the deformed section's own longitudinal direction.
      float warping = mix(instanceBendW.x, instanceBendW.y, xi);
      centreShift += tangent * gravissSectionWarping * warping * gravissBendFactor;

      // x is the one axis the instance matrix scales, so a physical shift in
      // that direction is stated as a fraction of the drawn chord.
      transformed.x += dot(centreShift, currentX) / instanceLength;
      transformed.y += dot(centreShift, currentY);
      transformed.z += dot(centreShift, currentZ);
    }
  }
  #endif
`;

const MEMBER_BEND_DECLARATIONS = `
  #ifdef GRAVISS_BEND
  attribute vec4 instanceBendA;
  attribute vec4 instanceBendB;
  attribute vec4 instanceBendR;
  attribute vec2 instanceBendW;
  attribute float instanceBendLength;
  attribute vec3 instanceBendY;
  attribute vec3 instanceBendZ;
  attribute float gravissSectionWarping;
  uniform float gravissBendFactor;
  #endif
`;

const MEMBER_FIELD_VERTEX_DECLARATIONS = `
  varying float gravissDisplacementFraction;
  varying float gravissDisplacementField;
`;

const MEMBER_FIELD_VERTEX_CHUNK = `
  gravissDisplacementFraction = 0.0;
  gravissDisplacementField = 0.0;
  #ifdef USE_INSTANCING_COLOR
    gravissDisplacementFraction = mix(
      instanceColor.r,
      instanceColor.g,
      clamp(position.x + 0.5, 0.0, 1.0)
    );
    gravissDisplacementField = step(1.5, instanceColor.b);
  #endif
`;

const SHELL_FIELD_VERTEX_DECLARATIONS = `
  attribute float gravissDisplacement;
  varying float gravissDisplacementFraction;
  varying float gravissDisplacementField;
`;

const SHELL_FIELD_VERTEX_CHUNK = `
  gravissDisplacementFraction = max(0.0, gravissDisplacement);
  gravissDisplacementField = step(0.0, gravissDisplacement);
`;

const DISPLACEMENT_FIELD_FRAGMENT_DECLARATIONS = `
  uniform vec3 gravissDisplacementStops[5];
  varying float gravissDisplacementFraction;
  varying float gravissDisplacementField;

  vec3 gravissSampleDisplacement(float fraction) {
    float position = clamp(fraction, 0.0, 1.0) * 4.0;
    if (position < 1.0) return mix(gravissDisplacementStops[0], gravissDisplacementStops[1], position);
    if (position < 2.0) return mix(gravissDisplacementStops[1], gravissDisplacementStops[2], position - 1.0);
    if (position < 3.0) return mix(gravissDisplacementStops[2], gravissDisplacementStops[3], position - 2.0);
    return mix(gravissDisplacementStops[3], gravissDisplacementStops[4], position - 3.0);
  }
`;

function writeColorScale(fraction, into, offset) {
  const clamped = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  const position = clamped * (STOPS.length - 1);
  const lower = Math.min(STOPS.length - 2, Math.floor(position));
  const within = position - lower;
  const from = STOPS[lower];
  const to = STOPS[lower + 1];
  into[offset] = from[0] + (to[0] - from[0]) * within;
  into[offset + 1] = from[1] + (to[1] - from[1]) * within;
  into[offset + 2] = from[2] + (to[2] - from[2]) * within;
}

function geometryBounds(geometry) {
  if (!geometry.nodes.length) {
    return { min: [0, 0, 0], max: [0, 0, 0], center: [0, 0, 0], radius: 1, planeNormal: null };
  }
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const node of geometry.nodes) {
    const values = [node.x, node.y, node.z];
    for (let index = 0; index < 3; index += 1) {
      min[index] = Math.min(min[index], values[index]);
      max[index] = Math.max(max[index], values[index]);
    }
  }
  const center = min.map((value, index) => (value + max[index]) / 2);
  const radius = Math.max(1, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
  return { min, max, center, radius, planeNormal: planeNormalOf(min, max) };
}

const AXIS_NAMES = ["x", "y", "z"];
// Module-scope so the connector shaper allocates nothing per element; read
// only, never written.
let UNIT_X = null;
let UNIT_Y = null;
let UNIT_Z = null;
const QUAD_FACES = [
  [0, 1, 2],
  [0, 2, 3],
];

const TRIANGLE_SURFACE_LAYOUT = Object.freeze({
  weights: Float32Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]),
  indices: Uint8Array.from([0, 1, 2]),
  boundaries: Object.freeze([
    Uint8Array.from([0, 1]),
    Uint8Array.from([1, 2]),
    Uint8Array.from([2, 0]),
  ]),
  corners: Uint8Array.from([0, 1, 2]),
  width: null,
});
const QUAD_SURFACE_LAYOUT = Object.freeze({
  // Four corners and the isoparametric centre. The centre's equal weights
  // retain the bilinear cross term that a single diagonal loses.
  weights: Float32Array.from([
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0.25, 0.25, 0.25, 0.25,
  ]),
  indices: Uint8Array.from([0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4]),
  boundaries: Object.freeze([
    Uint8Array.from([0, 1]),
    Uint8Array.from([1, 2]),
    Uint8Array.from([2, 3]),
    Uint8Array.from([3, 0]),
  ]),
  corners: Uint8Array.from([0, 1, 2, 3]),
  width: null,
});
const LINEAR_QUAD_SURFACE_LAYOUT = Object.freeze({
  weights: Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  indices: Uint8Array.from(QUAD_FACES.flat()),
  boundaries: QUAD_SURFACE_LAYOUT.boundaries,
  corners: QUAD_SURFACE_LAYOUT.corners,
  width: null,
});
const SAMPLED_QUAD_SURFACE_LAYOUT = createQuadSurfaceLayout(SHELL_RESULT_STEPS);

function createQuadSurfaceLayout(steps) {
  const width = steps + 1;
  const sampleCount = width * width;
  const weights = new Float32Array(sampleCount * 4);
  const parameters = new Float32Array(sampleCount * 2);
  for (let row = 0; row < width; row += 1) {
    const t = row / steps;
    for (let column = 0; column < width; column += 1) {
      const s = column / steps;
      const sample = row * width + column;
      const at = sample * 4;
      weights[at] = (1 - s) * (1 - t);
      weights[at + 1] = s * (1 - t);
      weights[at + 2] = s * t;
      weights[at + 3] = (1 - s) * t;
      parameters[sample * 2] = s;
      parameters[sample * 2 + 1] = t;
    }
  }
  const IndexArray = sampleCount > 255 ? Uint16Array : Uint8Array;
  const indices = new IndexArray(steps * steps * 6);
  let cursor = 0;
  for (let row = 0; row < steps; row += 1) {
    for (let column = 0; column < steps; column += 1) {
      const lowerLeft = row * width + column;
      const lowerRight = lowerLeft + 1;
      const upperLeft = lowerLeft + width;
      const upperRight = upperLeft + 1;
      indices[cursor] = lowerLeft;
      indices[cursor + 1] = lowerRight;
      indices[cursor + 2] = upperRight;
      indices[cursor + 3] = lowerLeft;
      indices[cursor + 4] = upperRight;
      indices[cursor + 5] = upperLeft;
      cursor += 6;
    }
  }
  const boundaries = [
    new Uint8Array(width),
    new Uint8Array(width),
    new Uint8Array(width),
    new Uint8Array(width),
  ];
  for (let step = 0; step < width; step += 1) {
    boundaries[0][step] = step;
    boundaries[1][step] = step * width + steps;
    boundaries[2][step] = steps * width + (steps - step);
    boundaries[3][step] = (steps - step) * width;
  }
  return Object.freeze({
    weights,
    indices,
    boundaries: Object.freeze(boundaries),
    corners: Uint8Array.from([0, steps, sampleCount - 1, steps * width]),
    parameters,
    width,
  });
}

function entityKey(type, id) {
  return `${type}:${typeof id}:${id}`;
}

function springComponents(element) {
  const axialStiffness =
    !element.rotational && Number.isFinite(element.stiffness) && element.stiffness > 0
      ? element.stiffness
      : null;
  const transverseStiffness =
    Number.isFinite(element.transverseStiffness) && element.transverseStiffness > 0
      ? element.transverseStiffness
      : null;
  const rotationalStiffness =
    Number.isFinite(element.rotationalStiffness) && element.rotationalStiffness > 0
      ? element.rotationalStiffness
      : element.rotational && Number.isFinite(element.stiffness) && element.stiffness > 0
        ? element.stiffness
        : null;
  const stated = axialStiffness || transverseStiffness || rotationalStiffness;
  return {
    axial: Boolean(axialStiffness) || (!stated && !element.rotational),
    transverse: Boolean(transverseStiffness),
    rotational: Boolean(rotationalStiffness) || Boolean(element.rotational),
    axialStiffness,
    transverseStiffness,
    rotationalStiffness,
  };
}

// An instanced mesh caches both its sphere and its box, and moving its
// instances invalidates both. `Box3.expandByObject` reads the cached box and
// only computes one when there is none, so a mesh that refreshed its sphere and
// left its box alone would keep reporting the room it used to take - which is
// what measuring the visible model is for.
function refreshInstanceBounds(mesh) {
  mesh.computeBoundingSphere();
  mesh.boundingBox = null;
  mesh.computeBoundingBox();
}

// Moving an instance makes both cached bounds stale. The renderer's moving
// instance sets are whole-model objects with frustum culling disabled, so no
// frame needs to walk every instance merely to rebuild a bound. The two users
// that do need one — picking and measuring the visible model — ask Three.js for
// it lazily.
function invalidateInstanceBounds(mesh) {
  mesh.boundingBox = null;
  if (!mesh.boundingSphere) {
    if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
    mesh.boundingSphere = mesh.geometry.boundingSphere.clone();
  }
  mesh.boundingSphere.radius = Infinity;
}

// Which entity owns a vertex, from the table that says where each one's run
// begins. The runs are laid down in entity order and do not overlap, so this is
// a binary search rather than a scan - a model has as many ranges as it has
// elements, and a pick happens on every click.
function entityIndexAtVertex(ranges, vertexIndex) {
  if (!ranges || !Number.isInteger(vertexIndex)) return undefined;
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const range = ranges[middle];
    if (vertexIndex < range.start) high = middle - 1;
    else if (vertexIndex >= range.start + range.count) low = middle + 1;
    else return middle;
  }
  return undefined;
}

// The margin is one distance, so it is measured in pixels and turned back into
// the fraction each axis needs. Adding the same fraction to both would leave a
// wider band across the longer side of the viewport than down its shorter one.
function marginedScreenRect(rect, viewport, marginFraction = PRINT_MARGIN_FRACTION) {
  const margin =
    Math.max(rect.width * viewport.width, rect.height * viewport.height) * marginFraction;
  const across = margin / viewport.width;
  const down = margin / viewport.height;
  return {
    x: rect.x - across,
    y: rect.y - down,
    width: rect.width + across * 2,
    height: rect.height + down * 2,
  };
}

function stableIdKey(id) {
  return `${typeof id}:${id}`;
}

function isWorldPointVisible(point, camera) {
  const projected = point.clone().project(camera);
  return (
    Number.isFinite(projected.x) &&
    Number.isFinite(projected.y) &&
    Number.isFinite(projected.z) &&
    projected.x >= -1 &&
    projected.x <= 1 &&
    projected.y >= -1 &&
    projected.y <= 1 &&
    projected.z >= -1 &&
    projected.z <= 1
  );
}

class GravissRenderer {
  static async create(host, geometry, callbacks = {}, options = {}) {
    const { THREE, OrbitControls, LineSegments2, LineSegmentsGeometry, LineMaterial } =
      await loadThreeRuntime();
    const renderer = new GravissRenderer(
      host,
      geometry,
      callbacks,
      THREE,
      OrbitControls,
      {
        LineSegments2,
        LineSegmentsGeometry,
        LineMaterial,
      },
      options,
    );
    try {
      renderer.initialize();
      return renderer;
    } catch (error) {
      renderer.destroy();
      throw error;
    }
  }

  constructor(host, geometry, callbacks, THREE, OrbitControls, wideLines, options = {}) {
    this.host = host;
    this.geometry = geometry;
    this.callbacks = callbacks;
    this.coordinateSystem = coordinateSystemDefinition(callbacks.coordinateSystem);
    this.THREE = THREE;
    UNIT_X ||= new THREE.Vector3(1, 0, 0);
    UNIT_Y ||= new THREE.Vector3(0, 1, 0);
    UNIT_Z ||= new THREE.Vector3(0, 0, 1);
    this.OrbitControls = OrbitControls;
    this.wideLines = wideLines;
    this.bounds = geometryBounds(geometry);
    this.visibility = { ...DEFAULT_VISIBILITY };
    this.pickables = [];
    this.memberContours = [];
    this.meshes = {};
    this.selected = null;
    this.destroyed = false;
    // Opening a saved view applies its appearance, visibility, filter, result
    // and camera after the scene has been built. Suppress all intermediate
    // frames when the owner asks for an atomic first paint; the finished state
    // is rendered synchronously by resumeRendering().
    this.renderSuspended = options.deferInitialRender === true;
    this.viewportVisible = true;
    this.shellDeformationBackend = options.shellDeformationBackend ?? "auto";
    this.renderFrame = null;
    this.pointerDown = null;
    this.orbitPivot = null;
    this.orbitPivotElement = null;
    this.orbitPivotEnabled = true;
    this.orbitPivotMarkerVisible = true;
    this.zoomTowardPointer = true;
    this.symbolSize = null;
    this.scaleSpringsByStiffness = false;
    this.backgroundGradient = true;
    this.sky = null;
    this.smoothZoom = true;
    this.zoomFlight = null;
    this.zoomFrame = null;
    this.zoomFrameTime = null;
    this.regionSelection = null;
    this.projection = "perspective";
    this.appearance = "auto";
    this.sectionRendering = true;
    // How finely a member is drawn along itself. One segment is a straight run
    // between its two nodes, which is what an undeformed member is; a member
    // that bends becomes a chain of them.
    this.memberSegments = 1;
    this.memberInstances = [];
    this.elementFilter = null;
    this.activeElementIds = null;
    this.activeNodeIds = null;
    this.connectedNodeIds = null;
    this.colorByDisplacement = false;
    this.memberDiagramResult = null;
    this.memberDiagramOptions = { ...DEFAULT_MEMBER_DIAGRAM_OPTIONS };
    this.memberDiagram = null;
    this.displacementColorStops = {
      value: STOPS.map(([red, green, blue]) => new THREE.Vector3(red, green, blue)),
    };
    this.displacementEncodingColor = new THREE.Color();
    // How finely members are tessellated along their length, and how far the
    // bow is drawn. One object, shared by every member material, so a frame
    // costs one number rather than a walk over the scene.
    this.memberBendSteps = 1;
    this.shellSurfaceSteps = 1;
    this.bendFactor = { value: 0 };
    this.stationsByElement = null;
    this.activeAppearance = "cloud";
    this.suppressCameraChange = 0;
    this.cameraChangeTimer = null;
    this.wheelCameraChangePending = false;
    this.cameraAnimationFrame = null;
    this.cameraAnimationTarget = null;
    this.frameRateMeter = new FrameRateMeter((fps) => this.callbacks.onFrameRate?.(fps));
  }

  initialize() {
    const THREE = this.THREE;
    this.worldUp = new THREE.Vector3(...this.coordinateSystem.up);
    this.modelYAxis = new THREE.Vector3(
      ...canonicalDirectionToModel([0, 1, 0], this.coordinateSystem),
    );
    this.scene = new THREE.Scene();
    this.createLighting();

    this.canvasRenderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
      // The member fills mark the pixels they visibly win, the shell fill
      // unmarks the ones it wins back, and the member contours draw only on
      // marked pixels — which is what lets an arris finish exactly where the
      // visible member surface does.
      stencil: true,
    });
    this.canvasRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.canvasRenderer.outputColorSpace = THREE.SRGBColorSpace;
    this.canvasRenderer.setClearColor(0x000000, 0);
    this.canvasRenderer.domElement.className = "graviss-canvas";
    this.canvasRenderer.domElement.tabIndex = 0;
    this.host.appendChild(this.canvasRenderer.domElement);

    this.perspectiveCamera = new THREE.PerspectiveCamera(42, 1, 0.01, 1000);
    this.orthographicCamera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.01, 1000);
    this.perspectiveCamera.up.copy(this.worldUp);
    this.orthographicCamera.up.copy(this.worldUp);
    this.camera = this.perspectiveCamera;

    this.controls = this.createControls(this.camera);

    this.raycaster = new THREE.Raycaster();
    // A line has no surface to hit, so picking one needs a radius around it.
    // Scaling it to the model keeps the same feel whatever units it uses.
    this.raycaster.params.Line.threshold = this.bounds.radius * 0.012;
    this.pointer = new THREE.Vector2();
    const viewElement = this.host.closest(".graviss");
    this.orbitPivotElement = viewElement.querySelector(".graviss-orbit-pivot");
    this.printRegionElement = viewElement.querySelector(".graviss-print-region");
    this.printRegion = null;
    this.printRegionPreview = null;
    // A lost WebGL context cannot initialize a new cube on the old canvas.
    // Keep the view's attributes, but retire the previous cube's cached state.
    const previousCubeCanvas = viewElement.querySelector(".graviss-view-cube");
    const cubeCanvas = previousCubeCanvas.cloneNode(false);
    for (const key of [
      "cameraOrientation",
      "hoverView",
      "hoverPart",
      "selectedView",
      "selectedPart",
      "tooltip",
    ])
      delete cubeCanvas.dataset[key];
    cubeCanvas.style.cursor = "default";
    previousCubeCanvas.replaceWith(cubeCanvas);
    this.viewCube = new ViewCube(THREE, cubeCanvas, {
      coordinateSystem: this.coordinateSystem,
      onSelect: (viewId) => {
        if (typeof this.callbacks.onViewSelect === "function") this.callbacks.onViewSelect(viewId);
        else this.setStandardView(viewId);
      },
    });
    this.orientationGizmo = new OrientationGizmo(
      THREE,
      viewElement.querySelector(".graviss-axis-gizmo"),
    );
    this.createReferenceGeometry();
    this.createModelGeometry();
    this.applyVisibility();
    this.applyTheme();
    this.installEvents();
    this.observeSize();
    this.suppressCameraChange += 1;
    try {
      // A model with three dimensions is first shown the way a drawing of one
      // is; a planar model is shown its plane, because there is nothing else of
      // it to see.
      this.setStandardView(this.planeView()?.viewId ?? "iso");
    } finally {
      this.suppressCameraChange -= 1;
    }
  }

  createControls(camera, target = null) {
    // A pivot belongs to the gesture that pinned it, and a zoom in flight is
    // aimed along a ray from where the camera used to be. Every caller that
    // reaches here has moved the camera out from under both.
    this.releaseOrbitPivot();
    this.cancelZoomFlight();
    // OrbitControls has no defined azimuth exactly at an orbit pole. Preserve
    // the current screen-up direction with an imperceptible deterministic tilt
    // before returning camera.up to the model's declared physical up axis.
    if (target) this.stabilizeOrbitPole(camera, target);
    camera.up.copy(this.worldUp);
    const controls = new this.OrbitControls(camera, this.canvasRenderer.domElement);
    if (target) controls.target.copy(target);
    controls.enableDamping = false;
    controls.screenSpacePanning = true;
    // Set here rather than beside maxDistance, which each caller assigns for
    // itself: this one depends on nothing a caller knows, and a rebuild that
    // forgot it would restore the collapse. A camera restored from a document
    // that already collapsed is pulled back out by the first update.
    //
    // The near plane is not part of this any more, and cannot be: it follows
    // the camera now. It does not have to be, either — the depth range never
    // lets near past far/MAXIMUM_DEPTH_RATIO, and far is never less than
    // twenty radii, so this floor is always at least five near planes out.
    controls.minDistance = this.bounds.radius * MINIMUM_ORBIT_DISTANCE_FRACTION;
    // Set here rather than by the setter alone: two callers dispose these
    // controls and build new ones, and anything assigned from outside is lost
    // with them.
    controls.zoomToCursor = this.zoomTowardPointer;
    // An anchor is measured against the canvas, and a canvas with no measured
    // size puts it at infinity, which unprojects to a camera position of NaN
    // and writes that straight into the view document. Declining to set one
    // leaves the zoom on its unanchored path, which measures nothing.
    const updateZoomParameters = controls._updateZoomParameters.bind(controls);
    controls._updateZoomParameters = (x, y) => {
      const rect = this.canvasRenderer.domElement.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      updateZoomParameters(x, y);
    };
    // Upstream reads the dolly anchor's vertical coordinate from the pointer's
    // horizontal one, which only shows once the zoom is anchored at all: a
    // middle-button dolly then pulls toward a point off the side of the
    // viewport. Re-reading the anchor afterwards costs nothing and becomes a
    // harmless repeat the day three.js fixes it. The wheel passes both
    // coordinates already and needs no help.
    const handleDolly = controls._handleMouseDownDolly.bind(controls);
    controls._handleMouseDownDolly = (event) => {
      handleDolly(event);
      controls._updateZoomParameters(event.clientX, event.clientY);
    };
    controls.addEventListener("change", () => {
      this.applyOrbitPivot();
      this.updateDepthRange();
      this.requestRender();
    });
    controls.addEventListener("start", () => this.viewCube?.setSelection(null));
    controls.addEventListener("end", () => {
      if (this.wheelCameraChangePending) this.scheduleCameraChange();
      else this.notifyCameraChange();
    });
    return controls;
  }

  stabilizeOrbitPole(camera, target) {
    const offset = camera.position.clone().sub(target);
    const distance = offset.length();
    if (!(distance > 0)) return;
    const direction = offset.multiplyScalar(1 / distance);
    const alignment = direction.dot(this.worldUp);
    if (Math.abs(alignment) < 1 - 1e-10) return;

    const screenUp = new this.THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    screenUp.addScaledVector(direction, -screenUp.dot(direction));
    if (screenUp.lengthSq() < 1e-12) {
      screenUp.copy(this.modelYAxis).addScaledVector(direction, -this.modelYAxis.dot(direction));
    }
    screenUp.normalize();
    direction
      .addScaledVector(screenUp, -Math.sign(alignment || 1) * CAMERA_POLE_OFFSET)
      .normalize();
    camera.position.copy(target).addScaledVector(direction, distance);
  }

  colorFromTheme(variable, fallback) {
    return new this.THREE.Color().setStyle(
      resolveThemeColor(this.host, `var(${variable}, ${fallback})`, fallback),
    );
  }

  // An ambient light alone gives every face the same value, which is why solid
  // sections used to read flat. A hemisphere carries the sky-to-ground gradient,
  // a key light held over the camera's shoulder does the shading, and a weak
  // opposing fill keeps the faces turned away from it from going dead. Three
  // lights, no shadow maps, and only the key and fill directions change.
  createLighting() {
    const THREE = this.THREE;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x6b7f8f, 1.7));
    this.keyLight = new THREE.DirectionalLight(0xffffff, 2.3);
    this.fillLight = new THREE.DirectionalLight(0xd8e9f6, 1.0);
    this.keyLight.position.fromArray(
      canonicalDirectionToModel([7, -10, 14], this.coordinateSystem),
    );
    this.fillLight.position.fromArray(
      canonicalDirectionToModel([-8, 6, -5], this.coordinateSystem),
    );
    this.lightDirection = new THREE.Vector3();
    this.lightRight = new THREE.Vector3();
    this.lightUp = new THREE.Vector3();
    this.lightOrigin = new THREE.Vector3();
    this.scene.add(this.keyLight, this.fillLight);
  }

  // Both lights keep their default targets at the world origin, so only the
  // direction from the origin has to be written when the camera moves.
  updateLighting() {
    if (!this.keyLight || !this.camera) return;
    const target = this.controls?.target || this.lightOrigin.set(0, 0, 0);
    const direction = this.lightDirection.copy(this.camera.position).sub(target);
    if (direction.lengthSq() === 0) return;
    direction.normalize();
    const right = this.lightRight.crossVectors(direction, this.worldUp);
    if (right.lengthSq() === 0) right.crossVectors(direction, this.modelYAxis);
    if (right.lengthSq() === 0) return;
    right.normalize();
    const up = this.lightUp.crossVectors(right, direction).normalize();
    this.keyLight.position
      .copy(direction)
      .addScaledVector(right, -0.55)
      .addScaledVector(up, 0.45)
      .multiplyScalar(100);
    this.fillLight.position
      .copy(direction)
      // Truly oppose the camera-side key. The previous positive component put
      // both lights on the same side of a slab, so an underside went nearly
      // black exactly when the camera orbited under it.
      .multiplyScalar(-0.65)
      .addScaledVector(right, 0.55)
      .addScaledVector(up, -0.35)
      .multiplyScalar(100);
  }

  // The standard view a planar model is looked at from, and the direction it
  // looks along — nothing at all for a model with three dimensions to it. The
  // model's own plane decides it, so a source states nothing and cannot state
  // it wrongly.
  planeView() {
    const normal = this.bounds.planeNormal;
    if (!normal) return null;
    for (const direction of [normal, normal.map((value) => -value)]) {
      const viewId = cameraViewIdForDirection(direction, this.coordinateSystem);
      if (PLANE_VIEW_IDS.includes(viewId)) return { viewId, direction };
    }
    return null;
  }

  createReferenceGeometry() {
    const THREE = this.THREE;
    const { center, radius } = this.bounds;
    const gridSize = Math.max(10, Math.ceil((radius * 2.6) / 5) * 5);
    const divisions = Math.min(50, Math.max(10, gridSize));
    this.grid = new THREE.GridHelper(gridSize, divisions, 0x5c6773, 0x353d46);
    this.grid.userData.gravissGridSize = gridSize;
    this.grid.visible = this.visibility.grid;
    // A model that lies in a plane is looked at face on, and a ground grid seen
    // face on is a line. Its grid goes in the model's own plane instead, a step
    // behind it, where it reads as the paper the elevation is drawn on — and
    // for a slab, whose plane is horizontal anyway, that step behind is the
    // ground the grid always was.
    const plane = this.planeView();
    const gridNormal = plane ? new THREE.Vector3(...plane.direction) : this.worldUp;
    this.grid.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), gridNormal);
    const gridCenter = new THREE.Vector3(...center);
    if (plane) gridCenter.addScaledVector(gridNormal, -radius * GRID_PLANE_CLEARANCE);
    // A ground plane stands at the world origin however high above it the model
    // is; a model's own plane is wherever the model is.
    else gridCenter.addScaledVector(this.worldUp, -gridCenter.dot(this.worldUp));
    this.grid.position.copy(gridCenter);
    this.scene.add(this.grid);

    // AxesHelper draws the model's own X, Y and Z. Building the triad from
    // canonicalDirectionToModel instead would draw the canonical frame, which
    // points the wrong way as soon as a model declares anything but Z up.
    const axesSize = Math.max(1.5, radius * 0.25);
    this.axes = new THREE.AxesHelper(axesSize);
    this.axes.position.set(0, 0, 0);
    this.scene.add(this.axes);

    // These two never deform, so measure them once. Animation replaces the
    // scene box with a cheap node-derived one every frame and unions whichever
    // reference layers are actually visible; a hidden ground grid must not
    // hold the near plane back and throw away depth precision.
    this.gridBox = new THREE.Box3().setFromObject(this.grid);
    this.axesBox = new THREE.Box3().setFromObject(this.axes);

    this.sceneBox = null;
  }

  // Everything drawable except the camera-following sky, as one axis-aligned
  // box. A box rather than a sphere, because the sphere around a long deck is
  // nearly as deep as the deck is long and a camera anywhere near the model is
  // inside it; the box keeps flat things flat, so hovering over the deck is
  // outside it by exactly the height above the deck — and the grid, which is a
  // plane, widens the box without deepening it. Instanced meshes carry their
  // instances' box, not their unit geometry's, so they are measured
  // themselves.
  computeSceneBox() {
    this.ensureCpuShellGeometry();
    const THREE = this.THREE;
    const box = new THREE.Box3();
    const transformed = new THREE.Box3();
    this.scene.updateMatrixWorld(true);
    for (const child of this.scene.children) {
      if (child === this.sky || !child.visible) continue;
      if (child === this.memberDiagram?.group) {
        box.union(this.memberDiagram.bounds(this.camera));
        continue;
      }
      child.traverseVisible((node) => {
        const geometry = node.geometry;
        if (!geometry || node.isLineSegments2) return;
        let local = geometry.boundingBox;
        if (node === this.meshes.shells) local = this.shellVisibleBounds();
        if (node.isInstancedMesh) {
          node.computeBoundingBox();
          local = node.boundingBox;
        } else if (!local) {
          geometry.computeBoundingBox();
          local = geometry.boundingBox;
        }
        if (local && !local.isEmpty())
          box.union(transformed.copy(local).applyMatrix4(node.matrixWorld));
      });
    }
    return box;
  }

  // How far the camera stands outside everything drawable; zero from inside.
  sceneClearance() {
    this.sceneBox ??= this.computeSceneBox();
    if (this.sceneBox.isEmpty()) return 0;
    return this.sceneBox.distanceToPoint(this.camera.position);
  }

  // Which elements are drawn.
  //
  // A filter is applied by compacting the instances that survive it to the
  // front of the buffer and drawing only those - which is a real saving in draw
  // work rather than a trick of transparency, and costs nothing extra because
  // the buffer is rewritten whenever the model moves anyway. Rebuilding the
  // meshes instead would re-derive every section and every range for a change
  // that happens at the speed a person types.
  setElementFilter(filter) {
    this.elementFilter = filter || null;
    this.keptElements = this.elementFilter
      ? new Set(this.geometry.elements.filter((element) => this.elementFilter(element)))
      : null;
    this.refreshElementVisibility();
    return this.elementFilter;
  }

  // The displayed load case can contain only part of the model. Its topology
  // intersects the user's filter without changing that saved filter.
  refreshElementVisibility(preparedMemberDiagram = null) {
    this.applyElementFilter({ compactStatic: true });
    this.syncShellFilter();
    // Everything the model is drawn from, not only the instanced part of it:
    // a filter that reached the members and left the slabs and the springs on
    // screen would be a filter whose counts were describing a different model
    // from the one being looked at.
    this.updateShellSurface();
    this.placeMemberLines();
    this.placeConnectorSymbols("spring");
    this.placeConnectorSymbols("coupling");
    this.placeNodeSymbols();
    this.placeSupportSymbols();
    this.writeLocalAxesPositions();
    this.refreshInstanceColors(
      (mesh) =>
        ["nodes", "supports"].includes(mesh.userData.visibilityKey) &&
        this.colors?.[mesh.userData.gravissColorKey] != null,
    );
    this.dropHiddenSelection();
    this.refreshMemberDiagram(preparedMemberDiagram);
    this.sceneBox = null;
    this.requestRender();
  }

  // Selecting something and then narrowing it away leaves a selection nobody can
  // see, reported to the toolbar and painted into an instance another element
  // now occupies. Hiding it is the same answer `setVisibility` already gives for
  // a whole group going away.
  //
  // Asked from the two places a user narrows the model, never from the frame
  // loop: this ends in a callback and a repaint, and a redraw is not the moment
  // to tell the rest of the application that its selection went.
  dropHiddenSelection() {
    const selected = this.selected;
    if (selected && !this.keepsEntity(selected.type, selected.entity)) this.setSelected(null);
  }

  getElementFilter() {
    return this.elementFilter || null;
  }

  syncShellFilter() {
    const state = this.shellState;
    const mesh = this.meshes.shells;
    if (!state?.geometry || !mesh) return;
    const active = [];
    const index = state.geometry.getIndex();
    const faces = mesh.userData.gravissFaceToEntityIndex;
    const zoom = mesh.userData.gravissZoomProxy.geometry;
    let indexCount = 0;
    let faceCount = 0;
    let zoomCount = 0;
    let edgeCount = 0;
    state.elements.forEach((element, entity) => {
      if (!this.keepsElement(element)) return;
      active.push(entity);
      const item = state.prepared[entity];
      index.array.set(
        state.indexValues.subarray(item.indexStart, item.indexStart + item.indexCount),
        indexCount,
      );
      faces.fill(entity, faceCount, faceCount + item.faceCount);
      const range = state.zoomEntityRanges[entity];
      zoom
        .getIndex()
        .array.set(state.zoomIndices.subarray(range.start, range.start + range.count), zoomCount);
      indexCount += item.indexCount;
      faceCount += item.faceCount;
      zoomCount += range.count;
      edgeCount += item.edgeCount;
    });
    state.activeElementIndices = active;
    index.needsUpdate = true;
    state.geometry.setDrawRange(0, indexCount);
    zoom.getIndex().needsUpdate = true;
    zoom.setDrawRange(0, zoomCount);
    state.edgeGeometry.instanceCount = edgeCount;
    state.geometry.boundingBox = null;
    state.geometry.boundingSphere ||= new this.THREE.Sphere();
    if (this.deformedBox) this.deformedBox.getCenter(state.geometry.boundingSphere.center);
    else state.geometry.boundingSphere.center.fromArray(this.bounds.center);
    state.geometry.boundingSphere.radius = Infinity;
    state.edgesStale = true;
    this.sceneBox = null;
    this.shellGpu?.syncFilter();
  }

  // How many of a kind are drawn against how many the model holds, which is
  // what a panel puts beside each of its switches.
  // Whether an element is drawn at all: its kind has to be switched on and the
  // filter has to keep it. Two questions asked in one place, because they are
  // answered by one pass over the instances.
  // Whether an element is drawn at all. One question now: did the rules keep
  // it. Which LAYER it belongs to - members, shells, springs - is a different
  // question with its own toolbar switch, and it is not asked here.
  keepsElement(element) {
    return (
      (!this.keptElements || this.keptElements.has(element)) &&
      (!this.activeElementIds || this.activeElementIds.has(stableIdKey(element.id)))
    );
  }

  // Nodal results are a displacement field, not an activity declaration. A
  // fixed active endpoint remains visible without a result row; standalone
  // nodes remain independent of the element mask and the user's filter.
  keepsNode(id) {
    const key = stableIdKey(id);
    return !this.activeNodeIds || this.activeNodeIds.has(key) || !this.connectedNodeIds.has(key);
  }

  keepsEntity(type, entity) {
    if (FILTERED_ENTITY_TYPES.has(type)) return this.keepsElement(entity);
    if (type === "node") return this.keepsNode(entity.id);
    if (type === "support") return this.keepsNode(entity.nodeId);
    return true;
  }

  // What a panel puts beside each kind: how many there are, and how many of
  // them survived whatever is currently narrowing the model.
  elementCounts() {
    const counts = new Map();
    for (const element of this.geometry.elements) {
      const entry = counts.get(element.kind) || { total: 0, shown: 0 };
      entry.total += 1;
      if (this.keepsElement(element)) entry.shown += 1;
      counts.set(element.kind, entry);
    }
    return counts;
  }

  applyElementFilter({ refreshColors = true, compactStatic = false } = {}) {
    for (const placement of this.memberInstances) {
      const perElement = this.memberSegments;
      const segments = placement.segmentToEntityIndex;
      const active = [];
      let cursor = 0;
      placement.elements.forEach((element, index) => {
        const range = placement.entityRanges[index];
        if (!this.keepsElement(element)) {
          // Somewhere is not where it is drawn, and nothing should be coloured
          // into a slot another element now occupies.
          range.start = 0;
          range.count = 0;
          return;
        }
        active.push(index);
        // Written every time rather than only when it moved: dropping a filter
        // leaves everything in place, and a mapping left over from the last one
        // would answer for the wrong element.
        for (let segment = 0; segment < perElement; segment += 1) {
          segments[cursor + segment] = index;
        }
        // The ranges say where an entity is drawn, which is what colouring and
        // selection both read - so compacting has to move them too.
        range.start = cursor;
        range.count = perElement;
        cursor += perElement;
      });
      placement.activeElementIndices = active;
      placement.drawn = cursor;
      this.writeMemberMatrices(placement);
      if (compactStatic) this.writeMemberStations(placement);
    }
    for (const mesh of this.pickables) {
      const placement = mesh.userData.gravissPlacement;
      if (!placement) continue;
      mesh.count = placement.drawn ?? placement.count;
      if (mesh.isInstancedMesh) invalidateInstanceBounds(mesh);
    }
    for (const contours of this.memberContours) {
      const placement = contours.userData.gravissPlacement;
      if (placement) contours.geometry.instanceCount = placement.drawn ?? placement.count;
    }
    // The compaction reordered the instances, so the colours that were written
    // per instance have to follow them.
    // A moving model rewrites its matrices in source order and compacts them
    // again under the same filter. Their order — and therefore their colours —
    // did not change. Repainting every entity every frame was pure filter tax;
    // only a new filter needs it.
    if (refreshColors) {
      this.refreshInstanceColors((mesh) => mesh.userData.visibilityKey === "members");
    }
  }

  // The clock a deformation swings on. Built the first time it is asked for,
  // because a model nobody animates should not carry one.
  getAnimation() {
    this.animation ||= new Animation({
      onFrame: (phase) => {
        if (this.memberDiagramResult) return;
        this.setDeformationPhase(phase);
        this.callbacks.onAnimationPositionChange?.(this.animation.position);
      },
      requestFrame: () => {
        if (this.memberDiagramResult) this.animation.stop();
        else this.requestRender();
      },
    });
    return this.animation;
  }

  // The displacement field the model is drawn under, or none.
  //
  // Setting one does not move anything on its own: the scale and the phase say
  // how far, and a factor of zero puts every node back exactly where it was.
  setResult(result, diagramOptions = null) {
    const nextOptions =
      diagramOptions == null
        ? this.memberDiagramOptions
        : memberDiagramOptions(diagramOptions, this.memberDiagramOptions);
    // A model with no result to show does not need an engine for showing one.
    if (!result && !this.deformation && !this.memberDiagramResult) {
      this.memberDiagramOptions = nextOptions;
      return null;
    }
    const memberDiagramResult = result?.kind === "memberDiagram" ? result : null;
    // Building is the fallible step (a finite manual factor can still overflow
    // GPU coordinates). Complete it before changing the displayed field,
    // element activity, displacement pose or running animation.
    const preparedMemberDiagram = memberDiagramResult
      ? this.createMemberDiagram(memberDiagramResult, nextOptions)
      : null;
    this.memberDiagramOptions = nextOptions;
    this.memberDiagramResult = memberDiagramResult;
    const displacement = this.memberDiagramResult ? null : result;
    if (this.memberDiagramResult) {
      this.animation?.stop();
      this.colorByDisplacement = false;
    }
    this.activeElementIds =
      result?.activeElementIds == null ? null : new Set(result.activeElementIds.map(stableIdKey));
    this.activeNodeIds = this.activeElementIds
      ? new Set(
          this.geometry.elements
            .filter((element) => this.activeElementIds.has(stableIdKey(element.id)))
            .flatMap((element) => element.nodeIds.map(stableIdKey)),
        )
      : null;
    if (this.activeElementIds && !this.connectedNodeIds) {
      this.connectedNodeIds = new Set(
        this.geometry.elements.flatMap((element) => element.nodeIds.map(stableIdKey)),
      );
    }
    this.deformation ||= new Deformation({
      nodes: this.geometry.nodes,
      indexOfId: (id) => this.nodeIndexById.get(stableIdKey(id)) ?? null,
      radius: this.bounds.radius,
    });
    this.deformation.setResult(displacement);
    this.appliedDeformationResult = undefined;
    const shellSurfaceSteps = this.deformation.rotations ? SHELL_RESULT_STEPS : 1;
    if (shellSurfaceSteps !== this.shellSurfaceSteps) {
      this.shellSurfaceSteps = shellSurfaceSteps;
      // Topology is a property of the undeformed bodies. A previous result may
      // have left the shared drawn-node objects displaced; rebuilding from
      // those would make exposed-side detection depend on which animation
      // frame happened to precede this result.
      this.nodePositions.set(this.restPositions);
      this.syncDrawnNodes();
      this.applyShellDetail();
      this.refreshInstanceColors((mesh) => mesh.userData.visibilityKey === "shells");
    }
    this.applyStations(displacement);
    this.refreshElementVisibility(preparedMemberDiagram);
    this.applyDeformation();
    if (this.colorByDisplacement || this.memberDiagramResult) this.refreshInstanceColors();
    // applyDeformation measures only the structure; diagrams and labels also
    // belong to the depth range after the undeformed pose has been restored.
    if (this.memberDiagramResult) {
      this.sceneBox = null;
      this.updateDepthRange();
    }
    return this.memberDiagramResult ? this.getMemberDiagramSummary() : this.deformation;
  }

  setMemberDiagramOptions(options) {
    const next = memberDiagramOptions(options, this.memberDiagramOptions);
    if (Object.keys(next).every((key) => next[key] === this.memberDiagramOptions[key]))
      return { ...this.memberDiagramOptions };
    const previous = this.memberDiagramOptions;
    this.memberDiagramOptions = next;
    try {
      this.refreshMemberDiagram();
    } catch (error) {
      this.memberDiagramOptions = previous;
      throw error;
    }
    this.sceneBox = null;
    this.updateDepthRange();
    this.requestRender();
    return { ...this.memberDiagramOptions };
  }

  getMemberDiagramSummary() {
    return this.memberDiagram?.summary ?? null;
  }

  createMemberDiagram(result, options = this.memberDiagramOptions) {
    const current = new MemberDiagram(this.THREE);
    const activeIds = result.activeElementIds == null ? null : new Set(result.activeElementIds);
    try {
      current.build(result, this.geometry, options, {
        radius: this.bounds.radius,
        visible: this.visibility.members,
        keepsElement: (element) =>
          (!this.keptElements || this.keptElements.has(element)) &&
          (!activeIds || activeIds.has(element.id)),
        selectedId: this.selected?.type === "element" ? this.selected.entity.id : null,
      });
      return current;
    } catch (error) {
      current.dispose();
      throw error;
    }
  }

  refreshMemberDiagram(prepared = null) {
    const diagram = this.memberDiagram;
    // Rebuilding buffers must not leave a selection pointing to a disposed
    // object. Rebind its stable entity to a newly created diagram below.
    const selection = this.selected?.object.userData.gravissMemberDiagram ? this.selected : null;
    if (!this.memberDiagramResult) {
      this.pickables = this.pickables.filter((object) => !object.userData.gravissMemberDiagram);
      diagram?.dispose();
      this.memberDiagram = null;
      delete this.meshes.memberDiagram;
      if (selection) this.setSelected(null);
      return;
    }
    const current = prepared || this.createMemberDiagram(this.memberDiagramResult);
    this.pickables = this.pickables.filter((object) => !object.userData.gravissMemberDiagram);
    diagram?.dispose();
    this.memberDiagram = current;
    this.meshes.memberDiagram = current.group;
    this.scene.add(current.group);
    this.pickables.push(...current.pickables);
    if (selection) {
      const object = current.pickables.find((candidate) =>
        candidate.userData.gravissEntities.some(
          (entity) => stableIdKey(entity.id) === stableIdKey(selection.entity.id),
        ),
      );
      if (object) {
        const entityIndex = object.userData.gravissEntities.findIndex(
          (entity) => stableIdKey(entity.id) === stableIdKey(selection.entity.id),
        );
        this.selected = { ...selection, object, entityIndex, instanceId: entityIndex };
      } else this.setSelected(null);
    }
    this.refreshInstanceColors((object) => object.userData.gravissMemberDiagram);
    this.updateMemberDiagramLabels();
  }

  updateMemberDiagramLabels(renderer = this.canvasRenderer, camera = this.camera) {
    if (!this.memberDiagram || !camera) return;
    const target = renderer?.getRenderTarget?.();
    if (target) this.memberDiagram.layoutLabels(camera, target.width, target.height);
    else if (renderer?.getDrawingBufferSize) {
      const size = (this.memberDiagramLabelSize ||= new this.THREE.Vector2());
      renderer.getDrawingBufferSize(size);
      this.memberDiagram.layoutLabels(camera, size.x, size.y);
    } else
      this.memberDiagram.layoutLabels(
        camera,
        this.host.clientWidth || 800,
        this.host.clientHeight || 600,
      );
  }

  // What a result says each member's ends did, and how finely to draw the bow
  // between them.
  //
  // Rebuilding is what changes the tessellation, so it happens when the answer
  // to "is there a bow at all" changes and not on every result: stepping from
  // one load case to the next of a solved model rewrites three small buffers
  // and nothing else.
  applyStations(result) {
    const stations = result?.elements;
    this.stationsByElement = Array.isArray(stations)
      ? new Map(stations.map((element) => [stableIdKey(element.id), element.stations]))
      : null;
    const steps = this.stationsByElement?.size ? MEMBER_BEND_STEPS : 1;
    if (
      steps !== this.memberBendSteps ||
      this.memberLines?.userData.gravissEntities.some(
        (element, index) =>
          this.memberLineSteps(element, steps) !==
          this.memberLines.userData.gravissLineSteps[index],
      )
    ) {
      this.memberBendSteps = steps;
      this.rebuildMemberMeshes();
      return steps;
    }
    for (const placement of this.memberInstances) this.writeMemberStations(placement);
    return steps;
  }

  getDeformation() {
    return this.deformation || null;
  }

  setDeformationScale(scale) {
    if (!this.deformation) return null;
    const applied = this.deformation.setScale(scale);
    this.applyDeformation();
    return applied;
  }

  setAutomaticScale(automatic) {
    if (!this.deformation) return null;
    const applied = this.deformation.setAutomatic(automatic);
    this.applyDeformation();
    return applied;
  }

  setDeformationPhase(phase) {
    if (!this.deformation) return null;
    const previous = this.deformation.phase;
    const applied = this.deformation.setPhase(phase);
    // Ordinary UI state restoration often writes the phase it already has. It
    // should not pay for a full model rewrite that changes no coordinate.
    if (applied === previous) return applied;
    this.applyDeformation();
    return applied;
  }

  // Moves everything the model is drawn from to where the deformation puts it.
  //
  // Every path writes into the buffers it already has: nothing is rebuilt, no
  // topology is decided again, and nothing is allocated. That is what makes
  // this affordable once a frame.
  applyDeformation() {
    if (!this.nodePositions) return;
    const result = this.deformation?.result ?? null;
    const factor = this.deformation?.factor ?? 0;
    if (this.appliedDeformationResult === result && this.appliedDeformationFactor === factor)
      return;
    this.appliedDeformationResult = result;
    this.appliedDeformationFactor = factor;
    if (this.deformation) this.deformation.apply(this.restPositions, this.nodePositions);
    else this.nodePositions.set(this.restPositions);
    // The whole of the bow, in one number. Every member material reads this
    // same object, so a frame of animation costs a uniform rather than a walk
    // over fourteen thousand vertices.
    this.bendFactor.value = this.deformation?.factor ?? 0;
    this.syncDrawnNodes();
    this.sceneBox = this.measureDeformedBox();
    if (this.shellState && !this.meshes.shells?.visible) {
      this.shellState.poseVersion = (this.shellState.poseVersion ?? 0) + 1;
      this.shellGpu?.markDirty();
    }
    if (this.meshes.members?.visible) this.updateMemberDeformation();
    if (this.meshes.shells?.visible) this.updateShellSurface();
    if (this.nodeMesh?.visible) this.placeNodeSymbols();
    if (this.supportMesh?.visible) this.placeSupportSymbols();
    if (this.meshes.springs?.visible) this.placeConnectorSymbols("spring");
    if (this.meshes.couplings?.visible) this.placeConnectorSymbols("coupling");
    if (this.localAxes?.visible) this.rebuildLocalAxes();
    else if (this.localAxes) this.localAxesStale = true;
    this.invalidateWrittenBounds();
    // The scene box is read on every pointer move to keep the depth range
    // honest, so it is measured rather than dropped: dropping it would rebuild
    // it from every object in the scene while the model is being orbited.
    this.updateDepthRange();
    this.requestRender();
  }

  // Everything drawn from a member's two end nodes. Kept together so a hidden
  // member group can skip the whole pass and be caught up once, immediately
  // before it is shown again.
  updateMemberDeformation() {
    for (const placement of this.memberInstances) this.writeMemberMatrices(placement);
    for (const mesh of this.pickables) {
      if (mesh.isInstancedMesh && mesh.userData.gravissInstanced) {
        invalidateInstanceBounds(mesh);
        this.deformedBox?.getCenter(mesh.boundingSphere.center);
      }
    }
    this.placeMemberLines();
  }

  // Everything written into rather than instanced has a bounding box and a
  // sphere cached on its geometry, and nothing invalidates them when the
  // positions underneath are rewritten. Left alone, a model that has moved is
  // still framed, printed and picked against where it was at rest.
  //
  // Dropped rather than recomputed, because the two consumers ask at very
  // different rates: framing and printing happen when a person asks for them,
  // and a raycast happens on a click. Recomputing here would pay for both on
  // every frame of an animation that nobody is clicking through.
  invalidateWrittenBounds() {
    const geometries = [
      this.shellState?.geometry,
      this.shellState?.edgeGeometry,
      this.memberLines?.geometry,
      this.connectors?.spring?.lines.geometry,
      this.connectors?.coupling?.lines.geometry,
    ];
    for (const geometry of geometries) {
      if (!geometry) continue;
      geometry.boundingBox = null;
      // Three also reads this sphere for draw sorting with culling disabled.
      // Its centre is cheap; an infinite radius keeps raycasting conservative
      // without measuring every rewritten vertex before every frame.
      geometry.boundingSphere ||= new this.THREE.Sphere();
      if (this.deformedBox) this.deformedBox.getCenter(geometry.boundingSphere.center);
      else geometry.boundingSphere.center.fromArray(this.bounds.center);
      geometry.boundingSphere.radius = Infinity;
    }
  }

  // The room the model takes now, from the node coordinates alone, expanded by
  // the largest thing drawn at a node. Cheap enough to run every frame, where
  // walking the scene is not.
  measureDeformedBox() {
    const THREE = this.THREE;
    const positions = this.nodePositions;
    if (!positions?.length) return null;
    const box = (this.deformedBox ||= new THREE.Box3());
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let at = 0; at + 2 < positions.length; at += 3) {
      const x = positions[at];
      const y = positions[at + 1];
      const z = positions[at + 2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    box.min.set(minX, minY, minZ);
    box.max.set(maxX, maxY, maxZ);
    // Sections, symbols and supports all stand off a node by something; one
    // generous margin covers every one of them without measuring each.
    const margin = Math.max(this.symbolRadius() * 4, this.bounds.radius * 0.05);
    box.expandByScalar(margin);
    if (this.grid?.visible && this.gridBox) box.union(this.gridBox);
    if (this.axes?.visible && this.axesBox) box.union(this.axesBox);
    return box;
  }

  createModelGeometry() {
    this.sceneBox = null;
    this.buildNodeIndex();
    const nodesById = new Map(
      this.drawnNodes.map((node) => [`${typeof node.id}:${node.id}`, node]),
    );
    this.nodesById = nodesById;
    this.sectionsById = new Map(
      (this.geometry.sections || []).map((section) => [
        `${typeof section.id}:${section.id}`,
        section,
      ]),
    );
    const memberElements = this.geometry.elements.filter(({ kind }) =>
      LINE_ELEMENT_KINDS.has(kind),
    );
    const shellElements = this.geometry.elements.filter(({ kind }) => kind === "shell");
    this.createMemberGeometry(nodesById, memberElements);
    this.createShellGeometry(nodesById, shellElements);
    this.createNodeGeometry();
    this.createSupportGeometry(nodesById);
    this.createConnectorGeometry(nodesById, "spring", "springs");
    this.createConnectorGeometry(nodesById, "coupling", "couplings");
    this.createLocalAxesGeometry(nodesById, this.geometry.elements);
  }

  // Rewrites the centrelines where the model has moved them. One segment a
  // member, straight into the buffer that is already there.
  // A centreline bends for the same reason a section does, and by the same
  // cubic - it is the same member. There is no card doing it here, because a
  // line has no vertices between its ends to bend: the run is written as the
  // chain of short segments it takes to look like a curve.
  placeMemberLines() {
    const lines = this.memberLines;
    if (!lines) return;
    const positions = lines.geometry.getAttribute("position");
    const into = positions.array;
    const nodes = this.nodePositions;
    const nodeIndices = lines.userData.gravissNodeIndices;
    const { xAxis, yAxis, zAxis } = this.memberScratch();
    const factor = this.deformation?.factor ?? 0;
    lines.userData.gravissEntities.forEach((element, index) => {
      const steps = lines.userData.gravissLineSteps[index];
      const first = nodeIndices[index * 2] * 3;
      const second = nodeIndices[index * 2 + 1] * 3;
      const startX = nodes[first];
      const startY = nodes[first + 1];
      const startZ = nodes[first + 2];
      const runX = nodes[second] - startX;
      const runY = nodes[second + 1] - startY;
      const runZ = nodes[second + 2] - startZ;
      let at = lines.userData.gravissEntityRanges[index].start * 3;
      // A member narrowed away collapses onto its own first node, which is the
      // answer a line of no length gets everywhere else here: nothing to draw
      // and nothing for a ray to hit, with every vertex still where it was so
      // the ranges that index it need not move.
      if (!this.keepsElement(element)) {
        for (let vertex = 0; vertex < steps * 2; vertex += 1) {
          into[at] = startX;
          into[at + 1] = startY;
          into[at + 2] = startZ;
          at += 3;
        }
        return;
      }
      const stations =
        factor === 0 || element.lineInterpolation === "linear"
          ? null
          : this.stationsByElement?.get(stableIdKey(element.id));
      if (!stations || element.lineInterpolation === "linear") {
        // Straight, and written as one long segment repeated rather than as a
        // chain, so a model with no bow costs the same arithmetic it always did.
        for (let step = 0; step < steps; step += 1) {
          const from = step / steps;
          const to = (step + 1) / steps;
          into[at] = startX + runX * from;
          into[at + 1] = startY + runY * from;
          into[at + 2] = startZ + runZ * from;
          into[at + 3] = startX + runX * to;
          into[at + 4] = startY + runY * to;
          into[at + 5] = startZ + runZ * to;
          at += 6;
        }
        return;
      }
      const rest = this.restPositions;
      this.memberAxes(
        element,
        rest[second] - rest[first],
        rest[second + 1] - rest[first + 1],
        rest[second + 2] - rest[first + 2],
        xAxis,
        yAxis,
        zAxis,
      );
      // The stations and their rotations describe the element in its reference
      // configuration. Feeding the already deformed chord length back into the
      // cubic handles makes the curvature grow a second time with the display
      // factor and eventually turns a beam into artificial waves and loops.
      const length = this.memberReferenceLength(element, stations);
      const firstStation = stations[0];
      const lastStation = stations.at(-1);
      const firstRotation = firstStation.phi ?? ZERO_MEMBER_ROTATION;
      const lastRotation = lastStation.phi ?? ZERO_MEMBER_ROTATION;
      const bend0Y = firstRotation[1] * factor;
      const bend0Z = firstRotation[2] * factor;
      const bend1Y = lastRotation[1] * factor;
      const bend1Z = lastRotation[2] * factor;
      const rawTangent0X = xAxis.x + yAxis.x * bend0Z - zAxis.x * bend0Y;
      const rawTangent0Y = xAxis.y + yAxis.y * bend0Z - zAxis.y * bend0Y;
      const rawTangent0Z = xAxis.z + yAxis.z * bend0Z - zAxis.z * bend0Y;
      const rawTangent1X = xAxis.x + yAxis.x * bend1Z - zAxis.x * bend1Y;
      const rawTangent1Y = xAxis.y + yAxis.y * bend1Z - zAxis.y * bend1Y;
      const rawTangent1Z = xAxis.z + yAxis.z * bend1Z - zAxis.z * bend1Y;
      const inverseTangent0Length = 1 / Math.hypot(rawTangent0X, rawTangent0Y, rawTangent0Z);
      const inverseTangent1Length = 1 / Math.hypot(rawTangent1X, rawTangent1Y, rawTangent1Z);
      const tangent0X = rawTangent0X * inverseTangent0Length;
      const tangent0Y = rawTangent0Y * inverseTangent0Length;
      const tangent0Z = rawTangent0Z * inverseTangent0Length;
      const tangent1X = rawTangent1X * inverseTangent1Length;
      const tangent1Y = rawTangent1Y * inverseTangent1Length;
      const tangent1Z = rawTangent1Z * inverseTangent1Length;
      const handle = length / 3;
      const control0X = tangent0X * handle;
      const control0Y = tangent0Y * handle;
      const control0Z = tangent0Z * handle;
      const control1X = runX - tangent1X * handle;
      const control1Y = runY - tangent1Y * handle;
      const control1Z = runZ - tangent1Z * handle;
      for (let step = 0; step < steps; step += 1) {
        for (let end = 0; end < 2; end += 1) {
          const fraction = (step + end) / steps;
          const oneMinus = 1 - fraction;
          const control0Weight = 3 * oneMinus * oneMinus * fraction;
          const control1Weight = 3 * oneMinus * fraction * fraction;
          const endWeight = fraction * fraction * fraction;
          const offset = at + end * 3;
          into[offset] =
            startX + control0X * control0Weight + control1X * control1Weight + runX * endWeight;
          into[offset + 1] =
            startY + control0Y * control0Weight + control1Y * control1Weight + runY * endWeight;
          into[offset + 2] =
            startZ + control0Z * control0Weight + control1Z * control1Weight + runZ * endWeight;
        }
        at += 6;
      }
    });
    positions.needsUpdate = true;
  }

  // The member's own frame, from the run between its two nodes and whatever the
  // source said about how its section stands. Written into the vectors handed
  // in, because this is asked once an element per frame.
  memberAxes(element, runX, runY, runZ, xAxis, yAxis, zAxis) {
    xAxis.set(runX, runY, runZ);
    const length = xAxis.length();
    if (length > 0) xAxis.divideScalar(length);
    const suppliedY = element.localAxes?.y;
    if (suppliedY) yAxis.set(suppliedY[0], suppliedY[1], suppliedY[2]);
    else yAxis.copy(this.worldUp).cross(xAxis);
    if (yAxis.lengthSq() < 1e-12) yAxis.copy(this.modelYAxis);
    yAxis.addScaledVector(xAxis, -yAxis.dot(xAxis)).normalize();
    zAxis.crossVectors(xAxis, yAxis).normalize();
    return length;
  }

  // The coordinate the solver used along a member, before any display factor
  // moved its nodes. Providers normally state it on the end stations; the rest
  // geometry is the fallback for a source that reports rotations but leaves
  // both station abscissae equal.
  memberReferenceLength(element, stations = null) {
    if (stations?.length >= 2) {
      const span = Math.abs(stations.at(-1).x - stations[0].x);
      if (Number.isFinite(span) && span > 0) return span;
    }
    const first = this.nodeIndex(element.nodeIds[0]) * 3;
    const second = this.nodeIndex(element.nodeIds[1]) * 3;
    return Math.hypot(
      this.restPositions[second] - this.restPositions[first],
      this.restPositions[second + 1] - this.restPositions[first + 1],
      this.restPositions[second + 2] - this.restPositions[first + 2],
    );
  }

  // Without section rendering a line element is a line: one segment per member
  // in a single buffer, coloured per vertex through the same entity ranges the
  // shell surface uses, so selection and appearance need no separate path.
  createMemberLines(elements) {
    const THREE = this.THREE;
    // A member owns as many segments as the model is being drawn with, which is
    // one when nothing bends. The range table is what picking and colouring
    // both ask, so neither has to know how finely a member is drawn.
    const lineSteps = elements.map((element) => this.memberLineSteps(element));
    const vertexCount = lineSteps.reduce((sum, steps) => sum + steps * 2, 0);
    const positions = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 3);
    const ranges = new Array(elements.length);
    const nodeIndices = new Int32Array(elements.length * 2);
    let start = 0;
    elements.forEach((element, index) => {
      const count = lineSteps[index] * 2;
      ranges[index] = { start, count };
      start += count;
      nodeIndices[index * 2] = this.nodeIndex(element.nodeIds[0]);
      nodeIndices[index * 2 + 1] = this.nodeIndex(element.nodeIds[1]);
    });

    const geometry = new THREE.BufferGeometry();
    const positionAttribute = new THREE.BufferAttribute(positions, 3);
    positionAttribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("position", positionAttribute);
    const colorAttribute = new THREE.BufferAttribute(colors, 3);
    colorAttribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("color", colorAttribute);
    // A colour attribute is present here, so vertex colours are correct.
    const material = new THREE.LineBasicMaterial({ vertexColors: true });
    const memberGroup = new THREE.Group();
    memberGroup.name = "graviss-members";
    this.meshes.members = memberGroup;
    this.scene.add(memberGroup);
    const lines = new THREE.LineSegments(geometry, material);
    // One object spans the whole model. Culling it is all-or-nothing and would
    // force the animated position buffer's sphere to be rebuilt every frame.
    lines.frustumCulled = false;
    lines.userData.gravissEntityRanges = ranges;
    lines.userData.gravissNodeIndices = nodeIndices;
    lines.userData.gravissLineSteps = lineSteps;
    lines.userData.gravissLineSegments = true;
    this.memberMaterial = material;
    this.memberLines = lines;
    this.registerPickable("element", lines, elements, "members", "element", memberGroup);
    // Written rather than laid out here, so the chain and the straight case go
    // through exactly one piece of code.
    this.placeMemberLines();
    geometry.computeBoundingSphere();
  }

  memberLineSteps(element, steps = this.memberBendSteps) {
    return element.lineInterpolation !== "linear" &&
      this.stationsByElement?.has(stableIdKey(element.id))
      ? steps
      : 1;
  }

  // Where the model's nodes are, in the two shapes the scene reads them in.
  //
  // `restPositions` is where the provider put them and never changes.
  // `nodePositions` is where they are drawn, which is the same thing until a
  // result moves them. Member matrices read the flat array by index; the shell,
  // symbol and connector paths read `drawnNodes`, so both have to say the same
  // thing and both are written in one pass.
  //
  // `drawnNodes` holds copies rather than the provider's own objects. The
  // contract says the geometry belongs to the provider, and moving a model
  // means writing coordinates every frame - into records the provider handed
  // over would be writing through its back.
  buildNodeIndex() {
    const nodes = this.geometry.nodes;
    this.nodeIndexById = new Map();
    this.restPositions = new Float32Array(nodes.length * 3);
    this.nodePositions = new Float32Array(nodes.length * 3);
    this.drawnNodes = new Array(nodes.length);
    nodes.forEach((node, index) => {
      this.nodeIndexById.set(stableIdKey(node.id), index);
      this.restPositions[index * 3] = node.x;
      this.restPositions[index * 3 + 1] = node.y;
      this.restPositions[index * 3 + 2] = node.z;
      this.drawnNodes[index] = { ...node };
    });
    this.nodePositions.set(this.restPositions);
    this.restNodesById = new Map(
      nodes.map((node, index) => [
        stableIdKey(node.id),
        {
          x: this.restPositions[index * 3],
          y: this.restPositions[index * 3 + 1],
          z: this.restPositions[index * 3 + 2],
        },
      ]),
    );
  }

  // Writes the drawn coordinates from the flat array into the records that read
  // them, so the two shapes cannot drift apart.
  syncDrawnNodes() {
    const drawn = this.drawnNodes;
    const positions = this.nodePositions;
    for (let index = 0; index < drawn.length; index += 1) {
      const at = index * 3;
      drawn[index].x = positions[at];
      drawn[index].y = positions[at + 1];
      drawn[index].z = positions[at + 2];
    }
  }

  nodeIndex(id) {
    return this.nodeIndexById.get(stableIdKey(id));
  }

  createMemberGeometry(nodesById, elements) {
    this.memberContours = [];
    this.memberInstances = [];
    // A rebuild may be returning from centrelines to rendered sections. The
    // old line object has already been detached and disposed; retaining it here
    // made every animation frame rewrite that dead buffer forever.
    this.memberLines = null;
    // A model with no members still has the switch that hides them, and
    // setVisibility only knows what is registered - so the group exists even
    // when there is nothing to put in it, or the toolbar would say members are
    // shown while nothing answers for them.
    if (elements.length === 0) {
      const empty = new this.THREE.Group();
      empty.name = "graviss-members";
      this.meshes.members = empty;
      this.scene.add(empty);
      return;
    }
    const THREE = this.THREE;
    if (!this.sectionRendering) {
      this.createMemberLines(elements);
      return;
    }
    const groups = new Map();
    for (const element of elements) {
      const section = this.sectionsById.get(`${typeof element.sectionId}:${element.sectionId}`);
      const key = section?.shape ? `${typeof section.id}:${section.id}` : "centerline";
      let group = groups.get(key);
      if (!group) {
        group = { section, elements: [] };
        groups.set(key, group);
      }
      group.elements.push(element);
    }

    const memberGroup = new THREE.Group();
    memberGroup.name = "graviss-members";
    this.meshes.members = memberGroup;
    this.scene.add(memberGroup);
    // A member fill WINS depth ties. A member is a solid laid onto or through a
    // meshed surface, and an eccentric girder ends up with its face exactly in
    // the slab's plane: coplanar to the micrometre, so no order of strict tests
    // can put the flange over the slab's mesh lines - they tie. Where the tie
    // happens, the member is the physical thing being looked at and the
    // discretization lines yield.
    //
    // Structural tint is per instance. A displacement field reuses that same
    // vec3 for its two end values and lets the shader interpolate along local
    // x, avoiding another attribute on an already full instance layout.
    const memberMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.55,
      metalness: 0.12,
      depthFunc: THREE.LessEqualDepth,
      // Every pixel this fill visibly wins is marked, and the contours draw
      // only on the marks that survive the shell fill - so an arris finishes
      // exactly where the visible member surface does, however thin a sliver
      // of the body technically protrudes.
      stencilWrite: true,
      stencilRef: 1,
      stencilZPass: THREE.ReplaceStencilOp,
    });
    this.memberMaterial = this.teachMaterialToBend(memberMaterial, {
      displacementColors: true,
    });
    for (const group of groups.values()) {
      const unit = this.createSectionGeometry(group.section?.shape, this.memberBendSteps);
      const placement = this.memberPlacement(group.elements);
      const fill = this.addMemberInstances(unit, placement, group.elements, memberGroup, "element");
      // A line carries no object-level bounds, so anything measuring the drawn
      // model would read the unit section's own box off the contours and place
      // the members at the origin. They occupy exactly the fill's room, being
      // its arrises, so they are told so.
      const arris = this.createMemberContours(unit, placement, group.section?.shape);
      arris.geometry.boundingBox = fill.boundingBox.clone();
      arris.geometry.boundingSphere = fill.boundingSphere.clone();
      memberGroup.add(arris);
      unit.dispose();
      // The part of the section that does not carry, stamped over the member it
      // belongs to and drawn after it. The two surfaces are exactly coincident
      // - the same section through the same matrices, over an area cut out of
      // it - so the later draw wins every tie outright and no offset is wanted.
      const ineffective = this.createIneffectiveGeometry(
        group.section?.ineffective,
        this.memberBendSteps,
        group.section?.shape,
      );
      if (ineffective) {
        this.addMemberInstances(
          ineffective,
          placement,
          group.elements,
          memberGroup,
          "ineffective",
        ).renderOrder = 3;
        ineffective.dispose();
      }
    }
  }

  // Where every segment of every member in one section group sits, as one flat
  // run of sixteen floats an instance.
  //
  // A member is one segment today and a chain of them once it bends, so the
  // table that says which member a segment belongs to is built here rather than
  // assumed: picking and colouring both ask it, and neither should have to know
  // how finely a member is drawn.
  memberPlacement(elements) {
    const THREE = this.THREE;
    const perElement = this.memberSegments;
    const count = elements.length * perElement;
    const matrices = new THREE.InstancedBufferAttribute(new Float32Array(count * 16), 16);
    matrices.setUsage(THREE.DynamicDrawUsage);
    const segmentToEntityIndex = new Int32Array(count);
    const entityRanges = new Array(elements.length);
    const nodeIndices = new Int32Array(elements.length * 2);
    for (let index = 0; index < elements.length; index += 1) {
      entityRanges[index] = { start: index * perElement, count: perElement };
      nodeIndices[index * 2] = this.nodeIndex(elements[index].nodeIds[0]);
      nodeIndices[index * 2 + 1] = this.nodeIndex(elements[index].nodeIds[1]);
      segmentToEntityIndex.fill(index * perElement, index * perElement, (index + 1) * perElement);
      for (let segment = 0; segment < perElement; segment += 1) {
        segmentToEntityIndex[index * perElement + segment] = index;
      }
    }
    // What each member's two ends did, which is everything the bow between them
    // needs. The two end displacements carry twist in their spare slot, another
    // vector carries bending rotations, and the last two fields carry warping
    // and the reference length used by the beam interpolation. Written when a
    // result arrives, not per frame.
    const bendA = new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4);
    const bendB = new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4);
    const bendR = new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4);
    const bendW = new THREE.InstancedBufferAttribute(new Float32Array(count * 2), 2);
    const bendLength = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
    const bendY = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    const bendZ = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    const placement = {
      matrices,
      bendA,
      bendB,
      bendR,
      bendW,
      bendLength,
      bendY,
      bendZ,
      segmentToEntityIndex,
      entityRanges,
      nodeIndices,
      elements,
      count,
      activeElementIndices: elements.map((unused, index) => index),
    };
    this.writeMemberMatrices(placement);
    this.writeMemberStations(placement);
    this.memberInstances.push(placement);
    return placement;
  }

  // What each member's ends did, from the result the model is drawn under.
  //
  // A member the result says nothing about gets zeroes, which is a straight
  // member between its two moved ends - the honest answer, and the one every
  // provider that states no stations gets for every member it has.
  writeMemberStations(placement) {
    const stations = this.stationsByElement;
    const { bendA, bendB, bendR, bendW, bendLength, bendY, bendZ } = placement;
    bendA.array.fill(0);
    bendB.array.fill(0);
    bendR.array.fill(0);
    bendW.array.fill(0);
    bendLength.array.fill(0);
    bendY.array.fill(0);
    bendZ.array.fill(0);
    if (stations) {
      const { xAxis, yAxis, zAxis } = this.memberScratch();
      placement.activeElementIndices.forEach((index, slot) => {
        const element = placement.elements[index];
        const found = stations.get(stableIdKey(element.id));
        if (!found || found.length < 2) return;
        const first = found[0];
        const last = found[found.length - 1];
        const at = slot * 4;
        bendA.array[at] = first.u[0];
        bendA.array[at + 1] = first.u[1];
        bendA.array[at + 2] = first.u[2];
        bendA.array[at + 3] = first.phi?.[0] ?? 0;
        bendB.array[at] = last.u[0];
        bendB.array[at + 1] = last.u[1];
        bendB.array[at + 2] = last.u[2];
        bendB.array[at + 3] = last.phi?.[0] ?? 0;
        bendR.array[at] = first.phi?.[1] ?? 0;
        bendR.array[at + 1] = first.phi?.[2] ?? 0;
        bendR.array[at + 2] = last.phi?.[1] ?? 0;
        bendR.array[at + 3] = last.phi?.[2] ?? 0;
        const warpAt = slot * 2;
        bendW.array[warpAt] = first.warping ?? 0;
        bendW.array[warpAt + 1] = last.warping ?? 0;
        const length = this.memberReferenceLength(element, found);
        // The shader already needs this length and an absent station is zero.
        // Its sign can therefore select the path without spending the last
        // vertex attribute many WebGL implementations do not have: positive is
        // Hermite, negative is a straight path that still twists and warps.
        bendLength.array[slot] = element.lineInterpolation === "linear" ? -length : length;
        const firstNode = placement.nodeIndices[index * 2] * 3;
        const secondNode = placement.nodeIndices[index * 2 + 1] * 3;
        this.memberAxes(
          element,
          this.restPositions[secondNode] - this.restPositions[firstNode],
          this.restPositions[secondNode + 1] - this.restPositions[firstNode + 1],
          this.restPositions[secondNode + 2] - this.restPositions[firstNode + 2],
          xAxis,
          yAxis,
          zAxis,
        );
        const axisAt = slot * 3;
        bendY.array[axisAt] = yAxis.x;
        bendY.array[axisAt + 1] = yAxis.y;
        bendY.array[axisAt + 2] = yAxis.z;
        bendZ.array[axisAt] = zAxis.x;
        bendZ.array[axisAt + 1] = zAxis.y;
        bendZ.array[axisAt + 2] = zAxis.z;
      });
    }
    bendA.needsUpdate = true;
    bendB.needsUpdate = true;
    bendR.needsUpdate = true;
    bendW.needsUpdate = true;
    bendLength.needsUpdate = true;
    bendY.needsUpdate = true;
    bendZ.needsUpdate = true;
    return placement;
  }

  // The bow is drawn on the card, so a material that draws a member has to know
  // how. Both the fill and its arrises take the same code and the same uniform
  // object - which is what keeps an arris on its fill once the fill has bent,
  // for the same reason they share one instance matrix.
  teachMaterialToBend(material, { displacementColors = false } = {}) {
    material.defines = { ...material.defines, GRAVISS_BEND: "" };
    material.onBeforeCompile = (shader) => {
      shader.uniforms.gravissBendFactor = this.bendFactor;
      if (displacementColors) {
        shader.uniforms.gravissDisplacementStops = this.displacementColorStops;
      }
      shader.vertexShader = shader.vertexShader
        .replace(
          "void main() {",
          `${MEMBER_BEND_DECLARATIONS}\n${displacementColors ? MEMBER_FIELD_VERTEX_DECLARATIONS : ""}\nvoid main() {`,
        )
        .replace(
          "#include <color_vertex>",
          `#include <color_vertex>\n${displacementColors ? MEMBER_FIELD_VERTEX_CHUNK : ""}`,
        )
        .replace("#include <begin_vertex>", `#include <begin_vertex>\n${MEMBER_BEND_CHUNK}`);
      if (displacementColors) {
        shader.fragmentShader = shader.fragmentShader
          .replace("void main() {", `${DISPLACEMENT_FIELD_FRAGMENT_DECLARATIONS}\nvoid main() {`)
          .replace(
            "#include <color_fragment>",
            `#include <color_fragment>
            if (gravissDisplacementField > 0.5) {
              diffuseColor.rgb = gravissSampleDisplacement(gravissDisplacementFraction);
            }`,
          );
      }
    };
    // Constant, because the program does not depend on anything that varies:
    // without this three would treat every material carrying an onBeforeCompile
    // as its own program and compile the same shader once per section.
    material.customProgramCacheKey = () =>
      displacementColors ? "graviss-bend-displacement-field" : "graviss-bend";
    return material;
  }

  teachShellMaterialToColor(material) {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.gravissDisplacementStops = this.displacementColorStops;
      shader.vertexShader = shader.vertexShader
        .replace("void main() {", `${SHELL_FIELD_VERTEX_DECLARATIONS}\nvoid main() {`)
        .replace("#include <color_vertex>", `#include <color_vertex>\n${SHELL_FIELD_VERTEX_CHUNK}`);
      shader.fragmentShader = shader.fragmentShader
        .replace("void main() {", `${DISPLACEMENT_FIELD_FRAGMENT_DECLARATIONS}\nvoid main() {`)
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
          if (gravissDisplacementField > 0.5) {
            diffuseColor.rgb = gravissSampleDisplacement(gravissDisplacementFraction);
          }`,
        );
    };
    material.customProgramCacheKey = () => "graviss-shell-displacement-field";
    return material;
  }

  // Writes one affine an instance, straight into the buffer. The columns of the
  // matrix are the member's own axes scaled to its length and its midpoint, so
  // there is nothing to compose and nothing to allocate - which matters at
  // fourteen thousand segments a frame.
  writeMemberMatrices(placement) {
    const { xAxis, yAxis, zAxis, midpoint } = this.memberScratch();
    const into = placement.matrices.array;
    const positions = this.nodePositions;
    placement.activeElementIndices.forEach((index, slot) => {
      const element = placement.elements[index];
      const first = placement.nodeIndices[index * 2] * 3;
      const second = placement.nodeIndices[index * 2 + 1] * 3;
      const startX = positions[first];
      const startY = positions[first + 1];
      const startZ = positions[first + 2];
      const endX = positions[second];
      const endY = positions[second + 1];
      const endZ = positions[second + 2];
      midpoint.set((startX + endX) * 0.5, (startY + endY) * 0.5, (startZ + endZ) * 0.5);
      xAxis.set(endX - startX, endY - startY, endZ - startZ);
      const length = xAxis.length();
      if (length > 0) xAxis.divideScalar(length);
      const suppliedY = element.localAxes?.y;
      if (suppliedY) {
        yAxis.set(suppliedY[0], suppliedY[1], suppliedY[2]);
      } else {
        yAxis.copy(this.worldUp).cross(xAxis);
      }
      if (yAxis.lengthSq() < 1e-12) yAxis.copy(this.modelYAxis);
      yAxis.addScaledVector(xAxis, -yAxis.dot(xAxis)).normalize();
      zAxis.crossVectors(xAxis, yAxis).normalize();
      const at = slot * this.memberSegments * 16;
      into[at] = xAxis.x * length;
      into[at + 1] = xAxis.y * length;
      into[at + 2] = xAxis.z * length;
      into[at + 3] = 0;
      into[at + 4] = yAxis.x;
      into[at + 5] = yAxis.y;
      into[at + 6] = yAxis.z;
      into[at + 7] = 0;
      into[at + 8] = zAxis.x;
      into[at + 9] = zAxis.y;
      into[at + 10] = zAxis.z;
      into[at + 11] = 0;
      into[at + 12] = midpoint.x;
      into[at + 13] = midpoint.y;
      into[at + 14] = midpoint.z;
      into[at + 15] = 1;
    });
    placement.matrices.needsUpdate = true;
  }

  // The member fill, as one instance of the section a segment.
  //
  // Baking it vertex by vertex on the CPU cost a fifth of a second a frame on a
  // real model and a hundred megabytes of buffer, which is not a thing an
  // animation can pay: the section is uploaded once and the segments are
  // sixteen floats each.
  addMemberInstances(unit, placement, elements, memberGroup, colorKey) {
    const THREE = this.THREE;
    const geometry = unit.clone();
    geometry.setAttribute("instanceBendA", placement.bendA);
    geometry.setAttribute("instanceBendB", placement.bendB);
    geometry.setAttribute("instanceBendR", placement.bendR);
    geometry.setAttribute("instanceBendW", placement.bendW);
    geometry.setAttribute("instanceBendLength", placement.bendLength);
    geometry.setAttribute("instanceBendY", placement.bendY);
    geometry.setAttribute("instanceBendZ", placement.bendZ);
    const mesh = new THREE.InstancedMesh(geometry, this.memberMaterial, placement.count);
    // The one buffer the fill and its contours both read, so both evaluate the
    // same instanceMatrix * position and a contour lies on its fill to the bit
    // - which is what lets an arris need no offset and no inflation.
    mesh.instanceMatrix = placement.matrices;
    mesh.count = placement.count;
    // Culling is off because the model is three or four giant objects and an
    // amplified one leaves the sphere it was built with; the box is still
    // computed, because measuring the visible model reads it.
    mesh.frustumCulled = false;
    refreshInstanceBounds(mesh);
    // This fill wins its ties against the later shell fill, leaving stencil one
    // wherever a flush flange owns the visible band. The late shell mesh lines
    // accept only stencil zero, so they yield there without a depth offset.
    mesh.renderOrder = 2;
    mesh.userData.gravissEntityRanges = placement.entityRanges;
    mesh.userData.gravissSegmentToEntityIndex = placement.segmentToEntityIndex;
    mesh.userData.gravissPlacement = placement;
    mesh.userData.gravissInstanced = true;
    this.registerPickable("element", mesh, elements, "members", colorKey, memberGroup);
    return mesh;
  }

  // The areas of a section that do not carry, as one extrusion in the same
  // unit frame the section itself is built in. Each is an outline with its own
  // holes, cut to the section by whoever read it — a viewer draws where the
  // material is not counted and never works out where that is.
  createIneffectiveGeometry(areas, steps = 1, sectionShape = null) {
    if (!areas?.length) return null;
    const THREE = this.THREE;
    const outlines = areas.map((area) => {
      const outline = this.createSectionPath(THREE.Shape, area.points);
      for (const hole of area.holes || []) {
        outline.holes.push(this.createSectionPath(THREE.Path, hole));
      }
      return outline;
    });
    const geometry = this.extrudeSectionShape(
      outlines.length === 1 ? outlines[0] : outlines,
      8,
      steps,
    );
    return this.assignSectionWarping(geometry, sectionShape);
  }

  // The section contour of every member, beside the shell edges.
  // EdgesGeometry of the unit section keeps its sharp edges — the end rings
  // and, for angular sections, the longitudinal arrises — and each element's
  // matrix stamps them onto it with the arithmetic that baked the fill, so
  // every contour vertex equals its fill vertex to the bit.
  //
  // Drawn last, and only where the stencil says a member is the visible
  // surface. Depth alone cannot finish these lines where the visible member
  // finishes: an eccentric girder weaves millimetres above and below the
  // eccentric slab that double-represents the same concrete, and a
  // millimetre of protruding ring rasterizes as a full pixel of line where
  // the protruding fill is a sliver too thin to see. The mark the member
  // fill left — and the shell fill took away wherever it won the pixel back
  // — is what makes an arris end exactly at the drawn intersection.
  createMemberContours(unit, placement, sectionShape = null) {
    const THREE = this.THREE;
    const unitEdges = new THREE.EdgesGeometry(unit);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute("position", unitEdges.getAttribute("position").clone());
    this.assignSectionWarping(geometry, sectionShape);
    // The same attribute object the fill reads. Sharing it is the whole point:
    // two buffers holding the same numbers would still be two roundings.
    geometry.setAttribute("instanceMatrix", placement.matrices);
    geometry.setAttribute("instanceBendA", placement.bendA);
    geometry.setAttribute("instanceBendB", placement.bendB);
    geometry.setAttribute("instanceBendR", placement.bendR);
    geometry.setAttribute("instanceBendW", placement.bendW);
    geometry.setAttribute("instanceBendLength", placement.bendLength);
    geometry.setAttribute("instanceBendY", placement.bendY);
    geometry.setAttribute("instanceBendZ", placement.bendZ);
    geometry.instanceCount = placement.count;
    unitEdges.dispose();
    // Opaque for the same reason the shell edges are, mixed toward the member
    // surface these arrises lie on, and drawn in the line tier before every
    // fill: the member's own fill sinks behind the depth these wrote, and a
    // foreign body in front paints over exactly the arrises it hides.
    const definition = appearanceDefinition(this.activeAppearance);
    const contours = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({
        color: this.mixedLineColor(definition.shellEdge, definition.member),
        stencilWrite: true,
        stencilWriteMask: 0,
        stencilFunc: THREE.EqualStencilFunc,
        stencilRef: 1,
      }),
    );
    // Three sets this for an InstancedMesh and a line is not one, so the shader
    // is told directly. It has to be assigned rather than passed in: a material
    // only takes constructor values for properties it already has, and a plain
    // one has no `defines`.
    contours.material.defines = { USE_INSTANCING: "" };
    this.teachMaterialToBend(contours.material);
    contours.userData.gravissPlacement = placement;
    contours.name = "graviss-member-contours";
    contours.renderOrder = 5;
    contours.frustumCulled = false;
    contours.visible = this.visibility.mesh !== false;
    this.memberContours.push(contours);
    return contours;
  }

  memberScratch() {
    const THREE = this.THREE;
    this._memberScratch ||= {
      xAxis: new THREE.Vector3(),
      yAxis: new THREE.Vector3(),
      zAxis: new THREE.Vector3(),
      midpoint: new THREE.Vector3(),
    };
    return this._memberScratch;
  }

  // `steps` is how many rings the extrusion carries along its length. One at
  // rest, because a straight member has nothing to say between its ends; more
  // once there is a bow to draw, and the rings are what there is to bend.
  createSectionGeometry(shape, steps = 1) {
    const THREE = this.THREE;
    const finish = (geometry) => this.assignSectionWarping(geometry, shape);
    // A member whose section the source never supplied still has to be drawn,
    // so it falls back to a thin round bar.
    if (!shape) {
      const geometry = new THREE.CylinderGeometry(0.055, 0.055, 1, 8, steps, false);
      geometry.rotateZ(-Math.PI / 2);
      return finish(geometry);
    }
    if (shape.kind === "rectangle") {
      return finish(new THREE.BoxGeometry(1, shape.width, shape.height, steps, 1, 1));
    }
    if (shape.kind === "circle") {
      const geometry = new THREE.CylinderGeometry(
        shape.diameter / 2,
        shape.diameter / 2,
        1,
        16,
        steps,
        false,
      );
      geometry.rotateZ(-Math.PI / 2);
      return finish(geometry);
    }
    if (shape.kind === "tube") {
      const outline = new THREE.Shape();
      outline.absarc(0, 0, shape.diameter / 2, 0, Math.PI * 2, false);
      const hole = new THREE.Path();
      hole.absarc(0, 0, shape.diameter / 2 - shape.thickness, 0, Math.PI * 2, true);
      outline.holes.push(hole);
      return finish(this.extrudeSectionShape(outline, 16, steps));
    }
    if (shape.kind === "tee") {
      const outline = new THREE.Shape();
      const halfFlange = shape.flangeWidth / 2;
      const halfWeb = shape.webWidth / 2;
      const halfHeight = shape.height / 2;
      const flangeBottom = halfHeight - shape.flangeThickness;
      outline.moveTo(-halfFlange, halfHeight);
      outline.lineTo(halfFlange, halfHeight);
      outline.lineTo(halfFlange, flangeBottom);
      outline.lineTo(halfWeb, flangeBottom);
      outline.lineTo(halfWeb, -halfHeight);
      outline.lineTo(-halfWeb, -halfHeight);
      outline.lineTo(-halfWeb, flangeBottom);
      outline.lineTo(-halfFlange, flangeBottom);
      outline.closePath();
      return finish(this.extrudeSectionShape(outline, 1, steps));
    }
    if (shape.kind === "polygon") {
      // One area with its holes, or several parts each with their own: a
      // composed section — a plate, a deck and the web between them — is one
      // extrusion carrying every part.
      const parts = shape.parts || [shape];
      const outlines = parts.map((part) => {
        const outline = this.createSectionPath(THREE.Shape, part.points);
        for (const hole of part.holes || []) {
          outline.holes.push(this.createSectionPath(THREE.Path, hole));
        }
        return outline;
      });
      return finish(
        this.extrudeSectionShape(outlines.length === 1 ? outlines[0] : outlines, 8, steps),
      );
    }
    if (shape.kind === "plates") {
      // One outline per plate, all of them in one extrusion. Plates that meet
      // are drawn meeting rather than merged: the seam between two plates of a
      // built-up section is an edge the section really has, and a boolean
      // union would be a shape nobody described.
      const outlines = shape.plates.map((plate) => this.createPlatePath(THREE.Shape, plate));
      return finish(
        this.extrudeSectionShape(outlines.length === 1 ? outlines[0] : outlines, 1, steps),
      );
    }
    throw new RangeError(`Unsupported Graviss section shape: ${shape.kind}`);
  }

  // The band one plate occupies: the run it was given, offset half a thickness
  // either way, square at both ends. Nothing is mitred or extended at a corner
  // — a source states where each plate ends, and lengthening one would add
  // material to the section that the source did not put there.
  createPlatePath(PathType, plate) {
    const [fromY, fromZ] = plate.from;
    const [toY, toZ] = plate.to;
    const runY = toY - fromY;
    const runZ = toZ - fromZ;
    const half = plate.thickness / 2 / Math.hypot(runY, runZ);
    const offsetY = -runZ * half;
    const offsetZ = runY * half;
    const path = new PathType();
    path.moveTo(fromY + offsetY, fromZ + offsetZ);
    path.lineTo(toY + offsetY, toZ + offsetZ);
    path.lineTo(toY - offsetY, toZ - offsetZ);
    path.lineTo(fromY - offsetY, fromZ - offsetZ);
    path.closePath();
    return path;
  }

  // The seventh beam degree of freedom is d(phi-x)/dx. A point of the cross
  // section moves axially by that value times the section's unit warping W0.
  // Thin-walled sections state W0 at both ends of every plate, so the card gets
  // one interpolated ordinate per section vertex and only the two station
  // values vary from member to member.
  assignSectionWarping(geometry, shape) {
    const THREE = this.THREE;
    const position = geometry.getAttribute("position");
    const values = new Float32Array(position?.count ?? 0);
    const plates =
      shape?.kind === "plates"
        ? shape.plates.filter(
            (plate) =>
              Array.isArray(plate.unitWarping) &&
              plate.unitWarping.length === 2 &&
              plate.unitWarping.every(Number.isFinite),
          )
        : [];
    if (position && plates.length) {
      for (let vertex = 0; vertex < position.count; vertex += 1) {
        const y = position.getY(vertex);
        const z = position.getZ(vertex);
        let nearest = Infinity;
        let warping = 0;
        for (const plate of plates) {
          const runY = plate.to[0] - plate.from[0];
          const runZ = plate.to[1] - plate.from[1];
          const lengthSquared = runY * runY + runZ * runZ;
          if (!(lengthSquared > 0)) continue;
          const along = Math.min(
            1,
            Math.max(0, ((y - plate.from[0]) * runY + (z - plate.from[1]) * runZ) / lengthSquared),
          );
          const offsetY = y - (plate.from[0] + runY * along);
          const offsetZ = z - (plate.from[1] + runZ * along);
          const distanceSquared = offsetY * offsetY + offsetZ * offsetZ;
          if (distanceSquared < nearest) {
            nearest = distanceSquared;
            warping = plate.unitWarping[0] + (plate.unitWarping[1] - plate.unitWarping[0]) * along;
          }
        }
        values[vertex] = warping;
      }
    }
    geometry.setAttribute("gravissSectionWarping", new THREE.BufferAttribute(values, 1));
    return geometry;
  }

  createSectionPath(PathType, points) {
    const path = new PathType();
    path.moveTo(points[0][0], points[0][1]);
    for (const point of points.slice(1)) path.lineTo(point[0], point[1]);
    path.closePath();
    return path;
  }

  extrudeSectionShape(shape, curveSegments, steps = 1) {
    const geometry = new this.THREE.ExtrudeGeometry(shape, {
      depth: 1,
      bevelEnabled: false,
      curveSegments,
      steps,
    });
    geometry.translate(0, 0, -0.5);
    // ExtrudeGeometry starts with section width on X, height on Y, and
    // extrusion on Z. Graviss members use length X, section width Y, height Z.
    geometry.rotateX(Math.PI / 2);
    geometry.rotateZ(Math.PI / 2);
    return geometry;
  }

  // With section rendering on an area element that declares a thickness is
  // drawn as both of its faces, half the thickness either side of the surface
  // it was given. Without section rendering — or without a thickness — the
  // element is the surface alone; doubling a zero-thickness surface would draw
  // the same coplanar triangles twice for nothing.
  shellLayerCount(element) {
    const declared = element.thickness;
    const thick = Array.isArray(declared) ? declared.some((value) => value > 0) : declared > 0;
    return this.sectionRendering && thick ? 2 : 1;
  }

  // Tangents along a Hermite QUAD's natural edges. A provider opts into this
  // kinematics explicitly: each rest edge is turned by the rotation at its own
  // endpoint, so every edge incident at one node stays in the one tangent plane
  // that node declares. The finite rotation retains the result's first-order
  // direction while keeping an intentionally amplified display bounded.
  prepareShellSurfaceTangents(state, item, into) {
    return prepareShellSurfaceTangents(this, state, item, into);
  }

  // A Coons patch whose four boundaries are cubic Hermite curves. Bilinear
  // interpolation is subtracted once because the four boundary blends contain
  // it twice, leaving exact translated corners and the slopes supplied by the
  // provider-selected element formulation.
  shellCoonsPosition(nodes, tangents, s, t, target) {
    return shellCoonsPosition(this, nodes, tangents, s, t, target);
  }

  // Lighting normals belong to the surface that was actually tessellated.
  // Interpolating the four thickness directors gives a different vector field
  // from a warped bilinear patch and makes its internal triangles appear as
  // false dents. Central differences in the sampled grid follow both the Q4
  // mid-surface and any varying offset/thickness applied to this layer.
  writeSampledShellNormals(positions, normalValues, layerStart, width) {
    return writeSampledShellNormals(this, positions, normalValues, layerStart, width);
  }

  // Where every vertex of every area element goes, from the corners it was
  // meshed on and the normals it stands off along.
  //
  // Run once when the surface is built and again whenever the model moves. What
  // it does NOT recompute is the topology - which side faces exist, how many
  // triangles there are, which joins are drawn - because those were decided
  // from the corners at rest and deciding them again every frame would both
  // cost more than the writing does and make side faces flicker in and out as
  // a slab bends.
  writeShellSurface(state, options = {}) {
    return writeShellSurface(this, state, options);
  }

  // Writes the area elements again where the model has moved them.
  //
  // The corners come from the drawn node records, which the deformation has
  // already written, and the normals are worked out again from them: frozen,
  // the mid-surface would bend while the faces stayed parallel to the shape at
  // rest, so a bending slab would shear instead of rotating and one swinging
  // about its root would render edge on with no thickness at all.
  updateShellSurface() {
    const state = this.shellState;
    if (!state?.geometry) return;
    state.poseVersion = (state.poseVersion ?? 0) + 1;
    if (this.ensureShellGpuBackend()) {
      this.shellGpu.setResult(this.deformation);
      this.shellGpu.markDirty();
      return;
    }
    // An adapted shell's rotations turn its independent thickness director;
    // they are not derivatives of the translated mid-surface. Thin shells have
    // no offset along that director, so only a thick or eccentric body needs
    // this pass at all. The Q4 surface itself always follows nodal translations.
    if (
      this.deformation?.rotations &&
      (state.requiresDisplacementNormals || state.requiresSurfaceRotations)
    ) {
      this.updateShellNormalsFromRotations(state);
    } else if (state.requiresDisplacementNormals) this.updateShellNormals(state);
    const writeEdges = this.shellEdgesVisible();
    this.writeShellSurface(state, { writeEdges });
    state.geometry.getAttribute("position").needsUpdate = true;
    state.geometry.getAttribute("normal").needsUpdate = true;
    if (writeEdges) state.edgeBuffer.needsUpdate = true;
    state.edgesStale = !writeEdges;
    state.cpuFullVersion = state.poseVersion;
    state.cpuProxyVersion = state.poseVersion;
  }

  ensureShellGpuBackend() {
    if (this.shellGpu) return true;
    const state = this.shellState;
    if (
      this.shellDeformationBackend === "cpu" ||
      !this.deformation?.result ||
      !state?.geometry ||
      state.gpuUnavailable
    )
      return false;
    const { backend, reason } = createShellGpuBackend(this, state);
    if (!backend) {
      state.gpuUnavailable = reason;
      if (this.shellDeformationBackend === "gpu") throw new Error(reason);
      return false;
    }
    const mesh = this.meshes.shells;
    backend.installMaterials(
      mesh.material,
      mesh.userData.gravissEdges.material,
      state.geometry,
      state.edgeGeometry,
    );
    this.shellGpu = backend;
    return true;
  }

  ensureGpuShellFrame() {
    if (!this.shellGpu || !this.meshes.shells?.visible) return;
    try {
      if (this.shellGpu.disposed) throw new Error("Shell GPU backend has been disposed");
      this.shellGpu.ensureFrame(this.deformation);
    } catch (error) {
      this.shellGpu.dispose();
      this.shellGpu = null;
      this.shellState.gpuUnavailable = error.message;
      this.updateShellSurface();
      if (this.shellDeformationBackend === "gpu") throw error;
    }
  }

  renderModel(renderer = this.canvasRenderer, camera = this.camera) {
    this.updateMemberDiagramLabels(renderer, camera);
    const debug = renderer.debug;
    const previous = debug.onShaderError;
    let failure = null;
    debug.onShaderError = (...args) => {
      failure = new Error("Shell drawing shader could not be compiled");
      previous?.(...args);
    };
    try {
      renderer.render(this.scene, camera);
    } finally {
      debug.onShaderError = previous;
    }
    if (failure && this.shellGpu) {
      this.shellGpu.dispose();
      this.shellGpu = null;
      this.shellState.gpuUnavailable = failure.message;
      this.updateShellSurface();
      if (this.shellDeformationBackend === "gpu") throw failure;
      renderer.render(this.scene, camera);
    } else if (failure) throw failure;
  }

  ensureCpuShellGeometry(detail = "full") {
    const state = this.shellState;
    if (!this.shellGpu || !state?.geometry) return;
    if (
      state.cpuFullVersion === state.poseVersion ||
      (detail === "proxy" && state.cpuProxyVersion === state.poseVersion)
    )
      return;
    if (
      this.deformation?.rotations &&
      (state.requiresDisplacementNormals || state.requiresSurfaceRotations)
    )
      this.updateShellNormalsFromRotations(state);
    else if (state.requiresDisplacementNormals) this.updateShellNormals(state);
    if (detail === "proxy") {
      writeShellProxy(this, state);
      state.cpuProxyVersion = state.poseVersion;
    } else {
      this.writeShellSurface(state, { writeEdges: false });
      state.cpuFullVersion = state.poseVersion;
      state.cpuProxyVersion = state.poseVersion;
      state.geometry.boundingBox = null;
    }
  }

  shellVisibleBounds() {
    const state = this.shellState;
    if (!state?.geometry) return null;
    if (state.geometry.boundingBox) return state.geometry.boundingBox;
    const box = new this.THREE.Box3();
    const point = new this.THREE.Vector3();
    for (const entity of state.activeElementIndices) {
      const item = state.prepared[entity];
      for (
        let vertex = item.vertexStart;
        vertex < item.vertexStart + item.vertexCount;
        vertex += 1
      ) {
        point.fromArray(state.positions, vertex * 3);
        box.expandByPoint(point);
      }
    }
    state.geometry.boundingBox = box;
    return box;
  }

  // A plate/shell node carries its own rotations. They rotate the director
  // through the thickness independently of the translations of neighbouring
  // corners; deriving that director from the translated polygon instead turns
  // transverse shear into a fictitious rigid rotation and produces kinks at
  // changes of mesh direction.
  updateShellNormalsFromRotations(state) {
    return updateShellNormalsFromRotations(this, state);
  }

  // The corner normals again, for a model that has moved.
  //
  // Only the normals: how thick an element is and where its body sits relative
  // to its nodes are facts about the element, not about where it ended up, so
  // they are decided once and kept. The normals are the opposite - frozen, the
  // mid-surface would bend while the faces stayed parallel to the shape at rest,
  // and a slab swinging about its root would render edge on with no thickness at
  // all.
  //
  // Keyed by node index into flat arrays rather than by an id string into a Map.
  // Same answer, and it is the difference between this pass costing twenty
  // milliseconds a frame and costing one: six thousand elements is twenty-five
  // thousand corners, and a string built per corner per frame is what that
  // twenty milliseconds was.
  updateShellNormals(state) {
    return updateShellNormals(this, state);
  }

  createShellGeometry(nodesById, elements) {
    if (elements.length === 0) return;
    const THREE = this.THREE;
    const { prepared, vertexCount, triangleCount, edgeCount, maximumSurfaceSamples } =
      prepareShellTopology(this, nodesById, elements, {
        TRIANGLE_SURFACE_LAYOUT,
        LINEAR_QUAD_SURFACE_LAYOUT,
        SAMPLED_QUAD_SURFACE_LAYOUT,
        QUAD_SURFACE_LAYOUT,
      });
    const positions = new Float32Array(vertexCount * 3);
    const normalValues = new Float32Array(vertexCount * 3);
    const IndexArray = vertexCount > 65535 ? Uint32Array : Uint16Array;
    const indexValues = new IndexArray(triangleCount * 3);
    const edgePositions = new Float32Array(edgeCount * 6);
    const entityRanges = [];
    const faceToEntityIndex = new Int32Array(triangleCount);

    // Held so the surface can be written again when the model moves, without
    // deciding its topology a second time. The index tables are part of that:
    // which node each corner sits on does not change when the model moves, and
    // working it out again per frame is what the per-frame pass is trying to
    // avoid.
    let cornerCount = 0;
    for (const item of prepared) cornerCount += item.nodes.length;
    const nodeIndices = new Int32Array(cornerCount);
    const restNormals = new Float32Array(cornerCount * 3);
    let corner = 0;
    for (let itemIndex = 0; itemIndex < elements.length; itemIndex += 1) {
      const element = elements[itemIndex];
      for (let nodeAt = 0; nodeAt < element.nodeIds.length; nodeAt += 1) {
        const nodeId = element.nodeIds[nodeAt];
        nodeIndices[corner] = this.nodeIndexById.get(stableIdKey(nodeId)) ?? -1;
        const normal = prepared[itemIndex].normals[nodeAt];
        restNormals[corner * 3] = normal.x;
        restNormals[corner * 3 + 1] = normal.y;
        restNormals[corner * 3 + 2] = normal.z;
        corner += 1;
      }
    }
    this.shellState = {
      prepared,
      positions,
      normalValues,
      indexValues,
      edgePositions,
      elements,
      entityRanges,
      faceToEntityIndex,
      activeElementIndices: elements.map((unused, index) => index),
      nodeIndices,
      restNormals,
      rotationMatrices: new Float32Array(this.geometry.nodes.length * 9),
      rotationParameters: new Float32Array(this.geometry.nodes.length * 4),
      rotationSource: null,
      maximumSurfaceSamples,
      // A plain mid-surface is written directly on its displaced nodes. Its
      // corner normal is multiplied by zero everywhere, so recomputing tens of
      // thousands of them cannot change one output coordinate.
      requiresDisplacementNormals: prepared.some(
        ({ layers, middle }) => layers === 2 || middle.some((value) => value !== 0),
      ),
      requiresSurfaceRotations: prepared.some(
        ({ surfaceInterpolation }) => surfaceInterpolation === "hermite",
      ),
    };
    this.writeShellSurface(this.shellState, { entityRanges, faceToEntityIndex });

    const shellGeometry = new THREE.BufferGeometry();
    const positionAttribute = new THREE.BufferAttribute(positions, 3);
    positionAttribute.setUsage(THREE.DynamicDrawUsage);
    shellGeometry.setAttribute("position", positionAttribute);
    const normalAttribute = new THREE.BufferAttribute(normalValues, 3);
    normalAttribute.setUsage(THREE.DynamicDrawUsage);
    shellGeometry.setAttribute("normal", normalAttribute);
    shellGeometry.setIndex(new THREE.BufferAttribute(indexValues.slice(), 1));
    const colorAttribute = new THREE.BufferAttribute(new Float32Array(positions.length), 3);
    colorAttribute.setUsage(THREE.DynamicDrawUsage);
    shellGeometry.setAttribute("color", colorAttribute);
    const displacementAttribute = new THREE.BufferAttribute(
      new Float32Array(vertexCount).fill(-1),
      1,
    );
    displacementAttribute.setUsage(THREE.DynamicDrawUsage);
    shellGeometry.setAttribute("gravissDisplacement", displacementAttribute);
    shellGeometry.computeBoundingSphere();
    // No polygon offset at all. Member fills arrive first and win exact ties;
    // this strict shell fill then clears their stencil mark only where it is
    // genuinely in front. Shell mesh lines arrive after every fill at their
    // true depth, so a rear face can never be pulled through the front one.
    const shellMaterial = this.teachShellMaterialToColor(
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.72,
        metalness: 0.04,
        side: THREE.DoubleSide,
        vertexColors: true,
        // The surface vertices carry the interpolated shell director. Flat
        // derivative normals would reveal the triangles used to sample the
        // bilinear QUAD as false facets across an otherwise smooth element.
        flatShading: false,
        depthFunc: THREE.LessDepth,
        // Every pixel this fill wins is a pixel where no member is the visible
        // surface, so the member mark is cleared and no arris will draw there.
        stencilWrite: true,
        stencilRef: 0,
        stencilZPass: THREE.ReplaceStencilOp,
      }),
    );
    const shellMesh = new THREE.Mesh(shellGeometry, shellMaterial);
    // After the member fills: a flange lying exactly in this surface's plane
    // has already claimed its band, and the tie-losing test leaves it there.
    // The two contour layers follow all fills and use the stencil value this
    // pass resolves to decide which family owns each visible pixel.
    shellMesh.renderOrder = 4;
    shellMesh.userData.gravissEntityRanges = entityRanges;
    shellMesh.userData.gravissFaceToEntityIndex = faceToEntityIndex.slice();

    // Pointer-directed wheel zoom needs only the depth of the surface under
    // the cursor. Raycasting the displayed surface for that depth becomes a
    // frame-sized synchronous job once a result turns every QUAD into a 4 x 4
    // sampled patch. Give the wheel a coarse copy of the same live position
    // attribute instead: four triangles around the patch centre (one for a
    // TRI) preserve its useful depth and reduce a sampled QUAD from 32
    // triangles to four. Selection still uses the full surface below.
    const zoomGeometry = new THREE.BufferGeometry();
    zoomGeometry.setAttribute("position", positionAttribute);
    const zoomIndices = [];
    const zoomEntityRanges = [];
    for (let itemIndex = 0; itemIndex < prepared.length; itemIndex += 1) {
      const zoomStart = zoomIndices.length;
      const item = prepared[itemIndex];
      const range = entityRanges[itemIndex];
      const corners = item.surfaceLayout.corners;
      const samples = item.surfaceLayout.weights.length / item.nodes.length;
      for (let layer = 0; layer < item.layers; layer += 1) {
        const layerStart = range.start + layer * samples;
        if (corners.length === 3 || item.surfaceInterpolation === "linear") {
          for (const index of item.surfaceLayout.indices) zoomIndices.push(layerStart + index);
          continue;
        }
        const center = item.surfaceLayout.width ? Math.floor(samples / 2) : samples - 1;
        for (let side = 0; side < corners.length; side += 1) {
          zoomIndices.push(
            layerStart + corners[side],
            layerStart + corners[(side + 1) % corners.length],
            layerStart + center,
          );
        }
      }
      zoomEntityRanges.push({ start: zoomStart, count: zoomIndices.length - zoomStart });
    }
    zoomGeometry.setIndex(zoomIndices);
    // These positions move with the displayed shell. An infinite broad-phase
    // sphere avoids both a stale rejection and recomputing bounds over the
    // dense shared attribute on every deformation frame; the small proxy index
    // remains the only geometry the ray actually walks.
    zoomGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    const zoomMaterial = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    shellMesh.userData.gravissZoomProxy = new THREE.Mesh(zoomGeometry, zoomMaterial);

    const { LineSegments2, LineSegmentsGeometry, LineMaterial } = this.wideLines;
    const edgeGeometry = new LineSegmentsGeometry();
    edgeGeometry.setPositions(edgePositions.slice());
    const edgeBuffer = edgeGeometry.getAttribute("instanceStart").data;
    edgeBuffer.setUsage(THREE.DynamicDrawUsage);
    // Built at the active appearance rather than white. Only applyTheme used to
    // colour these, so every rebuild that did not go through it — switching
    // section rendering, for one — left the mesh lines white.
    //
    // Opaque, but not depth-writing: the completed fill pass already contains
    // the visible surface. A line at that same depth passes LessEqual; a line
    // from the rear face fails against the front fill. Stencil zero says that
    // the visible surface is a shell rather than a member. Softness comes from
    // mixing the ink toward the surface colour, never from alpha.
    const definition = appearanceDefinition(this.activeAppearance);
    const edgeMaterial = new LineMaterial({
      color: this.mixedLineColor(definition.shellEdge, definition.shell),
      linewidth: 1.25,
      worldUnits: false,
      transparent: false,
      depthWrite: false,
      depthTest: true,
      depthFunc: THREE.LessEqualDepth,
      stencilWrite: true,
      stencilWriteMask: 0,
      stencilFunc: THREE.EqualStencilFunc,
      stencilRef: 0,
    });
    const edges = new LineSegments2(edgeGeometry, edgeMaterial);
    edges.renderOrder = 5;
    edges.visible = this.shellEdgesVisible();
    shellMesh.add(edges);
    shellMesh.userData.gravissEdges = edges;
    // The mesh lines are a layer of their own, so they can be switched off
    // while the surfaces they describe stay on screen. They remain children of
    // the shell mesh, so hiding the shells still takes them with it.
    this.meshes.mesh = edges;
    this.shellState.geometry = shellGeometry;
    this.shellState.edgeGeometry = edgeGeometry;
    this.shellState.edgeBuffer = edgeBuffer;
    this.shellState.zoomIndices = Uint32Array.from(zoomIndices);
    this.shellState.zoomEntityRanges = zoomEntityRanges;
    shellMesh.frustumCulled = false;
    edges.frustumCulled = false;
    this.registerPickable("element", shellMesh, elements, "shells", "shell");
    this.syncShellFilter();
  }

  // The size the model suggests, for a graphic that has never said otherwise.
  defaultSymbolSize() {
    return this.bounds.radius / SYMBOL_SIZE_DIVISOR;
  }

  symbolRadius() {
    return this.symbolSize == null ? this.defaultSymbolSize() : this.symbolSize;
  }

  createNodeGeometry() {
    const THREE = this.THREE;
    // Unit geometry, sized through the instance matrix, so changing the size
    // rewrites matrices rather than rebuilding the mesh.
    const nodeGeometry = new THREE.SphereGeometry(1, 12, 8);
    const nodeMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.5,
    });
    const nodeMesh = new THREE.InstancedMesh(
      nodeGeometry,
      nodeMaterial,
      this.geometry.nodes.length,
    );
    // This is one whole-model instance set, so object-level culling cannot save
    // any useful draw work. Keeping it off lets moved bounds stay lazy.
    nodeMesh.frustumCulled = false;
    nodeMesh.userData.gravissEntityRanges = this.geometry.nodes.map((unused, index) => ({
      start: index,
      count: 1,
    }));
    nodeMesh.userData.gravissInstanceToEntityIndex = new Int32Array(this.geometry.nodes.length);
    this.nodeMesh = nodeMesh;
    this.placeNodeSymbols();
    this.registerInstances("node", nodeMesh, this.geometry.nodes, "nodes", "node");
  }

  // Every symbol is placed from a size rather than built at one, so changing
  // the size is a matrix rewrite and never a rebuild.
  placeNodeSymbols() {
    const mesh = this.nodeMesh;
    if (!mesh) return false;
    const THREE = this.THREE;
    const scratch = (this.nodeSymbolScratch ||= {
      matrix: new THREE.Matrix4(),
      position: new THREE.Vector3(),
      rotation: new THREE.Quaternion(),
      scale: new THREE.Vector3(),
    });
    const { matrix, position, rotation, scale } = scratch;
    const radius = this.symbolRadius();
    scale.set(radius, radius, radius);
    let cursor = 0;
    this.drawnNodes.forEach((node, index) => {
      const range = mesh.userData.gravissEntityRanges[index];
      range.start = cursor;
      range.count = this.keepsNode(node.id) ? 1 : 0;
      if (!range.count) return;
      matrix.compose(position.set(node.x, node.y, node.z), rotation, scale);
      mesh.userData.gravissInstanceToEntityIndex[cursor] = index;
      mesh.setMatrixAt(cursor++, matrix);
    });
    mesh.count = cursor;
    mesh.instanceMatrix.needsUpdate = true;
    invalidateInstanceBounds(mesh);
    return true;
  }

  placeSupportSymbols() {
    const mesh = this.supportMesh;
    if (!mesh) return false;
    const THREE = this.THREE;
    const scratch = (this.supportSymbolScratch ||= {
      matrix: new THREE.Matrix4(),
      position: new THREE.Vector3(),
      scale: new THREE.Vector3(),
    });
    const { matrix, position, scale } = scratch;
    const radius = this.symbolRadius();
    scale.set(radius * SUPPORT_RADIUS, radius * SUPPORT_HEIGHT, radius * SUPPORT_RADIUS);
    const rotation = mesh.userData.gravissSupportRotation;
    // Hung below the node it restrains, by its own size, so the cone touches
    // the node rather than swallowing it at any scale.
    const standoff = -radius * SUPPORT_STANDOFF;
    let cursor = 0;
    this.supportNodes.forEach((node, index) => {
      const range = mesh.userData.gravissEntityRanges[index];
      range.start = cursor;
      range.count = this.keepsNode(node.id) ? 1 : 0;
      if (!range.count) return;
      position.set(node.x, node.y, node.z).addScaledVector(this.worldUp, standoff);
      matrix.compose(position, rotation, scale);
      mesh.userData.gravissInstanceToEntityIndex[cursor] = index;
      mesh.setMatrixAt(cursor++, matrix);
    });
    mesh.count = cursor;
    mesh.instanceMatrix.needsUpdate = true;
    invalidateInstanceBounds(mesh);
    return true;
  }

  // One size, in metres, for everything drawn as a mark rather than as
  // structure. Nothing said is the size the model suggests; zero is a size
  // somebody chose, and it puts every mark away.
  setSymbolSize(size) {
    const [lowest, highest] = SYMBOL_SIZE_RANGE;
    const next =
      size == null || !Number.isFinite(size) ? null : Math.min(highest, Math.max(lowest, size));
    this.symbolSize = next;
    this.placeNodeSymbols();
    this.placeSupportSymbols();
    this.placeConnectorSymbols("spring");
    this.placeConnectorSymbols("coupling");
    this.applyVisibility();
    this.sceneBox = null;
    this.requestRender();
    return this.symbolRadius();
  }

  getSymbolSize() {
    return this.symbolRadius();
  }

  setScaleSpringsByStiffness(enabled) {
    this.scaleSpringsByStiffness = Boolean(enabled);
    this.placeConnectorSymbols("spring");
    this.sceneBox = null;
    this.requestRender();
    return this.scaleSpringsByStiffness;
  }

  isScalingSpringsByStiffness() {
    return this.scaleSpringsByStiffness;
  }

  // A mark of no size is a mark nobody wants drawn, and a zero-scaled instance
  // is a speck of z-fighting rather than nothing.
  symbolsVisible() {
    return this.symbolRadius() > 0;
  }

  createSupportGeometry(nodesById) {
    const THREE = this.THREE;
    const yAxis = new THREE.Vector3(0, 1, 0);
    const supports = this.geometry.supports || [];
    if (supports.length === 0) return;
    const supportGeometry = new THREE.ConeGeometry(1, 1, 4);
    const supportMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.65,
    });
    const supportMesh = new THREE.InstancedMesh(supportGeometry, supportMaterial, supports.length);
    supportMesh.frustumCulled = false;
    supportMesh.userData.gravissEntityRanges = supports.map((unused, index) => ({
      start: index,
      count: 1,
    }));
    supportMesh.userData.gravissInstanceToEntityIndex = new Int32Array(supports.length);
    const supportRotation = new THREE.Quaternion().setFromUnitVectors(yAxis, this.worldUp);
    supportMesh.userData.gravissSupportRotation = supportRotation;
    this.supportMesh = supportMesh;
    this.supportNodes = supports.map((support) =>
      nodesById.get(`${typeof support.nodeId}:${support.nodeId}`),
    );
    this.placeSupportSymbols();
    this.registerInstances("support", supportMesh, supports, "supports", "support");
  }

  // Springs and couplings join two nodes without being structure, so they are
  // drawn as marks rather than as members: coils for translational components,
  // a ring for rotation, and a ticked link for a coupling. Both take their base
  // size from the symbol size; springs may then take a relative stiffness
  // fraction of it. Both are shaped in a buffer allocated once, so changing
  // either setting rewrites vertices rather than building a mesh again.
  createConnectorGeometry(nodesById, kind, visibilityKey) {
    const THREE = this.THREE;
    const elements = this.geometry.elements.filter((element) => element.kind === kind);
    if (elements.length === 0) return;
    const components = elements.map((element) =>
      kind === "spring" ? springComponents(element) : null,
    );
    const segmentCounts = components.map((component) => {
      if (!component) return 1;
      let count = 0;
      if (component.axial) count += SPRING_SEGMENT_BUDGET;
      if (component.transverse) count += SPRING_SEGMENT_BUDGET * 2 + 1;
      if (component.rotational) count += SPRING_RING_SEGMENTS + (component.transverse ? 0 : 1);
      return count;
    });
    let vertexCount = 0;
    const entityRanges = segmentCounts.map((count) => {
      const range = { start: vertexCount, count: count * 2 };
      vertexCount += range.count;
      return range;
    });
    const positions = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 3);
    const geometry = new THREE.BufferGeometry();
    const positionAttribute = new THREE.BufferAttribute(positions, 3);
    positionAttribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("position", positionAttribute);
    const colorAttribute = new THREE.BufferAttribute(colors, 3);
    colorAttribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("color", colorAttribute);
    const lines = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({ vertexColors: true }),
    );
    lines.frustumCulled = false;
    lines.userData.gravissEntityRanges = entityRanges;
    lines.userData.gravissLineSegments = true;
    const group = new THREE.Group();
    group.name = `graviss-${visibilityKey}`;
    this.meshes[visibilityKey] = group;
    this.scene.add(group);
    this.connectors ||= {};
    const maxima = { translational: 0, rotational: 0 };
    for (const component of components) {
      if (!component) continue;
      maxima.translational = Math.max(
        maxima.translational,
        component.axialStiffness || 0,
        component.transverseStiffness || 0,
      );
      maxima.rotational = Math.max(maxima.rotational, component.rotationalStiffness || 0);
    }
    const relativeStiffness = components.map((component) => ({
      axial:
        component?.axialStiffness && maxima.translational > 0
          ? component.axialStiffness / maxima.translational
          : 1,
      transverse:
        component?.transverseStiffness && maxima.translational > 0
          ? component.transverseStiffness / maxima.translational
          : 1,
      rotational:
        component?.rotationalStiffness && maxima.rotational > 0
          ? component.rotationalStiffness / maxima.rotational
          : 1,
    }));
    this.connectors[kind] = {
      lines,
      elements,
      nodes: elements.map((element) =>
        element.nodeIds.map((nodeId) => nodesById.get(`${typeof nodeId}:${nodeId}`)),
      ),
      entityRanges,
      components,
      relativeStiffness,
    };
    this.placeConnectorSymbols(kind);
    this.registerPickable(kind, lines, elements, visibilityKey, kind, group);
  }

  placeConnectorSymbols(kind) {
    const connector = this.connectors?.[kind];
    if (!connector) return false;
    const THREE = this.THREE;
    const { lines, elements, nodes, entityRanges, components, relativeStiffness } = connector;
    const positions = lines.geometry.getAttribute("position");
    const size = this.symbolRadius();
    const scratch = (connector.scratch ||= {
      start: new THREE.Vector3(),
      end: new THREE.Vector3(),
      along: new THREE.Vector3(),
      across: new THREE.Vector3(),
      beside: new THREE.Vector3(),
      center: new THREE.Vector3(),
      componentStart: new THREE.Vector3(),
      componentEnd: new THREE.Vector3(),
      componentAxis: new THREE.Vector3(),
      radial: new THREE.Vector3(),
      binormal: new THREE.Vector3(),
      from: new THREE.Vector3(),
      to: new THREE.Vector3(),
      next: new THREE.Vector3(),
    });
    const {
      start,
      end,
      along,
      across,
      beside,
      center,
      componentStart,
      componentEnd,
      componentAxis,
      radial,
      binormal,
      from,
      to,
      next,
    } = scratch;
    let cursor = 0;
    const segment = (a, b) => {
      positions.setXYZ(cursor, a.x, a.y, a.z);
      positions.setXYZ(cursor + 1, b.x, b.y, b.z);
      cursor += 2;
    };
    const drawHelix = (first, last, radius) => {
      componentAxis.subVectors(last, first);
      const componentLength = componentAxis.length();
      if (!(componentLength > 0)) return;
      componentAxis.divideScalar(componentLength);
      radial.crossVectors(componentAxis, Math.abs(componentAxis.z) < 0.9 ? UNIT_Z : UNIT_X);
      if (radial.lengthSq() === 0) radial.crossVectors(componentAxis, UNIT_Y);
      radial.normalize().multiplyScalar(radius);
      binormal.crossVectors(componentAxis, radial).normalize().multiplyScalar(radius);
      const bodyStart = (componentLength * (1 - SPRING_BODY)) / 2;
      const turns = SPRING_TURNS * SPRING_SEGMENTS;
      const step = (componentLength * SPRING_BODY) / turns;
      from.copy(first);
      to.copy(first).addScaledVector(componentAxis, bodyStart);
      segment(from, to);
      for (let turn = 1; turn <= turns; turn += 1) {
        const angle = (turn / SPRING_SEGMENTS) * Math.PI * 2;
        next
          .copy(first)
          .addScaledVector(componentAxis, bodyStart + step * turn)
          .addScaledVector(radial, Math.cos(angle))
          .addScaledVector(binormal, Math.sin(angle));
        segment(to, next);
        to.copy(next);
      }
      segment(to, last);
    };
    const drawRing = (origin, radius) => {
      to.copy(origin).addScaledVector(across, radius);
      for (let step = 1; step <= SPRING_RING_SEGMENTS; step += 1) {
        const angle = (step / SPRING_RING_SEGMENTS) * Math.PI * 2;
        next
          .copy(origin)
          .addScaledVector(across, Math.cos(angle) * radius)
          .addScaledVector(beside, Math.sin(angle) * radius);
        segment(to, next);
        to.copy(next);
      }
    };
    for (let elementIndex = 0; elementIndex < elements.length; elementIndex += 1) {
      const element = elements[elementIndex];
      const elementNodes = nodes[elementIndex];
      start.set(elementNodes[0].x, elementNodes[0].y, elementNodes[0].z);
      // A connector narrowed away collapses onto its own node, the same answer
      // a connector of no length already gets: a line with both ends in one
      // place draws nothing and cannot be hit. Its segments stay where they
      // were, so the ranges that index it need not move.
      if (!this.keepsElement(element)) {
        for (let index = 0; index < entityRanges[elementIndex].count / 2; index += 1) {
          segment(start, start);
        }
        continue;
      }
      // A grounded spring has one node and says which way it acts; a connector
      // between two nodes spans them.
      if (elementNodes.length > 1 && elementNodes[1]) {
        end.set(elementNodes[1].x, elementNodes[1].y, elementNodes[1].z);
      } else {
        along.fromArray(element.direction || [0, 0, 1]);
        if (along.lengthSq() === 0) along.set(0, 0, 1);
        end.copy(start).addScaledVector(along.normalize(), size * SPRING_TURNS * 2);
      }
      along.subVectors(end, start);
      const length = along.length();
      if (length === 0) {
        for (let index = 0; index < entityRanges[elementIndex].count / 2; index += 1) {
          segment(start, start);
        }
        continue;
      }
      along.divideScalar(length);
      // Two directions square to the axis and to each other, so a helix can
      // turn about it and a ring can lie across it. Any pair will do — a coil
      // has no roll of its own — and the steadiest is built from whichever
      // world axis the spring is least aligned with.
      across.crossVectors(along, Math.abs(along.z) < 0.9 ? UNIT_Z : UNIT_X);
      if (across.lengthSq() === 0) across.crossVectors(along, UNIT_Y);
      across.normalize();
      beside.crossVectors(along, across).normalize();

      if (kind !== "spring") {
        // A coupling is a rigid link, and a line between the nodes is the whole
        // of what it is.
        segment(start, end);
        continue;
      }
      const component = components[elementIndex];
      const relative = relativeStiffness[elementIndex];
      const componentSize = (name) => size * (this.scaleSpringsByStiffness ? relative[name] : 1);
      let axisDrawn = false;
      if (component.axial) drawHelix(start, end, componentSize("axial"));
      center.copy(start).addScaledVector(along, length / 2);
      if (component.transverse) {
        // CQ acts in the whole plane square to the principal spring axis. Two
        // perpendicular helices show the two identical translational springs
        // that plane represents; the straight axis keeps their connection to
        // the element's own pair of nodes explicit.
        segment(start, end);
        axisDrawn = true;
        const transverseSize = componentSize("transverse");
        const transverseLength = Math.min(length * 0.75, transverseSize * SPRING_TURNS * 2);
        componentStart.copy(center).addScaledVector(across, -transverseLength / 2);
        componentEnd.copy(center).addScaledVector(across, transverseLength / 2);
        drawHelix(componentStart, componentEnd, transverseSize);
        componentStart.copy(center).addScaledVector(beside, -transverseLength / 2);
        componentEnd.copy(center).addScaledVector(beside, transverseLength / 2);
        drawHelix(componentStart, componentEnd, transverseSize);
      }
      if (component.rotational) {
        if (!axisDrawn) segment(start, end);
        drawRing(center, componentSize("rotational"));
      }
      const range = entityRanges[elementIndex];
      const rangeEnd = range.start + range.count;
      while (cursor < rangeEnd) segment(end, end);
    }
    positions.needsUpdate = true;
    // Picking and visible-model measurement compute these on demand. Eagerly
    // rebuilding both here charged every animation frame for questions nobody
    // was asking, and culling a single whole-model line object saved nothing.
    lines.geometry.boundingBox = null;
    lines.geometry.boundingSphere = null;
    return true;
  }

  createLocalAxesGeometry(nodesById, elements) {
    const THREE = this.THREE;
    const axisLength = Math.max(0.1, this.bounds.radius * 0.025);
    const axisElements = elements.filter((element) => element.localAxes);
    if (!axisElements.length) return;
    const positions = new Float32Array(axisElements.length * 18);
    const colors = new Float32Array(positions.length);
    const axisColors = [
      new THREE.Color(0xe74c3c),
      new THREE.Color(0x2ecc71),
      new THREE.Color(0x3498db),
    ];
    const direction = new THREE.Vector3();
    const prepared = axisElements.map((element, index) => {
      const directions = new Float64Array(9);
      for (const [axisIndex, name] of AXIS_NAMES.entries()) {
        direction.fromArray(element.localAxes[name]).normalize();
        direction.toArray(directions, axisIndex * 3);
        const color = axisColors[axisIndex];
        color.toArray(colors, index * 18 + axisIndex * 6);
        color.toArray(colors, index * 18 + axisIndex * 6 + 3);
      }
      return {
        element,
        nodes: element.nodeIds.map((id) => nodesById.get(stableIdKey(id))),
        offset: meanOffset(element),
        directions,
      };
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage),
    );
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    // Local axes are geometry sitting at the element centres, so they are depth
    // tested like everything else: an opaque section in front of one hides it.
    // Drawing them without a depth test put every element's frame on top of the
    // model at once, which reads as though the sections were transparent.
    const material = new THREE.LineBasicMaterial({ vertexColors: true });
    const lines = new THREE.LineSegments(geometry, material);
    // The early line tier: every later opaque fill covers the axes it stands in
    // front of, while an exposed part remains visible.
    lines.renderOrder = 1;
    lines.visible = this.visibility.localAxes;
    lines.userData.gravissAxisLength = axisLength;
    lines.userData.gravissAxes = prepared;
    this.localAxes = lines;
    this.meshes.localAxes = lines;
    this.scene.add(lines);
    this.writeLocalAxesPositions();
  }

  writeLocalAxesPositions() {
    const lines = this.localAxes;
    if (!lines) return;
    const attribute = lines.geometry.getAttribute("position");
    const positions = attribute.array;
    const length = lines.userData.gravissAxisLength;
    let at = 0;
    for (const { element, nodes, offset, directions } of lines.userData.gravissAxes) {
      if (!this.keepsElement(element)) continue;
      let x = 0;
      let y = 0;
      let z = 0;
      for (const node of nodes) {
        x += node.x;
        y += node.y;
        z += node.z;
      }
      x /= nodes.length;
      y /= nodes.length;
      z /= nodes.length;
      if (this.sectionRendering && offset && nodes.length >= 3) {
        const ax = nodes[1].x - nodes[0].x;
        const ay = nodes[1].y - nodes[0].y;
        const az = nodes[1].z - nodes[0].z;
        const bx = nodes[2].x - nodes[0].x;
        const by = nodes[2].y - nodes[0].y;
        const bz = nodes[2].z - nodes[0].z;
        const nx = ay * bz - az * by;
        const ny = az * bx - ax * bz;
        const nz = ax * by - ay * bx;
        const magnitude = Math.hypot(nx, ny, nz);
        if (magnitude > 1e-9) {
          x += (nx / magnitude) * offset;
          y += (ny / magnitude) * offset;
          z += (nz / magnitude) * offset;
        }
      }
      for (let axis = 0; axis < 3; axis += 1) {
        positions[at] = x;
        positions[at + 1] = y;
        positions[at + 2] = z;
        positions[at + 3] = x + directions[axis * 3] * length;
        positions[at + 4] = y + directions[axis * 3 + 1] * length;
        positions[at + 5] = z + directions[axis * 3 + 2] * length;
        at += 6;
      }
    }
    attribute.needsUpdate = true;
    lines.geometry.setDrawRange(0, at / 3);
    lines.geometry.boundingBox ||= new this.THREE.Box3();
    lines.geometry.boundingBox.setFromArray(positions.subarray(0, at));
    lines.geometry.boundingSphere = null;
  }

  // Where the element is drawn, which for an offset area element under
  // section rendering is not the middle of its nodes: a triad left on the
  // plane the element was meshed at would float off the body it belongs to.
  // Without sections the drawn element is the analysis surface on its nodes,
  // and the triad stays there with it.
  elementCenter(element, nodesById = this.nodesById, target = new this.THREE.Vector3()) {
    target.set(0, 0, 0);
    for (const nodeId of element.nodeIds) {
      const node = nodesById.get(`${typeof nodeId}:${nodeId}`);
      target.x += node.x;
      target.y += node.y;
      target.z += node.z;
    }
    target.multiplyScalar(1 / element.nodeIds.length);
    const offset = this.sectionRendering ? meanOffset(element) : 0;
    if (offset && element.nodeIds.length >= 3) {
      const normal = this.elementNormal(element, nodesById);
      if (normal) target.addScaledVector(normal, offset);
    }
    return target;
  }

  // The right-handed normal of an area element's node order — the direction an
  // offset and a thickness are both measured along — or null when its nodes are
  // collinear and it has none.
  elementNormal(element, nodesById = this.nodesById, target = new this.THREE.Vector3()) {
    const THREE = this.THREE;
    const corners = element.nodeIds
      .slice(0, 3)
      .map((nodeId) => nodesById.get(`${typeof nodeId}:${nodeId}`));
    if (corners.length < 3 || corners.some((corner) => !corner)) return null;
    const [origin, next, last] = corners;
    const edge = new THREE.Vector3(next.x - origin.x, next.y - origin.y, next.z - origin.z);
    const other = new THREE.Vector3(last.x - origin.x, last.y - origin.y, last.z - origin.z);
    target.crossVectors(edge, other);
    return target.lengthSq() > 0 ? target.normalize() : null;
  }

  registerInstances(type, mesh, entities, visibilityKey, colorKey) {
    this.registerPickable(type, mesh, entities, visibilityKey, colorKey);
  }

  registerPickable(type, mesh, entities, visibilityKey, colorKey, parent = null) {
    mesh.userData.gravissType = type;
    mesh.userData.gravissEntities = entities;
    mesh.userData.visibilityKey = visibilityKey;
    mesh.userData.gravissColorKey = colorKey;
    this.meshes[visibilityKey] ||= mesh;
    this.pickables.push(mesh);
    (parent || this.scene).add(mesh);
  }

  // A flat colour, or a sky the view sits inside. The grade belongs to the
  // world and not to the screen: the light comes from the model's own up axis,
  // so turning the camera under the structure puts the bright side below, which
  // is where it would be. A backdrop painted across the viewport would instead
  // keep the ceiling at the top of the screen however the model was turned.
  //
  // The clear colour stays flat either way — it is what shows where the sky
  // does not reach — and so does scene.background, which is behind it.
  applyBackground(appearance) {
    const THREE = this.THREE;
    this.disposeSky();
    this.canvasRenderer.setClearColor(appearance.background, 1);
    this.scene.background = new THREE.Color(appearance.background);
    if (!this.backgroundGradient) return false;
    const base = new THREE.Color(appearance.background);
    const lifted = base.clone().lerp(new THREE.Color(SKY_TINT), BACKGROUND_GRADIENT_LIFT);
    const dropped = base.clone().lerp(new THREE.Color(GROUND_TINT), BACKGROUND_GRADIENT_DROP);
    const geometry = new THREE.SphereGeometry(1, ...SKY_SEGMENTS);
    const position = geometry.getAttribute("position");
    const colors = new Float32Array(position.count * 3);
    const direction = new THREE.Vector3();
    const color = new THREE.Color();
    for (let index = 0; index < position.count; index += 1) {
      direction.fromBufferAttribute(position, index).normalize();
      // Measured against the model's declared up axis rather than the world's,
      // so a Z-down model grades the way it stands. The horizon is the colour
      // the appearance chose, and each half grades away from it: one sphere
      // carrying both, since two would only overlap.
      const height = direction.dot(this.worldUp);
      color
        .copy(base)
        .lerp(height >= 0 ? lifted : dropped, Math.abs(height))
        .toArray(colors, index * 3);
    }
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    // Seen from the inside, never written to depth, and drawn before anything
    // else, so it is behind the model without ever being in front of it.
    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    const sky = new THREE.Mesh(geometry, material);
    sky.name = "graviss-sky";
    sky.renderOrder = -1;
    sky.frustumCulled = false;
    this.sky = sky;
    this.scene.add(sky);
    this.placeSky();
    return true;
  }

  // Centred on the camera and sized to sit inside whatever it can see, so it is
  // a sky rather than an object the camera can leave behind or fly through.
  placeSky() {
    if (!this.sky || !this.camera) return false;
    this.sky.position.copy(this.camera.position);
    this.sky.scale.setScalar(Math.max(this.camera.near * 2, this.camera.far * 0.5));
    return true;
  }

  disposeSky() {
    if (!this.sky) return false;
    this.scene.remove(this.sky);
    this.sky.geometry.dispose();
    this.sky.material.dispose();
    this.sky = null;
    return true;
  }

  setBackgroundGradient(enabled) {
    const next = Boolean(enabled);
    if (next === this.backgroundGradient) return this.backgroundGradient;
    this.backgroundGradient = next;
    this.applyTheme();
    this.requestRender();
    return this.backgroundGradient;
  }

  isBackgroundGradient() {
    return this.backgroundGradient;
  }

  // Every colour the canvas draws with is a custom property, so a theme or a
  // stylesheet of your own can move one without this package shipping a new
  // scheme — and so that colouring by material, by type or by group has
  // somewhere to hang when it comes. What the scheme declares in JavaScript is
  // the fallback, for a canvas rendered before its stylesheet is attached.
  //
  // Read declared values once, then resolve their CSS color expressions in the
  // host before passing them to Three's sRGB parser.
  resolveAppearance(appearance) {
    const styles = getComputedStyle(this.host);
    const resolved = { ...appearance };
    for (const [key, value] of Object.entries(appearance)) {
      if (typeof value !== "number") continue;
      const declared = styles.getPropertyValue(`--graviss-${dashedName(key)}`).trim();
      if (!declared) continue;
      try {
        const fallback = `#${value.toString(16).padStart(6, "0")}`;
        resolved[key] = new this.THREE.Color()
          .setStyle(resolveThemeColor(this.host, declared, fallback))
          .getHex();
      } catch {
        // A property that is not a colour is one to leave to the fallback.
      }
    }
    return resolved;
  }

  applyTheme() {
    if (this.destroyed) return;
    const connectedRefresh = this.host.isConnected && this.appearanceNeedsConnectedRefresh;
    this.appearanceNeedsConnectedRefresh = !this.host.isConnected;
    const themeColor = this.colorFromTheme("--base-background-color", "#101b24");
    const automaticAppearance =
      themeColor.r + themeColor.g + themeColor.b < 0.9 ? "midnight" : "cloud";
    this.activeAppearance = this.appearance === "auto" ? automaticAppearance : this.appearance;
    // Before the colours are read, not after: they are custom properties keyed
    // on this attribute, so reading them first would read the scheme being
    // left rather than the one being taken up.
    this.host.closest(".graviss")?.setAttribute("data-appearance", this.activeAppearance);
    const appearance = this.resolveAppearance(appearanceDefinition(this.activeAppearance));
    const signature = JSON.stringify([this.activeAppearance, this.backgroundGradient, appearance]);
    if (!connectedRefresh && signature === this.appearanceSignature) return false;
    this.appearanceSignature = signature;
    this.applyBackground(appearance);
    this.applyGridAppearance(appearance);
    this.colors = {
      element: new this.THREE.Color(appearance.member),
      truss: new this.THREE.Color(appearance.truss),
      cable: new this.THREE.Color(appearance.cable),
      ineffective: new this.THREE.Color(appearance.ineffective),
      shell: new this.THREE.Color(appearance.shell),
      node: new this.THREE.Color(appearance.node),
      support: new this.THREE.Color(appearance.support),
      spring: new this.THREE.Color(appearance.spring),
      coupling: new this.THREE.Color(appearance.coupling),
      selected: new this.THREE.Color(appearance.selected),
    };
    const shellEdges = this.meshes.shells?.userData.gravissEdges;
    if (shellEdges) {
      shellEdges.material.color.setHex(this.mixedLineColor(appearance.shellEdge, appearance.shell));
    }
    for (const contours of this.memberContours) {
      contours.material.color.setHex(this.mixedLineColor(appearance.shellEdge, appearance.member));
    }
    this.refreshInstanceColors();
    this.viewCube?.setScheme(this.activeAppearance, appearance);
    this.requestRender();
    return true;
  }

  // What used to be alpha. Mesh lines are softened by mixing their ink toward
  // the surface they mostly lie on, which reads the same as the old 0.62
  // opacity there — and keeps the line opaque, so it renders in the opaque
  // pass where draw order and its depth can decide what covers it.
  mixedLineColor(edgeHex, surfaceHex) {
    return new this.THREE.Color(edgeHex).lerp(new this.THREE.Color(surfaceHex), 0.38).getHex();
  }

  applyGridAppearance(appearance) {
    const colors = this.grid.geometry.getAttribute("color");
    const positions = this.grid.geometry.getAttribute("position");
    const gridColor = new this.THREE.Color(appearance.grid);
    const centerColor = new this.THREE.Color(appearance.gridCenter);
    const tolerance = this.grid.userData.gravissGridSize * 1e-9;
    for (let vertex = 0; vertex < positions.count; vertex += 4) {
      const color = Math.abs(positions.getZ(vertex)) <= tolerance ? centerColor : gridColor;
      for (let offset = 0; offset < 4; offset += 1) {
        color.toArray(colors.array, (vertex + offset) * 3);
      }
    }
    colors.needsUpdate = true;
    const materials = Array.isArray(this.grid.material) ? this.grid.material : [this.grid.material];
    for (const material of materials) material.color.setHex(0xffffff);
  }

  // The one display distinction the model makes: with section rendering on a
  // line element carries its extruded cross-section and a thick area element
  // is a closed solid; with it off a line element is a line and an area
  // element its reference surface. Members are rebuilt because their geometry
  // changes; shells are rebuilt for their thickness layers.
  setSectionRendering(enabled) {
    const next = Boolean(enabled);
    if (next === this.sectionRendering) return this.sectionRendering;
    this.sectionRendering = next;
    this.rebuildMemberMeshes();
    this.applyShellDetail();
    // The triads sit on whatever surface is drawn, and switching modes moves
    // an offset element between its body and its node plane.
    this.rebuildLocalAxes();
    this.refreshInstanceColors();
    this.sceneBox = null;
    this.requestRender();
    return this.sectionRendering;
  }

  rebuildLocalAxes() {
    const lines = this.localAxes;
    if (!lines) return;
    // Rebuilding means disposing a geometry and building another, which is far
    // too much to do every frame for something nobody is looking at - and this
    // is off by default. It is remembered as owed instead, and paid when the
    // triads are asked for.
    if (this.visibility.localAxes === false) {
      this.localAxesStale = true;
      return;
    }
    this.localAxesStale = false;
    this.writeLocalAxesPositions();
  }

  isSectionRendering() {
    return this.sectionRendering;
  }

  rebuildMemberMeshes() {
    const group = this.meshes.members;
    if (!group) return;
    // A selection names the object it was picked from, and that object is about
    // to be disposed. Nothing else clears it, so a stale one would have the
    // highlight written into dead geometry and would survive being hidden.
    if (this.selected && this.selected.object?.userData.visibilityKey === "members") {
      this.setSelected(null);
    }
    for (const child of [...group.children]) {
      child.geometry?.dispose();
      child.material?.dispose?.();
      group.remove(child);
    }
    this.pickables = this.pickables.filter((mesh) => mesh.userData.visibilityKey !== "members");
    this.scene.remove(group);
    delete this.meshes.members;
    const members = this.geometry.elements.filter(({ kind }) => LINE_ELEMENT_KINDS.has(kind));
    this.createMemberGeometry(this.nodesById, members);
    if (this.meshes.members) this.meshes.members.visible = this.visibility.members !== false;
    // A freshly baked fill carries a colour attribute of zeros, and the
    // material draws by vertex colour - so a rebuild that did not repaint what
    // it built would render every member black.
    if (this.elementFilter || this.activeElementIds) {
      this.applyElementFilter({ compactStatic: true });
    } else {
      this.refreshInstanceColors((mesh) => mesh.userData.visibilityKey === "members");
    }
  }

  // An area element has no cross-section to extrude, so its levels are the
  // surface it encloses and, at full detail, the thickness it was given.
  applyShellDetail() {
    const mesh = this.meshes.shells;
    if (!mesh) return;
    if (
      this.selected &&
      (this.selected.object === mesh || mesh.getObjectById?.(this.selected.object.id))
    ) {
      this.setSelected(null);
    }
    const elements = mesh.userData.gravissEntities;
    this.shellGpu?.dispose();
    this.shellGpu = null;
    mesh.userData.gravissZoomProxy?.geometry.dispose();
    mesh.userData.gravissZoomProxy?.material.dispose();
    mesh.geometry.dispose();
    mesh.material.dispose();
    mesh.userData.gravissEdges?.geometry.dispose();
    mesh.userData.gravissEdges?.material.dispose();
    this.scene.remove(mesh);
    this.pickables = this.pickables.filter((pickable) => pickable !== mesh);
    delete this.meshes.shells;
    this.createShellGeometry(this.nodesById, elements);
    const rebuilt = this.meshes.shells;
    if (!rebuilt) return;
    // An area element is always drawn as its area; section rendering decides
    // whether a declared thickness closes it into a solid.
    rebuilt.visible = this.visibility.shells !== false;
    this.updateShellSurface();
  }

  setAppearance(name) {
    if (name !== "auto" && !APPEARANCE_IDS.includes(name)) return this.appearance;
    this.appearance = name;
    this.applyTheme();
    return this.appearance;
  }

  setOrbitPivot(enabled) {
    this.orbitPivotEnabled = Boolean(enabled);
    if (!this.orbitPivotEnabled) this.releaseOrbitPivot();
    return this.orbitPivotEnabled;
  }

  setOrbitPivotMarker(visible) {
    this.orbitPivotMarkerVisible = Boolean(visible);
    this.paintOrbitPivot();
    return this.orbitPivotMarkerVisible;
  }

  setZoomTowardPointer(enabled) {
    this.zoomTowardPointer = Boolean(enabled);
    if (this.controls) this.controls.zoomToCursor = this.zoomTowardPointer;
    return this.zoomTowardPointer;
  }

  setSmoothZoom(enabled) {
    this.smoothZoom = Boolean(enabled);
    // Whatever is in flight lands where it was headed rather than stopping
    // wherever the setting happened to change.
    if (!this.smoothZoom && this.zoomFlight) {
      const flight = this.zoomFlight;
      this.cancelZoomFlight();
      flight.apply(flight, flight.goal);
    }
    return this.smoothZoom;
  }

  installEvents() {
    const canvas = this.canvasRenderer.domElement;
    this.onContextLost = () => {
      if (this.destroyed) return;
      this.webglContextLost = true;
      if (this.renderFrame != null) cancelAnimationFrame(this.renderFrame);
      this.renderFrame = null;
      this.frameRateMeter.reset();
      this.shellGpu?.dispose();
      this.shellGpu = null;
      if (this.shellState) this.shellState.gpuUnavailable = null;
    };
    this.onContextRestored = () => {
      if (this.destroyed) return;
      this.webglContextLost = false;
      if (this.shellState) this.shellState.gpuUnavailable = null;
      this.updateShellSurface();
      this.resize();
      this.requestRender();
    };
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);
    this.onPointerDown = (event) => {
      // A drag takes over from a zoom still settling, rather than orbiting or
      // framing against a view that has not come to rest.
      this.cancelZoomFlight();
      this.flushScheduledCameraChange();
      this.pointerDown = { x: event.clientX, y: event.clientY };
      // Pinned after the flush, which can settle a pending view and rebuild the
      // controls, and before the controls have moved anything: the point read
      // is the one that was under the pointer when it went down.
      this.armOrbitPivot(event);
    };
    // Clicking does not select an element. The picking path stays for the
    // callers that resolve entities deliberately; a click on the canvas is
    // reserved for camera gestures until a real selection feature owns it.
    this.onPointerUp = () => {
      this.pointerDown = null;
      this.releaseOrbitPivot();
    };
    this.onWheel = (event) => {
      // A wheel carrying a command modifier is not a camera gesture, whichever
      // of the two means "region" on this platform. The view claims those it
      // recognises before this runs; what reaches here is the rest, and a
      // trackpad pinch on macOS is among them.
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      this.scheduleCameraChange();
      if (!this.zoomOnWheel(event)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    // On the host rather than the canvas, because the controls listen on the
    // canvas itself and a listener there would race theirs by registration
    // order — which flips every time the controls are rebuilt. An ancestor's
    // capture phase runs before either of them, every time.
    this.host.addEventListener("wheel", this.onWheel, { capture: true, passive: false });
  }

  observeSize() {
    this.viewportVisibility = new ViewportVisibility(this.host, {
      onDidChange: (visible) => this.setViewportVisible(visible),
      onResize: () => this.resize(),
    });
    this.setViewportVisible(this.viewportVisibility.visible);
    this.resize();
  }

  setViewportVisible(visible) {
    if (this.destroyed || this.viewportVisible === visible) return;
    this.viewportVisible = visible;
    if (!visible) {
      if (this.renderFrame != null) cancelAnimationFrame(this.renderFrame);
      this.renderFrame = null;
      this.frameRateMeter.reset();
    } else if (this.canvasRenderer) {
      this.resize();
      this.requestRender();
    }
  }

  isViewportDrawable() {
    return (
      this.viewportVisible &&
      !this.webglContextLost &&
      this.host.isConnected &&
      this.host.clientWidth > 0 &&
      this.host.clientHeight > 0 &&
      !this.host.ownerDocument?.hidden
    );
  }

  resize() {
    if (
      this.destroyed ||
      !this.host.isConnected ||
      this.host.clientWidth <= 0 ||
      this.host.clientHeight <= 0 ||
      this.host.ownerDocument?.hidden
    )
      return;
    const width = Math.max(1, this.host.clientWidth || 800);
    const height = Math.max(1, this.host.clientHeight || 600);
    const aspect = width / height;
    // Resizing the pane reveals and crops; it never rescales what is framed.
    // Width always worked that way, because the horizontal angle follows the
    // aspect — but the vertical angle and the orthographic height were fixed,
    // so changing the pane's height squeezed the same world span into
    // different pixels and the structure being looked at swam. Both now
    // follow the height, holding the world a pixel covers: the framed region
    // stays exactly where it was, and a taller pane shows more above and
    // below it. Only measured heights count — the first layout is a
    // baseline, not a resize.
    const measured = this.host.clientHeight > 0 ? height : null;
    if (this.viewportHeight && measured && measured !== this.viewportHeight) {
      const grown = measured / this.viewportHeight;
      this.orthographicHeight = (this.orthographicHeight || this.bounds.radius * 2.6) * grown;
      const halfTangent = Math.tan((this.perspectiveCamera.fov * Math.PI) / 360) * grown;
      const fov = (Math.atan(halfTangent) * 360) / Math.PI;
      this.perspectiveCamera.fov = Math.min(130, Math.max(2, fov));
    }
    if (measured) this.viewportHeight = measured;
    this.viewportWidth = width;
    this.canvasRenderer.setSize(width, height, false);
    this.perspectiveCamera.aspect = aspect;
    this.perspectiveCamera.updateProjectionMatrix();
    this.updateOrthographicFrustum(aspect);
    this.paintOrbitPivot();
    // Painted now, not next frame: setSize just cleared the buffer, and the
    // ResizeObserver fires before paint, so a synchronous render is what
    // keeps the cleared canvas from ever reaching the screen.
    if (!this.renderSuspended) this.paintFrame();
  }

  // What the viewport currently covers, in world units, on the plane through
  // the camera target. The screen states one of these two numbers and derives
  // the other from its own shape, which is why a print has to carry both.
  visibleExtentAtTarget() {
    const distance = this.camera.position.distanceTo(this.controls.target);
    const width = Math.max(1, this.host.clientWidth || 800);
    const height = Math.max(1, this.host.clientHeight || 600);
    const visibleHeight = this.camera.isPerspectiveCamera
      ? perspectiveVisibleHeight(distance, this.camera.fov, this.camera.zoom)
      : (this.orthographicCamera.top - this.orthographicCamera.bottom) /
        this.orthographicCamera.zoom;
    if (!(visibleHeight > 0)) return null;
    return { width: (visibleHeight * width) / height, height: visibleHeight };
  }

  // The model's bounding box measured on that same plane, symmetric about the
  // camera axis so it contains the model without moving the camera. A corner
  // nearer than the target needs more room at the target plane than its own
  // offset, because a perspective frustum widens with depth.
  // The frustum an image with no region needs: the drawn model measured about
  // its own centre, which is the point the render will aim at. Measuring about
  // the camera's current axis instead and then aiming at the centre would frame
  // it with the two disagreeing, which shows up as lopsided margins.
  // The frustum an image with no region needs: the drawn model measured on the
  // plane it will be framed at.
  //
  // Under perspective a near corner projects further out than a far one at the
  // same world offset, so the projection is not symmetric about the model's
  // centre and a symmetric frame around that centre leaves lopsided margins.
  // The extents are therefore measured signed, and the centre moves to the
  // middle of what was measured. Moving it changes the measurement slightly, so
  // it settles over a few passes.
  projectedModelExtent() {
    const THREE = this.THREE;
    const bounds = this.visibleModelBounds();
    const min = bounds.min.toArray();
    const max = bounds.max.toArray();
    const forward = new THREE.Vector3().subVectors(this.controls.target, this.camera.position);
    const distance = forward.length();
    if (!(distance > 0)) return null;
    forward.divideScalar(distance);
    const right = new THREE.Vector3().crossVectors(forward, this.camera.up);
    if (right.lengthSq() === 0) right.crossVectors(forward, this.modelYAxis);
    if (right.lengthSq() === 0) return null;
    right.normalize();
    const up = new THREE.Vector3().crossVectors(right, forward).normalize();
    const perspective = Boolean(this.camera.isPerspectiveCamera);
    const center = bounds.getCenter(new THREE.Vector3());
    const eye = new THREE.Vector3();
    const corner = new THREE.Vector3();
    let width = 0;
    let height = 0;

    for (let pass = 0; pass < PROJECTED_EXTENT_PASSES; pass += 1) {
      eye.copy(center).addScaledVector(forward, -distance);
      let leftMost = Infinity;
      let rightMost = -Infinity;
      let topMost = Infinity;
      let bottomMost = -Infinity;
      for (const x of [min[0], max[0]]) {
        for (const y of [min[1], max[1]]) {
          for (const z of [min[2], max[2]]) {
            corner.set(x, y, z).sub(eye);
            const depth = corner.dot(forward);
            // A corner behind the camera cannot be framed at all; the rest still
            // describe everything the image can reach.
            if (perspective && depth <= this.camera.near) continue;
            const scale = perspective ? distance / depth : 1;
            const across = corner.dot(right) * scale;
            const along = corner.dot(up) * scale;
            leftMost = Math.min(leftMost, across);
            rightMost = Math.max(rightMost, across);
            topMost = Math.min(topMost, along);
            bottomMost = Math.max(bottomMost, along);
          }
        }
      }
      if (!(rightMost > leftMost) || !(bottomMost > topMost)) return null;
      width = rightMost - leftMost;
      height = bottomMost - topMost;
      center
        .addScaledVector(right, (leftMost + rightMost) / 2)
        .addScaledVector(up, (topMost + bottomMost) / 2);
    }

    return { center: center.toArray(), width, height };
  }

  // Dragging a rectangle over the canvas states the print region directly. A
  // region is centred on the camera axis, so the camera pans to whatever was
  // drawn rather than the region carrying an offset the document would have to
  // hold and every consumer would have to honour.
  beginRegionSelection(onComplete) {
    if (this.destroyed || this.regionSelection) return false;
    const canvas = this.canvasRenderer.domElement;
    const marquee = this.host.parentElement?.querySelector(".graviss-region-marquee");
    if (!marquee) return false;
    const canvasPoint = (event) => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const selection = { marquee, onComplete, origin: null };

    selection.onPointerDown = (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      selection.origin = canvasPoint(event);
      canvas.setPointerCapture?.(event.pointerId);
      this.paintRegionMarquee(marquee, selection.origin, selection.origin);
    };
    selection.onPointerMove = (event) => {
      if (!selection.origin) return;
      this.paintRegionMarquee(marquee, selection.origin, canvasPoint(event));
    };
    selection.onPointerUp = (event) => {
      if (!selection.origin) return;
      const origin = selection.origin;
      selection.origin = null;
      this.endRegionSelection(this.regionForScreenRect(origin, canvasPoint(event)));
    };
    selection.onKeyDown = (event) => {
      if (event.key === "Escape") this.endRegionSelection(null);
    };

    this.regionSelection = selection;
    this.controls.enabled = false;
    canvas.classList.add("is-selecting-region");
    canvas.addEventListener("pointerdown", selection.onPointerDown, true);
    canvas.addEventListener("pointermove", selection.onPointerMove, true);
    canvas.addEventListener("pointerup", selection.onPointerUp, true);
    window.addEventListener("keydown", selection.onKeyDown, true);
    return true;
  }

  endRegionSelection(region = null) {
    const selection = this.regionSelection;
    if (!selection) return null;
    this.regionSelection = null;
    const canvas = this.canvasRenderer.domElement;
    canvas.removeEventListener("pointerdown", selection.onPointerDown, true);
    canvas.removeEventListener("pointermove", selection.onPointerMove, true);
    canvas.removeEventListener("pointerup", selection.onPointerUp, true);
    window.removeEventListener("keydown", selection.onKeyDown, true);
    canvas.classList.remove("is-selecting-region");
    selection.marquee.hidden = true;
    this.controls.enabled = true;
    selection.onComplete?.(region);
    return region;
  }

  paintRegionMarquee(marquee, from, to) {
    marquee.hidden = false;
    marquee.style.left = `${Math.min(from.x, to.x)}px`;
    marquee.style.top = `${Math.min(from.y, to.y)}px`;
    marquee.style.width = `${Math.abs(to.x - from.x)}px`;
    marquee.style.height = `${Math.abs(to.y - from.y)}px`;
  }

  // Where a world point lands on the canvas, in canvas pixels.
  projectToScreen(worldPoint) {
    const width = Math.max(1, this.host.clientWidth || 800);
    const height = Math.max(1, this.host.clientHeight || 600);
    const projected = new this.THREE.Vector3(...worldPoint).project(this.camera);
    if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y)) return null;
    return { x: ((projected.x + 1) / 2) * width, y: ((1 - projected.y) / 2) * height };
  }

  // The rectangle the structure occupies on screen, in fractions of the
  // viewport. Measured from the drawn model, never from the reference grid,
  // which spreads well beyond it.
  // The world box the drawn model actually occupies, which is not the box its
  // nodes occupy: a rendered section stands off its own centre line by half its
  // depth, and a thick area element by half its thickness. Only what is on
  // screen counts, so hiding a kind of element also frees the room it took.
  visibleModelBounds() {
    this.ensureCpuShellGeometry();
    const THREE = this.THREE;
    const box = new THREE.Box3();
    for (const key of ["members", "shells", "nodes", "supports", "localAxes", "memberDiagram"]) {
      const object = this.meshes[key];
      if (object && this.isObjectVisible(object)) {
        if (key === "memberDiagram") box.union(this.memberDiagram.bounds(this.camera));
        else if (key === "shells") {
          object.updateWorldMatrix(true, false);
          box.union(this.shellVisibleBounds().clone().applyMatrix4(object.matrixWorld));
        } else box.expandByObject(object);
      }
    }
    if (box.isEmpty()) {
      box.set(new THREE.Vector3(...this.bounds.min), new THREE.Vector3(...this.bounds.max));
    }
    return box;
  }

  // Every point of the drawn model that a screen rectangle has to hold. An
  // instanced mesh contributes the corners of one geometry per instance, and
  // anything else its own vertices, so the rectangle follows the silhouette
  // rather than a box drawn round it. A box's corners stick out where no
  // geometry reaches, which is what left one margin narrower than the rest.
  forEachModelScreenPoint(visit) {
    this.ensureCpuShellGeometry();
    this.updateMemberDiagramLabels();
    const THREE = this.THREE;
    const point = new THREE.Vector3();
    const instance = new THREE.Matrix4();
    let budget = MODEL_SILHOUETTE_POINT_BUDGET;

    const project = (x, y, z, matrix) => {
      point.set(x, y, z).applyMatrix4(matrix).applyMatrix4(this.camera.matrixWorldInverse);
      // Behind the camera the perspective divide flips, so the point is dropped
      // rather than folded back into the rectangle inverted.
      if (-point.z <= this.camera.near) return;
      point.applyMatrix4(this.camera.projectionMatrix);
      visit(point.x, point.y);
    };

    for (const key of ["members", "shells", "nodes", "supports", "localAxes", "memberDiagram"]) {
      const root = this.meshes[key];
      if (!root || !this.isObjectVisible(root)) continue;
      root.updateWorldMatrix(true, true);
      if (key === "memberDiagram") {
        this.memberDiagram.forEachLabelCorner(this.camera, (corner) => {
          if ((budget -= 1) > 0) project(corner.x, corner.y, corner.z, root.matrixWorld);
        });
      }
      root.traverse((object) => {
        const geometry = object.geometry;
        if (!geometry || budget <= 0 || object.isLineSegments2 || object.isSprite) return;
        const position = geometry.getAttribute("position");
        if (object === this.meshes.shells) {
          for (const entity of this.shellState.activeElementIndices) {
            const item = this.shellState.prepared[entity];
            for (
              let vertex = item.vertexStart;
              vertex < item.vertexStart + item.vertexCount;
              vertex += 1
            ) {
              if ((budget -= 1) <= 0) return;
              project(
                position.getX(vertex),
                position.getY(vertex),
                position.getZ(vertex),
                object.matrixWorld,
              );
            }
          }
          return;
        }
        if (object.isInstancedMesh) {
          // A bounding-box corner stands where the geometry does not: the
          // corner of a sphere's box misses it by nearly three quarters of a
          // radius. Its vertices are used where they fit in the budget, and the
          // corners stand in only for an instance count that cannot afford it.
          const exact = position && position.count * object.count <= budget;
          if (!exact && !geometry.boundingBox) geometry.computeBoundingBox();
          const box = geometry.boundingBox;
          for (let index = 0; index < object.count; index += 1) {
            if (budget <= 0) return;
            object.getMatrixAt(index, instance);
            instance.premultiply(object.matrixWorld);
            if (exact) {
              budget -= position.count;
              for (let vertex = 0; vertex < position.count; vertex += 1) {
                project(
                  position.getX(vertex),
                  position.getY(vertex),
                  position.getZ(vertex),
                  instance,
                );
              }
              continue;
            }
            budget -= 8;
            for (const x of [box.min.x, box.max.x]) {
              for (const y of [box.min.y, box.max.y]) {
                for (const z of [box.min.z, box.max.z]) project(x, y, z, instance);
              }
            }
          }
          return;
        }
        if (!position) return;
        if (object.userData.gravissLineSegments) {
          const entities = object.userData.gravissEntities;
          const ranges = object.userData.gravissEntityRanges;
          for (let entity = 0; entity < entities.length; entity += 1) {
            if (!this.keepsElement(entities[entity])) continue;
            const range = ranges[entity];
            for (let vertex = range.start; vertex < range.start + range.count; vertex += 1) {
              if ((budget -= 1) <= 0) return;
              project(
                position.getX(vertex),
                position.getY(vertex),
                position.getZ(vertex),
                object.matrixWorld,
              );
            }
          }
          return;
        }
        const start = geometry.drawRange.start;
        const end = Math.min(position.count, start + geometry.drawRange.count);
        for (let index = start; index < end; index += 1) {
          if ((budget -= 1) <= 0) return;
          project(
            position.getX(index),
            position.getY(index),
            position.getZ(index),
            object.matrixWorld,
          );
        }
      });
    }
    return budget > 0;
  }

  // The rectangle the structure really paints, in fractions of the viewport.
  // Geometry supplies a conservative first window, including parts beyond the
  // pane; a transparent off-screen render then trims that window to the actual
  // silhouette. This matters under perspective: the projected corners of a
  // world-axis-aligned box can sit far outside an oblique model, leaving a
  // large false margin on only one side.
  modelScreenRect() {
    const viewport = this.viewportPixels();
    const coarse = this.modelScreenRectFromGeometry();
    if (!coarse) return null;
    let probe = marginedScreenRect(coarse, viewport, 0.05);
    let measured = coarse;
    for (let pass = 0; pass < 4; pass += 1) {
      const sample = this.rasterizedModelScreenRect(probe);
      if (!sample) return measured;
      const rect = sample.rect;
      measured = {
        x: probe.x + rect.x * probe.width,
        y: probe.y + rect.y * probe.height,
        width: rect.width * probe.width,
        height: rect.height * probe.height,
      };
      const touches = sample.touchesBoundary;
      if (!touches.left && !touches.right && !touches.top && !touches.bottom) return measured;
      // A shader can move a section past its CPU-side box. Grow only the sides
      // it reached and sample again; connected geometry crossing a boundary is
      // thereby followed without imposing an arbitrary deformation limit.
      const across = probe.width * 0.5;
      const down = probe.height * 0.5;
      if (touches.left) {
        probe.x -= across;
        probe.width += across;
      }
      if (touches.right) probe.width += across;
      if (touches.top) {
        probe.y -= down;
        probe.height += down;
      }
      if (touches.bottom) probe.height += down;
    }
    return measured;
  }

  // The CPU-side enclosure used only as a safe first window for the pixel
  // measurement above. Small models are followed vertex by vertex; large ones
  // deliberately fall back to the looser world box instead of making an export
  // wait on an unbounded JavaScript walk.
  modelScreenRectFromGeometry() {
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    const visit = (x, y) => {
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, -y);
      bottom = Math.max(bottom, -y);
    };
    this.camera.updateMatrixWorld(true);
    if (!this.forEachModelScreenPoint(visit)) return this.modelScreenRectFromBounds();
    if (!(right > left) || !(bottom > top)) return null;
    // Normalised device coordinates run -1 to 1; the viewport runs 0 to 1.
    return {
      x: (left + 1) / 2,
      y: (top + 1) / 2,
      width: (right - left) / 2,
      height: (bottom - top) / 2,
    };
  }

  // Render only the model through one viewport-fraction window, then read its
  // alpha into a tight rectangle. The sky, grid and global axes are reference
  // furniture rather than structure and therefore do not participate. The
  // current camera, renderer target, clear colour and visibility are restored
  // before returning, so measuring a boundary never flashes the live canvas.
  rasterizedModelScreenRect(region) {
    this.ensureGpuShellFrame();
    const renderer = this.canvasRenderer;
    const camera = this.camera;
    if (!renderer || !camera || !this.scene) return null;
    const viewport = this.viewportPixels();
    const covered = {
      width: region.width * viewport.width,
      height: region.height * viewport.height,
    };
    if (!(covered.width > 0) || !(covered.height > 0)) return null;
    const resolution = printPixelSize(covered, {
      maxEdge: Math.min(MODEL_BOUNDARY_MAX_EDGE, renderer.capabilities.maxTextureSize),
      maxPixels: MODEL_BOUNDARY_MAX_EDGE * MODEL_BOUNDARY_MAX_EDGE,
    });
    const target = new this.THREE.WebGLRenderTarget(resolution.width, resolution.height, {
      depthBuffer: true,
      stencilBuffer: true,
    });
    const pixels = new Uint8Array(resolution.width * resolution.height * 4);
    const previousTarget = renderer.getRenderTarget();
    const previousClearColor = renderer.getClearColor(new this.THREE.Color()).clone();
    const previousClearAlpha = renderer.getClearAlpha();
    const previousAutoClear = renderer.autoClear;
    const previousBackground = this.scene.background;
    const previousAspect = camera.aspect;
    const previousView = camera.view?.enabled ? { ...camera.view } : null;
    const excluded = [this.sky, this.grid, this.axes].filter(Boolean);
    const visibility = excluded.map((object) => object.visible);
    try {
      camera.setViewOffset(
        viewport.width,
        viewport.height,
        region.x * viewport.width,
        region.y * viewport.height,
        covered.width,
        covered.height,
      );
      excluded.forEach((object) => {
        object.visible = false;
      });
      this.scene.background = null;
      renderer.autoClear = true;
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(target);
      renderer.clear(true, true, true);
      this.renderModel(renderer, camera);
      renderer.readRenderTargetPixels(target, 0, 0, resolution.width, resolution.height, pixels);
    } catch {
      return null;
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.setClearColor(previousClearColor, previousClearAlpha);
      renderer.autoClear = previousAutoClear;
      this.scene.background = previousBackground;
      excluded.forEach((object, index) => {
        object.visible = visibility[index];
      });
      if (previousView) {
        camera.setViewOffset(
          previousView.fullWidth,
          previousView.fullHeight,
          previousView.offsetX,
          previousView.offsetY,
          previousView.width,
          previousView.height,
        );
      } else {
        camera.clearViewOffset();
        if (previousAspect != null) camera.aspect = previousAspect;
        camera.updateProjectionMatrix();
      }
      target.dispose();
      this.updateMemberDiagramLabels(renderer, camera);
    }

    let left = resolution.width;
    let right = -1;
    let bottom = resolution.height;
    let top = -1;
    for (let y = 0; y < resolution.height; y += 1) {
      for (let x = 0; x < resolution.width; x += 1) {
        if (pixels[(y * resolution.width + x) * 4 + 3] === 0) continue;
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < bottom) bottom = y;
        if (y > top) top = y;
      }
    }
    if (right < left || top < bottom) return null;
    return {
      rect: {
        x: left / resolution.width,
        y: (resolution.height - top - 1) / resolution.height,
        width: (right - left + 1) / resolution.width,
        height: (top - bottom + 1) / resolution.height,
      },
      resolution,
      touchesBoundary: {
        left: left === 0,
        right: right === resolution.width - 1,
        top: top === resolution.height - 1,
        bottom: bottom === 0,
      },
    };
  }

  marginedScreenRect(rect, marginFraction = PRINT_MARGIN_FRACTION) {
    return marginedScreenRect(rect, this.viewportPixels(), marginFraction);
  }

  viewportPixels() {
    return {
      width: Math.max(1, this.host.clientWidth || this.viewportWidth || 800),
      height: Math.max(1, this.host.clientHeight || this.viewportHeight || 600),
    };
  }

  modelScreenRectFromBounds() {
    const width = Math.max(1, this.host.clientWidth || 800);
    const height = Math.max(1, this.host.clientHeight || 600);
    const bounds = this.visibleModelBounds();
    const min = bounds.min.toArray();
    const max = bounds.max.toArray();
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const x of [min[0], max[0]]) {
      for (const y of [min[1], max[1]]) {
        for (const z of [min[2], max[2]]) {
          const screen = this.projectToScreen([x, y, z]);
          if (!screen) continue;
          left = Math.min(left, screen.x);
          right = Math.max(right, screen.x);
          top = Math.min(top, screen.y);
          bottom = Math.max(bottom, screen.y);
        }
      }
    }
    if (!(right > left) || !(bottom > top)) return null;
    return {
      x: left / width,
      y: top / height,
      width: (right - left) / width,
      height: (bottom - top) / height,
    };
  }

  // The camera basis on the plane through its target, which is the plane a
  // region is measured on.
  targetPlaneBasis() {
    const THREE = this.THREE;
    const forward = new THREE.Vector3().subVectors(this.controls.target, this.camera.position);
    if (forward.lengthSq() === 0) return null;
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, this.camera.up);
    if (right.lengthSq() === 0) right.crossVectors(forward, this.modelYAxis);
    if (right.lengthSq() === 0) return null;
    right.normalize();
    return { forward, right, up: new THREE.Vector3().crossVectors(right, forward).normalize() };
  }

  // The rectangle the user drew, in fractions of the viewport, so it survives a
  // resize and stays where it was drawn. A drag too small to have been meant as
  // a rectangle sets nothing.
  regionForScreenRect(from, to) {
    const width = Math.max(1, this.host.clientWidth || 800);
    const height = Math.max(1, this.host.clientHeight || 600);
    const rectWidth = Math.abs(to.x - from.x);
    const rectHeight = Math.abs(to.y - from.y);
    if (rectWidth < MINIMUM_REGION_PIXELS || rectHeight < MINIMUM_REGION_PIXELS) return null;
    const clamp = (value) => Math.min(1, Math.max(0, value));
    const left = clamp(Math.min(from.x, to.x) / width);
    const top = clamp(Math.min(from.y, to.y) / height);
    return {
      x: left,
      y: top,
      width: Math.min(1 - left, rectWidth / width),
      height: Math.min(1 - top, rectHeight / height),
    };
  }

  // One vertical half-view in the stored region's units: the tangent of half
  // the vertical field for a perspective camera — a region is stored as
  // angles about the view axis, which is what rides the camera — and half the
  // visible height for an orthographic one, where parallel projection makes
  // the angles lengths.
  printRegionUnitHalf() {
    if (this.camera.isPerspectiveCamera) {
      return Math.tan((this.camera.fov * Math.PI) / 360) / this.camera.zoom;
    }
    return (
      (this.orthographicCamera.top - this.orthographicCamera.bottom) /
      (2 * this.orthographicCamera.zoom)
    );
  }

  // A stored region is absolute tangents about the view axis; the viewport is
  // fractions of the pane. No camera ACTION enters the bridge — orbiting,
  // panning and scrolling never touch the field of view — which is exactly
  // why the frame is frozen on the user's screen while the structure
  // recomposes through it. A pane RESIZE rescales the field instead of the
  // framing, revealing and cropping at constant pixels per tangent, so the
  // same stored angles keep the same pixels and go on marking the same
  // structure. Both sides are free to leave the 0..1 square: a region larger
  // than the pane is a pane showing less of it.
  printRegionToViewportFractions(region) {
    const viewport = this.viewportPixels();
    const aspect = viewport.width / viewport.height;
    const half = this.printRegionUnitHalf();
    if (!(half > 0)) return null;
    const width = region.width / (2 * half * aspect);
    const height = region.height / (2 * half);
    return {
      x: 0.5 + region.center[0] / (2 * half * aspect) - width / 2,
      y: 0.5 - region.center[1] / (2 * half) - height / 2,
      width,
      height,
    };
  }

  printRegionFromViewportFractions(fractions) {
    const viewport = this.viewportPixels();
    const aspect = viewport.width / viewport.height;
    const half = this.printRegionUnitHalf();
    if (!(half > 0)) return null;
    return {
      center: [
        (fractions.x + fractions.width / 2 - 0.5) * 2 * half * aspect,
        (0.5 - fractions.y - fractions.height / 2) * 2 * half,
      ],
      width: fractions.width * 2 * half * aspect,
      height: fractions.height * 2 * half,
    };
  }

  // The region overlay is the renderer's to paint: where a world rectangle
  // falls on the screen depends on the camera and the pane, so it is repainted
  // with every frame rather than parked at fractions that mean something else
  // after every resize and zoom.
  setPrintRegion(region) {
    this.printRegion = region || null;
    this.paintPrintRegion();
    this.requestRender();
  }

  // A gesture previews in viewport fractions directly — the drag is a screen
  // thing until it is written down in metres on release.
  setPrintRegionPreview(fractions) {
    this.printRegionPreview = fractions || null;
    this.paintPrintRegion();
  }

  paintPrintRegion() {
    const overlay = this.printRegionElement;
    if (!overlay) return;
    const fractions = this.regionSelection
      ? null
      : this.printRegionPreview ||
        (this.printRegion && this.printRegionToViewportFractions(this.printRegion));
    if (!fractions) {
      overlay.hidden = true;
      return;
    }
    overlay.hidden = false;
    overlay.style.left = `${fractions.x * 100}%`;
    overlay.style.top = `${fractions.y * 100}%`;
    overlay.style.width = `${fractions.width * 100}%`;
    overlay.style.height = `${fractions.height * 100}%`;
  }

  // What an export covers: the stored view window placed on the target plane,
  // or the whole model with a margin when no region was drawn. A tangent
  // spans its angle times the target distance in metres, so the same stored
  // region resolves to the same world rectangle from any pane and from no
  // pane at all — and to a different one after a zoom, because the window is
  // the view's and zooming moves the view.
  resolvePrintRegion(storedRegion = null) {
    if (storedRegion) {
      const region = validatePrintRegion(storedRegion);
      const visible = this.visibleExtentAtTarget();
      const basis = this.targetPlaneBasis();
      const half = this.printRegionUnitHalf();
      if (!visible || !basis || !(half > 0)) return null;
      const worldPerUnit = visible.height / (2 * half);
      return {
        center: this.controls.target
          .clone()
          .addScaledVector(basis.right, region.center[0] * worldPerUnit)
          .addScaledVector(basis.up, region.center[1] * worldPerUnit)
          .toArray(),
        width: region.width * worldPerUnit,
        height: region.height * worldPerUnit,
      };
    }
    const extent = this.projectedModelExtent();
    if (!extent) return null;
    const margin = Math.max(extent.width, extent.height) * PRINT_MARGIN_FRACTION;
    return {
      center: extent.center,
      width: extent.width + margin * 2,
      height: extent.height + margin * 2,
    };
  }

  // Renders one frame covering exactly the region, at print resolution, and
  // hands back a PNG. The camera and the drawing buffer are restored before
  // returning, so the viewport is untouched by having been printed from.
  renderPrintImage(storedRegion = null, options = {}) {
    if (!storedRegion) return this.renderModelFit(options);
    // Metres to fractions of the current full view: the fractions compensate
    // for whatever the pane happens to show, so the off-axis frustum through
    // them covers the same rectangle of the world at every pane size — which
    // is what makes the exported picture the same picture everywhere.
    const fractions = this.printRegionToViewportFractions(validatePrintRegion(storedRegion));
    return fractions ? this.renderRegionCrop(fractions, options) : null;
  }

  // A region is a rectangle of what the viewport already shows, so the export
  // is that rectangle of the very same view: an off-axis frustum through it,
  // with the camera left exactly where it is.
  //
  // Aiming the camera at the region's middle instead would render it head-on
  // while the viewport shows it obliquely, and under perspective the two
  // disagree by more the further the frame sits from the centre of the view.
  renderRegionCrop(region, options) {
    this.ensureGpuShellFrame();
    // The sky is placed per frame, and an export renders without waiting for
    // one, so it is placed here too rather than left at the size the depth
    // range had before the camera last moved.
    this.placeSky();
    const { width, height } = this.viewportPixels();
    const covered = { width: region.width * width, height: region.height * height };
    // Never ask for a buffer wider than the context can allocate; a driver
    // that refuses one hands back a blank image rather than an error.
    const pixels = printPixelSize(covered, {
      maxEdge: Math.min(EXPORT_MAX_EDGE, this.canvasRenderer.capabilities.maxTextureSize),
      ...options,
    });
    const renderer = this.canvasRenderer;
    const camera = this.camera;
    const originalSize = renderer.getSize(new this.THREE.Vector2());
    const pixelRatio = renderer.getPixelRatio();
    try {
      camera.setViewOffset(
        width,
        height,
        region.x * width,
        region.y * height,
        covered.width,
        covered.height,
      );
      renderer.setPixelRatio(1);
      renderer.setSize(pixels.width, pixels.height, false);
      this.updateLighting();
      this.renderModel(renderer, camera);
      return {
        dataUrl: renderer.domElement.toDataURL("image/png"),
        region: covered,
        ...pixels,
      };
    } finally {
      camera.clearViewOffset();
      renderer.setPixelRatio(pixelRatio);
      renderer.setSize(originalSize.x, originalSize.y, false);
      this.updateMemberDiagramLabels(renderer, camera);
      this.resize();
    }
  }

  // Without a region the image still comes from the view on screen; it just
  // reaches past the edges of it. The camera is not moved, because moving it
  // changes the perspective — the foreshortening and the vanishing point — and
  // the image would then be taken from somewhere the viewport never was.
  renderModelFit(options) {
    const rect = this.modelScreenRect();
    if (!rect) return null;
    return this.renderRegionCrop(marginedScreenRect(rect, this.viewportPixels()), options);
  }

  updateOrthographicFrustum(aspect) {
    const halfHeight = (this.orthographicHeight || this.bounds.radius * 2.6) / 2;
    this.orthographicCamera.left = -halfHeight * aspect;
    this.orthographicCamera.right = halfHeight * aspect;
    this.orthographicCamera.top = halfHeight;
    this.orthographicCamera.bottom = -halfHeight;
    this.orthographicCamera.updateProjectionMatrix();
  }

  // Pin the orbit to whatever is under the pointer as a drag begins. The pivot
  // is a bare world point, never the object it was read from, so rebuilding the
  // geometry under a held pointer cannot leave it dangling.
  armOrbitPivot(event) {
    if (!this.orbitPivotEnabled || this.orbitPivot) return null;
    if (event.button !== 0) return null;
    // The controls read a held modifier as a pan before they read it as a
    // rotation, and a pan has no pivot to pin.
    if (event.ctrlKey || event.metaKey || event.shiftKey) return null;
    if (!this.controls?.enabled) return null;
    const intersection = this.intersectionAt(event);
    if (!intersection) return null;
    this.orbitPivot = {
      point: intersection.point.clone(),
      quaternion: this.camera.quaternion.clone(),
      rotating: false,
    };
    return this.orbitPivot;
  }

  releaseOrbitPivot() {
    const released = Boolean(this.orbitPivot);
    this.orbitPivot = null;
    if (this.orbitPivotElement) this.orbitPivotElement.hidden = true;
    return released;
  }

  // Turning about an arbitrary pivot is the turn the controls already made
  // about their target plus a rigid translation of the whole rig. With Q the
  // rotation the camera just underwent, moving the camera and the target both
  // by (I - Q)(pivot - target) converts one into the other: the offset between
  // them is unchanged, so the orientation lookAt already produced is still
  // right and nothing needs updating a second time. What it buys is exact — the
  // pivot keeps the camera-space coordinates it had, so it keeps its place and
  // its size on screen for the whole drag.
  //
  // Q is read back from the camera rather than from the yaw and pitch that were
  // asked for, so a drag clamped at an orbit pole is corrected by what the
  // controls actually did. A pan or a dolly turns the camera by nothing, which
  // makes the correction inert without having to ask which gesture is running.
  applyOrbitPivot() {
    const pivot = this.orbitPivot;
    if (!pivot) return false;
    // q_after * q_before⁻¹, the turn in world axes. The other order is the same
    // turn read in the camera's own axes, and would rotate the wrong vector.
    const inverse = pivot.quaternion.clone().invert();
    const rotation = this.camera.quaternion.clone().multiply(inverse);
    pivot.quaternion.copy(this.camera.quaternion);
    if (1 - Math.abs(rotation.w) < ORBIT_PIVOT_ROTATION_EPSILON) return false;
    const offset = pivot.point.clone().sub(this.controls.target);
    const rotated = offset.clone().applyQuaternion(rotation);
    const delta = offset.sub(rotated);
    this.camera.position.add(delta);
    this.controls.target.add(delta);
    pivot.rotating = true;
    this.paintOrbitPivot();
    return true;
  }

  // Only while a rotation is running, and only once one has actually started: a
  // press that never moved is a click and marks nothing. The pinned point keeps
  // its place on screen for the whole drag by construction, so repainting is
  // what keeps it right across a resize under a held pointer, nothing more.
  paintOrbitPivot() {
    const marker = this.orbitPivotElement;
    if (!marker) return false;
    if (!this.orbitPivotMarkerVisible || !this.orbitPivot?.rotating) {
      marker.hidden = true;
      return false;
    }
    this.camera.updateMatrixWorld(true);
    const screen = this.projectToScreen(this.orbitPivot.point.toArray());
    if (!screen) {
      marker.hidden = true;
      return false;
    }
    marker.style.left = `${screen.x}px`;
    marker.style.top = `${screen.y}px`;
    marker.hidden = false;
    return true;
  }

  // How far ahead the camera can see, rebuilt from where it is now. Framing the
  // view fixed these once, which left the near plane where the model started
  // rather than where the camera went: flying in clipped away the surface being
  // approached, and flying out dropped the far side of the model behind a far
  // plane sized for a much closer camera.
  //
  // The step the depth buffer resolves at the model grows with the span between
  // the planes, and a near plane trailing at a thousandth of the target
  // distance drags the span out with the camera: depth quality falls linearly
  // as it backs away, until faces that stand cleanly apart up close — a beam
  // section against the slab it runs through — tie in the buffer and flicker
  // over each other. From outside the scene nothing drawable sits nearer than
  // its front, so the near plane rides there, held under a third of far so the
  // camera-centred sky keeps a shell between the planes to sit in.
  updateDepthRange() {
    if (!this.camera || !this.controls) return false;
    const distance = this.camera.position.distanceTo(this.controls.target);
    const far = distance + this.bounds.radius * 20;
    const near = Math.max(
      far / MAXIMUM_DEPTH_RATIO,
      distance / 1000,
      Math.min(this.sceneClearance() * 0.9, far / 3),
    );
    if (this.camera.near === near && this.camera.far === far) return false;
    this.camera.near = near;
    this.camera.far = far;
    this.camera.updateProjectionMatrix();
    return true;
  }

  // The depth of whatever the pointer is over, measured along the camera axis.
  // With nothing under it the plane through the target stands in, so a wheel
  // over the background keeps the pace the model set.
  pointerDepth(intersection, forward, alignment) {
    if (intersection) return intersection.distance * alignment;
    return this.controls.target.clone().sub(this.camera.position).dot(forward);
  }

  // Put the camera at a given depth from what it is aimed at, travelling along
  // the ray so that whatever is under the pointer stays under it, and keeping
  // the target on the camera axis ahead.
  applyDollyDepth(flight, depth) {
    this.camera.position.addScaledVector(
      flight.direction,
      (flight.value - depth) / flight.alignment,
    );
    this.controls.target.copy(this.camera.position).addScaledVector(flight.forward, depth);
    flight.value = depth;
    this.controls.update();
    this.requestRender();
  }

  // The height an orthographic camera currently draws through, and the zoom
  // that would draw through a given one. The frustum itself is the framing at
  // zoom 1 and is rebuilt from the viewport on every resize, so the zoom is
  // where a wheel's answer belongs: it survives a resize, and it is the one
  // number `captureCameraState` folds back out into the height it writes down.
  orthographicVisibleHeight() {
    const camera = this.orthographicCamera;
    return (camera.top - camera.bottom) / camera.zoom;
  }

  // Narrow or widen the framing, keeping whatever the wheel is over where it
  // is. An orthographic camera cannot approach anything — moving it forward
  // changes nothing it draws — so the anchor is held by sliding the camera
  // across its own image plane by however far the point moved, which is the
  // same displacement a pan would have made.
  applyFrustumHeight(flight, height) {
    const camera = this.orthographicCamera;
    const anchor = flight.anchor;
    const before = anchor && this.unprojectPointer(anchor);
    camera.zoom = (camera.top - camera.bottom || 1) / height;
    camera.updateProjectionMatrix();
    if (before) {
      const shift = before.sub(this.unprojectPointer(anchor));
      camera.position.add(shift);
      this.controls.target.add(shift);
    }
    flight.value = height;
    this.controls.update();
    this.requestRender();
  }

  // Where a point of the canvas falls in the world, on the plane through the
  // camera. Orthographic only: a perspective unprojection at the near plane
  // would be a point on a ray rather than a place.
  unprojectPointer(pointer) {
    return new this.THREE.Vector3(pointer.x, pointer.y, 0).unproject(this.orthographicCamera);
  }

  cancelZoomFlight() {
    const flying = this.zoomFlight != null;
    if (this.zoomFrame != null) cancelAnimationFrame(this.zoomFrame);
    this.zoomFrame = null;
    this.zoomFlight = null;
    this.zoomFrameTime = null;
    return flying;
  }

  // Eased in log space, because a notch is multiplicative: interpolating the
  // value itself would run away while far out and crawl on arrival, which is
  // the same motion the wheel is supposed to be hiding. What the value means
  // is the flight's own — a depth to travel to, or a framing to draw through.
  advanceZoomFlight(timestamp) {
    this.zoomFrame = null;
    const flight = this.zoomFlight;
    if (this.destroyed || !flight) return;
    const elapsed =
      this.zoomFrameTime == null
        ? ZOOM_MAXIMUM_FRAME_MS / 4
        : Math.min(ZOOM_MAXIMUM_FRAME_MS, timestamp - this.zoomFrameTime);
    this.zoomFrameTime = timestamp;
    const remaining = Math.log(flight.goal / flight.value);
    if (Math.abs(remaining) < ZOOM_SETTLE_EPSILON) {
      flight.apply(flight, flight.goal);
      this.zoomFlight = null;
      this.zoomFrameTime = null;
      return;
    }
    flight.apply(
      flight,
      flight.value * Math.exp(remaining * (1 - Math.exp(-elapsed / ZOOM_SETTLE_MS))),
    );
    // Holding the history write off until the camera has settled, so the undo
    // entry is a camera the view actually came to rest at rather than one it
    // passed through. Each call restarts the same settle timer.
    this.scheduleCameraChange();
    this.zoomFrame = requestAnimationFrame((next) => this.advanceZoomFlight(next));
  }

  // A wheel notch moves the camera along the ray under the pointer, closing a
  // fraction of the gap to what that ray hits. Scaling the step by the surface
  // rather than by the camera target is the whole difference: the controls'
  // own zoom scales the target distance and walks the camera exactly that far
  // along the ray, which sails through anything nearer than the target and
  // stops short of anything beyond it. Closing a fraction of the real gap
  // approaches the surface and never reaches it, at any scale.
  //
  // An orthographic camera has no gap to close — moving it forward changes
  // nothing it draws — so the notch narrows the framing instead, by the same
  // fraction, and the point under the wheel is held by sliding the camera
  // across its own image plane. Both projections are eased the same way.
  //
  // Declining leaves the notch to the controls, which happens only when the
  // wheel is neither aimed nor eased and their own single-step zoom is
  // therefore exactly what was asked for.
  zoomOnWheel(event) {
    if (this.destroyed || !this.controls?.enabled) return false;
    if (!this.zoomTowardPointer && !this.smoothZoom) return false;
    // The controls refuse a notch mid-drag, and a camera being dragged has a
    // pivot pinned that a zoom would be measured against wrongly.
    if (this.pointerDown) return false;
    const notches = wheelNotches(event);
    if (!notches) return false;
    const flight = this.camera.isPerspectiveCamera
      ? this.dollyFlightFor(event, notches)
      : this.frustumFlightFor(event, notches);
    if (!flight) return false;
    if (!this.smoothZoom) {
      this.cancelZoomFlight();
      flight.apply(flight, flight.goal);
      return true;
    }
    this.zoomFlight = flight;
    if (this.zoomFrame == null) {
      this.zoomFrameTime = null;
      this.zoomFrame = requestAnimationFrame((next) => this.advanceZoomFlight(next));
    }
    return true;
  }

  // A notch that lands while the camera is still moving compounds on what the
  // last one asked for, not on where it has got to, so a fast turn of the
  // wheel covers the ground it names instead of chasing itself. Only while the
  // wheel is still pointing at the same thing: aim somewhere else and the
  // pending value is a measurement of something else.
  pendingZoomValue(sameAim, value) {
    return this.zoomFlight && sameAim(this.zoomFlight) ? this.zoomFlight.goal : value;
  }

  // Where the wheel is pointing, as normalized device coordinates, or null for
  // a wheel that is not aimed at all. The two nulls are not the same thing and
  // only one of them is this method's to report: a canvas with no measured
  // size cannot say where the pointer is, and a notch over one is left to the
  // controls rather than aimed at a guess.
  zoomAnchor(event) {
    if (!this.zoomTowardPointer) return { aimed: false, pointer: null };
    const pointer = this.pointerFromEvent(event);
    return pointer ? { aimed: true, pointer: { x: pointer.x, y: pointer.y } } : null;
  }

  dollyFlightFor(event, notches) {
    const anchor = this.zoomAnchor(event);
    if (!anchor) return null;
    const forward = new this.THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const active = this.zoomFlight;
    if (
      active?.direction &&
      active.deformationFactor === (this.deformation?.factor ?? 0) &&
      Boolean(anchor.pointer) === Boolean(active.anchor) &&
      (!anchor.pointer ||
        (Math.abs(active.anchor.x - anchor.pointer.x) < 1e-6 &&
          Math.abs(active.anchor.y - anchor.pointer.y) < 1e-6))
    ) {
      // A wheel emits a burst of events at one screen point. The first one has
      // already found the fixed world surface and the easing keeps that point
      // under the cursor, so the rest can retarget the same flight without
      // raycasting the model again.
      active.goal = Math.min(
        this.controls.maxDistance,
        Math.max(
          this.controls.minDistance,
          active.goal * Math.pow(1 - ZOOM_NOTCH_FRACTION, notches),
        ),
      );
      return active;
    }
    // Unaimed, the ray is the camera's own axis and the gap is the one to the
    // target, which is the middle of the viewport by construction.
    // Leaves the raycaster aimed under the pointer, which is the ray to travel
    // along whether or not it hit anything.
    const intersection = anchor.aimed ? this.zoomIntersectionAt(event) : null;
    const direction = anchor.aimed ? this.raycaster.ray.direction.clone() : forward.clone();
    const alignment = direction.dot(forward);
    if (!(alignment > 1e-6)) return null;
    const value = this.pointerDepth(intersection, forward, alignment);
    if (!(value > 0)) return null;
    const pending = this.pendingZoomValue(
      (flight) => flight.direction?.dot(direction) > ZOOM_SAME_AIM,
      value,
    );
    const goal = Math.min(
      this.controls.maxDistance,
      Math.max(this.controls.minDistance, pending * Math.pow(1 - ZOOM_NOTCH_FRACTION, notches)),
    );
    // The target belongs on the camera axis. Anywhere else and the controls'
    // own lookAt would swing the view round to face it on the next update.
    return {
      anchor: anchor.pointer,
      deformationFactor: this.deformation?.factor ?? 0,
      direction,
      forward,
      alignment,
      value,
      goal,
      apply: (flight, depth) => this.applyDollyDepth(flight, depth),
    };
  }

  frustumFlightFor(event, notches) {
    const aim = this.zoomAnchor(event);
    if (!aim) return null;
    const value = this.orthographicVisibleHeight();
    if (!(value > 0)) return null;
    // An unaimed notch narrows the framing about the middle of the viewport,
    // which is where a zoom with nothing to hold belongs.
    const anchor = aim.pointer;
    const pending = this.pendingZoomValue(
      (flight) =>
        Boolean(anchor) === Boolean(flight.anchor) &&
        (!anchor ||
          (Math.abs(flight.anchor.x - anchor.x) < 1e-6 &&
            Math.abs(flight.anchor.y - anchor.y) < 1e-6)),
      value,
    );
    const radius = this.bounds.radius;
    const goal = Math.min(
      radius * FRUSTUM_MAXIMUM_FACTOR,
      Math.max(
        radius * FRUSTUM_MINIMUM_FRACTION,
        pending * Math.pow(1 - ZOOM_NOTCH_FRACTION, notches),
      ),
    );
    return {
      anchor,
      value,
      goal,
      apply: (flight, height) => this.applyFrustumHeight(flight, height),
    };
  }

  // Normalized device coordinates for a pointer event, or null when the canvas
  // has no size to measure them against.
  pointerFromEvent(event) {
    const rect = this.canvasRenderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    return this.pointer;
  }

  // The nearest visible thing under a pointer event. `pick` reads the entity
  // behind it; the orbit pivot reads only where it is in the world.
  intersectionAt(event) {
    if (!this.pointerFromEvent(event)) return null;
    this.ensureCpuShellGeometry();
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return (
      this.raycaster
        .intersectObjects(
          this.pickables.filter((mesh) => this.isObjectVisible(mesh)),
          false,
        )
        .find((intersection) => this.keepsIntersection(intersection)) || null
    );
  }

  // A wheel needs a depth, not the exact rendered triangle or its entity.
  // Shells therefore substitute their low-density live proxy while every
  // other kind keeps its ordinary pickable. This path is deliberately separate
  // from selection and orbit pinning, whose exact hit still matters.
  zoomIntersectionAt(event) {
    if (!this.pointerFromEvent(event)) return null;
    this.ensureCpuShellGeometry("proxy");
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const objects = [];
    for (const mesh of this.pickables) {
      if (!this.isObjectVisible(mesh)) continue;
      objects.push(mesh.userData.gravissZoomProxy || mesh);
    }
    return (
      this.raycaster
        .intersectObjects(objects, false)
        .find((intersection) => this.keepsIntersection(intersection)) || null
    );
  }

  resolveIntersection(intersection) {
    if (!intersection) return null;
    const type = intersection.object.userData.gravissType;
    // A line intersection reports the first vertex of the segment it hit
    // rather than a face, and how many vertices an entity owns is the mesh's
    // own business: a member drawn as its centreline owns two, a spring owns
    // a whole helix. The range table is what knows, so it is what is asked.
    const data = intersection.object.userData;
    const entityIndex =
      intersection.instanceId != null
        ? // An instance is one segment of a member rather than the member, so
          // the table that says which member owns a segment resolves it.
          (data.gravissSegmentToEntityIndex?.[intersection.instanceId] ??
          data.gravissInstanceToEntityIndex?.[intersection.instanceId] ??
          intersection.instanceId)
        : data.gravissLineSegments
          ? entityIndexAtVertex(data.gravissEntityRanges, intersection.index)
          : data.gravissFaceToEntityIndex?.[intersection.faceIndex];
    const entity = data.gravissEntities?.[entityIndex];
    if (entity) {
      return { type, entity, entityIndex, instanceId: entityIndex, object: intersection.object };
    }
    return null;
  }

  keepsIntersection(intersection) {
    const type = intersection.object.userData.gravissType;
    // The shell zoom proxy already has an active triangle index and carries
    // no entity metadata. Nodes and supports retain their own hit semantics.
    if (!FILTERED_ENTITY_TYPES.has(type) && type !== "node" && type !== "support") return true;
    const hit = this.resolveIntersection(intersection);
    return Boolean(hit) && this.keepsEntity(type, hit.entity);
  }

  pick(event) {
    if (!this.pointerFromEvent(event)) return;
    this.setSelected(this.resolveIntersection(this.intersectionAt(event)));
  }

  isObjectVisible(object) {
    for (let current = object; current; current = current.parent) {
      if (!current.visible) return false;
    }
    return true;
  }

  sameHit(left, right) {
    return Boolean(
      left &&
      right &&
      left.type === right.type &&
      entityKey(left.type, left.entity.id) === entityKey(right.type, right.entity.id),
    );
  }

  setSelected(hit) {
    if (this.sameHit(this.selected, hit) || (!this.selected && !hit)) return;
    const previous = this.selected;
    this.selected = hit;
    this.refreshHitColors([previous, hit]);
    if (this.memberDiagram) {
      this.memberDiagram.select(hit?.type === "element" ? hit.entity.id : null);
      this.updateMemberDiagramLabels();
      // A diagram and its physical member are two views of the same entity.
      this.refreshInstanceColors((object) => object.userData.gravissType === "element");
      this.sceneBox = null;
    }
    this.callbacks.onSelectionChange?.(hit ? { type: hit.type, entity: hit.entity } : null);
    this.requestRender();
  }

  refreshHitColors(hits) {
    if (!this.colors) return;
    const visited = new Set();
    for (const hit of hits) {
      if (!hit) continue;
      const key = `${hit.object.uuid}:${hit.instanceId}`;
      if (visited.has(key)) continue;
      visited.add(key);
      const selected = this.sameHit(this.selected, hit);
      this.paintEntityColor(hit.object, hit.entityIndex, hit.entity, selected);
    }
  }

  // `matches` narrows the pass to the meshes a caller just rebuilt; without it
  // every pickable is repainted, which is what a change of theme or of
  // selection wants.
  refreshInstanceColors(matches = null) {
    if (!this.colors) return;
    // The selected key is loop invariant, and with nothing selected no entity
    // needs a key built at all.
    const selectedKey = this.selected
      ? entityKey(this.selected.type, this.selected.entity.id)
      : null;
    for (const mesh of matches ? this.pickables.filter(matches) : this.pickables) {
      const type = mesh.userData.gravissType;
      const colorKey = mesh.userData.gravissColorKey || type;
      const entities = mesh.userData.gravissEntities;
      entities.forEach((entity, index) => {
        const selected = selectedKey !== null && entityKey(type, entity.id) === selectedKey;
        this.paintEntityColor(mesh, index, entity, selected, colorKey);
      });
    }
  }

  paintEntityColor(mesh, entityIndex, entity, selected, colorKey = null) {
    if (selected) {
      this.setEntityColor(mesh, entityIndex, this.colors.selected);
      return;
    }
    if (mesh.userData.gravissMemberDiagram) {
      this.setEntityColor(mesh, entityIndex, mesh.userData.gravissMemberDiagramColor);
      return;
    }
    if (this.paintInterpolatedDisplacement(mesh, entityIndex, entity)) return;
    this.setEntityColor(
      mesh,
      entityIndex,
      this.elementColor(colorKey || mesh.userData.gravissColorKey || entity?.kind, entity),
    );
  }

  paintInterpolatedDisplacement(mesh, entityIndex, entity) {
    if (
      !this.colorByDisplacement ||
      !this.deformation?.magnitudes ||
      !(this.deformation.extent > 0)
    ) {
      return false;
    }
    const layer = mesh.userData.visibilityKey;
    if (layer === "shells" && mesh === this.meshes.shells) {
      return this.paintShellDisplacement(mesh, entityIndex);
    }
    if (layer !== "members") return false;
    if (mesh.isInstancedMesh)
      return this.paintMemberInstanceDisplacement(mesh, entityIndex, entity);
    if (mesh === this.memberLines)
      return this.paintMemberLineDisplacement(mesh, entityIndex, entity);
    return false;
  }

  normalizedNodeDisplacement(nodeId) {
    const index = this.nodeIndexById.get(stableIdKey(nodeId));
    const extent = this.deformation?.extent;
    if (index == null || !(extent > 0)) return null;
    return Math.min(1, Math.max(0, this.deformation.magnitudes[index] / extent));
  }

  paintMemberInstanceDisplacement(mesh, entityIndex, entity) {
    const first = this.normalizedNodeDisplacement(entity?.nodeIds?.[0]);
    const last = this.normalizedNodeDisplacement(entity?.nodeIds?.at(-1));
    if (first == null || last == null) return false;
    const range = mesh.userData.gravissEntityRanges?.[entityIndex];
    if (!range || range.count === 0) return true;
    // The existing vec3 instance colour carries two scalar end values and a
    // marker outside the RGB range. The fill shader reads that marker and
    // samples the common colour ramp along local x, so interpolation costs no
    // extra vertex attribute on WebGL implementations already at their limit.
    this.displacementEncodingColor.setRGB(first, last, 2);
    for (let instance = range.start; instance < range.start + range.count; instance += 1) {
      mesh.setColorAt(instance, this.displacementEncodingColor);
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    return true;
  }

  paintMemberLineDisplacement(mesh, entityIndex, entity) {
    const first = this.normalizedNodeDisplacement(entity?.nodeIds?.[0]);
    const last = this.normalizedNodeDisplacement(entity?.nodeIds?.at(-1));
    const range = mesh.userData.gravissEntityRanges?.[entityIndex];
    const colors = mesh.geometry.getAttribute("color");
    if (first == null || last == null || !range || !colors) return false;
    const steps = range.count / 2;
    for (let step = 0; step < steps; step += 1) {
      for (let end = 0; end < 2; end += 1) {
        const fraction = (step + end) / steps;
        const value = first + (last - first) * fraction;
        writeColorScale(value, colors.array, (range.start + step * 2 + end) * 3);
      }
    }
    colors.needsUpdate = true;
    return true;
  }

  paintShellDisplacement(mesh, entityIndex) {
    const item = this.shellState?.prepared?.[entityIndex];
    const range = mesh.userData.gravissEntityRanges?.[entityIndex];
    const displacement = mesh.geometry.getAttribute("gravissDisplacement");
    const magnitudes = this.deformation?.magnitudes;
    const extent = this.deformation?.extent;
    if (!item || !range || !displacement || !magnitudes || !(extent > 0)) return false;
    const weights = item.surfaceLayout.weights;
    const samples = weights.length / item.nodeIndices.length;
    let values = this.shellColorScratch;
    if (!values || values.length < samples) {
      values = this.shellColorScratch = new Float32Array(samples);
    }
    for (let sample = 0; sample < samples; sample += 1) {
      let value = 0;
      const weightAt = sample * item.nodeIndices.length;
      for (let node = 0; node < item.nodeIndices.length; node += 1) {
        const index = item.nodeIndices[node];
        if (index >= 0) value += magnitudes[index] * weights[weightAt + node];
      }
      values[sample] = Math.min(1, Math.max(0, value / extent));
    }
    let vertex = range.start;
    const writeSample = (sample) => {
      displacement.array[vertex] = values[sample];
      vertex += 1;
    };
    for (let layer = 0; layer < item.layers; layer += 1) {
      for (let sample = 0; sample < samples; sample += 1) writeSample(sample);
    }
    if (item.layers === 2) {
      for (let side = 0; side < item.nodeIndices.length; side += 1) {
        if (!item.sideWanted[side]) continue;
        const boundary = item.surfaceLayout.boundaries[side];
        for (let layer = 0; layer < 2; layer += 1) {
          for (const sample of boundary) writeSample(sample);
        }
      }
    }
    displacement.needsUpdate = true;
    return true;
  }

  // A line element's kind may carry a colour of its own; a kind that names none
  // is drawn as the member colour the scheme states, which is what keeps a
  // model of nothing but beams looking exactly as it did. `ineffective` is not
  // a fallback but a statement about the part being drawn - the piece of a
  // section that carries nothing - so no kind overrides it.
  elementColor(colorKey, entity) {
    const scaled = this.displacementColor(entity);
    if (scaled) return scaled;
    if (colorKey === "ineffective") return this.colors.ineffective;
    return this.colors[entity?.kind] ?? this.colors[colorKey];
  }

  // A point-like entity or a connector has no surface over which to interpolate,
  // so it keeps one representative colour: the mean nodal displacement. Shells
  // and members take the interpolated paths above instead.
  displacementColor(entity) {
    if (!this.colorByDisplacement) return null;
    const magnitudes = this.deformation?.magnitudes;
    const extent = this.deformation?.extent;
    if (!magnitudes || !(extent > 0)) return null;
    const at = (id) => this.nodeIndexById.get(stableIdKey(id));
    let total = 0;
    let counted = 0;
    for (const id of entity?.nodeIds ?? [entity?.id]) {
      const index = at(id);
      if (index == null) continue;
      total += magnitudes[index];
      counted += 1;
    }
    if (!counted) return null;
    this.scaleColor ||= new this.THREE.Color();
    return this.scaleColor.setRGB(...sampleColorScale(total / counted / extent));
  }

  // Reading the model as a field, or as a structure. The legend a panel draws
  // beside it comes from `colorScaleRange`.
  setColorByDisplacement(enabled) {
    const next = Boolean(enabled) && !this.memberDiagramResult;
    if (next === this.colorByDisplacement) return this.colorByDisplacement;
    this.colorByDisplacement = next;
    this.refreshInstanceColors();
    this.requestRender();
    return this.colorByDisplacement;
  }

  // What the ends of the scale mean, in the units the provider answered in. Zero
  // at the bottom rather than the smallest displacement there is: a field starts
  // at not having moved, and a legend that started elsewhere would say the parts
  // that stayed put had gone somewhere.
  colorScaleRange() {
    const extent = this.deformation?.extent;
    return extent > 0 ? { min: 0, max: extent } : null;
  }

  setEntityColor(mesh, entityIndex, color) {
    if (mesh.isInstancedMesh) {
      // A member owns a run of instances once it is drawn as a chain of
      // segments, so the range table answers here too: colouring only the first
      // would tint one segment of a bent beam and leave the rest of it.
      const instances = mesh.userData.gravissEntityRanges?.[entityIndex];
      // A hidden entity is drawn nowhere, so there is nothing of it to colour.
      if (instances?.count === 0) return;
      if (instances) {
        const last = instances.start + instances.count;
        for (let instance = instances.start; instance < last; instance += 1) {
          mesh.setColorAt(instance, color);
        }
      } else {
        mesh.setColorAt(entityIndex, color);
      }
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      return;
    }
    const range = mesh.userData.gravissEntityRanges?.[entityIndex];
    const colors = mesh.geometry.getAttribute("color");
    if (!range || !colors) return;
    const displacement = mesh.geometry.getAttribute("gravissDisplacement");
    if (displacement) {
      displacement.array.fill(-1, range.start, range.start + range.count);
      displacement.needsUpdate = true;
    }
    for (let vertex = range.start; vertex < range.start + range.count; vertex += 1) {
      color.toArray(colors.array, vertex * 3);
    }
    colors.needsUpdate = true;
  }

  shellEdgesVisible() {
    return this.visibility.mesh !== false;
  }

  // Everything drawn as a mark rather than as structure. A size of nothing puts
  // all four away at once, whatever their own switches say.
  static SYMBOL_KINDS = ["nodes", "supports", "springs", "couplings"];

  // A hidden layer does no animation work. Before it becomes visible again it
  // is brought directly to the current phase, so skipping all the intervening
  // frames can never make it jump back to stale geometry.
  syncDeformedLayer(name) {
    if (!this.nodePositions) return;
    if (name === "members") this.updateMemberDeformation();
    else if (name === "shells") this.updateShellSurface();
    else if (name === "nodes" && this.symbolsVisible()) this.placeNodeSymbols();
    else if (name === "supports" && this.symbolsVisible()) this.placeSupportSymbols();
    else if (name === "springs" && this.symbolsVisible()) this.placeConnectorSymbols("spring");
    else if (name === "couplings" && this.symbolsVisible()) this.placeConnectorSymbols("coupling");
  }

  applyVisibility() {
    for (const name of GravissRenderer.SYMBOL_KINDS) {
      const object = this.meshes[name];
      if (object) object.visible = this.visibility[name] && this.symbolsVisible();
    }
    return true;
  }

  setVisibility(name, visible) {
    if (!(name in this.visibility)) return;
    this.visibility[name] = Boolean(visible);
    // Turning the triads back on is when the rebuilds skipped while they were
    // hidden come due, and before the object is shown rather than after.
    if (name === "localAxes" && this.visibility.localAxes && this.localAxesStale) {
      this.rebuildLocalAxes();
    }
    if (this.visibility[name] && name !== "localAxes") this.syncDeformedLayer(name);
    const object = this.meshes[name] || this[name];
    if (object) {
      object.visible = name === "mesh" ? this.shellEdgesVisible() : this.visibility[name];
      if (GravissRenderer.SYMBOL_KINDS.includes(name)) {
        object.visible = object.visible && this.symbolsVisible();
      }
    }
    if (name === "mesh") {
      for (const contours of this.memberContours) contours.visible = this.visibility.mesh;
      if (this.visibility.mesh && this.shellState?.edgesStale) this.updateShellSurface();
    }
    if (name === "members") this.refreshMemberDiagram();
    if (
      this.selected &&
      object &&
      !object.visible &&
      (this.selected.object === object || object.getObjectById?.(this.selected.object.id))
    ) {
      this.setSelected(null);
    }
    // Hidden geometry is not part of the depth problem. Keeping it in the
    // cached scene box can hold the near plane far behind the visible model and
    // make close surfaces collapse into one depth value at a middle zoom.
    this.sceneBox = null;
    this.updateDepthRange();
    this.requestRender();
  }

  moveCamera(direction) {
    const movements = {
      left: [0, -1],
      right: [0, 1],
      up: [1, 1],
      down: [1, -1],
    };
    const movement = movements[direction];
    if (!movement) throw new RangeError(`Unsupported camera move direction: ${direction}`);
    return this.performCameraStep(() => {
      const distance = this.camera.position.distanceTo(this.controls.target);
      const visibleHeight = this.camera.isPerspectiveCamera
        ? perspectiveVisibleHeight(distance, this.camera.fov, this.camera.zoom)
        : (this.camera.top - this.camera.bottom) / this.camera.zoom;
      const axis = new this.THREE.Vector3(movement[0] === 0 ? 1 : 0, movement[0], 0)
        .applyQuaternion(this.camera.quaternion)
        .normalize()
        .multiplyScalar(visibleHeight * CAMERA_PAN_FRACTION * movement[1]);
      this.camera.position.add(axis);
      this.controls.target.add(axis);
      this.controls.update();
    });
  }

  rotateCamera(direction) {
    const rotations = {
      left: ["rotateLeft", CAMERA_ROTATION_STEP],
      right: ["rotateLeft", -CAMERA_ROTATION_STEP],
      up: ["rotateUp", CAMERA_ROTATION_STEP],
      down: ["rotateUp", -CAMERA_ROTATION_STEP],
    };
    const rotation = rotations[direction];
    if (!rotation) throw new RangeError(`Unsupported camera rotation direction: ${direction}`);
    return this.performCameraStep(() => this.controls[rotation[0]](rotation[1]));
  }

  zoomCamera(direction) {
    if (direction !== "in" && direction !== "out") {
      throw new RangeError(`Unsupported camera zoom direction: ${direction}`);
    }
    const method = direction === "in" ? "dollyIn" : "dollyOut";
    return this.performCameraStep(() => this.controls[method](CAMERA_ZOOM_SCALE));
  }

  performCameraStep(action) {
    if (this.destroyed) return false;
    this.cancelCameraAnimation();
    this.cancelScheduledCameraChange();
    action();
    this.viewCube?.setSelection(null);
    this.requestRender();
    this.notifyCameraChange();
    return this.captureCameraState();
  }

  setStandardView(name, { animate = false } = {}) {
    const viewId = name === "iso" ? "top-front-right" : name;
    const definition = cameraViewDefinition(viewId, this.coordinateSystem);
    const direction = new this.THREE.Vector3(...definition.direction);
    const up = new this.THREE.Vector3(...definition.up);
    if (animate) this.animateToFittedView(this.createFittedView(direction, up));
    else this.fitView(direction, up);
    this.viewCube?.setSelection(viewId);
  }

  fitView(direction = null, up = null) {
    this.cancelCameraAnimation();
    this.cancelZoomFlight();
    this.applyFittedView(this.createFittedView(direction, up));
  }

  // The frame a particular camera direction needs, measured in the camera's
  // own right/up plane. A circumscribed sphere is direction-blind: the radius
  // of a long bridge becomes a vertical requirement even when the bridge is
  // seen as a shallow horizontal strip. Projecting the visible model's bounds
  // instead makes the limiting screen dimension the one the picture actually
  // has. Perspective depth and its slightly asymmetric centre settle together
  // over a few cheap passes through the eight box corners.
  fittedProjection(viewDirection, cameraUp, aspect) {
    const THREE = this.THREE;
    const bounds = this.visibleModelBounds();
    const center = bounds.getCenter(new THREE.Vector3());
    const sphere = bounds.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius, this.bounds.radius * 1e-6);
    const forward = viewDirection.clone().negate().normalize();
    const right = new THREE.Vector3().crossVectors(forward, cameraUp);
    if (right.lengthSq() === 0) right.crossVectors(forward, this.modelYAxis);
    if (right.lengthSq() === 0) right.crossVectors(forward, this.worldUp);
    right.normalize();
    const screenUp = new THREE.Vector3().crossVectors(right, forward).normalize();
    const min = bounds.min.toArray();
    const max = bounds.max.toArray();
    const corner = new THREE.Vector3();
    const delta = new THREE.Vector3();
    const measure = (distance, perspective) => {
      let left = Infinity;
      let rightmost = -Infinity;
      let top = Infinity;
      let bottom = -Infinity;
      let minimumDepthOffset = Infinity;
      for (const x of [min[0], max[0]]) {
        for (const y of [min[1], max[1]]) {
          for (const z of [min[2], max[2]]) {
            delta.copy(corner.set(x, y, z)).sub(center);
            const depthOffset = delta.dot(forward);
            minimumDepthOffset = Math.min(minimumDepthOffset, depthOffset);
            const depth = distance + depthOffset;
            if (perspective && depth <= 0) continue;
            const scale = perspective ? distance / depth : 1;
            const across = delta.dot(right) * scale;
            const along = delta.dot(screenUp) * scale;
            left = Math.min(left, across);
            rightmost = Math.max(rightmost, across);
            top = Math.min(top, along);
            bottom = Math.max(bottom, along);
          }
        }
      }
      return {
        left,
        right: rightmost,
        top,
        bottom,
        width: rightmost - left,
        height: bottom - top,
        minimumDepthOffset,
      };
    };

    let distance = sphereFitDistance(
      radius,
      this.perspectiveCamera.fov,
      aspect,
      MODEL_FIT_FILL_FRACTION,
    );
    for (let pass = 0; pass < PROJECTED_EXTENT_PASSES; pass += 1) {
      const extent = measure(distance, true);
      if (!(extent.width > 0) || !(extent.height > 0)) break;
      center
        .addScaledVector(right, (extent.left + extent.right) / 2)
        .addScaledVector(screenUp, (extent.top + extent.bottom) / 2);
      const requiredHeight =
        Math.max(extent.height, extent.width / aspect) / MODEL_FIT_FILL_FRACTION;
      const fittedDistance = perspectiveDistanceForHeight(
        requiredHeight,
        this.perspectiveCamera.fov,
        this.perspectiveCamera.zoom,
      );
      // Keep every corner in front of the near plane even for a view looking
      // almost along a very long model.
      const depthSafeDistance = -extent.minimumDepthOffset + Math.max(0.01, radius * 0.01);
      distance = Math.max(fittedDistance, depthSafeDistance);
    }

    const parallel = measure(distance, false);
    if (!this.camera.isPerspectiveCamera) {
      center
        .addScaledVector(right, (parallel.left + parallel.right) / 2)
        .addScaledVector(screenUp, (parallel.top + parallel.bottom) / 2);
    }
    const orthographicHeight =
      Math.max(parallel.height, parallel.width / aspect) / MODEL_FIT_FILL_FRACTION;
    return { center, radius, distance, orthographicHeight };
  }

  createFittedView(direction = null, up = null) {
    const viewDirection = direction || this.camera.position.clone().sub(this.controls.target);
    if (viewDirection.lengthSq() === 0) {
      viewDirection.fromArray(canonicalDirectionToModel([1, -1, 0.8], this.coordinateSystem));
    }
    viewDirection.normalize();
    const width = Math.max(1, this.host.clientWidth || 800);
    const height = Math.max(1, this.host.clientHeight || 600);
    const aspect = width / height;
    const cameraUp = up || this.camera.up.clone();
    const { center, radius, distance, orthographicHeight } = this.fittedProjection(
      viewDirection,
      cameraUp,
      aspect,
    );
    return {
      center,
      viewDirection,
      cameraUp,
      radius,
      distance,
      aspect,
      orthographicHeight,
    };
  }

  applyFittedView(fittedView) {
    const { center, viewDirection, cameraUp, radius, distance, aspect, orthographicHeight } =
      fittedView;
    for (const camera of [this.perspectiveCamera, this.orthographicCamera]) {
      camera.up.copy(cameraUp);
      camera.position.copy(center).addScaledVector(viewDirection, distance);
      camera.near = Math.max(0.01, distance / 1000);
      camera.far = distance + radius * 20;
      camera.lookAt(center);
      camera.up.copy(this.worldUp);
      camera.updateProjectionMatrix();
    }
    this.orthographicHeight = orthographicHeight;
    this.updateOrthographicFrustum(aspect);
    this.controls.dispose();
    this.controls = this.createControls(this.camera, center);
    this.controls.maxDistance = distance * 10;
    this.controls.update();
    this.requestRender();
    this.notifyCameraChange();
  }

  animateToFittedView(fittedView) {
    this.cancelCameraAnimation();
    this.cancelScheduledCameraChange();
    const startPosition = this.camera.position.clone();
    const startTarget = this.controls.target.clone();
    const startQuaternion = this.camera.quaternion.clone();
    const endPosition = fittedView.center
      .clone()
      .addScaledVector(fittedView.viewDirection, fittedView.distance);
    const destinationCamera = this.camera.clone();
    destinationCamera.position.copy(endPosition);
    destinationCamera.up.copy(fittedView.cameraUp);
    destinationCamera.lookAt(fittedView.center);
    const endQuaternion = destinationCamera.quaternion.clone();
    let startedAt = null;

    this.controls.enabled = false;
    this.cameraAnimationTarget = fittedView;
    const step = (timestamp) => {
      if (this.destroyed) return;
      startedAt ??= timestamp;
      const elapsed = Math.max(0, timestamp - startedAt);
      const progress = Math.min(1, elapsed / CAMERA_VIEW_ANIMATION_MS);
      const eased = easeInOutCubic(progress);
      this.camera.position.lerpVectors(startPosition, endPosition, eased);
      this.controls.target.lerpVectors(startTarget, fittedView.center, eased);
      this.camera.quaternion.slerpQuaternions(startQuaternion, endQuaternion, eased);
      this.camera.up.copy(this.worldUp);
      this.updateDepthRange();
      this.requestRender();

      if (progress < 1) {
        this.cameraAnimationFrame = requestAnimationFrame(step);
        return;
      }

      this.cameraAnimationFrame = null;
      this.cameraAnimationTarget = null;
      this.controls.enabled = true;
      this.applyFittedView(fittedView);
    };
    this.cameraAnimationFrame = requestAnimationFrame(step);
  }

  cancelCameraAnimation() {
    this.cancelZoomFlight();
    if (this.cameraAnimationFrame != null) cancelAnimationFrame(this.cameraAnimationFrame);
    this.cameraAnimationFrame = null;
    this.cameraAnimationTarget = null;
    if (this.controls) this.controls.enabled = true;
  }

  finishCameraAnimation() {
    const fittedView = this.cameraAnimationTarget;
    if (!fittedView) return false;
    if (this.cameraAnimationFrame != null) cancelAnimationFrame(this.cameraAnimationFrame);
    this.cameraAnimationFrame = null;
    this.cameraAnimationTarget = null;
    this.controls.enabled = true;
    this.applyFittedView(fittedView);
    return true;
  }

  setProjection(projection) {
    this.cancelCameraAnimation();
    // The eased value is a depth in one projection and a framing in the other,
    // so a flight cannot survive the change of meaning.
    this.cancelZoomFlight();
    if (projection !== "perspective" && projection !== "orthographic") {
      throw new RangeError(`Unsupported Graviss projection: ${projection}`);
    }
    if (projection === this.projection) {
      this.callbacks.onProjectionChange?.(this.projection);
      return this.projection;
    }
    const previous = this.camera;
    const target = this.controls.target.clone();
    const offset = previous.position.clone().sub(target);
    const distance = Math.max(offset.length(), 1e-6);
    const direction = offset.normalize();
    this.projection = projection;
    this.camera =
      this.projection === "perspective" ? this.perspectiveCamera : this.orthographicCamera;
    if (this.projection === "orthographic") {
      this.orthographicHeight = perspectiveVisibleHeight(
        distance,
        this.perspectiveCamera.fov,
        this.perspectiveCamera.zoom,
      );
      this.orthographicCamera.zoom = 1;
      this.camera.position.copy(previous.position);
    } else {
      const visibleHeight = this.orthographicHeight / this.orthographicCamera.zoom;
      const perspectiveDistance = perspectiveDistanceForHeight(
        visibleHeight,
        this.perspectiveCamera.fov,
        this.perspectiveCamera.zoom,
      );
      this.camera.position.copy(target).addScaledVector(direction, perspectiveDistance);
    }
    this.camera.quaternion.copy(previous.quaternion);
    this.camera.up.copy(previous.up);
    this.controls.object = this.camera;
    this.updateOrthographicFrustum(
      Math.max(1, this.host.clientWidth || 800) / Math.max(1, this.host.clientHeight || 600),
    );
    this.controls.update();
    this.callbacks.onProjectionChange?.(this.projection);
    this.requestRender();
    this.notifyCameraChange();
    return this.projection;
  }

  toggleProjection() {
    return this.setProjection(this.projection === "perspective" ? "orthographic" : "perspective");
  }

  applyCameraState(cameraState) {
    this.cancelCameraAnimation();
    this.cancelZoomFlight();
    this.cancelScheduledCameraChange();
    const state = validateCameraState(cameraState);
    const THREE = this.THREE;
    this.suppressCameraChange += 1;
    try {
      this.setProjection(state.projection);
      if (state.fieldOfView != null) {
        this.perspectiveCamera.fov = state.fieldOfView;
        this.perspectiveCamera.updateProjectionMatrix();
      }
      if (state.frustumHeight != null) {
        this.orthographicHeight = state.frustumHeight;
        this.orthographicCamera.zoom = 1;
        this.updateOrthographicFrustum(
          Math.max(1, this.host.clientWidth || 800) / Math.max(1, this.host.clientHeight || 600),
        );
      }

      const position = new THREE.Vector3(...state.position);
      const target = new THREE.Vector3(...state.target);
      const up = new THREE.Vector3(...state.up);
      const distance = position.distanceTo(target);
      this.camera.position.copy(position);
      this.camera.up.copy(up);
      this.camera.near = Math.max(0.01, distance / 1000);
      this.camera.far = distance + this.bounds.radius * 20;
      this.camera.lookAt(target);
      this.camera.up.copy(this.worldUp);
      this.camera.updateProjectionMatrix();
      this.controls.dispose();
      this.controls = this.createControls(this.camera, target);
      this.controls.maxDistance = Math.max(distance * 10, this.bounds.radius * 20);
      this.controls.update();
      this.viewCube?.setSelection(null);
      this.requestRender();
      return state;
    } finally {
      this.suppressCameraChange -= 1;
    }
  }

  captureCameraState() {
    const state = {
      projection: this.projection,
      position: this.camera.position.toArray().map(cleanNumber),
      target: this.controls.target.toArray().map(cleanNumber),
      up: this.camera.up.toArray().map(cleanNumber),
    };
    if (this.projection === "perspective") {
      state.fieldOfView = cleanNumber(this.perspectiveCamera.fov);
    } else {
      state.frustumHeight = cleanNumber(this.orthographicHeight / this.orthographicCamera.zoom);
    }
    return state;
  }

  notifyCameraChange() {
    this.cancelScheduledCameraChange();
    this.emitCameraChange();
  }

  scheduleCameraChange() {
    if (this.destroyed || this.suppressCameraChange > 0) return;
    this.wheelCameraChangePending = true;
    if (this.cameraChangeTimer != null) clearTimeout(this.cameraChangeTimer);
    this.cameraChangeTimer = setTimeout(() => {
      this.cameraChangeTimer = null;
      this.wheelCameraChangePending = false;
      this.emitCameraChange();
    }, CAMERA_SCROLL_SETTLE_MS);
  }

  flushScheduledCameraChange() {
    const finishedAnimation = this.finishCameraAnimation();
    if (this.cameraChangeTimer == null) return finishedAnimation;
    clearTimeout(this.cameraChangeTimer);
    this.cameraChangeTimer = null;
    this.wheelCameraChangePending = false;
    this.emitCameraChange();
    return true;
  }

  cancelScheduledCameraChange() {
    if (this.cameraChangeTimer != null) clearTimeout(this.cameraChangeTimer);
    this.cameraChangeTimer = null;
    this.wheelCameraChangePending = false;
  }

  emitCameraChange() {
    if (this.destroyed || this.suppressCameraChange > 0) return;
    this.callbacks.onCameraChange?.(this.captureCameraState());
  }

  requestRender() {
    if (
      this.destroyed ||
      this.renderSuspended ||
      this.renderFrame != null ||
      !this.isViewportDrawable()
    )
      return;
    this.renderFrame = requestAnimationFrame((timestamp) => {
      this.renderFrame = null;
      this.paintFrame(timestamp);
    });
  }

  // Render immediately while a View Transition is collecting its new state.
  // All other scene changes stay coalesced through `requestRender`.
  flushRender() {
    if (this.destroyed || this.renderSuspended || !this.isViewportDrawable()) return;
    if (this.renderFrame != null) cancelAnimationFrame(this.renderFrame);
    this.renderFrame = null;
    this.paintFrame();
  }

  // Finish an atomic initialization. Every scene mutation made while paused is
  // already in memory, so one synchronous frame is enough and can be revealed
  // by the owner immediately afterwards without exposing any construction
  // state to the compositor.
  resumeRendering() {
    if (this.destroyed || !this.renderSuspended) return false;
    this.renderSuspended = false;
    this.flushRender();
    // start() may have requested the animation's first frame while rendering
    // was paused. That request was intentionally suppressed with every other
    // construction frame, so restart the clock after the complete still has
    // been painted.
    if (this.animation?.running) this.requestRender();
    return true;
  }

  // One painted frame. Scheduled through requestRender for everything that
  // can wait until the next animation frame — and called directly from
  // resize, because resizing the drawing buffer clears it on the spot: a
  // repaint left to the next frame lets the compositor show the empty canvas
  // first, and the pane flashes its bare background on every step of a drag.
  paintFrame(timestamp = null) {
    if (this.destroyed || !this.isViewportDrawable()) return;
    // An animation moves the model before the frame it moved it for is drawn,
    // and asks for the next one itself. It never draws: this is the only place
    // that does, which is what keeps rendering on demand.
    if (timestamp != null) this.animation?.advance(timestamp);
    if (this.destroyed) return;
    this.ensureGpuShellFrame();
    this.camera.updateMatrixWorld(true);
    this.placeSky();
    this.paintPrintRegion();
    this.updateLighting();
    if (this.orientationGizmo) {
      this.orientationGizmo.update(this.camera.quaternion);
      const mainAxesVisible =
        this.visibility.axes && isWorldPointVisible(this.axes.position, this.camera);
      this.orientationGizmo.element.hidden = !this.visibility.axes || mainAxesVisible;
    }
    this.viewCube?.update(this.camera.quaternion);
    this.renderModel();
    if (timestamp != null) this.frameRateMeter.record(timestamp);
  }

  getSceneSummary() {
    const members = this.geometry.elements.filter(({ kind }) =>
      LINE_ELEMENT_KINDS.has(kind),
    ).length;
    const shells = this.geometry.elements.filter(({ kind }) => kind === "shell").length;
    return {
      members,
      shells,
      nodes: this.geometry.nodes.length,
      supports: (this.geometry.supports || []).length,
      pickables: this.pickables.length,
    };
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.endRegionSelection(null);
    this.releaseOrbitPivot();
    this.cancelZoomFlight();
    this.disposeSky();
    if (this.renderFrame != null) cancelAnimationFrame(this.renderFrame);
    this.cancelCameraAnimation();
    this.cancelScheduledCameraChange();
    this.frameRateMeter.dispose();
    this.shellGpu?.dispose();
    this.viewportVisibility?.dispose();
    const canvas = this.canvasRenderer?.domElement;
    canvas?.removeEventListener("webglcontextlost", this.onContextLost);
    canvas?.removeEventListener("webglcontextrestored", this.onContextRestored);
    canvas?.removeEventListener("pointerdown", this.onPointerDown);
    canvas?.removeEventListener("pointerup", this.onPointerUp);
    canvas?.removeEventListener("pointercancel", this.onPointerUp);
    this.host?.removeEventListener("wheel", this.onWheel, true);
    this.controls?.dispose();
    this.viewCube?.destroy();
    this.memberDiagram?.dispose();
    const shellZoomProxy = this.meshes?.shells?.userData.gravissZoomProxy;
    shellZoomProxy?.geometry.dispose();
    shellZoomProxy?.material.dispose();
    this.scene?.traverse((object) => {
      object.geometry?.dispose?.();
      if (Array.isArray(object.material)) {
        object.material.forEach((material) => material.dispose?.());
      } else {
        object.material?.dispose?.();
      }
    });
    this.canvasRenderer?.dispose();
    this.canvasRenderer?.forceContextLoss();
    canvas?.remove();
  }
}

// A wheel notch, whatever units the device quotes its deltas in. A mouse
// reports about 120 pixels a notch; a trackpad reports a stream of much smaller
// pixel deltas, which is what makes the step a smooth fraction rather than a
// count.
function wheelNotches(event) {
  const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
  const delta = event.deltaY * scale;
  if (!Number.isFinite(delta) || delta === 0) return 0;
  return -delta / 120;
}

// `shellEdge` names the property `--graviss-shell-edge`, the way a custom
// property is spelt.
function dashedName(key) {
  return key.replace(
    /([a-z])([A-Z])/g,
    (unused, lower, upper) => `${lower}-${upper.toLowerCase()}`,
  );
}

// One number standing for the whole, for the triad that marks the element.
function meanOffset(element) {
  const declared = element.offset;
  if (!Array.isArray(declared)) return Number.isFinite(declared) ? declared : 0;
  const usable = declared.filter(Number.isFinite);
  if (!usable.length) return 0;
  return usable.reduce((total, value) => total + value, 0) / usable.length;
}

function cleanNumber(value) {
  const rounded = Number(value.toPrecision(12));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function easeInOutCubic(progress) {
  return progress < 0.5
    ? 4 * progress * progress * progress
    : 1 - Math.pow(-2 * progress + 2, 3) / 2;
}

module.exports = {
  DEFAULT_VISIBILITY,
  GravissRenderer,
  entityIndexAtVertex,
  geometryBounds,
  isWorldPointVisible,
};
