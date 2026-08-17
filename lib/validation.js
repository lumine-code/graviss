const ELEMENT_NODE_COUNTS = new Map([
  ["beam", [2]],
  ["shell", [3, 4]],
]);
const SECTION_SHAPE_FIELDS = new Map([
  ["rectangle", ["width", "height"]],
  ["circle", ["diameter"]],
  ["tube", ["diameter", "thickness"]],
  ["tee", ["webWidth", "height", "flangeWidth", "flangeThickness"]],
  ["polygon", []],
]);

function fail(message) {
  throw new TypeError(`Invalid Graviss model: ${message}`);
}

function isObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isId(value) {
  return (
    (typeof value === "string" && value.length > 0) ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function assertId(value, location) {
  if (!isId(value)) fail(`${location} must be a non-empty string or finite number`);
}

function assertUniqueId(id, ids, location) {
  assertId(id, `${location}.id`);
  const key = `${typeof id}:${id}`;
  if (ids.has(key)) fail(`${location}.id duplicates ${JSON.stringify(id)}`);
  ids.add(key);
}

function validateCapabilities(capabilities) {
  if (!isObject(capabilities)) fail("description.capabilities must be an object");
  if (capabilities.geometry !== true && !isObject(capabilities.geometry)) {
    fail("description.capabilities.geometry must be true or an object");
  }
  if (isObject(capabilities.geometry)) {
    const { elementKinds, supports, sections, localAxes } = capabilities.geometry;
    if (!Array.isArray(elementKinds) || elementKinds.length === 0) {
      fail("description.capabilities.geometry.elementKinds must be a non-empty array");
    }
    const uniqueKinds = new Set(elementKinds);
    if (
      uniqueKinds.size !== elementKinds.length ||
      elementKinds.some((kind) => !ELEMENT_NODE_COUNTS.has(kind))
    ) {
      fail(
        `description.capabilities.geometry.elementKinds must contain unique supported kinds: ${[
          ...ELEMENT_NODE_COUNTS.keys(),
        ].join(", ")}`,
      );
    }
    if (supports != null && typeof supports !== "boolean") {
      fail("description.capabilities.geometry.supports must be a boolean");
    }
    if (sections != null && typeof sections !== "boolean") {
      fail("description.capabilities.geometry.sections must be a boolean");
    }
    if (localAxes != null && typeof localAxes !== "boolean") {
      fail("description.capabilities.geometry.localAxes must be a boolean");
    }
  }
  return capabilities;
}

function validateDescription(description) {
  if (!isObject(description)) fail("session.describe() must return an object");
  const model = description.model;
  if (!isObject(model)) fail("description.model must be an object");
  assertId(model.id, "description.model.id");
  if (typeof model.title !== "string" || model.title.length === 0) {
    fail("description.model.title must be a non-empty string");
  }
  if (typeof model.source !== "string" || model.source.length === 0) {
    fail("description.model.source must be a non-empty string");
  }
  if (
    !isObject(model.coordinateSystem) ||
    !["x", "-x", "y", "-y", "z", "-z"].includes(model.coordinateSystem.upAxis)
  ) {
    fail("description.model.coordinateSystem.upAxis must be a signed X, Y, or Z axis");
  }
  validateCapabilities(description.capabilities);
  return description;
}

function validateSession(session) {
  if (!isObject(session)) fail("source session must be an object");
  for (const method of ["describe", "getGeometry", "dispose"]) {
    if (typeof session[method] !== "function") {
      fail(`source session must implement ${method}()`);
    }
  }
  if (session.onDidChange != null && typeof session.onDidChange !== "function") {
    fail("source session onDidChange must be a function when supplied");
  }
  return session;
}

const CHANGE_SCOPES = Object.freeze(["all", "geometry"]);

function validateSourceProvider(provider) {
  if (!isObject(provider)) fail("a graviss.source provider must be an object");
  assertId(provider.id, "provider.id");
  if (typeof provider.createSession !== "function") {
    fail("a graviss.source provider must implement createSession()");
  }
  return provider;
}

function validateChangeEvent(event) {
  const scope = event?.scope ?? "all";
  if (!CHANGE_SCOPES.includes(scope)) {
    fail(`session change scope must be one of ${CHANGE_SCOPES.join(", ")}`);
  }
  return { scope };
}

function validateGeometry(geometry) {
  if (!isObject(geometry)) fail("geometry must be an object");
  if (!Array.isArray(geometry.nodes)) fail("geometry.nodes must be an array");
  if (!Array.isArray(geometry.elements)) fail("geometry.elements must be an array");
  if (geometry.supports != null && !Array.isArray(geometry.supports)) {
    fail("geometry.supports must be an array when supplied");
  }
  if (geometry.sections != null && !Array.isArray(geometry.sections)) {
    fail("geometry.sections must be an array when supplied");
  }

  const nodeIds = new Set();
  const nodeById = new Map();
  geometry.nodes.forEach((node, index) => {
    const location = `geometry.nodes[${index}]`;
    if (!isObject(node)) fail(`${location} must be an object`);
    assertUniqueId(node.id, nodeIds, location);
    for (const coordinate of ["x", "y", "z"]) {
      if (!Number.isFinite(node[coordinate])) fail(`${location}.${coordinate} must be finite`);
    }
    nodeById.set(`${typeof node.id}:${node.id}`, node);
  });

  const sectionIds = new Set();
  const sectionById = new Map();
  for (const [index, section] of (geometry.sections || []).entries()) {
    const location = `geometry.sections[${index}]`;
    if (!isObject(section)) fail(`${location} must be an object`);
    assertUniqueId(section.id, sectionIds, location);
    if (section.name != null && (typeof section.name !== "string" || !section.name)) {
      fail(`${location}.name must be a non-empty string when supplied`);
    }
    if (section.shape != null) validateSectionShape(section.shape, `${location}.shape`);
    if (section.area != null && (!Number.isFinite(section.area) || section.area <= 0)) {
      fail(`${location}.area must be a positive finite number when supplied`);
    }
    sectionById.set(`${typeof section.id}:${section.id}`, section);
  }

  const elementIds = new Set();
  geometry.elements.forEach((element, index) => {
    const location = `geometry.elements[${index}]`;
    if (!isObject(element)) fail(`${location} must be an object`);
    assertUniqueId(element.id, elementIds, location);
    if (!ELEMENT_NODE_COUNTS.has(element.kind)) {
      fail(`${location}.kind must be one of: ${[...ELEMENT_NODE_COUNTS.keys()].join(", ")}`);
    }
    const allowedNodeCounts = ELEMENT_NODE_COUNTS.get(element.kind);
    if (!Array.isArray(element.nodeIds) || !allowedNodeCounts.includes(element.nodeIds.length)) {
      fail(
        `${location}.nodeIds must contain ${allowedNodeCounts.join(" or ")} node IDs for a ${element.kind}`,
      );
    }
    const nodes = element.nodeIds.map((nodeId, nodeIndex) => {
      assertId(nodeId, `${location}.nodeIds[${nodeIndex}]`);
      const node = nodeById.get(`${typeof nodeId}:${nodeId}`);
      if (!node) fail(`${location}.nodeIds references unknown node ${JSON.stringify(nodeId)}`);
      return node;
    });
    if (element.kind === "beam" && samePosition(nodes[0], nodes[1])) {
      fail(`${location} has zero length`);
    }
    if (element.sectionId != null) {
      assertId(element.sectionId, `${location}.sectionId`);
      if (!sectionById.has(`${typeof element.sectionId}:${element.sectionId}`)) {
        fail(
          `${location}.sectionId references unknown section ${JSON.stringify(element.sectionId)}`,
        );
      }
    }
    if (element.localAxes != null) validateLocalAxes(element.localAxes, `${location}.localAxes`);
    if (
      element.thickness != null &&
      (!Number.isFinite(element.thickness) || element.thickness <= 0)
    ) {
      fail(`${location}.thickness must be a positive finite number when supplied`);
    }
    // Signed, because an element sits on either side of the nodes it was meshed
    // on, and zero is a real answer rather than a missing one.
    if (element.offset != null && !Number.isFinite(element.offset)) {
      fail(`${location}.offset must be a finite number when supplied`);
    }
    if (element.kind === "shell") {
      if (new Set(element.nodeIds.map((nodeId) => `${typeof nodeId}:${nodeId}`)).size < 3) {
        fail(`${location} repeats shell nodes`);
      }
      const origin = nodes[0];
      const hasArea = nodes.slice(1, -1).some((node, offset) => {
        const next = nodes[offset + 2];
        return triangleAreaSquared(origin, node, next) > 0;
      });
      if (!hasArea) fail(`${location} has zero area`);
    }
  });

  const supportIds = new Set();
  for (const [index, support] of (geometry.supports || []).entries()) {
    const location = `geometry.supports[${index}]`;
    if (!isObject(support)) fail(`${location} must be an object`);
    assertUniqueId(support.id, supportIds, location);
    assertId(support.nodeId, `${location}.nodeId`);
    if (!nodeById.has(`${typeof support.nodeId}:${support.nodeId}`)) {
      fail(`${location}.nodeId references unknown node ${JSON.stringify(support.nodeId)}`);
    }
    if (
      !Array.isArray(support.restraints) ||
      support.restraints.length !== 6 ||
      support.restraints.some((restraint) => typeof restraint !== "boolean")
    ) {
      fail(`${location}.restraints must contain six booleans`);
    }
  }

  return geometry;
}

function validateSectionShape(shape, location) {
  if (!isObject(shape)) fail(`${location} must be an object`);
  const fields = SECTION_SHAPE_FIELDS.get(shape.kind);
  if (!fields) {
    fail(`${location}.kind must be one of: ${[...SECTION_SHAPE_FIELDS.keys()].join(", ")}`);
  }
  for (const field of fields) {
    if (!Number.isFinite(shape[field]) || shape[field] <= 0) {
      fail(`${location}.${field} must be a positive finite number`);
    }
  }
  if (shape.kind === "polygon") {
    validateSectionPolygon(shape.points, `${location}.points`);
    if (shape.holes != null) {
      if (!Array.isArray(shape.holes)) fail(`${location}.holes must be an array when supplied`);
      shape.holes.forEach((points, index) =>
        validateSectionPolygon(points, `${location}.holes[${index}]`),
      );
    }
  }
  if (shape.kind === "tube" && shape.thickness * 2 >= shape.diameter) {
    fail(`${location}.thickness must be less than half its diameter`);
  }
  if (shape.kind === "tee") {
    if (shape.webWidth > shape.flangeWidth) {
      fail(`${location}.webWidth must not exceed flangeWidth`);
    }
    if (shape.flangeThickness >= shape.height) {
      fail(`${location}.flangeThickness must be less than height`);
    }
  }
}

function validateSectionPolygon(points, location) {
  if (!Array.isArray(points) || points.length < 3) {
    fail(`${location} must contain at least three points`);
  }
  for (const [index, point] of points.entries()) {
    if (
      !Array.isArray(point) ||
      point.length !== 2 ||
      point.some((value) => !Number.isFinite(value))
    ) {
      fail(`${location}[${index}] must contain two finite coordinates`);
    }
  }
  const twiceArea = points.reduce((area, point, index) => {
    const next = points[(index + 1) % points.length];
    return area + point[0] * next[1] - next[0] * point[1];
  }, 0);
  if (Math.abs(twiceArea) <= Number.EPSILON) fail(`${location} must enclose a non-zero area`);
}

function validateLocalAxes(axes, location) {
  if (!isObject(axes)) fail(`${location} must be an object`);
  for (const name of ["x", "y", "z"]) {
    const vector = axes[name];
    if (
      !Array.isArray(vector) ||
      vector.length !== 3 ||
      vector.some((value) => !Number.isFinite(value))
    ) {
      fail(`${location}.${name} must contain three finite numbers`);
    }
    if (vector.every((value) => value === 0)) fail(`${location}.${name} must not be zero`);
  }
}

function samePosition(left, right) {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

function triangleAreaSquared(origin, second, third) {
  const ax = second.x - origin.x;
  const ay = second.y - origin.y;
  const az = second.z - origin.z;
  const bx = third.x - origin.x;
  const by = third.y - origin.y;
  const bz = third.z - origin.z;
  const cx = ay * bz - az * by;
  const cy = az * bx - ax * bz;
  const cz = ax * by - ay * bx;
  return cx * cx + cy * cy + cz * cz;
}

module.exports = {
  CHANGE_SCOPES,
  validateCapabilities,
  validateChangeEvent,
  validateDescription,
  validateGeometry,
  validateSession,
  validateSourceProvider,
};
