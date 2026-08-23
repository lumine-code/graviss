// Moving a model by what was computed for it.
//
// A provider returns true displacements and the viewer owns the amplification,
// which is what makes the scale on screen mean something: a source that had
// pre-multiplied its own numbers would leave the factor a decoration.

// The factors a user reaches for, in the order they sit on a toolbar. Zero is
// one of them on purpose - it is how you check what moved against what did not,
// without losing the case you were looking at.
const SCALE_PRESETS = Object.freeze([0, 0.5, 1, 2, 10, 100, 1000]);

// What an automatic scale aims at: the largest displacement drawn as this much
// of the model's own radius. Big enough to read at a glance, small enough that
// the structure is still recognisably itself.
const AUTOMATIC_TARGET = 0.04;

// The scale that makes the largest displacement a visible fraction of the model
// rather than a number of metres. A model that did not move has no scale that
// would show it moving, so it keeps the one it had.
function automaticScale(extent, radius, target = AUTOMATIC_TARGET) {
  if (!Number.isFinite(extent) || extent <= 0) return null;
  if (!Number.isFinite(radius) || radius <= 0) return null;
  return (radius * target) / extent;
}

// The largest resultant translation in a field, for a result that did not say.
function extentOf(result) {
  if (Number.isFinite(result?.extent)) return result.extent;
  const values = result?.nodes?.values;
  const components = result?.components ?? 3;
  if (!values?.length) return 0;
  let extent = 0;
  for (let at = 0; at + 2 < values.length; at += components) {
    const resultant = Math.hypot(values[at], values[at + 1], values[at + 2]);
    if (resultant > extent) extent = resultant;
  }
  return extent;
}

// Where a result's nodes sit in the geometry's own order.
//
// A result may name its nodes or leave them in the geometry's order, and either
// way what a renderer wants is one row per node of the model it is drawing. A
// node the result says nothing about does not move, which is what an absent row
// means - a result is a field over the nodes that have one.
function alignToNodes(result, nodes, indexOfId) {
  const components = result.components ?? 3;
  const values = result.nodes.values;
  const rows = new Float32Array(nodes.length * 3);
  const ids = result.nodes.ids;
  if (!ids) {
    const shared = Math.min(nodes.length, Math.floor(values.length / components));
    for (let index = 0; index < shared; index += 1) {
      const from = index * components;
      const to = index * 3;
      rows[to] = values[from];
      rows[to + 1] = values[from + 1];
      rows[to + 2] = values[from + 2];
    }
    return rows;
  }
  for (let entry = 0; entry < ids.length; entry += 1) {
    const index = indexOfId(ids[entry]);
    if (index == null) continue;
    const from = entry * components;
    const to = index * 3;
    rows[to] = values[from];
    rows[to + 1] = values[from + 1];
    rows[to + 2] = values[from + 2];
  }
  return rows;
}

// The displacement of one model at one scale and one phase.
//
// It holds the field in the geometry's node order and writes displaced
// positions into whatever array it is handed, which is how a renderer keeps one
// buffer rather than allocating a set of coordinates every frame.
class Deformation {
  constructor({ nodes, indexOfId, radius }) {
    this.nodes = nodes;
    this.indexOfId = indexOfId;
    this.radius = radius;
    this.result = null;
    this.rows = null;
    this.extent = 0;
    this.scale = 1;
    this.phase = 1;
    this.automatic = true;
  }

  // A result of null is the undeformed model, which is a state and not an
  // absence: the viewer still draws, and every displacement is zero.
  setResult(result) {
    this.result = result || null;
    this.rows = result ? alignToNodes(result, this.nodes, this.indexOfId) : null;
    this.extent = result ? extentOf(result) : 0;
    if (this.automatic) this.applyAutomaticScale();
    return this;
  }

  applyAutomaticScale() {
    const scale = automaticScale(this.extent, this.radius);
    if (scale != null) this.scale = scale;
    return this.scale;
  }

  setScale(scale) {
    if (!Number.isFinite(scale) || scale < 0) return this.scale;
    this.automatic = false;
    this.scale = scale;
    return this.scale;
  }

  setAutomatic(automatic) {
    this.automatic = Boolean(automatic);
    if (this.automatic) this.applyAutomaticScale();
    return this.automatic;
  }

  setPhase(phase) {
    this.phase = Number.isFinite(phase) ? phase : 1;
    return this.phase;
  }

  // How far the model is moved right now: the scale a user chose, times where
  // in its cycle an animation has got to.
  get factor() {
    return this.result ? this.scale * this.phase : 0;
  }

  // Whether anything would move at all, so a caller can skip a pass.
  get active() {
    return Boolean(this.result) && this.extent > 0 && this.factor !== 0;
  }

  // Writes `rest + factor * displacement` for every node into `into`, which is
  // the flat XYZ array the renderer reads positions out of.
  apply(rest, into) {
    const factor = this.factor;
    if (!this.rows || factor === 0) {
      into.set(rest);
      return into;
    }
    for (let index = 0; index < rest.length; index += 1) {
      into[index] = rest[index] + this.rows[index] * factor;
    }
    return into;
  }
}

module.exports = {
  AUTOMATIC_TARGET,
  Deformation,
  SCALE_PRESETS,
  alignToNodes,
  automaticScale,
  extentOf,
};
