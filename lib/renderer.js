const { APPEARANCE_IDS, appearanceDefinition } = require("./appearance");
const {
  cameraViewDefinition,
  cameraViewIdForDirection,
  orthographicFitHeight,
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

const CAMERA_SCROLL_SETTLE_MS = 180;
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
// Enough vertices for either, so one buffer serves both and a spring changing
// kind needs no new one.
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
const TRIANGLE_FACES = [[0, 1, 2]];
const QUAD_FACES = [
  [0, 1, 2],
  [0, 2, 3],
];

function entityKey(type, id) {
  return `${type}:${typeof id}:${id}`;
}

// Flat-shaded normals for a non-indexed triangle soup, written straight into
// the existing typed array. Matches THREE.BufferGeometry#computeVertexNormals
// for this geometry — every vertex belongs to exactly one face — while
// avoiding its per-vertex attribute accessors.
function computeFlatVertexNormals(geometry) {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  if (!position || !normal) return;
  const points = position.array;
  const normals = normal.array;
  for (let index = 0; index + 8 < points.length; index += 9) {
    const ax = points[index];
    const ay = points[index + 1];
    const az = points[index + 2];
    const bx = points[index + 3];
    const by = points[index + 4];
    const bz = points[index + 5];
    const cx = points[index + 6];
    const cy = points[index + 7];
    const cz = points[index + 8];
    const e1x = cx - bx;
    const e1y = cy - by;
    const e1z = cz - bz;
    const e2x = ax - bx;
    const e2y = ay - by;
    const e2z = az - bz;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (length > 0) {
      nx /= length;
      ny /= length;
      nz /= length;
    }
    normals[index] = nx;
    normals[index + 1] = ny;
    normals[index + 2] = nz;
    normals[index + 3] = nx;
    normals[index + 4] = ny;
    normals[index + 5] = nz;
    normals[index + 6] = nx;
    normals[index + 7] = ny;
    normals[index + 8] = nz;
  }
  normal.needsUpdate = true;
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
  static async create(host, geometry, callbacks = {}) {
    const { THREE, OrbitControls } = await loadThreeRuntime();
    const renderer = new GravissRenderer(host, geometry, callbacks, THREE, OrbitControls);
    try {
      renderer.initialize();
      return renderer;
    } catch (error) {
      renderer.destroy();
      throw error;
    }
  }

  constructor(host, geometry, callbacks, THREE, OrbitControls) {
    this.host = host;
    this.geometry = geometry;
    this.callbacks = callbacks;
    this.coordinateSystem = coordinateSystemDefinition(callbacks.coordinateSystem);
    this.THREE = THREE;
    this.OrbitControls = OrbitControls;
    this.bounds = geometryBounds(geometry);
    this.visibility = {
      members: true,
      shells: true,
      nodes: true,
      supports: true,
      mesh: true,
      grid: true,
      axes: true,
      localAxes: false,
      springs: true,
      couplings: true,
    };
    this.pickables = [];
    this.memberContours = [];
    this.meshes = {};
    this.selected = null;
    this.destroyed = false;
    this.renderFrame = null;
    this.pointerDown = null;
    this.orbitPivot = null;
    this.orbitPivotElement = null;
    this.orbitPivotEnabled = true;
    this.orbitPivotMarkerVisible = true;
    this.zoomTowardPointer = true;
    this.symbolSize = null;
    this.backgroundGradient = false;
    this.sky = null;
    this.smoothZoom = true;
    this.zoomFlight = null;
    this.zoomFrame = null;
    this.zoomFrameTime = null;
    this.regionSelection = null;
    this.projection = "perspective";
    this.appearance = "auto";
    this.sectionRendering = true;
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
    UNIT_X ||= new THREE.Vector3(1, 0, 0);
    UNIT_Y ||= new THREE.Vector3(0, 1, 0);
    UNIT_Z ||= new THREE.Vector3(0, 0, 1);
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
    this.viewCube = new ViewCube(THREE, viewElement.querySelector(".graviss-view-cube"), {
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
    const THREE = this.THREE;
    const probe = document.createElement("span");
    probe.style.color = `var(${variable}, ${fallback})`;
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    this.host.appendChild(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    const color = new THREE.Color(fallback);
    try {
      color.setStyle(resolved || fallback);
    } catch {
      color.set(fallback);
    }
    return color;
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
    this.fillLight = new THREE.DirectionalLight(0xd8e9f6, 0.7);
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
      .multiplyScalar(0.4)
      .addScaledVector(right, 0.8)
      .addScaledVector(up, -0.55)
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
    const THREE = this.THREE;
    const box = new THREE.Box3();
    const instanced = new THREE.Box3();
    this.scene.updateMatrixWorld(true);
    for (const child of this.scene.children) {
      if (child === this.sky) continue;
      child.traverse((node) => {
        if (!node.isInstancedMesh) return;
        node.computeBoundingBox();
        if (node.boundingBox) {
          instanced.copy(node.boundingBox).applyMatrix4(node.matrixWorld);
          box.union(instanced);
        }
      });
      box.expandByObject(child);
    }
    return box;
  }

  // How far the camera stands outside everything drawable; zero from inside.
  sceneClearance() {
    this.sceneBox ??= this.computeSceneBox();
    if (this.sceneBox.isEmpty()) return 0;
    return this.sceneBox.distanceToPoint(this.camera.position);
  }

  createModelGeometry() {
    this.sceneBox = null;
    const nodesById = new Map(
      this.geometry.nodes.map((node) => [`${typeof node.id}:${node.id}`, node]),
    );
    this.nodesById = nodesById;
    this.buildNodeIndex();
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

  // Without section rendering a line element is a line: one segment per member
  // in a single buffer, coloured per vertex through the same entity ranges the
  // shell surface uses, so selection and appearance need no separate path.
  createMemberLines(elements) {
    const THREE = this.THREE;
    const positions = new Float32Array(elements.length * 6);
    const colors = new Float32Array(elements.length * 6);
    const ranges = new Array(elements.length);
    const nodes = this.nodePositions;
    elements.forEach((element, index) => {
      const start = this.nodeIndex(element.nodeIds[0]) * 3;
      const end = this.nodeIndex(element.nodeIds[1]) * 3;
      const cursor = index * 6;
      positions[cursor] = nodes[start];
      positions[cursor + 1] = nodes[start + 1];
      positions[cursor + 2] = nodes[start + 2];
      positions[cursor + 3] = nodes[end];
      positions[cursor + 4] = nodes[end + 1];
      positions[cursor + 5] = nodes[end + 2];
      ranges[index] = { start: index * 2, count: 2 };
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const colorAttribute = new THREE.BufferAttribute(colors, 3);
    colorAttribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("color", colorAttribute);
    geometry.computeBoundingSphere();
    // A colour attribute is present here, so vertex colours are correct.
    const material = new THREE.LineBasicMaterial({ vertexColors: true });
    const memberGroup = new THREE.Group();
    memberGroup.name = "graviss-members";
    this.meshes.members = memberGroup;
    this.scene.add(memberGroup);
    const lines = new THREE.LineSegments(geometry, material);
    lines.userData.gravissEntityRanges = ranges;
    lines.userData.gravissLineSegments = true;
    this.memberMaterial = material;
    this.registerPickable("element", lines, elements, "members", "element", memberGroup);
  }

  // Member matrices read node positions straight out of this flat array by
  // index, which is cheaper than resolving each node through a string-keyed
  // Map every time the element detail level rebuilds them.
  buildNodeIndex() {
    const nodes = this.geometry.nodes;
    this.nodeIndexById = new Map();
    this.nodePositions = new Float32Array(nodes.length * 3);
    nodes.forEach((node, index) => {
      this.nodeIndexById.set(stableIdKey(node.id), index);
      this.nodePositions[index * 3] = node.x;
      this.nodePositions[index * 3 + 1] = node.y;
      this.nodePositions[index * 3 + 2] = node.z;
    });
  }

  nodeIndex(id) {
    return this.nodeIndexById.get(stableIdKey(id));
  }

  createMemberGeometry(nodesById, elements) {
    this.memberContours = [];
    if (elements.length === 0) return;
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
    // Every section group shades identically, so one material keeps the
    // renderer from re-binding program state per group; the merged geometry
    // carries its tint per vertex, exactly as the shell fill does.
    //
    // Unlike the shell fill, a member fill WINS depth ties. A member is a
    // solid laid onto or through a meshed surface, and an eccentric girder
    // ends up with its face exactly in the slab's plane: coplanar to the
    // micrometre, so no order of strict tests can put the flange over the
    // slab's mesh lines — they tie. Where the tie happens, the member is the
    // physical thing being looked at and the discretization lines yield.
    const memberMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.55,
      metalness: 0.12,
      vertexColors: true,
      depthFunc: THREE.LessEqualDepth,
      // Every pixel this fill visibly wins is marked, and the contours draw
      // only on the marks that survive the shell fill — so an arris finishes
      // exactly where the visible member surface does, however thin a sliver
      // of the body technically protrudes.
      stencilWrite: true,
      stencilRef: 1,
      stencilZPass: THREE.ReplaceStencilOp,
    });
    this.memberMaterial = memberMaterial;
    for (const group of groups.values()) {
      const unit = this.createSectionGeometry(group.section?.shape);
      // One matrix per element, applied verbatim to the fill and to the
      // contours: both are baked on the CPU from the same unit vertices with
      // the same arithmetic, so a contour lies on its fill to the bit and
      // needs no offset, no inflation and no other epsilon to win the depth
      // tie it is entitled to.
      const matrices = group.elements.map((element) => this.memberElementMatrix(element));
      this.bakeMemberFill(unit, matrices, group.elements, memberGroup);
      memberGroup.add(this.createMemberContours(unit, matrices));
      unit.dispose();
    }
  }

  // One member's placement: unit length along X becomes the run between its
  // nodes, with the section plane oriented by the element's stated local Y,
  // or by the world up when it states none.
  memberElementMatrix(element) {
    const THREE = this.THREE;
    const { quaternion, basis, xAxis, yAxis, zAxis, midpoint, scale } = this.memberScratch();
    const positions = this.nodePositions;
    const first = this.nodeIndex(element.nodeIds[0]) * 3;
    const second = this.nodeIndex(element.nodeIds[1]) * 3;
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
    basis.makeBasis(xAxis, yAxis, zAxis);
    quaternion.setFromRotationMatrix(basis);
    scale.set(length, 1, 1);
    return new THREE.Matrix4().compose(midpoint, quaternion, scale);
  }

  // The member fill, stamped element by element into one merged buffer — on
  // the CPU, deliberately, so the contours built from the same matrices tie
  // with it exactly. Coloured per vertex through entity ranges and picked
  // through the face map: the same registration the shell surface uses.
  bakeMemberFill(unit, matrices, elements, memberGroup) {
    const THREE = this.THREE;
    const source = unit.getIndex() ? unit.toNonIndexed() : unit;
    const unitPositions = source.getAttribute("position");
    const unitNormals = source.getAttribute("normal");
    const vertsPerElement = unitPositions.count;
    const positions = new Float32Array(matrices.length * vertsPerElement * 3);
    const normals = new Float32Array(matrices.length * vertsPerElement * 3);
    const faceToEntityIndex = new Int32Array((matrices.length * vertsPerElement) / 3);
    const entityRanges = [];
    const point = new THREE.Vector3();
    const normalMatrix = new THREE.Matrix3();
    let cursor = 0;
    matrices.forEach((matrix, index) => {
      normalMatrix.getNormalMatrix(matrix);
      entityRanges.push({ start: index * vertsPerElement, count: vertsPerElement });
      faceToEntityIndex.fill(
        index,
        (index * vertsPerElement) / 3,
        ((index + 1) * vertsPerElement) / 3,
      );
      for (let vertex = 0; vertex < vertsPerElement; vertex += 1) {
        point.fromBufferAttribute(unitPositions, vertex).applyMatrix4(matrix);
        positions[cursor] = point.x;
        positions[cursor + 1] = point.y;
        positions[cursor + 2] = point.z;
        point.fromBufferAttribute(unitNormals, vertex).applyMatrix3(normalMatrix).normalize();
        normals[cursor] = point.x;
        normals[cursor + 1] = point.y;
        normals[cursor + 2] = point.z;
        cursor += 3;
      }
    });
    if (source !== unit) source.dispose();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    const colors = new THREE.BufferAttribute(new Float32Array(positions.length), 3);
    colors.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("color", colors);
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, this.memberMaterial);
    // Every fill draws after every line. This fill wins its ties, so a flush
    // flange claims its band from the slab's mesh lines; its own contours
    // draw after it and tie back over it exactly.
    mesh.renderOrder = 2;
    mesh.userData.gravissEntityRanges = entityRanges;
    mesh.userData.gravissFaceToEntityIndex = faceToEntityIndex;
    this.registerPickable("element", mesh, elements, "members", "element", memberGroup);
    return mesh;
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
  createMemberContours(unit, matrices) {
    const THREE = this.THREE;
    const unitEdges = new THREE.EdgesGeometry(unit);
    const unitPositions = unitEdges.getAttribute("position");
    const positions = new Float32Array(matrices.length * unitPositions.count * 3);
    const point = new THREE.Vector3();
    let cursor = 0;
    for (const matrix of matrices) {
      for (let vertex = 0; vertex < unitPositions.count; vertex += 1) {
        point.fromBufferAttribute(unitPositions, vertex).applyMatrix4(matrix);
        positions[cursor] = point.x;
        positions[cursor + 1] = point.y;
        positions[cursor + 2] = point.z;
        cursor += 3;
      }
    }
    unitEdges.dispose();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.computeBoundingSphere();
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
    contours.name = "graviss-member-contours";
    contours.renderOrder = 5;
    contours.visible = this.visibility.mesh !== false;
    this.memberContours.push(contours);
    return contours;
  }

  memberScratch() {
    const THREE = this.THREE;
    this._memberScratch ||= {
      quaternion: new THREE.Quaternion(),
      basis: new THREE.Matrix4(),
      xAxis: new THREE.Vector3(),
      yAxis: new THREE.Vector3(),
      zAxis: new THREE.Vector3(),
      midpoint: new THREE.Vector3(),
      scale: new THREE.Vector3(1, 1, 1),
    };
    return this._memberScratch;
  }

  createSectionGeometry(shape) {
    const THREE = this.THREE;
    // A member whose section the source never supplied still has to be drawn,
    // so it falls back to a thin round bar.
    if (!shape) {
      const geometry = new THREE.CylinderGeometry(0.055, 0.055, 1, 8, 1, false);
      geometry.rotateZ(-Math.PI / 2);
      return geometry;
    }
    if (shape.kind === "rectangle") {
      return new THREE.BoxGeometry(1, shape.width, shape.height);
    }
    if (shape.kind === "circle") {
      const geometry = new THREE.CylinderGeometry(
        shape.diameter / 2,
        shape.diameter / 2,
        1,
        16,
        1,
        false,
      );
      geometry.rotateZ(-Math.PI / 2);
      return geometry;
    }
    if (shape.kind === "tube") {
      const outline = new THREE.Shape();
      outline.absarc(0, 0, shape.diameter / 2, 0, Math.PI * 2, false);
      const hole = new THREE.Path();
      hole.absarc(0, 0, shape.diameter / 2 - shape.thickness, 0, Math.PI * 2, true);
      outline.holes.push(hole);
      return this.extrudeSectionShape(outline, 16);
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
      return this.extrudeSectionShape(outline, 1);
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
      return this.extrudeSectionShape(outlines.length === 1 ? outlines[0] : outlines, 8);
    }
    if (shape.kind === "plates") {
      // One outline per plate, all of them in one extrusion. Plates that meet
      // are drawn meeting rather than merged: the seam between two plates of a
      // built-up section is an edge the section really has, and a boolean
      // union would be a shape nobody described.
      const outlines = shape.plates.map((plate) => this.createPlatePath(THREE.Shape, plate));
      return this.extrudeSectionShape(outlines.length === 1 ? outlines[0] : outlines, 1);
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

  createSectionPath(PathType, points) {
    const path = new PathType();
    path.moveTo(points[0][0], points[0][1]);
    for (const point of points.slice(1)) path.lineTo(point[0], point[1]);
    path.closePath();
    return path;
  }

  extrudeSectionShape(shape, curveSegments) {
    const geometry = new this.THREE.ExtrudeGeometry(shape, {
      depth: 1,
      bevelEnabled: false,
      curveSegments,
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

  createShellGeometry(nodesById, elements) {
    if (elements.length === 0) return;
    const THREE = this.THREE;
    const shared = sharedNodeSurfaces(elements, nodesById);
    const prepared = elements.map((element) => {
      const nodes = element.nodeIds.map((nodeId) => nodesById.get(`${typeof nodeId}:${nodeId}`));
      const layers = this.shellLayerCount(element);
      // Half the thickness either side, along the element's own normal — and
      // per node, because an area element can be thicker at one corner than at
      // another. A single number is the same number at every one of them.
      const half = layers === 2 ? elementHalfThickness(element, nodes.length, shared.halves) : null;
      // Where the element's own body sits relative to the nodes it was meshed
      // on. A slab modelled at its top face, a deck sitting on beams: the
      // nodes stay where the analysis put them and the body is drawn where it
      // physically is. Nodes are shared between elements that offset
      // differently, so this belongs to the element and never to the node —
      // and it belongs to the body alone: without section rendering the
      // element is the analysis surface itself, and that surface is where the
      // nodes are. Drawn eccentric it would hang half a thickness clear of the
      // supports, springs and couplings that meet it there.
      const middle = this.sectionRendering
        ? elementOffsets(element, nodes.length, shared.offsets)
        : new Array(nodes.length).fill(0);
      // Displaced along the surface normal at each node, never along one plane
      // for the whole element: a quad's four nodes need not be planar, and a
      // single normal would flatten a warped element onto the plane of its
      // first three corners.
      const normals = cornerDisplacementNormals(element, nodes, shared.normals);
      const sideKeys =
        layers === 2
          ? nodes.map((unused, index) =>
              sideFaceKey(nodes, normals, middle, half, index, (index + 1) % nodes.length),
            )
          : null;
      return { nodes, layers, half, middle, normals, sideKeys };
    });
    // A side face exists to close a body against open air. Where two elements
    // meet with the same displaced corners the body continues through the seam
    // and each element's wall lies exactly on its neighbour's — a coincident
    // twin the depth buffer cannot order, so at distance the seam flickers as
    // one or the other wins pixel by pixel. Neither wall is drawn: a seam both
    // bodies continue through has no wall to show. A genuine step keeps both,
    // because its corners differ by the length of the step.
    const sideFaceOwners = new Map();
    for (const { sideKeys } of prepared) {
      for (const key of sideKeys ?? []) {
        sideFaceOwners.set(key, (sideFaceOwners.get(key) ?? 0) + 1);
      }
    }
    let triangleCount = 0;
    let edgeCount = 0;
    for (const item of prepared) {
      item.sideWanted = item.sideKeys?.map((key) => sideFaceOwners.get(key) === 1) ?? null;
      // The lines that join the two faces mark facet boundaries on the side
      // band, so one is kept while either side face beside it shows; a corner
      // whose walls are all suppressed sits inside the body.
      item.joinWanted =
        item.sideWanted?.map(
          (unused, index, wanted) =>
            wanted[index] || wanted[(index - 1 + wanted.length) % wanted.length],
        ) ?? null;
      const corners = item.nodes.length;
      triangleCount += (corners === 3 ? 1 : 2) * item.layers;
      // A thick element is a closed solid: each exposed perimeter edge carries
      // a side face of two triangles between the two parallel faces.
      if (item.layers === 2) {
        triangleCount += item.sideWanted.filter(Boolean).length * 2;
      }
      edgeCount += corners * item.layers;
      // A solid's side faces need the edges that join its two faces, or each
      // one reads as a single band running the length of the plate rather than
      // as the row of element facets it is.
      if (item.layers === 2) edgeCount += item.joinWanted.filter(Boolean).length;
    }
    const vertexCount = triangleCount * 3;
    const positions = new Float32Array(vertexCount * 3);
    const edgePositions = new Float32Array(edgeCount * 6);
    const entityRanges = [];
    const faceToEntityIndex = new Int32Array(triangleCount);
    let vertexCursor = 0;
    let edgeCursor = 0;
    let faceCursor = 0;

    prepared.forEach((item, entityIndex) => {
      const { nodes, layers, half, middle, normals, sideWanted, joinWanted } = item;
      const triangles = nodes.length === 3 ? TRIANGLE_FACES : QUAD_FACES;
      const start = vertexCursor;
      for (let layer = 0; layer < layers; layer += 1) {
        const away = layers === 1 ? 0 : layer === 0 ? 1 : -1;
        for (const triangle of triangles) {
          for (const nodeIndex of triangle) {
            const node = nodes[nodeIndex];
            const normal = normals[nodeIndex];
            const side = middle[nodeIndex] + away * (half ? half[nodeIndex] : 0);
            positions[vertexCursor * 3] = node.x + normal.x * side;
            positions[vertexCursor * 3 + 1] = node.y + normal.y * side;
            positions[vertexCursor * 3 + 2] = node.z + normal.z * side;
            vertexCursor += 1;
          }
          faceToEntityIndex[faceCursor] = entityIndex;
          faceCursor += 1;
        }
      }
      if (layers === 2) {
        // Close the solid: one side face per exposed perimeter edge, spanning
        // the two parallel faces, so the element reads as a body from every
        // direction.
        for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
          if (!sideWanted[nodeIndex]) continue;
          const nextIndex = (nodeIndex + 1) % nodes.length;
          const corners = [
            [nodeIndex, 1],
            [nextIndex, 1],
            [nextIndex, -1],
            [nodeIndex, -1],
          ];
          for (const triangle of QUAD_FACES) {
            for (const cornerIndex of triangle) {
              const [at, sign] = corners[cornerIndex];
              const node = nodes[at];
              const normal = normals[at];
              const side = middle[at] + sign * half[at];
              positions[vertexCursor * 3] = node.x + normal.x * side;
              positions[vertexCursor * 3 + 1] = node.y + normal.y * side;
              positions[vertexCursor * 3 + 2] = node.z + normal.z * side;
              vertexCursor += 1;
            }
            faceToEntityIndex[faceCursor] = entityIndex;
            faceCursor += 1;
          }
        }
      }
      entityRanges.push({ start, count: vertexCursor - start });
      for (let layer = 0; layer < layers; layer += 1) {
        const away = layers === 1 ? 0 : layer === 0 ? 1 : -1;
        for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
          const startNode = nodes[nodeIndex];
          const nextIndex = (nodeIndex + 1) % nodes.length;
          const endNode = nodes[nextIndex];
          const from = middle[nodeIndex] + away * (half ? half[nodeIndex] : 0);
          const to = middle[nextIndex] + away * (half ? half[nextIndex] : 0);
          const fromNormal = normals[nodeIndex];
          const toNormal = normals[nextIndex];
          edgePositions[edgeCursor * 6] = startNode.x + fromNormal.x * from;
          edgePositions[edgeCursor * 6 + 1] = startNode.y + fromNormal.y * from;
          edgePositions[edgeCursor * 6 + 2] = startNode.z + fromNormal.z * from;
          edgePositions[edgeCursor * 6 + 3] = endNode.x + toNormal.x * to;
          edgePositions[edgeCursor * 6 + 4] = endNode.y + toNormal.y * to;
          edgePositions[edgeCursor * 6 + 5] = endNode.z + toNormal.z * to;
          edgeCursor += 1;
        }
      }
      if (layers === 2) {
        for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
          if (!joinWanted[nodeIndex]) continue;
          const node = nodes[nodeIndex];
          const normal = normals[nodeIndex];
          const above = middle[nodeIndex] + half[nodeIndex];
          const below = middle[nodeIndex] - half[nodeIndex];
          edgePositions[edgeCursor * 6] = node.x + normal.x * above;
          edgePositions[edgeCursor * 6 + 1] = node.y + normal.y * above;
          edgePositions[edgeCursor * 6 + 2] = node.z + normal.z * above;
          edgePositions[edgeCursor * 6 + 3] = node.x + normal.x * below;
          edgePositions[edgeCursor * 6 + 4] = node.y + normal.y * below;
          edgePositions[edgeCursor * 6 + 5] = node.z + normal.z * below;
          edgeCursor += 1;
        }
      }
    });

    const shellGeometry = new THREE.BufferGeometry();
    shellGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const colorAttribute = new THREE.BufferAttribute(new Float32Array(positions.length), 3);
    colorAttribute.setUsage(THREE.DynamicDrawUsage);
    shellGeometry.setAttribute("color", colorAttribute);
    shellGeometry.setAttribute(
      "normal",
      new THREE.BufferAttribute(new Float32Array(positions.length), 3),
    );
    computeFlatVertexNormals(shellGeometry);
    shellGeometry.computeBoundingSphere();
    // No polygon offset at all: a fill loses depth ties instead. The lines
    // draw first, from the same computed positions, and write true depth — a
    // strict test is then all a fill needs to stay behind its own lines,
    // while a body in front by any distance covers foreign lines to the
    // exact intersection. Any sink, however small, is worth its size over
    // the dihedral wherever two bodies graze: a tail of foreign mesh lines
    // reaching past the intersection, stretching as the view flattens along
    // it.
    const shellMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.72,
      metalness: 0.04,
      side: THREE.DoubleSide,
      vertexColors: true,
      depthFunc: THREE.LessDepth,
      // Every pixel this fill wins is a pixel where no member is the visible
      // surface, so the member mark is cleared and no arris will draw there.
      stencilWrite: true,
      stencilRef: 0,
      stencilZPass: THREE.ReplaceStencilOp,
    });
    const shellMesh = new THREE.Mesh(shellGeometry, shellMaterial);
    // Last of all: after every line, so that losing depth ties keeps it
    // behind its own edge lines while any distance in front of a foreign
    // line paints over it — and after the member fills and their contours,
    // so a flange lying exactly in this surface's plane has already claimed
    // its band, arrises included, and the tie-losing test leaves it there.
    shellMesh.renderOrder = 4;
    shellMesh.userData.gravissEntityRanges = entityRanges;
    shellMesh.userData.gravissFaceToEntityIndex = faceToEntityIndex;

    const edgeGeometry = new THREE.BufferGeometry();
    edgeGeometry.setAttribute("position", new THREE.BufferAttribute(edgePositions, 3));
    // Built at the active appearance rather than white. Only applyTheme used to
    // colour these, so every rebuild that did not go through it — switching
    // section rendering, for one — left the mesh lines white.
    //
    // Opaque and depth-writing, never softened through alpha: a translucent
    // line renders in the transparent pass, after every opaque body, where no
    // draw order can put a body back over the lines it hides. Softness comes
    // from mixing the colour toward the surface the lines lie on, and the
    // depth they write is what lets a body drawn later cover exactly the
    // lines it stands in front of.
    const definition = appearanceDefinition(this.activeAppearance);
    const edgeMaterial = new THREE.LineBasicMaterial({
      color: this.mixedLineColor(definition.shellEdge, definition.shell),
    });
    const edges = new THREE.LineSegments(edgeGeometry, edgeMaterial);
    edges.renderOrder = 1;
    edges.visible = this.shellEdgesVisible();
    shellMesh.add(edges);
    shellMesh.userData.gravissEdges = edges;
    // The mesh lines are a layer of their own, so they can be switched off
    // while the surfaces they describe stay on screen. They remain children of
    // the shell mesh, so hiding the shells still takes them with it.
    this.meshes.mesh = edges;
    this.registerPickable("element", shellMesh, elements, "shells", "shell");
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
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const radius = this.symbolRadius();
    const scale = new THREE.Vector3(radius, radius, radius);
    this.geometry.nodes.forEach((node, index) => {
      matrix.compose(position.set(node.x, node.y, node.z), rotation, scale);
      mesh.setMatrixAt(index, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    return true;
  }

  placeSupportSymbols() {
    const mesh = this.supportMesh;
    if (!mesh) return false;
    const THREE = this.THREE;
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const radius = this.symbolRadius();
    const scale = new THREE.Vector3(
      radius * SUPPORT_RADIUS,
      radius * SUPPORT_HEIGHT,
      radius * SUPPORT_RADIUS,
    );
    const rotation = mesh.userData.gravissSupportRotation;
    // Hung below the node it restrains, by its own size, so the cone touches
    // the node rather than swallowing it at any scale.
    const standoff = -radius * SUPPORT_STANDOFF;
    this.supportNodes.forEach((node, index) => {
      position.set(node.x, node.y, node.z).addScaledVector(this.worldUp, standoff);
      matrix.compose(position, rotation, scale);
      mesh.setMatrixAt(index, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
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
  // drawn as marks rather than as members: a coil for a spring, a ticked link
  // for a coupling. Both take their size from the symbol size, and both are
  // shaped in a buffer allocated once, so moving the slider rewrites the
  // vertices it already has rather than building a mesh again.
  createConnectorGeometry(nodesById, kind, visibilityKey) {
    const THREE = this.THREE;
    const elements = this.geometry.elements.filter((element) => element.kind === kind);
    if (elements.length === 0) return;
    const perElement = kind === "spring" ? SPRING_SEGMENT_BUDGET : 1;
    const positions = new Float32Array(elements.length * perElement * 6);
    const colors = new Float32Array(elements.length * perElement * 6);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const colorAttribute = new THREE.BufferAttribute(colors, 3);
    colorAttribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("color", colorAttribute);
    const lines = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({ vertexColors: true }),
    );
    lines.userData.gravissEntityRanges = elements.map((element, index) => ({
      start: index * perElement * 2,
      count: perElement * 2,
    }));
    lines.userData.gravissLineSegments = true;
    const group = new THREE.Group();
    group.name = `graviss-${visibilityKey}`;
    this.meshes[visibilityKey] = group;
    this.scene.add(group);
    this.connectors ||= {};
    this.connectors[kind] = { lines, elements, nodesById, perElement };
    this.placeConnectorSymbols(kind);
    this.registerPickable(kind, lines, elements, visibilityKey, kind, group);
  }

  placeConnectorSymbols(kind) {
    const connector = this.connectors?.[kind];
    if (!connector) return false;
    const THREE = this.THREE;
    const { lines, elements, nodesById, perElement } = connector;
    const positions = lines.geometry.getAttribute("position");
    const size = this.symbolRadius();
    const start = new THREE.Vector3();
    const end = new THREE.Vector3();
    const along = new THREE.Vector3();
    const across = new THREE.Vector3();
    const beside = new THREE.Vector3();
    const from = new THREE.Vector3();
    const to = new THREE.Vector3();
    let cursor = 0;
    const segment = (a, b) => {
      positions.setXYZ(cursor, a.x, a.y, a.z);
      positions.setXYZ(cursor + 1, b.x, b.y, b.z);
      cursor += 2;
    };
    for (const element of elements) {
      const nodes = element.nodeIds.map((nodeId) => nodesById.get(`${typeof nodeId}:${nodeId}`));
      start.set(nodes[0].x, nodes[0].y, nodes[0].z);
      // A grounded spring has one node and says which way it acts; a connector
      // between two nodes spans them.
      if (nodes.length > 1 && nodes[1]) {
        end.set(nodes[1].x, nodes[1].y, nodes[1].z);
      } else {
        along.fromArray(element.direction || [0, 0, 1]);
        if (along.lengthSq() === 0) along.set(0, 0, 1);
        end.copy(start).addScaledVector(along.normalize(), size * SPRING_TURNS * 2);
      }
      along.subVectors(end, start);
      const length = along.length();
      if (length === 0) {
        for (let index = 0; index < perElement; index += 1) segment(start, start);
        continue;
      }
      along.divideScalar(length);
      // Two directions square to the axis and to each other, so a helix can
      // turn about it and a ring can lie across it. Any pair will do — a coil
      // has no roll of its own — and the steadiest is built from whichever
      // world axis the spring is least aligned with.
      across.crossVectors(along, Math.abs(along.z) < 0.9 ? UNIT_Z : UNIT_X);
      if (across.lengthSq() === 0) across.crossVectors(along, UNIT_Y);
      across.normalize().multiplyScalar(size);
      beside.crossVectors(along, across).normalize().multiplyScalar(size);

      if (kind !== "spring") {
        // A coupling is a rigid link, and a line between the nodes is the whole
        // of what it is.
        segment(start, end);
        continue;
      }

      if (element.rotational) {
        // Acting about the axis rather than along it, so it is drawn as a turn
        // about it: a ring at the middle, in the plane it rotates in.
        from.copy(start).addScaledVector(along, length / 2);
        to.copy(from).addScaledVector(across, 1);
        for (let step = 1; step <= SPRING_RING_SEGMENTS; step += 1) {
          const angle = (step / SPRING_RING_SEGMENTS) * Math.PI * 2;
          const next = from
            .clone()
            .addScaledVector(across, Math.cos(angle))
            .addScaledVector(beside, Math.sin(angle));
          segment(to, next);
          to.copy(next);
        }
        segment(start, end);
        for (let spare = SPRING_RING_SEGMENTS + 1; spare < perElement; spare += 1)
          segment(end, end);
        continue;
      }

      // Acting along the axis: a helix over the middle of the length, with the
      // ends left straight so it still reads as reaching the nodes it reaches.
      const bodyStart = (length * (1 - SPRING_BODY)) / 2;
      const turns = SPRING_TURNS * SPRING_SEGMENTS;
      const step = (length * SPRING_BODY) / turns;
      from.copy(start);
      to.copy(start).addScaledVector(along, bodyStart);
      segment(from, to);
      for (let turn = 1; turn <= turns; turn += 1) {
        const angle = (turn / SPRING_SEGMENTS) * Math.PI * 2;
        const next = start
          .clone()
          .addScaledVector(along, bodyStart + step * turn)
          .addScaledVector(across, Math.cos(angle))
          .addScaledVector(beside, Math.sin(angle));
        segment(to, next);
        to.copy(next);
      }
      segment(to, end);
      for (let spare = turns + 2; spare < perElement; spare += 1) segment(end, end);
    }
    positions.needsUpdate = true;
    // Both, and every time: a bounding box is computed once on demand and then
    // cached, so a reshaped connector keeps the bounds of the size it used to
    // be — which is what the model's own extent is measured from.
    lines.geometry.computeBoundingBox();
    lines.geometry.computeBoundingSphere();
    return true;
  }

  createLocalAxesGeometry(nodesById, elements) {
    const THREE = this.THREE;
    const axisLength = Math.max(0.1, this.bounds.radius * 0.025);
    const positions = [];
    const colors = [];
    const axisColors = [
      new THREE.Color(0xe74c3c),
      new THREE.Color(0x2ecc71),
      new THREE.Color(0x3498db),
    ];
    const axisElements = elements.filter((element) => element.localAxes);
    if (!axisElements.length) return;
    const direction = new THREE.Vector3();
    const center = new THREE.Vector3();
    for (const element of axisElements) {
      this.elementCenter(element, nodesById, center);
      for (const [axisIndex, name] of AXIS_NAMES.entries()) {
        direction.fromArray(element.localAxes[name]).normalize();
        positions.push(
          center.x,
          center.y,
          center.z,
          center.x + direction.x * axisLength,
          center.y + direction.y * axisLength,
          center.z + direction.z * axisLength,
        );
        const color = axisColors[axisIndex];
        colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    // Local axes are geometry sitting at the element centres, so they are depth
    // tested like everything else: an opaque section in front of one hides it.
    // Drawing them without a depth test put every element's frame on top of the
    // model at once, which reads as though the sections were transparent.
    const material = new THREE.LineBasicMaterial({ vertexColors: true });
    const lines = new THREE.LineSegments(geometry, material);
    // The line tier: their own element's sunk fill stays behind them, and a
    // body in front covers them, exactly as for the mesh lines.
    lines.renderOrder = 1;
    lines.visible = this.visibility.localAxes;
    lines.userData.gravissAxisLength = axisLength;
    this.localAxes = lines;
    this.meshes.localAxes = lines;
    this.scene.add(lines);
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
  // One computed style for the lot: custom properties are inherited and read
  // straight off it, so this costs a single recalculation rather than one per
  // colour.
  resolveAppearance(appearance) {
    const styles = getComputedStyle(this.host);
    const resolved = { ...appearance };
    for (const [key, value] of Object.entries(appearance)) {
      if (typeof value !== "number") continue;
      const declared = styles.getPropertyValue(`--graviss-${dashedName(key)}`).trim();
      if (!declared) continue;
      try {
        resolved[key] = new this.THREE.Color().setStyle(declared).getHex();
      } catch {
        // A property that is not a colour is one to leave to the fallback.
      }
    }
    return resolved;
  }

  applyTheme() {
    if (this.destroyed) return;
    const themeColor = this.colorFromTheme("--base-background-color", "#101b24");
    const automaticAppearance =
      themeColor.r + themeColor.g + themeColor.b < 0.9 ? "midnight" : "cloud";
    this.activeAppearance = this.appearance === "auto" ? automaticAppearance : this.appearance;
    // Before the colours are read, not after: they are custom properties keyed
    // on this attribute, so reading them first would read the scheme being
    // left rather than the one being taken up.
    this.host.closest(".graviss")?.setAttribute("data-appearance", this.activeAppearance);
    const appearance = this.resolveAppearance(appearanceDefinition(this.activeAppearance));
    this.applyBackground(appearance);
    this.applyGridAppearance(appearance);
    this.colors = {
      element: new this.THREE.Color(appearance.member),
      shell: new this.THREE.Color(appearance.shell),
      node: new this.THREE.Color(appearance.node),
      support: new this.THREE.Color(appearance.support),
      spring: new this.THREE.Color(appearance.spring),
      coupling: new this.THREE.Color(appearance.coupling),
      selected: new this.THREE.Color("#ff6b35"),
    };
    const shellEdges = this.meshes.shells?.userData.gravissEdges;
    if (shellEdges) {
      shellEdges.material.color.setHex(this.mixedLineColor(appearance.shellEdge, appearance.shell));
    }
    for (const contours of this.memberContours) {
      contours.material.color.setHex(this.mixedLineColor(appearance.shellEdge, appearance.member));
    }
    this.refreshInstanceColors();
    this.viewCube?.setScheme(this.activeAppearance);
    this.requestRender();
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
    this.scene.remove(lines);
    lines.geometry.dispose();
    lines.material.dispose();
    this.localAxes = null;
    delete this.meshes.localAxes;
    this.createLocalAxesGeometry(this.nodesById, this.geometry.elements);
  }

  isSectionRendering() {
    return this.sectionRendering;
  }

  rebuildMemberMeshes() {
    const group = this.meshes.members;
    if (!group) return;
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
  }

  // An area element has no cross-section to extrude, so its levels are the
  // surface it encloses and, at full detail, the thickness it was given.
  applyShellDetail() {
    const mesh = this.meshes.shells;
    if (!mesh) return;
    const elements = mesh.userData.gravissEntities;
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
    this.onWindowResize = () => this.resize();
    if (typeof ResizeObserver === "function") {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.host);
    } else {
      window.addEventListener("resize", this.onWindowResize);
    }
    this.resize();
  }

  resize() {
    if (this.destroyed) return;
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
    this.canvasRenderer.setSize(width, height, false);
    this.perspectiveCamera.aspect = aspect;
    this.perspectiveCamera.updateProjectionMatrix();
    this.updateOrthographicFrustum(aspect);
    this.paintOrbitPivot();
    // Painted now, not next frame: setSize just cleared the buffer, and the
    // ResizeObserver fires before paint, so a synchronous render is what
    // keeps the cleared canvas from ever reaching the screen.
    this.paintFrame();
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
    const THREE = this.THREE;
    const box = new THREE.Box3();
    for (const key of ["members", "shells", "nodes", "supports", "localAxes"]) {
      const object = this.meshes[key];
      if (object && this.isObjectVisible(object)) box.expandByObject(object);
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

    for (const key of ["members", "shells", "nodes", "supports", "localAxes"]) {
      const root = this.meshes[key];
      if (!root || !this.isObjectVisible(root)) continue;
      root.updateWorldMatrix(true, true);
      root.traverse((object) => {
        const geometry = object.geometry;
        if (!geometry || budget <= 0) return;
        const position = geometry.getAttribute("position");
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
        for (let index = 0; index < position.count; index += 1) {
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

  // The rectangle the structure occupies on screen, in fractions of the
  // viewport. Measured from the drawn model, never from the reference grid,
  // which spreads well beyond it. A model too large to walk point by point
  // falls back to the corners of its bounds, which is looser but bounded work.
  modelScreenRect() {
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

  marginedScreenRect(rect, marginFraction = PRINT_MARGIN_FRACTION) {
    return marginedScreenRect(rect, this.viewportPixels(), marginFraction);
  }

  viewportPixels() {
    return {
      width: Math.max(1, this.host.clientWidth || 800),
      height: Math.max(1, this.host.clientHeight || 600),
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
    // The sky is placed per frame, and an export renders without waiting for
    // one, so it is placed here too rather than left at the size the depth
    // range had before the camera last moved.
    this.placeSky();
    const width = Math.max(1, this.host.clientWidth || 800);
    const height = Math.max(1, this.host.clientHeight || 600);
    const covered = { width: region.width * width, height: region.height * height };
    // Never ask for a buffer wider than the context can allocate; a driver
    // that refuses one hands back a blank image rather than an error.
    const pixels = printPixelSize(covered, {
      maxEdge: Math.min(EXPORT_MAX_EDGE, this.canvasRenderer.capabilities.maxTextureSize),
      ...options,
    });
    const renderer = this.canvasRenderer;
    const camera = this.camera;
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
      renderer.render(this.scene, camera);
      return {
        dataUrl: renderer.domElement.toDataURL("image/png"),
        region: covered,
        ...pixels,
      };
    } finally {
      camera.clearViewOffset();
      renderer.setPixelRatio(pixelRatio);
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
    // Unaimed, the ray is the camera's own axis and the gap is the one to the
    // target, which is the middle of the viewport by construction.
    // Leaves the raycaster aimed under the pointer, which is the ray to travel
    // along whether or not it hit anything.
    const intersection = anchor.aimed ? this.intersectionAt(event) : null;
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
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return (
      this.raycaster.intersectObjects(
        this.pickables.filter((mesh) => this.isObjectVisible(mesh)),
        false,
      )[0] || null
    );
  }

  pick(event) {
    if (!this.pointerFromEvent(event)) return;
    const intersection = this.intersectionAt(event);
    let hit = null;
    if (intersection) {
      const type = intersection.object.userData.gravissType;
      // A line intersection reports the first vertex of the segment it hit
      // rather than a face, and every member owns exactly two vertices.
      const entityIndex =
        intersection.instanceId ??
        (intersection.object.userData.gravissLineSegments
          ? Math.floor(intersection.index / 2)
          : intersection.object.userData.gravissFaceToEntityIndex?.[intersection.faceIndex]);
      const entity = intersection.object.userData.gravissEntities[entityIndex];
      if (entity) {
        hit = { type, entity, entityIndex, instanceId: entityIndex, object: intersection.object };
      }
    }
    this.setSelected(hit);
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
      const colorKey = hit.object.userData.gravissColorKey || hit.type;
      this.setEntityColor(
        hit.object,
        hit.entityIndex,
        selected ? this.colors.selected : this.colors[colorKey],
      );
    }
  }

  refreshInstanceColors() {
    if (!this.colors) return;
    // The selected key is loop invariant, and with nothing selected no entity
    // needs a key built at all.
    const selectedKey = this.selected
      ? entityKey(this.selected.type, this.selected.entity.id)
      : null;
    for (const mesh of this.pickables) {
      const type = mesh.userData.gravissType;
      const colorKey = mesh.userData.gravissColorKey || type;
      const entities = mesh.userData.gravissEntities;
      const base = this.colors[colorKey];
      entities.forEach((entity, index) => {
        const selected = selectedKey !== null && entityKey(type, entity.id) === selectedKey;
        this.setEntityColor(mesh, index, selected ? this.colors.selected : base);
      });
    }
  }

  setEntityColor(mesh, entityIndex, color) {
    if (mesh.isInstancedMesh) {
      mesh.setColorAt(entityIndex, color);
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      return;
    }
    const range = mesh.userData.gravissEntityRanges?.[entityIndex];
    const colors = mesh.geometry.getAttribute("color");
    if (!range || !colors) return;
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
    const object = this.meshes[name] || this[name];
    if (object) {
      object.visible = name === "mesh" ? this.shellEdgesVisible() : this.visibility[name];
      if (GravissRenderer.SYMBOL_KINDS.includes(name)) {
        object.visible = object.visible && this.symbolsVisible();
      }
    }
    if (name === "mesh") {
      for (const contours of this.memberContours) contours.visible = this.visibility.mesh;
    }
    if (
      this.selected &&
      object &&
      !object.visible &&
      (this.selected.object === object || object.getObjectById?.(this.selected.object.id))
    ) {
      this.setSelected(null);
    }
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

  createFittedView(direction = null, up = null) {
    const THREE = this.THREE;
    const center = new THREE.Vector3(...this.bounds.center);
    const viewDirection = direction || this.camera.position.clone().sub(this.controls.target);
    if (viewDirection.lengthSq() === 0) {
      viewDirection.fromArray(canonicalDirectionToModel([1, -1, 0.8], this.coordinateSystem));
    }
    viewDirection.normalize();
    const radius = this.bounds.radius;
    const width = Math.max(1, this.host.clientWidth || 800);
    const height = Math.max(1, this.host.clientHeight || 600);
    const aspect = width / height;
    const distance = sphereFitDistance(radius, this.perspectiveCamera.fov, aspect);
    const cameraUp = up || this.camera.up.clone();
    return {
      center,
      viewDirection,
      cameraUp,
      radius,
      distance,
      aspect,
      orthographicHeight: orthographicFitHeight(radius, aspect),
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
      const distance = this.camera.position.distanceTo(this.controls.target);
      this.camera.near = Math.max(0.01, distance / 1000);
      this.camera.far = distance + this.bounds.radius * 20;
      this.camera.updateProjectionMatrix();
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
    if (this.destroyed || this.renderFrame != null) return;
    this.renderFrame = requestAnimationFrame((timestamp) => {
      this.renderFrame = null;
      this.paintFrame(timestamp);
    });
  }

  // One painted frame. Scheduled through requestRender for everything that
  // can wait until the next animation frame — and called directly from
  // resize, because resizing the drawing buffer clears it on the spot: a
  // repaint left to the next frame lets the compositor show the empty canvas
  // first, and the pane flashes its bare background on every step of a drag.
  paintFrame(timestamp = null) {
    if (this.destroyed) return;
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
    this.canvasRenderer.render(this.scene, this.camera);
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
    this.endRegionSelection(null);
    this.releaseOrbitPivot();
    this.cancelZoomFlight();
    this.disposeSky();
    this.destroyed = true;
    if (this.renderFrame != null) cancelAnimationFrame(this.renderFrame);
    this.cancelCameraAnimation();
    this.cancelScheduledCameraChange();
    this.frameRateMeter.dispose();
    this.resizeObserver?.disconnect();
    window.removeEventListener("resize", this.onWindowResize);
    const canvas = this.canvasRenderer?.domElement;
    canvas?.removeEventListener("pointerdown", this.onPointerDown);
    canvas?.removeEventListener("pointerup", this.onPointerUp);
    canvas?.removeEventListener("pointercancel", this.onPointerUp);
    this.host?.removeEventListener("wheel", this.onWheel, true);
    this.controls?.dispose();
    this.viewCube?.destroy();
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

// Half the thickness at each node of an area element. A list is one per node,
// which is how a slab that tapers across itself is described, and it is taken
// exactly as given: somebody said what each corner measures. A list shorter
// than the element repeats its last value, a provider naming fewer corners than
// it has meaning the rest are the same.
//
// A single number is a different thing. It is what the element measures, and a
// plate whose thickness varies is meshed as a run of elements each carrying its
// own — so drawn at face value the plate comes out as a stair rather than a
// taper, with a step at every element boundary. The value at a node is the mean
// of the elements meeting there, which is the surface those elements are
// describing between them and what every FE viewer draws.
function elementHalfThickness(element, count, shared) {
  const declared = element.thickness;
  if (Array.isArray(declared)) {
    if (!declared.length) return null;
    return Array.from({ length: count }, (unused, index) => {
      const value = declared[Math.min(index, declared.length - 1)];
      return Number.isFinite(value) ? Math.abs(value) / 2 : 0;
    });
  }
  const half = Math.abs(declared || 0) / 2;
  if (!shared) return new Array(count).fill(half);
  return element.nodeIds.map((nodeId) => shared.get(stableIdKey(nodeId)) ?? half);
}

// Where the element's surface sits relative to each of its nodes. A list is one
// per node and is taken exactly as given. A single number is, like a single
// thickness, one element's sample of a surface that can vary across a run of
// them — so at each node it is read as the mean over the elements meeting
// there. An eccentric run states thickness and offset together, so the two
// means move by the same amount and the face the nodes sit on stays on the
// nodes; averaging one without the other would step both faces.
function elementOffsets(element, count, shared) {
  const declared = element.offset;
  if (Array.isArray(declared)) {
    return Array.from({ length: count }, (unused, index) => {
      const value = declared[Math.min(index, declared.length - 1)];
      return Number.isFinite(value) ? value : 0;
    });
  }
  if (!Number.isFinite(declared) || declared === 0) return new Array(count).fill(0);
  if (!shared) return new Array(count).fill(declared);
  return element.nodeIds.map((nodeId) => shared.get(stableIdKey(nodeId)) ?? declared);
}

// Corners meant to be the same point agree to floating-point rounding — the
// nodal means are computed once and read by every element at the node — while
// a genuine thickness or offset step disagrees by a real length. A micrometre
// sits far above the one and far below the other.
const SIDE_FACE_QUANTUM = 1e-6;

// A side face named by the four displaced corners that define it, spelt the
// same way by both elements sharing the edge whichever direction each walks
// it. Two elements produce one name only when their bodies continue through
// the seam exactly — same thickness, same offset, same mitred normals.
function sideFaceKey(nodes, normals, middle, half, from, to) {
  const corner = (at) => {
    const node = nodes[at];
    const normal = normals[at];
    const parts = [];
    for (const side of [middle[at] + half[at], middle[at] - half[at]]) {
      parts.push(
        Math.round((node.x + normal.x * side) / SIDE_FACE_QUANTUM),
        Math.round((node.y + normal.y * side) / SIDE_FACE_QUANTUM),
        Math.round((node.z + normal.z * side) / SIDE_FACE_QUANTUM),
      );
    }
    return parts.join(",");
  };
  const a = corner(from);
  const b = corner(to);
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// One number standing for the whole, for the triad that marks the element.
function meanOffset(element) {
  const declared = element.offset;
  if (!Array.isArray(declared)) return Number.isFinite(declared) ? declared : 0;
  const usable = declared.filter(Number.isFinite);
  if (!usable.length) return 0;
  return usable.reduce((total, value) => total + value, 0) / usable.length;
}

// The mean half-thickness and mean offset of the elements meeting at each
// node, over the ones that state single numbers. A plate whose thickness or
// eccentricity varies continuously is meshed as a run of elements each
// carrying its own number, so taken at face value the run is a stair, with a
// step at every boundary; the surface those elements describe between them
// meets at the mean, which is what the source's own viewer draws. An element
// stating values per node has said what each corner measures and takes no
// part in either mean.
function sharedNodeSurfaces(elements, nodesById) {
  const halves = new Map();
  const offsets = new Map();
  const normals = new Map();
  for (const element of elements) {
    if (!Array.isArray(element.thickness) && element.thickness > 0) {
      accumulateShared(halves, element.nodeIds, Math.abs(element.thickness) / 2);
    }
    if (!Array.isArray(element.offset) && Number.isFinite(element.offset) && element.offset !== 0) {
      accumulateShared(offsets, element.nodeIds, element.offset);
    }
    const nodes = element.nodeIds.map((nodeId) => nodesById.get(`${typeof nodeId}:${nodeId}`));
    if (nodes.some((node) => !node)) continue;
    element.nodeIds.forEach((nodeId, index) => {
      const normal = cornerNormalAt(nodes, index);
      if (!normal) return;
      const key = stableIdKey(nodeId);
      const entry = normals.get(key) || { x: 0, y: 0, z: 0 };
      entry.x += normal.x;
      entry.y += normal.y;
      entry.z += normal.z;
      normals.set(key, entry);
    });
  }
  return { halves: sharedMeans(halves), offsets: sharedMeans(offsets), normals };
}

// The normal at one corner of an area element, from the two edges that meet
// there. A quad's four nodes need not lie on one plane, so the element has no
// single normal for a corner to borrow.
function cornerNormalAt(nodes, index) {
  const corner = nodes[index];
  const next = nodes[(index + 1) % nodes.length];
  const previous = nodes[(index + nodes.length - 1) % nodes.length];
  const ax = next.x - corner.x;
  const ay = next.y - corner.y;
  const az = next.z - corner.z;
  const bx = previous.x - corner.x;
  const by = previous.y - corner.y;
  const bz = previous.z - corner.z;
  const x = ay * bz - az * by;
  const y = az * bx - ax * bz;
  const z = ax * by - ay * bx;
  const length = Math.hypot(x, y, z);
  if (!(length > 0)) return null;
  return { x: x / length, y: y / length, z: z / length };
}

// The direction each corner is displaced along: the surface's own normal at
// that node, the mean over the elements meeting there, so a folded or curved
// run of elements extrudes as one continuous solid instead of flat slabs that
// gap and overlap at their shared edges. A mean that cancels out, or one turned
// against this element's winding by a neighbour wound the other way, is no
// direction to displace along, and that corner falls back to the element's own.
function cornerDisplacementNormals(element, nodes, sharedNormals) {
  return element.nodeIds.map((nodeId, index) => {
    const own = cornerNormalAt(nodes, index) || { x: 0, y: 0, z: 0 };
    const summed = sharedNormals.get(stableIdKey(nodeId));
    if (summed) {
      const length = Math.hypot(summed.x, summed.y, summed.z);
      if (length > 1e-6) {
        const mean = { x: summed.x / length, y: summed.y / length, z: summed.z / length };
        if (mean.x * own.x + mean.y * own.y + mean.z * own.z > 1e-6) return mean;
      }
    }
    return own;
  });
}

function accumulateShared(map, nodeIds, value) {
  for (const nodeId of nodeIds) {
    const key = stableIdKey(nodeId);
    const entry = map.get(key) || { sum: 0, count: 0 };
    entry.sum += value;
    entry.count += 1;
    map.set(key, entry);
  }
}

function sharedMeans(totals) {
  const means = new Map();
  for (const [key, { sum, count }] of totals) means.set(key, sum / count);
  return means;
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

module.exports = { GravissRenderer, geometryBounds, isWorldPointVisible };
