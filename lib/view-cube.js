const { appearanceDefinition } = require("./appearance");
const {
  CAMERA_VIEWS,
  CAMERA_VIEW_IDS,
  cameraViewDefinition,
  cameraViewIdForDirection,
} = require("./camera-navigation");

const FACE_SIZE = 1.36;
const CUBE_HALF_SIZE = FACE_SIZE / 2;
const FACE_BORDER_SIZE = 0.27;
const FACE_CENTER_SIZE = FACE_SIZE - FACE_BORDER_SIZE * 2;
const FACE_BORDER_CENTER = (FACE_SIZE - FACE_BORDER_SIZE) / 2;
const VIEW_HALF_SIZE = 1.42;
const MIN_PIXEL_RATIO = 2;
const MAX_PIXEL_RATIO = 3;
const PART_BY_AXES = Object.freeze([null, "face", "edge", "corner"]);

function viewCubePixelRatio(devicePixelRatio) {
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.min(MAX_PIXEL_RATIO, Math.max(MIN_PIXEL_RATIO, ratio));
}

function cubeTargetDefinitions(coordinateSystem = null) {
  return CAMERA_VIEW_IDS.map((viewId) => {
    const definition = cameraViewDefinition(viewId, coordinateSystem);
    const activeAxes = definition.direction.filter((value) => value !== 0).length;
    return Object.freeze({
      viewId,
      label: definition.label,
      direction: definition.direction,
      up: definition.up,
      part: PART_BY_AXES[activeAxes],
    });
  });
}

function cubeFaceQuaternion(THREE, direction, upDirection = null) {
  if (!Array.isArray(direction) || direction.length !== 3) {
    throw new TypeError("Cube-face orientation requires a three-component direction");
  }
  const normal = new THREE.Vector3(...direction);
  if (normal.lengthSq() === 0) {
    throw new RangeError("Cube-face orientation requires a nonzero direction");
  }
  normal.normalize();
  const zAxis = new THREE.Vector3(0, 0, 1);
  const up = upDirection
    ? new THREE.Vector3(...upDirection).normalize()
    : Math.abs(normal.dot(zAxis)) > 1 - 1e-9
      ? new THREE.Vector3(0, 1, 0)
      : new THREE.Vector3(0, 0, 1);
  const right = up.clone().cross(normal).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(right, up, normal),
  );
}

function cubeFaceRegions(THREE, coordinateSystem = null) {
  const xAxis = new THREE.Vector3(1, 0, 0);
  const yAxis = new THREE.Vector3(0, 1, 0);
  return cubeTargetDefinitions(coordinateSystem)
    .filter(({ part }) => part === "face")
    .flatMap((face) => {
      const normal = new THREE.Vector3(...face.direction);
      const rotation = cubeFaceQuaternion(THREE, face.direction, face.up);
      const horizontal = xAxis.clone().applyQuaternion(rotation);
      const vertical = yAxis.clone().applyQuaternion(rotation);

      return [-1, 0, 1].flatMap((verticalPosition) =>
        [-1, 0, 1].map((horizontalPosition) => {
          const direction = normal
            .clone()
            .addScaledVector(horizontal, horizontalPosition)
            .addScaledVector(vertical, verticalPosition)
            .toArray()
            .map((value) => Math.round(value));
          const viewId = cameraViewIdForDirection(direction, coordinateSystem);
          const target = cameraViewDefinition(viewId, coordinateSystem);
          return Object.freeze({
            faceViewId: face.viewId,
            viewId,
            label: target.label,
            direction: target.direction,
            part: PART_BY_AXES[direction.filter((value) => value !== 0).length],
            horizontalPosition,
            verticalPosition,
          });
        }),
      );
    });
}

function viewCubeRotation(THREE, cameraQuaternion) {
  if (!cameraQuaternion?.isQuaternion) {
    throw new TypeError("View-cube rotation requires a Three.js camera quaternion");
  }
  return cameraQuaternion.clone().invert();
}

class ViewCube {
  constructor(THREE, canvas, { coordinateSystem = null, onSelect } = {}) {
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new TypeError("ViewCube requires a canvas element");
    }
    this.THREE = THREE;
    this.canvas = canvas;
    this.onSelect = onSelect;
    this.coordinateSystem = coordinateSystem;
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(
      -VIEW_HALF_SIZE,
      VIEW_HALF_SIZE,
      VIEW_HALF_SIZE,
      -VIEW_HALF_SIZE,
      0.1,
      20,
    );
    this.camera.position.set(0, 0, 5);
    this.camera.lookAt(0, 0, 0);
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(viewCubePixelRatio(window.devicePixelRatio));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.textureAnisotropy = Math.max(1, this.renderer.capabilities.getMaxAnisotropy());
    this.root = new THREE.Group();
    this.root.name = "rotating-view-cube";
    this.scene.add(this.root);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x70818a, 2.4));
    const light = new THREE.DirectionalLight(0xffffff, 2.2);
    light.position.set(-3, 4, 6);
    this.scene.add(light);
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.pickTargets = [];
    this.displayTargets = new Map();
    this.faceMaterials = [];
    this.labelMaterials = [];
    this.outlineMaterial = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.82 });
    this.selectedView = null;
    this.hoveredView = null;
    this.scheme = "cloud";
    this.createTargets();
    this.publishTargetCounts();
    this.setScheme("cloud");
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    canvas.addEventListener("pointermove", this.handlePointerMove);
    canvas.addEventListener("pointerleave", this.handlePointerLeave);
    canvas.addEventListener("click", this.handleClick);
    canvas.addEventListener("keydown", this.handleKeyDown);
    this.resize();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener("pointermove", this.handlePointerMove);
    this.canvas.removeEventListener("pointerleave", this.handlePointerLeave);
    this.canvas.removeEventListener("click", this.handleClick);
    this.canvas.removeEventListener("keydown", this.handleKeyDown);
    disposeObjectTree(this.scene);
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  update(cameraQuaternion) {
    const signature = cameraQuaternion
      .toArray()
      .map((value) => value.toFixed(6))
      .join(":");
    if (signature === this.canvas.dataset.cameraOrientation) return;
    this.canvas.dataset.cameraOrientation = signature;
    this.root.quaternion.copy(viewCubeRotation(this.THREE, cameraQuaternion));
    this.root.updateMatrixWorld(true);
    this.hoveredView = null;
    this.canvas.dataset.hoverView = "";
    this.canvas.dataset.hoverPart = "";
    this.canvas.style.cursor = "default";
    this.paintTargets();
    this.render();
  }

  setSelection(viewId) {
    this.selectedView = CAMERA_VIEWS[viewId] ? viewId : null;
    this.canvas.dataset.selectedView = this.selectedView || "";
    this.canvas.dataset.selectedPart = this.displayTargets.get(this.selectedView)?.part || "";
    this.paintTargets();
    this.render();
  }

  setScheme(name) {
    this.scheme = name;
    this.paintTargets();
    this.render();
  }

  createTargets() {
    const THREE = this.THREE;
    const faces = new Map();
    for (const definition of cubeTargetDefinitions(this.coordinateSystem).filter(
      ({ part }) => part === "face",
    )) {
      faces.set(definition.viewId, this.createFace(definition));
    }
    const boxGeometry = new THREE.BoxGeometry(FACE_SIZE, FACE_SIZE, FACE_SIZE);
    const outlineGeometry = new THREE.EdgesGeometry(boxGeometry);
    boxGeometry.dispose();
    const outline = new THREE.LineSegments(outlineGeometry, this.outlineMaterial);
    outline.name = "view-cube-outline";
    outline.renderOrder = 4;
    this.root.add(outline);
    for (const region of cubeFaceRegions(THREE, this.coordinateSystem)) {
      this.createFaceRegion(faces.get(region.faceViewId), region);
    }
  }

  createFace(definition) {
    const THREE = this.THREE;
    const normal = new THREE.Vector3(...definition.direction);
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.86,
      metalness: 0,
    });
    this.faceMaterials.push(material);
    const face = new THREE.Mesh(new THREE.PlaneGeometry(FACE_SIZE, FACE_SIZE), material);
    face.name = `${definition.viewId}-face`;
    face.position.copy(normal).multiplyScalar(CUBE_HALF_SIZE);
    face.quaternion.copy(cubeFaceQuaternion(THREE, definition.direction, definition.up));
    const labelMaterial = new THREE.MeshBasicMaterial({
      map: createLabelTexture(THREE, definition.label, this.textureAnisotropy),
      color: 0xffffff,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    this.labelMaterials.push(labelMaterial);
    const label = new THREE.Mesh(new THREE.PlaneGeometry(0.92, 0.92), labelMaterial);
    label.name = `${definition.viewId}-label`;
    label.position.z = 0.012;
    label.renderOrder = 3;
    face.add(label);
    this.root.add(face);
    return face;
  }

  createFaceRegion(face, definition) {
    const THREE = this.THREE;
    const width = definition.horizontalPosition === 0 ? FACE_CENTER_SIZE : FACE_BORDER_SIZE;
    const height = definition.verticalPosition === 0 ? FACE_CENTER_SIZE : FACE_BORDER_SIZE;
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const region = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
    region.name = `${definition.faceViewId}-${definition.viewId}-${definition.part}-region`;
    region.position.set(
      definition.horizontalPosition * FACE_BORDER_CENTER,
      definition.verticalPosition * FACE_BORDER_CENTER,
      0.006,
    );
    region.renderOrder = 2;
    face.add(region);
    let target = this.displayTargets.get(definition.viewId);
    if (!target) {
      target = { ...definition, displayObjects: [] };
      this.displayTargets.set(definition.viewId, target);
    }
    target.displayObjects.push(region);
    region.userData.viewCubeTarget = target;
    this.pickTargets.push(region);
  }

  pick(event) {
    const bounds = this.canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return null;
    this.pointer.set(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return (
      this.raycaster.intersectObjects(this.pickTargets, false)[0]?.object.userData.viewCubeTarget ||
      null
    );
  }

  handlePointerMove = (event) => {
    const target = this.pick(event);
    const nextView = target?.viewId || null;
    if (nextView === this.hoveredView) return;
    this.hoveredView = nextView;
    this.canvas.dataset.hoverView = nextView || "";
    this.canvas.dataset.hoverPart = target?.part || "";
    this.canvas.style.cursor = target ? "pointer" : "default";
    this.canvas.dataset.tooltip = target
      ? `${target.label} view`
      : "Rotate to a standard camera view";
    this.paintTargets();
    this.render();
  };

  handlePointerLeave = () => {
    this.hoveredView = null;
    this.canvas.dataset.hoverView = "";
    this.canvas.dataset.hoverPart = "";
    this.canvas.style.cursor = "default";
    this.paintTargets();
    this.render();
  };

  handleClick = (event) => {
    const target = this.pick(event);
    if (!target) return;
    this.setSelection(target.viewId);
    this.onSelect?.(target.viewId);
  };

  handleKeyDown = (event) => {
    if ((event.key !== "Enter" && event.key !== " ") || !this.hoveredView) return;
    event.preventDefault();
    this.setSelection(this.hoveredView);
    this.onSelect?.(this.hoveredView);
  };

  paintTargets() {
    const palette = appearanceDefinition(this.scheme);
    for (const material of this.faceMaterials) material.color.setHex(palette.cubeFace);
    for (const material of this.labelMaterials) material.color.setHex(palette.cubeText);
    this.outlineMaterial.color.setHex(palette.cubeBorder);
    for (const target of this.displayTargets.values()) {
      const highlighted = target.viewId === this.hoveredView;
      const selected = target.viewId === this.selectedView;
      for (const displayObject of target.displayObjects) {
        displayObject.material.color.setHex(highlighted ? 0x76d5f2 : 0x25b8e8);
        displayObject.material.opacity = highlighted ? 0.9 : selected ? 0.78 : 0;
      }
    }
  }

  publishTargetCounts() {
    const counts = { face: 0, edge: 0, corner: 0 };
    for (const target of this.displayTargets.values()) counts[target.part] += 1;
    this.canvas.dataset.faceTargets = String(counts.face);
    this.canvas.dataset.edgeTargets = String(counts.edge);
    this.canvas.dataset.cornerTargets = String(counts.corner);
    this.canvas.dataset.renderer = "threejs";
  }

  resize() {
    const width = Math.max(1, this.canvas.clientWidth || 120);
    const height = Math.max(1, this.canvas.clientHeight || 120);
    this.renderer.setSize(width, height, false);
    const aspect = width / height;
    this.camera.left = -VIEW_HALF_SIZE * aspect;
    this.camera.right = VIEW_HALF_SIZE * aspect;
    this.camera.top = VIEW_HALF_SIZE;
    this.camera.bottom = -VIEW_HALF_SIZE;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  render() {
    if (!this.destroyed) this.renderer.render(this.scene, this.camera);
  }
}

function createLabelTexture(THREE, label, anisotropy = 1) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, 512, 512);
  context.fillStyle = "#ffffff";
  context.font = '800 172px "Segoe UI", sans-serif';
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label.toUpperCase(), 256, 260, 448);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = Math.max(1, anisotropy);
  return texture;
}

function disposeObjectTree(root) {
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  root.traverse((object) => {
    if (object.geometry && !geometries.has(object.geometry)) {
      geometries.add(object.geometry);
      object.geometry.dispose();
    }
    const objectMaterials = Array.isArray(object.material)
      ? object.material
      : object.material
        ? [object.material]
        : [];
    for (const material of objectMaterials) {
      if (materials.has(material)) continue;
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value?.isTexture && !textures.has(value)) {
          textures.add(value);
          value.dispose();
        }
      }
      material.dispose();
    }
  });
}

module.exports = {
  ViewCube,
  createLabelTexture,
  cubeFaceQuaternion,
  cubeFaceRegions,
  cubeTargetDefinitions,
  viewCubePixelRatio,
  viewCubeRotation,
};
