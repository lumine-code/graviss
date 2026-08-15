const { APPEARANCE_IDS, appearanceDefinition } = require("./appearance");
const { DETAIL_LEVELS } = require("./element-detail");
const {
  cameraViewDefinition,
  orthographicFitHeight,
  perspectiveDistanceForHeight,
  perspectiveVisibleHeight,
  sphereFitDistance,
  validateCameraState,
} = require("./camera-navigation");
const { OrientationGizmo } = require("./orientation-gizmo");
const { FrameRateMeter } = require("./frame-rate-meter");
const { canonicalDirectionToModel, coordinateSystemDefinition } = require("./coordinate-system");
const { loadThreeRuntime } = require("./three-runtime");
const { ViewCube } = require("./view-cube");

const CAMERA_SCROLL_SETTLE_MS = 180;
const CAMERA_VIEW_ANIMATION_MS = 360;
const CAMERA_PAN_FRACTION = 0.06;
const CAMERA_ROTATION_STEP = Math.PI / 12;
const CAMERA_ZOOM_SCALE = 0.82;
const CAMERA_POLE_OFFSET = 2e-6;

function geometryBounds(geometry) {
  if (!geometry.nodes.length) {
    return { min: [0, 0, 0], max: [0, 0, 0], center: [0, 0, 0], radius: 1 };
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
  return { min, max, center, radius };
}

const AXIS_NAMES = ["x", "y", "z"];
const ORIGIN_AXIS_COLORS = Object.freeze([0xd23b34, 0x2f9e44, 0x2b7fd0]);

function unitDirection(axisIndex) {
  return [0, 1, 2].map((index) => (index === axisIndex ? 1 : 0));
}

function originAxisProportions(length) {
  if (!(length > 0)) throw new RangeError("The origin axes require a positive axis length");
  const headLength = length * 0.26;
  return {
    shaftRadius: length * 0.05,
    shaftLength: length - headLength,
    headRadius: length * 0.12,
    headLength,
    labelSize: length * 0.46,
    labelOffset: length * 1.28,
  };
}

// A filled chip carrying a white glyph. An outlined glyph loses its core to the
// outline once the sprite is only a few dozen pixels tall, which is the usual
// size of this marker.
function createAxisLabelTexture(THREE, label, color) {
  const surface = document.createElement("canvas");
  surface.width = 128;
  surface.height = 128;
  const context = surface.getContext("2d");
  context.fillStyle = "rgba(255, 255, 255, 0.94)";
  context.beginPath();
  context.arc(64, 64, 58, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
  context.beginPath();
  context.arc(64, 64, 50, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#ffffff";
  context.font = '800 74px "Segoe UI", sans-serif';
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label.toUpperCase(), 64, 68);
  const texture = new THREE.CanvasTexture(surface);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
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
    };
    this.pickables = [];
    this.meshes = {};
    this.selected = null;
    this.destroyed = false;
    this.renderFrame = null;
    this.pointerDown = null;
    this.projection = "perspective";
    this.appearance = "auto";
    this.elementDetail = "section";
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
    this.pointer = new THREE.Vector2();
    const viewElement = this.host.closest(".graviss");
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
      this.setStandardView("iso");
    } finally {
      this.suppressCameraChange -= 1;
    }
  }

  createControls(camera, target = null) {
    // OrbitControls has no defined azimuth exactly at an orbit pole. Preserve
    // the current screen-up direction with an imperceptible deterministic tilt
    // before returning camera.up to the model's declared physical up axis.
    if (target) this.stabilizeOrbitPole(camera, target);
    camera.up.copy(this.worldUp);
    const controls = new this.OrbitControls(camera, this.canvasRenderer.domElement);
    if (target) controls.target.copy(target);
    controls.enableDamping = false;
    controls.screenSpacePanning = true;
    controls.addEventListener("change", () => this.requestRender());
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

  createReferenceGeometry() {
    const THREE = this.THREE;
    const { center, radius } = this.bounds;
    const gridSize = Math.max(10, Math.ceil((radius * 2.6) / 5) * 5);
    const divisions = Math.min(50, Math.max(10, gridSize));
    this.grid = new THREE.GridHelper(gridSize, divisions, 0x5c6773, 0x353d46);
    this.grid.userData.gravissGridSize = gridSize;
    this.grid.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), this.worldUp);
    const gridCenter = new THREE.Vector3(...center);
    gridCenter.addScaledVector(this.worldUp, -gridCenter.dot(this.worldUp));
    this.grid.position.copy(gridCenter);
    this.scene.add(this.grid);

    this.axes = this.createOriginAxes(Math.max(1.5, radius * 0.25));
    this.axes.position.set(0, 0, 0);
    this.scene.add(this.axes);
  }

  // AxesHelper draws three one-pixel lines, which disappear against the mesh at
  // any distance. Solid tapered arrows carry the global frame at a glance and
  // are occluded like any other body, while the labels stay readable wherever
  // the origin happens to fall inside the model.
  createOriginAxes(length) {
    const THREE = this.THREE;
    const proportions = originAxisProportions(length);
    const group = new THREE.Group();
    group.name = "graviss-origin-axes";
    const shaft = new THREE.CylinderGeometry(
      proportions.shaftRadius,
      proportions.shaftRadius,
      proportions.shaftLength,
      12,
    );
    const head = new THREE.ConeGeometry(proportions.headRadius, proportions.headLength, 16);
    const alignment = new THREE.Vector3(0, 1, 0);

    for (const [axisIndex, name] of AXIS_NAMES.entries()) {
      const direction = new THREE.Vector3(
        ...canonicalDirectionToModel(unitDirection(axisIndex), this.coordinateSystem),
      );
      const rotation = new THREE.Quaternion().setFromUnitVectors(alignment, direction);
      const material = new THREE.MeshBasicMaterial({
        color: ORIGIN_AXIS_COLORS[axisIndex],
        toneMapped: false,
      });
      const shaftMesh = new THREE.Mesh(shaft, material);
      shaftMesh.quaternion.copy(rotation);
      shaftMesh.position.copy(direction).multiplyScalar(proportions.shaftLength / 2);
      const headMesh = new THREE.Mesh(head, material);
      headMesh.quaternion.copy(rotation);
      headMesh.position
        .copy(direction)
        .multiplyScalar(proportions.shaftLength + proportions.headLength / 2);
      const label = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: createAxisLabelTexture(THREE, name, ORIGIN_AXIS_COLORS[axisIndex]),
          depthTest: false,
          depthWrite: false,
          toneMapped: false,
          transparent: true,
        }),
      );
      label.position.copy(direction).multiplyScalar(proportions.labelOffset);
      label.scale.setScalar(proportions.labelSize);
      label.renderOrder = 900;
      const axis = new THREE.Group();
      axis.name = `graviss-origin-axis-${name}`;
      axis.add(shaftMesh, headMesh, label);
      group.add(axis);
    }
    return group;
  }

  createModelGeometry() {
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
    const beamElements = this.geometry.elements.filter(({ kind }) => kind === "beam");
    const shellElements = this.geometry.elements.filter(({ kind }) => kind === "shell");
    this.createBeamGeometry(nodesById, beamElements);
    this.createShellGeometry(nodesById, shellElements);
    this.createNodeGeometry();
    this.createSupportGeometry(nodesById);
    this.createLocalAxesGeometry(nodesById, this.geometry.elements);
  }

  // Member matrices are written straight out of this flat array by index, which
  // is cheaper than resolving each node through a string-keyed Map every time
  // the element detail level rebuilds them.
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

  createBeamGeometry(nodesById, elements) {
    if (elements.length === 0) return;
    const THREE = this.THREE;
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
    // renderer from re-binding program state per group.
    // No `vertexColors` here: these geometries carry no colour attribute and
    // are tinted per instance. Declaring it defines USE_COLOR in the vertex
    // shader, where `vColor.rgb *= color` reads the missing attribute as black
    // and swallows the instance colour. The fragment shader already defines
    // USE_COLOR from the instance colour alone, so the tint arrives without it.
    const memberMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.55,
      metalness: 0.12,
    });
    this.memberMaterial = memberMaterial;
    for (const group of groups.values()) {
      const memberGeometry = this.createSectionGeometry(group.section?.shape);
      const memberMesh = new THREE.InstancedMesh(
        memberGeometry,
        memberMaterial,
        group.elements.length,
      );
      memberMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      memberMesh.userData.gravissBeamElements = group.elements;
      const nodeIndices = new Int32Array(group.elements.length * 2);
      const localY = new Float32Array(group.elements.length * 3);
      const hasLocalY = new Uint8Array(group.elements.length);
      group.elements.forEach((element, index) => {
        nodeIndices[index * 2] = this.nodeIndex(element.nodeIds[0]);
        nodeIndices[index * 2 + 1] = this.nodeIndex(element.nodeIds[1]);
        const suppliedY = element.localAxes?.y;
        if (!suppliedY) return;
        hasLocalY[index] = 1;
        localY[index * 3] = suppliedY[0];
        localY[index * 3 + 1] = suppliedY[1];
        localY[index * 3 + 2] = suppliedY[2];
      });
      memberMesh.userData.gravissBeamNodeIndices = nodeIndices;
      memberMesh.userData.gravissBeamLocalY = localY;
      memberMesh.userData.gravissBeamHasLocalY = hasLocalY;
      this.writeBeamMatrices(memberMesh);
      this.registerPickable(
        "element",
        memberMesh,
        group.elements,
        "members",
        "element",
        memberGroup,
      );
    }
  }

  // Writes every instance matrix of one member mesh straight into the
  // instanceMatrix buffer. Scratch objects are reused, so a full rebuild
  // allocates nothing regardless of how many beams the model has.
  writeBeamMatrices(mesh) {
    const nodeIndices = mesh.userData.gravissBeamNodeIndices;
    const localY = mesh.userData.gravissBeamLocalY;
    const hasLocalY = mesh.userData.gravissBeamHasLocalY;
    if (!nodeIndices) return;
    const positions = this.nodePositions;
    const scratch = this.beamScratch();
    const { matrix, quaternion, basis, xAxis, yAxis, zAxis, midpoint, scale } = scratch;
    const target = mesh.instanceMatrix.array;
    const count = nodeIndices.length / 2;
    for (let index = 0; index < count; index += 1) {
      const first = nodeIndices[index * 2] * 3;
      const second = nodeIndices[index * 2 + 1] * 3;
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
      if (hasLocalY[index]) {
        yAxis.set(localY[index * 3], localY[index * 3 + 1], localY[index * 3 + 2]);
      } else {
        yAxis.copy(this.worldUp).cross(xAxis);
      }
      if (yAxis.lengthSq() < 1e-12) yAxis.copy(this.modelYAxis);
      yAxis.addScaledVector(xAxis, -yAxis.dot(xAxis)).normalize();
      zAxis.crossVectors(xAxis, yAxis).normalize();
      basis.makeBasis(xAxis, yAxis, zAxis);
      quaternion.setFromRotationMatrix(basis);
      scale.set(length, 1, 1);
      matrix.compose(midpoint, quaternion, scale);
      matrix.toArray(target, index * 16);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  beamScratch() {
    const THREE = this.THREE;
    this._beamScratch ||= {
      matrix: new THREE.Matrix4(),
      quaternion: new THREE.Quaternion(),
      basis: new THREE.Matrix4(),
      xAxis: new THREE.Vector3(),
      yAxis: new THREE.Vector3(),
      zAxis: new THREE.Vector3(),
      midpoint: new THREE.Vector3(),
      scale: new THREE.Vector3(1, 1, 1),
    };
    return this._beamScratch;
  }

  createSectionGeometry(shape) {
    const THREE = this.THREE;
    // At axis level a member is its reference line, whatever section it has.
    if (!shape || this.elementDetail === "axis") {
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
      const outline = this.createSectionPath(THREE.Shape, shape.points);
      for (const hole of shape.holes || []) {
        outline.holes.push(this.createSectionPath(THREE.Path, hole));
      }
      return this.extrudeSectionShape(outline, 8);
    }
    throw new RangeError(`Unsupported Graviss section shape: ${shape.kind}`);
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
    // extrusion on Z. Graviss beams use length X, section width Y, height Z.
    geometry.rotateX(Math.PI / 2);
    geometry.rotateZ(Math.PI / 2);
    return geometry;
  }

  createShellGeometry(nodesById, elements) {
    if (elements.length === 0) return;
    const THREE = this.THREE;
    // At full detail an area element is drawn as both of its faces, half its
    // thickness either side of the surface it was given.
    const layers = this.elementDetail === "full" ? 2 : 1;
    let triangleCount = 0;
    let edgeCount = 0;
    for (const element of elements) {
      triangleCount += (element.nodeIds.length === 3 ? 1 : 2) * layers;
      edgeCount += element.nodeIds.length * layers;
    }
    const vertexCount = triangleCount * 3;
    const positions = new Float32Array(vertexCount * 3);
    const edgePositions = new Float32Array(edgeCount * 6);
    const faceNormal = new THREE.Vector3();
    const faceEdge = new THREE.Vector3();
    const faceOther = new THREE.Vector3();
    const entityRanges = [];
    const faceToEntityIndex = new Int32Array(triangleCount);
    let vertexCursor = 0;
    let edgeCursor = 0;
    let faceCursor = 0;

    elements.forEach((element, entityIndex) => {
      const nodes = element.nodeIds.map((nodeId) => nodesById.get(`${typeof nodeId}:${nodeId}`));
      const triangles = nodes.length === 3 ? TRIANGLE_FACES : QUAD_FACES;
      const start = vertexCursor;
      // Half the thickness either side, along the element's own normal.
      const half = layers === 2 ? Math.abs(element.thickness || 0) / 2 : 0;
      faceEdge.set(nodes[1].x - nodes[0].x, nodes[1].y - nodes[0].y, nodes[1].z - nodes[0].z);
      faceOther.set(nodes[2].x - nodes[0].x, nodes[2].y - nodes[0].y, nodes[2].z - nodes[0].z);
      faceNormal.crossVectors(faceEdge, faceOther);
      if (faceNormal.lengthSq() > 0) faceNormal.normalize();
      for (let layer = 0; layer < layers; layer += 1) {
        const side = layers === 1 ? 0 : layer === 0 ? half : -half;
        for (const triangle of triangles) {
          for (const nodeIndex of triangle) {
            const node = nodes[nodeIndex];
            positions[vertexCursor * 3] = node.x + faceNormal.x * side;
            positions[vertexCursor * 3 + 1] = node.y + faceNormal.y * side;
            positions[vertexCursor * 3 + 2] = node.z + faceNormal.z * side;
            vertexCursor += 1;
          }
          faceToEntityIndex[faceCursor] = entityIndex;
          faceCursor += 1;
        }
      }
      entityRanges.push({ start, count: triangles.length * 3 * layers });
      for (let layer = 0; layer < layers; layer += 1) {
        const side = layers === 1 ? 0 : layer === 0 ? half : -half;
        for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
          const startNode = nodes[nodeIndex];
          const endNode = nodes[(nodeIndex + 1) % nodes.length];
          edgePositions[edgeCursor * 6] = startNode.x + faceNormal.x * side;
          edgePositions[edgeCursor * 6 + 1] = startNode.y + faceNormal.y * side;
          edgePositions[edgeCursor * 6 + 2] = startNode.z + faceNormal.z * side;
          edgePositions[edgeCursor * 6 + 3] = endNode.x + faceNormal.x * side;
          edgePositions[edgeCursor * 6 + 4] = endNode.y + faceNormal.y * side;
          edgePositions[edgeCursor * 6 + 5] = endNode.z + faceNormal.z * side;
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
    const shellMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.72,
      metalness: 0.04,
      side: THREE.DoubleSide,
      vertexColors: true,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    const shellMesh = new THREE.Mesh(shellGeometry, shellMaterial);
    shellMesh.userData.gravissEntityRanges = entityRanges;
    shellMesh.userData.gravissFaceToEntityIndex = faceToEntityIndex;

    const edgeGeometry = new THREE.BufferGeometry();
    edgeGeometry.setAttribute("position", new THREE.BufferAttribute(edgePositions, 3));
    const edgeMaterial = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.62,
      depthWrite: false,
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

  createNodeGeometry() {
    const THREE = this.THREE;
    const matrix = new THREE.Matrix4();

    const nodeGeometry = new THREE.SphereGeometry(0.115, 12, 8);
    const nodeMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.5,
    });
    const nodeMesh = new THREE.InstancedMesh(
      nodeGeometry,
      nodeMaterial,
      this.geometry.nodes.length,
    );
    this.geometry.nodes.forEach((node, index) => {
      matrix.makeTranslation(node.x, node.y, node.z);
      nodeMesh.setMatrixAt(index, matrix);
    });
    nodeMesh.instanceMatrix.needsUpdate = true;
    this.registerInstances("node", nodeMesh, this.geometry.nodes, "nodes", "node");
  }

  createSupportGeometry(nodesById) {
    const THREE = this.THREE;
    const yAxis = new THREE.Vector3(0, 1, 0);
    const matrix = new THREE.Matrix4();

    const supports = this.geometry.supports || [];
    if (supports.length === 0) return;
    const supportGeometry = new THREE.ConeGeometry(0.3, 0.52, 4);
    const supportMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.65,
    });
    const supportMesh = new THREE.InstancedMesh(supportGeometry, supportMaterial, supports.length);
    const supportRotation = new THREE.Quaternion().setFromUnitVectors(yAxis, this.worldUp);
    const unitScale = new THREE.Vector3(1, 1, 1);
    const position = new THREE.Vector3();
    supports.forEach((support, index) => {
      const node = nodesById.get(`${typeof support.nodeId}:${support.nodeId}`);
      position.set(node.x, node.y, node.z).addScaledVector(this.worldUp, -0.27);
      matrix.compose(position, supportRotation, unitScale);
      supportMesh.setMatrixAt(index, matrix);
    });
    supportMesh.instanceMatrix.needsUpdate = true;
    supportMesh.userData.gravissSupportRotation = supportRotation;
    this.registerInstances("support", supportMesh, supports, "supports", "support");
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
    lines.renderOrder = 3;
    lines.visible = this.visibility.localAxes;
    lines.userData.gravissAxisLength = axisLength;
    this.localAxes = lines;
    this.meshes.localAxes = lines;
    this.scene.add(lines);
  }

  elementCenter(element, nodesById = this.nodesById, target = new this.THREE.Vector3()) {
    target.set(0, 0, 0);
    for (const nodeId of element.nodeIds) {
      const node = nodesById.get(`${typeof nodeId}:${nodeId}`);
      target.x += node.x;
      target.y += node.y;
      target.z += node.z;
    }
    return target.multiplyScalar(1 / element.nodeIds.length);
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

  applyTheme() {
    if (this.destroyed) return;
    const themeColor = this.colorFromTheme("--base-background-color", "#101b24");
    const automaticAppearance =
      themeColor.r + themeColor.g + themeColor.b < 0.9 ? "midnight" : "cloud";
    this.activeAppearance = this.appearance === "auto" ? automaticAppearance : this.appearance;
    const appearance = appearanceDefinition(this.activeAppearance);
    this.scene.background = new this.THREE.Color(appearance.background);
    this.canvasRenderer.setClearColor(appearance.background, 1);
    this.applyGridAppearance(appearance);
    this.colors = {
      element: new this.THREE.Color(appearance.member),
      shell: new this.THREE.Color(appearance.shell),
      node: new this.THREE.Color(appearance.node),
      support: new this.THREE.Color(appearance.support),
      selected: new this.THREE.Color("#ff6b35"),
    };
    const shellEdges = this.meshes.shells?.userData.gravissEdges;
    if (shellEdges) shellEdges.material.color.setHex(appearance.shellEdge);
    this.refreshInstanceColors();
    this.viewCube?.setScheme(this.activeAppearance);
    this.host.closest(".graviss")?.setAttribute("data-appearance", this.activeAppearance);
    this.requestRender();
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

  // How much of an element is drawn: its reference line, its cross-section, or
  // the section with the area elements given their real thickness. Members are
  // rebuilt because their geometry changes; shells only change what is shown.
  setElementDetail(level) {
    if (!DETAIL_LEVELS.includes(level) || level === this.elementDetail) return this.elementDetail;
    this.elementDetail = level;
    this.rebuildMemberMeshes();
    this.applyShellDetail();
    this.refreshInstanceColors();
    this.requestRender();
    return this.elementDetail;
  }

  getElementDetail() {
    return this.elementDetail;
  }

  rebuildMemberMeshes() {
    const group = this.meshes.members;
    if (!group) return;
    for (const child of [...group.children]) {
      child.geometry?.dispose();
      group.remove(child);
    }
    this.pickables = this.pickables.filter((mesh) => mesh.userData.visibilityKey !== "members");
    this.scene.remove(group);
    delete this.meshes.members;
    const beams = this.geometry.elements.filter(({ kind }) => kind === "beam");
    this.createBeamGeometry(this.nodesById, beams);
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
    rebuilt.visible = this.visibility.shells !== false;
    // At axis level an area element is only its outline.
    rebuilt.material.visible = this.elementDetail !== "axis";
  }

  setAppearance(name) {
    if (name !== "auto" && !APPEARANCE_IDS.includes(name)) return this.appearance;
    this.appearance = name;
    this.applyTheme();
    return this.appearance;
  }

  installEvents() {
    const canvas = this.canvasRenderer.domElement;
    this.onPointerDown = (event) => {
      this.flushScheduledCameraChange();
      this.pointerDown = { x: event.clientX, y: event.clientY };
    };
    this.onPointerUp = (event) => {
      const origin = this.pointerDown;
      this.pointerDown = null;
      if (!origin || Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 4) return;
      this.pick(event);
    };
    this.onWheel = () => this.scheduleCameraChange();
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("wheel", this.onWheel, { capture: true, passive: true });
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
    this.canvasRenderer.setSize(width, height, false);
    this.perspectiveCamera.aspect = aspect;
    this.perspectiveCamera.updateProjectionMatrix();
    this.updateOrthographicFrustum(aspect);
    this.requestRender();
  }

  updateOrthographicFrustum(aspect) {
    const halfHeight = (this.orthographicHeight || this.bounds.radius * 2.6) / 2;
    this.orthographicCamera.left = -halfHeight * aspect;
    this.orthographicCamera.right = halfHeight * aspect;
    this.orthographicCamera.top = halfHeight;
    this.orthographicCamera.bottom = -halfHeight;
    this.orthographicCamera.updateProjectionMatrix();
  }

  pick(event) {
    const canvas = this.canvasRenderer.domElement;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const intersection = this.raycaster.intersectObjects(
      this.pickables.filter((mesh) => this.isObjectVisible(mesh)),
      false,
    )[0];
    let hit = null;
    if (intersection) {
      const type = intersection.object.userData.gravissType;
      const entityIndex =
        intersection.instanceId ??
        intersection.object.userData.gravissFaceToEntityIndex?.[intersection.faceIndex];
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

  // At axis level an area element is drawn as its outline alone, so the same
  // line segments are the element itself rather than a mesh drawn over it and
  // the mesh-line switch leaves them be. Everywhere else they are the mesh.
  shellEdgesVisible() {
    return this.elementDetail === "axis" || this.visibility.mesh !== false;
  }

  setVisibility(name, visible) {
    if (!(name in this.visibility)) return;
    this.visibility[name] = Boolean(visible);
    const object = this.meshes[name] || this[name];
    if (object) {
      object.visible = name === "mesh" ? this.shellEdgesVisible() : this.visibility[name];
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
      if (!this.destroyed) {
        this.camera.updateMatrixWorld(true);
        this.updateLighting();
        if (this.orientationGizmo) {
          this.orientationGizmo.update(this.camera.quaternion);
          const mainAxesVisible =
            this.visibility.axes && isWorldPointVisible(this.axes.position, this.camera);
          this.orientationGizmo.element.hidden = !this.visibility.axes || mainAxesVisible;
        }
        this.viewCube?.update(this.camera.quaternion);
        this.canvasRenderer.render(this.scene, this.camera);
        this.frameRateMeter.record(timestamp);
      }
    });
  }

  getSceneSummary() {
    const members = this.geometry.elements.filter(({ kind }) => kind === "beam").length;
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
    if (this.renderFrame != null) cancelAnimationFrame(this.renderFrame);
    this.cancelCameraAnimation();
    this.cancelScheduledCameraChange();
    this.frameRateMeter.dispose();
    this.resizeObserver?.disconnect();
    window.removeEventListener("resize", this.onWindowResize);
    const canvas = this.canvasRenderer?.domElement;
    canvas?.removeEventListener("pointerdown", this.onPointerDown);
    canvas?.removeEventListener("pointerup", this.onPointerUp);
    canvas?.removeEventListener("wheel", this.onWheel, true);
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
