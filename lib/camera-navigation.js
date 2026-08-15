const { canonicalDirectionToModel, modelDirectionToCanonical } = require("./coordinate-system");

const PROJECTION_MODES = Object.freeze(["perspective", "orthographic"]);

const CAMERA_VIEWS = Object.freeze({
  top: view("Top", [0, 0, 1]),
  bottom: view("Bottom", [0, 0, -1]),
  front: view("Front", [0, -1, 0]),
  back: view("Back", [0, 1, 0]),
  right: view("Right", [1, 0, 0]),
  left: view("Left", [-1, 0, 0]),
  "top-left": view("Top left", [-1, 0, 1]),
  "top-back": view("Top back", [0, 1, 1]),
  "top-right": view("Top right", [1, 0, 1]),
  "top-front": view("Top front", [0, -1, 1]),
  "front-left": view("Front left", [-1, -1, 0]),
  "front-right": view("Front right", [1, -1, 0]),
  "bottom-front": view("Bottom front", [0, -1, -1]),
  "bottom-back": view("Bottom back", [0, 1, -1]),
  "bottom-left": view("Bottom left", [-1, 0, -1]),
  "bottom-right": view("Bottom right", [1, 0, -1]),
  "back-left": view("Back left", [-1, 1, 0]),
  "back-right": view("Back right", [1, 1, 0]),
  "top-back-left": view("Top back left", [-1, 1, 1]),
  "top-back-right": view("Top back right", [1, 1, 1]),
  "top-front-right": view("Top front right", [1, -1, 1]),
  "top-front-left": view("Top front left", [-1, -1, 1]),
  "bottom-front-left": view("Bottom front left", [-1, -1, -1]),
  "bottom-front-right": view("Bottom front right", [1, -1, -1]),
  "bottom-back-left": view("Bottom back left", [-1, 1, -1]),
  "bottom-back-right": view("Bottom back right", [1, 1, -1]),
});

const CAMERA_VIEW_IDS = Object.freeze(Object.keys(CAMERA_VIEWS));

function cameraViewDefinition(viewId, coordinateSystem = null) {
  const definition = CAMERA_VIEWS[viewId] || CAMERA_VIEWS["top-front-right"];
  if (!coordinateSystem || coordinateSystem.upAxis === "z") return definition;
  return {
    ...definition,
    direction: canonicalDirectionToModel(definition.direction, coordinateSystem),
    up: canonicalDirectionToModel(definition.up, coordinateSystem),
  };
}

function cameraViewIdForDirection(direction, coordinateSystem = null) {
  if (!Array.isArray(direction) || direction.length !== 3) return null;
  const canonical = coordinateSystem
    ? modelDirectionToCanonical(direction, coordinateSystem)
    : direction;
  const normalized = canonical.map((value) => Math.sign(value));
  return (
    CAMERA_VIEW_IDS.find((viewId) =>
      CAMERA_VIEWS[viewId].direction.every((value, index) => value === normalized[index]),
    ) || null
  );
}

function sphereFitDistance(radius, fieldOfViewDegrees, aspect, fillFraction = 0.82) {
  if (
    !(radius > 0) ||
    !(fieldOfViewDegrees > 0 && fieldOfViewDegrees < 180) ||
    !(aspect > 0) ||
    !(fillFraction > 0 && fillFraction <= 1)
  ) {
    throw new RangeError(
      "Camera fitting requires a positive radius and aspect, a valid field of view, and a fill fraction",
    );
  }
  const halfFieldOfView = (fieldOfViewDegrees * Math.PI) / 360;
  const verticalDistance = radius / Math.sin(halfFieldOfView);
  const horizontalDistance = verticalDistance / Math.max(aspect, 0.4);
  return Math.max(verticalDistance, horizontalDistance) / fillFraction;
}

function orthographicFitHeight(radius, aspect, fillFraction = 0.82) {
  if (!(radius > 0) || !(aspect > 0) || !(fillFraction > 0 && fillFraction <= 1)) {
    throw new RangeError(
      "Orthographic fitting requires a positive radius and aspect and a valid fill fraction",
    );
  }
  return (2 * radius) / (Math.min(aspect, 1) * fillFraction);
}

function perspectiveVisibleHeight(distance, fieldOfViewDegrees, zoom = 1) {
  if (!(distance > 0) || !(fieldOfViewDegrees > 0 && fieldOfViewDegrees < 180) || !(zoom > 0)) {
    throw new RangeError(
      "Perspective scale requires a positive distance and zoom and a valid field of view",
    );
  }
  const halfFieldOfView = (fieldOfViewDegrees * Math.PI) / 360;
  return (2 * distance * Math.tan(halfFieldOfView)) / zoom;
}

function perspectiveDistanceForHeight(height, fieldOfViewDegrees, zoom = 1) {
  if (!(height > 0) || !(fieldOfViewDegrees > 0 && fieldOfViewDegrees < 180) || !(zoom > 0)) {
    throw new RangeError(
      "Perspective scale requires a positive height and zoom and a valid field of view",
    );
  }
  const halfFieldOfView = (fieldOfViewDegrees * Math.PI) / 360;
  return (height * zoom) / (2 * Math.tan(halfFieldOfView));
}

function validateCameraState(cameraState) {
  if (!cameraState || typeof cameraState !== "object" || Array.isArray(cameraState)) {
    throw new TypeError("A Graviss graphic requires a camera state");
  }
  if (!PROJECTION_MODES.includes(cameraState.projection)) {
    throw new RangeError(`Unsupported Graviss projection: ${cameraState.projection}`);
  }
  const position = finiteVector(cameraState.position, "position");
  const target = finiteVector(cameraState.target, "target");
  const up = finiteVector(cameraState.up, "up");
  const direction = position.map((value, index) => target[index] - value);
  const directionLength = Math.hypot(...direction);
  const upLength = Math.hypot(...up);
  if (!(directionLength > 0) || !(upLength > 0)) {
    throw new RangeError("Graviss camera position, target, and up must define an orientation");
  }
  const cross = [
    direction[1] * up[2] - direction[2] * up[1],
    direction[2] * up[0] - direction[0] * up[2],
    direction[0] * up[1] - direction[1] * up[0],
  ];
  if (Math.hypot(...cross) <= directionLength * upLength * 1e-9) {
    throw new RangeError("Graviss camera up must not be parallel to its viewing direction");
  }
  if (
    cameraState.fieldOfView != null &&
    !(
      Number.isFinite(cameraState.fieldOfView) &&
      cameraState.fieldOfView > 0 &&
      cameraState.fieldOfView < 180
    )
  ) {
    throw new RangeError("Graviss camera fieldOfView must be between 0 and 180 degrees");
  }
  if (
    cameraState.frustumHeight != null &&
    !(Number.isFinite(cameraState.frustumHeight) && cameraState.frustumHeight > 0)
  ) {
    throw new RangeError("Graviss camera frustumHeight must be positive");
  }
  return cameraState;
}

function finiteVector(value, name) {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some((component) => !Number.isFinite(component))
  ) {
    throw new TypeError(`Graviss camera ${name} must contain three finite numbers`);
  }
  return value;
}

function view(label, direction) {
  const vertical = direction[0] === 0 && direction[1] === 0;
  return Object.freeze({
    label,
    direction: Object.freeze(direction),
    up: Object.freeze(vertical ? [0, 1, 0] : [0, 0, 1]),
  });
}

module.exports = {
  CAMERA_VIEWS,
  CAMERA_VIEW_IDS,
  PROJECTION_MODES,
  cameraViewDefinition,
  cameraViewIdForDirection,
  orthographicFitHeight,
  perspectiveDistanceForHeight,
  perspectiveVisibleHeight,
  sphereFitDistance,
  validateCameraState,
};
