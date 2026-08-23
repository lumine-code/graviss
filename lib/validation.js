// The kinds drawn as members: a run of structure between two nodes, drawn as
// its centreline or as its section extruded along it. What separates them is
// what they carry - a beam bends, a truss takes axial force alone, a cable
// takes only tension - which decides the analysis and not the picture, so all
// three are drawn the same way and each says which it is.
const LINE_ELEMENT_KINDS = new Set(["beam", "truss", "cable"]);
const ELEMENT_NODE_COUNTS = new Map([
  ["beam", [2]],
  ["truss", [2]],
  ["cable", [2]],
  ["shell", [3, 4]],
  // A coupling joins two nodes. A spring joins two, or acts between one node
  // and the ground, which is why it may name only one and say which way.
  ["spring", [1, 2]],
  ["coupling", [2]],
]);
const SECTION_SHAPE_FIELDS = new Map([
  ["rectangle", ["width", "height"]],
  ["circle", ["diameter"]],
  ["tube", ["diameter", "thickness"]],
  ["tee", ["webWidth", "height", "flangeWidth", "flangeThickness"]],
  ["polygon", []],
  ["plates", []],
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
  if (capabilities.results != null) {
    const results = capabilities.results;
    if (!isObject(results)) fail("description.capabilities.results must be an object");
    // Both are stated as true rather than as booleans: a source that cannot
    // answer says nothing at all, the way it does for geometry.
    for (const answer of ["displacement", "loadCases"]) {
      if (results[answer] !== true) {
        fail(`description.capabilities.results.${answer} must be true`);
      }
    }
    if (results.beamStations != null && typeof results.beamStations !== "boolean") {
      fail("description.capabilities.results.beamStations must be a boolean");
    }
  }
  if (capabilities.facets != null && capabilities.facets !== true) {
    fail("description.capabilities.facets must be true when supplied");
  }
  return capabilities;
}

// The dimensions a model is divided along besides its element kinds - groups,
// selection sets, the geometric entity an element was meshed from. Graviss
// names none of them and only checks that a provider's own names hold together.
function validateFacets(facets, location = "geometry.facets") {
  if (!Array.isArray(facets)) fail(`${location} must be an array when supplied`);
  const facetIds = new Set();
  const valuesByFacet = new Map();
  facets.forEach((facet, index) => {
    const at = `${location}[${index}]`;
    if (!isObject(facet)) fail(`${at} must be an object`);
    assertUniqueId(facet.id, facetIds, at);
    if (typeof facet.title !== "string" || facet.title.length === 0) {
      fail(`${at}.title must be a non-empty string`);
    }
    if (facet.multiple != null && typeof facet.multiple !== "boolean") {
      fail(`${at}.multiple must be a boolean when supplied`);
    }
    if (!Array.isArray(facet.values)) fail(`${at}.values must be an array`);
    const valueIds = new Set();
    facet.values.forEach((value, valueIndex) => {
      const valueAt = `${at}.values[${valueIndex}]`;
      if (!isObject(value)) fail(`${valueAt} must be an object`);
      assertUniqueId(value.id, valueIds, valueAt);
      if (value.title != null && (typeof value.title !== "string" || !value.title)) {
        fail(`${valueAt}.title must be a non-empty string when supplied`);
      }
    });
    valuesByFacet.set(`${typeof facet.id}:${facet.id}`, {
      multiple: Boolean(facet.multiple),
      values: valueIds,
    });
  });
  return valuesByFacet;
}

// What an element says it belongs to, against what the model said exists. A
// facet an element is silent about simply does not filter it.
function validateFacetValues(facetValues, valuesByFacet, location) {
  if (!isObject(facetValues)) fail(`${location} must be an object when supplied`);
  for (const [facetId, held] of Object.entries(facetValues)) {
    const at = `${location}[${JSON.stringify(facetId)}]`;
    // An object key is always a string, so a numeric facet id arrives as its
    // own text and is looked up as both.
    const facet =
      valuesByFacet.get(`string:${facetId}`) ??
      (Number.isFinite(Number(facetId)) ? valuesByFacet.get(`number:${Number(facetId)}`) : null);
    if (!facet) fail(`${at} references unknown facet ${JSON.stringify(facetId)}`);
    const list = Array.isArray(held) ? held : [held];
    if (Array.isArray(held) && !facet.multiple) {
      fail(`${at} must be one value, because its facet does not declare multiple`);
    }
    if (Array.isArray(held) && held.length === 0) {
      fail(`${at} must be a non-empty array when supplied as a list`);
    }
    for (const value of list) {
      assertId(value, at);
      if (!facet.values.has(`${typeof value}:${value}`)) {
        fail(`${at} references unknown value ${JSON.stringify(value)}`);
      }
    }
  }
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
  for (const method of ["onDidChange", "getLoadCases", "getResult"]) {
    if (session[method] != null && typeof session[method] !== "function") {
      fail(`source session ${method} must be a function when supplied`);
    }
  }
  return session;
}

// What the model was solved for. A case may exist and hold nothing - a model
// names a hundred and holds results for three - so `hasResults` is a statement
// about the answer rather than about the question.
function validateLoadCases(loadCases) {
  if (!Array.isArray(loadCases)) fail("session.getLoadCases() must return an array");
  const ids = new Set();
  loadCases.forEach((loadCase, index) => {
    const location = `loadCases[${index}]`;
    if (!isObject(loadCase)) fail(`${location} must be an object`);
    assertUniqueId(loadCase.id, ids, location);
    if (typeof loadCase.title !== "string" || loadCase.title.length === 0) {
      fail(`${location}.title must be a non-empty string`);
    }
    if (loadCase.kind != null && !LOAD_CASE_KINDS.has(loadCase.kind)) {
      fail(`${location}.kind must be one of: ${[...LOAD_CASE_KINDS].join(", ")}`);
    }
    if (loadCase.actionType != null && typeof loadCase.actionType !== "string") {
      fail(`${location}.actionType must be a string when supplied`);
    }
    if (loadCase.factor != null && !Number.isFinite(loadCase.factor)) {
      fail(`${location}.factor must be a finite number when supplied`);
    }
    if (loadCase.hasResults != null && typeof loadCase.hasResults !== "boolean") {
      fail(`${location}.hasResults must be a boolean when supplied`);
    }
  });
  return loadCases;
}

// A displacement field, as the source computed it and before Graviss amplifies
// anything. `nodes.values` runs three or six components a node - translations,
// then rotations where the source has them - in the geometry's own node order
// unless `ids` names another.
function validateResult(result, geometry) {
  if (!isObject(result)) fail("session.getResult() must return an object");
  if (result.kind !== "displacement") fail('result.kind must be "displacement"');
  assertId(result.loadCaseId, "result.loadCaseId");
  if (result.components !== 3 && result.components !== 6) {
    fail("result.components must be 3 or 6");
  }
  if (!isObject(result.nodes)) fail("result.nodes must be an object");
  const values = result.nodes.values;
  const isNumbers = Array.isArray(values) || ArrayBuffer.isView(values);
  if (!isNumbers) fail("result.nodes.values must be an array of numbers");
  const expected = result.nodes.ids ? result.nodes.ids.length : (geometry?.nodes?.length ?? null);
  if (result.nodes.ids != null) {
    if (!Array.isArray(result.nodes.ids)) fail("result.nodes.ids must be an array when supplied");
    result.nodes.ids.forEach((id, index) => assertId(id, `result.nodes.ids[${index}]`));
  }
  if (expected != null && values.length !== expected * result.components) {
    fail(
      `result.nodes.values must hold ${result.components} components for each of ${expected} nodes`,
    );
  }
  for (let index = 0; index < values.length; index += 1) {
    if (!Number.isFinite(values[index])) fail(`result.nodes.values[${index}] must be finite`);
  }
  if (result.extent != null && (!Number.isFinite(result.extent) || result.extent < 0)) {
    fail("result.extent must be a non-negative finite number when supplied");
  }
  if (result.elements != null) validateResultStations(result.elements);
  return result;
}

// How a member bends between its ends, in the element's own local frame. Two
// stations and their rotations already describe a curve, so a source with only
// the ends is worth reporting.
function validateResultStations(elements) {
  if (!Array.isArray(elements)) fail("result.elements must be an array when supplied");
  elements.forEach((entry, index) => {
    const location = `result.elements[${index}]`;
    if (!isObject(entry)) fail(`${location} must be an object`);
    assertId(entry.id, `${location}.id`);
    if (!Array.isArray(entry.stations) || entry.stations.length === 0) {
      fail(`${location}.stations must be a non-empty array`);
    }
    entry.stations.forEach((station, stationIndex) => {
      const at = `${location}.stations[${stationIndex}]`;
      if (!isObject(station)) fail(`${at} must be an object`);
      if (!Number.isFinite(station.x)) fail(`${at}.x must be finite`);
      validateVector(station.u, `${at}.u`);
      if (station.phi != null) validateVector(station.phi, `${at}.phi`);
    });
  });
}

function validateVector(vector, location) {
  if (!Array.isArray(vector) || vector.length !== 3 || !vector.every(Number.isFinite)) {
    fail(`${location} must be three finite numbers`);
  }
}

// "results" is the narrow scope: the model stands and only what was solved for
// it has moved, so the scene is left where it is and only the results are read
// again. A re-analysis that also remeshed is "geometry".
const CHANGE_SCOPES = Object.freeze(["all", "geometry", "results"]);

// The classifications a provider may put on a load case. Only two of them mean
// anything to a viewer: an eigenmode and a buckling mode have no sign, so their
// shape is animated about zero rather than up from it.
const LOAD_CASE_KINDS = new Set([
  "linear",
  "nonlinear",
  "superposition",
  "eigenmode",
  "buckling",
  "design",
  "transient",
]);

const UNSIGNED_LOAD_CASE_KINDS = new Set(["eigenmode", "buckling"]);

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

  const valuesByFacet = geometry.facets == null ? new Map() : validateFacets(geometry.facets);

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
    if (section.ineffective != null) {
      validateIneffectiveAreas(section.ineffective, `${location}.ineffective`);
    }
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
    if (LINE_ELEMENT_KINDS.has(element.kind) && samePosition(nodes[0], nodes[1])) {
      fail(`${location} has zero length`);
    }
    // The element's own number in the source, which is what a user types when
    // they ask for a range of them. It is not the id: ids are unique across
    // every kind, so a source holding both a beam 5 and a shell 5 has to
    // qualify them and only it knows the bare number underneath.
    if (element.number != null && !Number.isFinite(element.number)) {
      fail(`${location}.number must be a finite number when supplied`);
    }
    if (element.facetValues != null) {
      validateFacetValues(element.facetValues, valuesByFacet, `${location}.facetValues`);
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
    // One number is that thickness everywhere; a list is one per node, which is
    // how an area element that tapers across itself is described.
    if (Array.isArray(element.thickness)) {
      if (
        element.thickness.length === 0 ||
        element.thickness.some((value) => !Number.isFinite(value) || value <= 0)
      ) {
        fail(`${location}.thickness must list a positive finite number for each node`);
      }
    } else if (
      element.thickness != null &&
      (!Number.isFinite(element.thickness) || element.thickness <= 0)
    ) {
      fail(`${location}.thickness must be a positive finite number when supplied`);
    }
    // A spring acts along its axis or about it, and is drawn as the one or the
    // other; anything else is a spring acting along it.
    if (element.rotational != null && typeof element.rotational !== "boolean") {
      fail(`${location}.rotational must be a boolean when supplied`);
    }
    // Which way a grounded spring acts, for the one that names a single node.
    if (element.direction != null) {
      validateDirection(element.direction, `${location}.direction`);
    }
    // Signed, because an element sits on either side of the nodes it was meshed
    // on, and zero is a real answer rather than a missing one.
    if (Array.isArray(element.offset)) {
      if (element.offset.length === 0 || element.offset.some((value) => !Number.isFinite(value))) {
        fail(`${location}.offset must list a finite number for each node`);
      }
    } else if (element.offset != null && !Number.isFinite(element.offset)) {
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
    // One area with its holes, or several parts each with their own — never
    // both spellings at once, so a reader knows which one it is looking at.
    if (shape.parts != null) {
      if (shape.points != null) fail(`${location} must state points or parts, not both`);
      if (!Array.isArray(shape.parts) || shape.parts.length === 0) {
        fail(`${location}.parts must be a non-empty array when supplied`);
      }
      shape.parts.forEach((part, index) => {
        if (!part || typeof part !== "object" || Array.isArray(part)) {
          fail(`${location}.parts[${index}] must be an object`);
        }
        validateSectionPolygonWithHoles(part, `${location}.parts[${index}]`);
      });
    } else {
      validateSectionPolygonWithHoles(shape, location);
    }
  }
  if (shape.kind === "plates") validateSectionPlates(shape.plates, location);
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

// A plate is a straight run of material of one thickness, and the run given is
// its middle: the plate stands half a thickness either side of it and ends
// square at both ends. Nothing asks the plates to touch, to close, or to be
// given in any order - a section of plates is what stands where they stand.
// The parts of a section that do not carry: plain areas in the section's own
// plane, each an outline with its own holes, exactly as a polygon shape states
// one. They are stated as areas rather than as the rule that produced them
// because a source knows both and only one of them is a picture.
function validateIneffectiveAreas(areas, location) {
  if (!Array.isArray(areas) || areas.length === 0) {
    fail(`${location} must be a non-empty array`);
  }
  for (const [index, area] of areas.entries()) {
    const at = `${location}[${index}]`;
    if (!isObject(area)) fail(`${at} must be an object`);
    validateSectionPolygonWithHoles(area, at);
  }
}

function validateSectionPlates(plates, location) {
  if (!Array.isArray(plates) || plates.length === 0) {
    fail(`${location}.plates must be a non-empty array`);
  }
  for (const [index, plate] of plates.entries()) {
    const at = `${location}.plates[${index}]`;
    if (!isObject(plate)) fail(`${at} must be an object`);
    validateSectionPoint(plate.from, `${at}.from`);
    validateSectionPoint(plate.to, `${at}.to`);
    if (!Number.isFinite(plate.thickness) || plate.thickness <= 0) {
      fail(`${at}.thickness must be a positive finite number`);
    }
    if (plate.from[0] === plate.to[0] && plate.from[1] === plate.to[1]) {
      fail(`${at} must run between two different points`);
    }
  }
}

function validateSectionPolygonWithHoles(part, location) {
  validateSectionPolygon(part.points, `${location}.points`);
  if (part.holes != null) {
    if (!Array.isArray(part.holes)) fail(`${location}.holes must be an array when supplied`);
    part.holes.forEach((points, index) =>
      validateSectionPolygon(points, `${location}.holes[${index}]`),
    );
  }
}

function validateSectionPolygon(points, location) {
  if (!Array.isArray(points) || points.length < 3) {
    fail(`${location} must contain at least three points`);
  }
  for (const [index, point] of points.entries()) {
    validateSectionPoint(point, `${location}[${index}]`);
  }
  const twiceArea = points.reduce((area, point, index) => {
    const next = points[(index + 1) % points.length];
    return area + point[0] * next[1] - next[0] * point[1];
  }, 0);
  if (Math.abs(twiceArea) <= Number.EPSILON) fail(`${location} must enclose a non-zero area`);
}

function validateSectionPoint(point, location) {
  if (
    !Array.isArray(point) ||
    point.length !== 2 ||
    point.some((value) => !Number.isFinite(value))
  ) {
    fail(`${location} must contain two finite coordinates`);
  }
}

function validateLocalAxes(axes, location) {
  if (!isObject(axes)) fail(`${location} must be an object`);
  for (const name of ["x", "y", "z"]) {
    validateDirection(axes[name], `${location}.${name}`);
  }
}

function validateDirection(vector, location) {
  if (
    !Array.isArray(vector) ||
    vector.length !== 3 ||
    vector.some((value) => !Number.isFinite(value))
  ) {
    fail(`${location} must contain three finite numbers`);
  }
  if (vector.every((value) => value === 0)) fail(`${location} must not be zero`);
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
  LINE_ELEMENT_KINDS,
  LOAD_CASE_KINDS,
  UNSIGNED_LOAD_CASE_KINDS,
  validateCapabilities,
  validateChangeEvent,
  validateDescription,
  validateFacets,
  validateGeometry,
  validateLoadCases,
  validateResult,
  validateSession,
  validateSourceProvider,
};
