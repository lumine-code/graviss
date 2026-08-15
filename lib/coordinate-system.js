const UP_AXES = Object.freeze(["x", "-x", "y", "-y", "z", "-z"]);

const MODEL_FROM_CANONICAL = Object.freeze({
  z: matrix([1, 0, 0], [0, 1, 0], [0, 0, 1]),
  "-z": matrix([1, 0, 0], [0, -1, 0], [0, 0, -1]),
  y: matrix([1, 0, 0], [0, 0, 1], [0, -1, 0]),
  "-y": matrix([1, 0, 0], [0, 0, -1], [0, 1, 0]),
  x: matrix([0, 0, 1], [0, 1, 0], [-1, 0, 0]),
  "-x": matrix([0, 0, -1], [0, 1, 0], [1, 0, 0]),
});

function coordinateSystemDefinition(coordinateSystem = {}) {
  const upAxis = UP_AXES.includes(coordinateSystem.upAxis) ? coordinateSystem.upAxis : "z";
  const modelFromCanonical = MODEL_FROM_CANONICAL[upAxis];
  return Object.freeze({
    ...coordinateSystem,
    upAxis,
    handedness: coordinateSystem.handedness || "right",
    up: Object.freeze(mapDirection([0, 0, 1], modelFromCanonical)),
    down: Object.freeze(mapDirection([0, 0, -1], modelFromCanonical)),
    modelFromCanonical,
  });
}

function canonicalDirectionToModel(direction, coordinateSystem) {
  return mapDirection(direction, coordinateSystemDefinition(coordinateSystem).modelFromCanonical);
}

function modelDirectionToCanonical(direction, coordinateSystem) {
  const definition = coordinateSystemDefinition(coordinateSystem);
  const transposed = definition.modelFromCanonical[0].map((_, column) =>
    definition.modelFromCanonical.map((row) => row[column]),
  );
  return mapDirection(direction, transposed);
}

function matrix(...rows) {
  return Object.freeze(rows.map((row) => Object.freeze(row)));
}

function mapDirection(direction, transform) {
  if (!Array.isArray(direction) || direction.length !== 3) {
    throw new TypeError("A coordinate-system direction must contain three components");
  }
  return transform.map((row) =>
    row.reduce((sum, value, index) => sum + value * direction[index], 0),
  );
}

module.exports = {
  UP_AXES,
  canonicalDirectionToModel,
  coordinateSystemDefinition,
  modelDirectionToCanonical,
};
