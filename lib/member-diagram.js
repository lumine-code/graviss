const DEFAULT_MEMBER_DIAGRAM_OPTIONS = Object.freeze({
  component: "N",
  scale: "auto",
  plane: "auto",
  flip: false,
  filled: true,
  labels: true,
});
const POSITIVE_COLOR = 0x1679bd;
const NEGATIVE_COLOR = 0xd4483a;
const AUTOMATIC_TARGET = 0.15;
const LABEL_LIMIT = 300;

function memberDiagramOptions(options, previous = DEFAULT_MEMBER_DIAGRAM_OPTIONS) {
  const next = { ...previous, ...options };
  if (typeof next.component !== "string" || !next.component.trim())
    throw new RangeError(`Unsupported member-diagram component: ${next.component}`);
  if (next.scale !== "auto" && !(Number.isFinite(next.scale) && next.scale > 0))
    throw new RangeError("Member-diagram scale must be auto or a positive finite number");
  if (!["auto", "y", "z"].includes(next.plane))
    throw new RangeError(`Unsupported member-diagram plane: ${next.plane}`);
  for (const key of ["flip", "filled", "labels"]) {
    if (typeof next[key] !== "boolean")
      throw new TypeError(`Member-diagram ${key} must be boolean`);
  }
  return next;
}

// The source defines each quantity's natural display plane and polarity.
// Choosing a plane explicitly instead means a positive ordinate on that axis.
function memberDiagramDirection(quantity, plane = "auto", flip = false) {
  const automatic = plane === "auto";
  return {
    plane: automatic ? quantity.plane : plane,
    directionSign: (automatic ? quantity.directionSign : 1) * (flip ? -1 : 1),
  };
}

// No section equilibrium is inferred from samples. A repeated abscissa is a
// jump with two one-sided ordinates, never an interval to interpolate across.
// Splitting sign changes before triangulation keeps the two filled lobes from
// crossing the baseline or borrowing one another's colour.
function memberDiagramSegments(stations, interpolation = "linear") {
  if (interpolation === "point") return [];
  const segments = [];
  for (let index = 1; index < stations.length; index += 1) {
    const a = stations[index - 1];
    const b = stations[index];
    if (a.value == null || b.value == null) continue;
    if ((a.value < 0 && b.value > 0) || (a.value > 0 && b.value < 0)) {
      // Scaling the ratio avoids overflowing a.value - b.value.
      const largest = Math.max(Math.abs(a.value), Math.abs(b.value));
      const fraction =
        Math.abs(a.value / largest) / (Math.abs(a.value / largest) + Math.abs(b.value / largest));
      const zero = { x: a.x + (b.x - a.x) * fraction, value: 0 };
      segments.push({ a, b: zero, sign: Math.sign(a.value) });
      segments.push({ a: zero, b, sign: Math.sign(b.value) });
    } else segments.push({ a, b, sign: Math.sign(a.value || b.value) || 1 });
  }
  return segments;
}

function memberDiagramLabelIndices(stations, interpolation = "linear") {
  if (interpolation === "point")
    return stations.flatMap((station, index) => (station.value == null ? [] : [index]));
  const indices = new Set();
  let minimum = null;
  let maximum = null;
  for (let index = 0; index < stations.length; index += 1) {
    const current = stations[index];
    if (current.value == null) continue;
    if (minimum == null || current.value < stations[minimum].value) minimum = index;
    if (maximum == null || current.value > stations[maximum].value) maximum = index;
    const previous = stations[index - 1];
    const next = stations[index + 1];
    if (previous?.value == null || next?.value == null) indices.add(index);
    if (previous?.x === current.x || next?.x === current.x) indices.add(index);
    if (
      previous?.value != null &&
      next?.value != null &&
      ((current.value > previous.value && current.value >= next.value) ||
        (current.value < previous.value && current.value <= next.value))
    )
      indices.add(index);
  }
  if (minimum != null) indices.add(minimum);
  if (maximum != null) indices.add(maximum);
  return Array.from(indices).sort((a, b) => a - b);
}

function stationPoint(origin, axes, station, scale, plane, directionSign, baseline = false) {
  const ordinate = baseline ? 0 : station.value * scale * directionSign;
  return [0, 1, 2].map(
    (axis) => origin[axis] + axes.x[axis] * station.x + axes[plane][axis] * ordinate,
  );
}

function formatMemberDiagram(value, displayFactor = 1) {
  const displayed = value * displayFactor;
  if (displayed === 0) return "0";
  const absolute = Math.abs(displayed);
  const number =
    absolute < 0.001 || absolute >= 1e6
      ? displayed.toExponential(3)
      : Number(displayed.toPrecision(5)).toString();
  return displayed > 0 ? `+${number}` : number;
}

class MemberDiagram {
  constructor(THREE) {
    this.THREE = THREE;
    this.group = new THREE.Group();
    this.group.name = "member-diagrams";
    this.pickables = [];
    this.labels = [];
    this.records = [];
    this.summary = null;
  }

  build(result, geometry, options, { radius, keepsElement, visible, selectedId }) {
    this.clear();
    this.options = options;
    this.radius = radius;
    let column = result.components.findIndex(({ id }) => id === options.component);
    if (column < 0) {
      column = result.components.findIndex((_quantity, index) =>
        result.elements.some(({ stations }) =>
          stations.some(({ values }) => values[index] != null),
        ),
      );
      if (column < 0) column = 0;
    }
    const quantity = result.components[column];
    const { plane, directionSign } = memberDiagramDirection(quantity, options.plane, options.flip);
    const byId = new Map(geometry.elements.map((element) => [element.id, element]));
    const nodes = new Map(geometry.nodes.map((node) => [node.id, node]));
    let minimum = null;
    let maximum = null;
    let stationCount = 0;
    let elementCount = 0;
    for (const row of result.elements) {
      const element = byId.get(row.id);
      if (!element) continue;
      const first = nodes.get(element.nodeIds[0]);
      const origin = [first.x, first.y, first.z];
      const axes = Object.fromEntries(
        ["x", "y", "z"].map((name) => {
          const vector = element.localAxes[name];
          const length = Math.hypot(...vector);
          return [name, vector.map((value) => value / length)];
        }),
      );
      // A manual factor applies to the field, including members currently
      // filtered away. Reject impossible coordinates here so showing a layer
      // or clearing a filter cannot make a previously accepted factor fail.
      if (options.scale !== "auto") {
        for (const { x, values } of row.stations) {
          if (values[column] == null) continue;
          const point = stationPoint(
            origin,
            axes,
            { x, value: values[column] },
            options.scale,
            plane,
            directionSign,
          );
          if (!point.every((value) => Number.isFinite(Math.fround(value))))
            throw new RangeError("Member-diagram ordinates exceed the supported coordinate range");
        }
      }
      if (!visible || !keepsElement(element)) continue;
      const stations = row.stations.map(({ x, values }) => ({ x, value: values[column] }));
      let knownStations = 0;
      for (const station of stations) {
        if (station.value == null) continue;
        knownStations += 1;
        const record = { elementId: element.id, ...station };
        if (!minimum || station.value < minimum.value) minimum = record;
        if (!maximum || station.value > maximum.value) maximum = record;
      }
      stationCount += knownStations;
      if (knownStations) elementCount += 1;
      this.records.push({ element, axes, stations, origin });
    }
    const extent = Math.max(Math.abs(minimum?.value ?? 0), Math.abs(maximum?.value ?? 0));
    const scale =
      options.scale === "auto"
        ? extent > 0
          ? (radius * AUTOMATIC_TARGET) / extent
          : 0
        : options.scale;
    // Refuse impossible world coordinates instead of uploading infinities and
    // silently poisoning camera fitting, exports and picking.
    if (!Number.isFinite(scale) || !Number.isFinite(extent * scale))
      throw new RangeError("Member-diagram ordinates exceed the supported coordinate range");
    this.summary = {
      component: quantity.id,
      quantity,
      unit: quantity.unit,
      displayUnit: quantity.displayUnit,
      displayFactor: quantity.displayFactor,
      min: minimum?.value ?? null,
      max: maximum?.value ?? null,
      minimum,
      maximum,
      extent,
      scale,
      automatic: options.scale === "auto",
      plane,
      directionSign,
      flipped: options.flip,
      elementCount,
      stationCount,
      totalElementCount: result.elements.length,
      empty: stationCount === 0,
      selected: null,
      labelsShown: 0,
      labelsTotal: 0,
    };
    const batches = [-1, 1].map((sign) => ({
      sign,
      lines: [],
      fills: [],
      lineRanges: [],
      fillRanges: [],
      faces: [],
    }));
    const { THREE } = this;
    this.records.forEach((record, entityIndex) => {
      const { axes, origin, stations } = record;
      const point = (station, baseline = false) =>
        stationPoint(origin, axes, station, scale, plane, directionSign, baseline);
      record.point = point;
      const starts = batches.map((batch) => [batch.lines.length / 3, batch.fills.length / 3]);
      for (const { a, b, sign } of memberDiagramSegments(stations, quantity.interpolation)) {
        const batch = batches[sign < 0 ? 0 : 1];
        const p = point(a);
        const q = point(b);
        batch.lines.push(...p, ...q);
        if (a.x !== b.x) batches[1].lines.push(...point(a, true), ...point(b, true));
        // Vertical jumps close the outline, but have no area. A triangular
        // lobe is represented by one real triangle rather than a degenerate
        // second triangle at its zero end.
        if (options.filled && a.x !== b.x) {
          const baseA = point(a, true);
          const baseB = point(b, true);
          if (a.value !== 0) {
            batch.fills.push(...baseA, ...p, ...baseB);
            batch.faces.push(entityIndex);
          }
          if (b.value !== 0) {
            batch.fills.push(...p, ...q, ...baseB);
            batch.faces.push(entityIndex);
          }
        }
      }
      // Close each known run independently. A null is missing data, so neither
      // the outline nor the baseline bridges it. An isolated sample contributes
      // its own ordinate without pretending there is a neighbouring interval.
      // Point quantities (for example, hinge reactions) always use this shape,
      // even when the source has supplied adjacent non-null station rows.
      for (let index = 0; index < stations.length; index += 1) {
        const station = stations[index];
        if (station.value == null) continue;
        if (
          station.value !== 0 &&
          (quantity.interpolation === "point" ||
            stations[index - 1]?.value == null ||
            stations[index + 1]?.value == null)
        )
          batches[station.value < 0 ? 0 : 1].lines.push(...point(station, true), ...point(station));
      }
      batches.forEach((batch, index) => {
        batch.lineRanges.push({
          start: starts[index][0],
          count: batch.lines.length / 3 - starts[index][0],
        });
        batch.fillRanges.push({
          start: starts[index][1],
          count: batch.fills.length / 3 - starts[index][1],
        });
      });
    });
    for (const batch of batches) {
      const color = new THREE.Color(batch.sign < 0 ? NEGATIVE_COLOR : POSITIVE_COLOR);
      for (const kind of ["lines", "fills"]) {
        const positions = batch[kind];
        if (!positions.length) continue;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
        // Three uploads Float32: finite doubles outside that range cannot be
        // drawn correctly either.
        if (!geometry.attributes.position.array.every(Number.isFinite)) {
          geometry.dispose();
          throw new RangeError("Member-diagram ordinates exceed the supported coordinate range");
        }
        const colors = new Float32Array(positions.length);
        for (let offset = 0; offset < colors.length; offset += 3) color.toArray(colors, offset);
        geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
        const line = kind === "lines";
        const material = line
          ? new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, toneMapped: false })
          : new THREE.MeshBasicMaterial({
              vertexColors: true,
              transparent: true,
              opacity: 0.2,
              side: THREE.DoubleSide,
              depthWrite: false,
              depthTest: false,
              toneMapped: false,
            });
        const object = line
          ? new THREE.LineSegments(geometry, material)
          : new THREE.Mesh(geometry, material);
        object.renderOrder = line ? 11 : 10;
        object.userData = {
          gravissMemberDiagram: true,
          gravissType: "element",
          visibilityKey: "memberDiagram",
          gravissEntities: this.records.map(({ element }) => element),
          gravissEntityRanges: line ? batch.lineRanges : batch.fillRanges,
          gravissLineSegments: line,
          gravissFaceToEntityIndex: batch.faces,
          gravissMemberDiagramColor: color,
        };
        this.group.add(object);
        this.pickables.push(object);
      }
    }
    this.select(selectedId);
    return this.summary;
  }

  select(selectedId) {
    if (!this.summary) return;
    const selected =
      selectedId == null ? null : this.records.find(({ element }) => element.id === selectedId);
    this.summary.selected = selected
      ? {
          elementId: selected.element.id,
          stations: selected.stations.map((station) => ({ ...station })),
          min: selected.stations.reduce(
            (value, station) =>
              station.value == null
                ? value
                : value == null
                  ? station.value
                  : Math.min(value, station.value),
            null,
          ),
          max: selected.stations.reduce(
            (value, station) =>
              station.value == null
                ? value
                : value == null
                  ? station.value
                  : Math.max(value, station.value),
            null,
          ),
        }
      : null;
    this.createLabels(selected);
  }

  createLabels(selected) {
    this.clearLabels();
    this.summary.labelsShown = 0;
    this.summary.labelsTotal = 0;
    if (!this.options.labels) return;
    const candidates = [];
    for (const record of this.records) {
      for (const index of memberDiagramLabelIndices(
        record.stations,
        this.summary.quantity.interpolation,
      )) {
        const station = record.stations[index];
        const isGlobal = [this.summary.minimum, this.summary.maximum].some(
          (extreme) =>
            extreme?.elementId === record.element.id &&
            extreme.x === station.x &&
            extreme.value === station.value,
        );
        candidates.push({ record, index, priority: record === selected ? 0 : isGlobal ? 1 : 2 });
      }
    }
    candidates.sort((a, b) => a.priority - b.priority);
    this.summary.labelsTotal = candidates.length;
    const { THREE } = this;
    for (const { record, index } of candidates.slice(0, LABEL_LIMIT)) {
      const station = record.stations[index];
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (!context) continue;
      const text = `${formatMemberDiagram(station.value, this.summary.displayFactor)} ${this.summary.displayUnit}`;
      context.font = "26px sans-serif";
      canvas.width = Math.ceil(context.measureText(text).width) + 20;
      canvas.height = 42;
      context.fillStyle = "rgba(255,255,255,0.94)";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.font = "26px sans-serif";
      context.textBaseline = "middle";
      context.fillStyle = station.value < 0 ? "#a22a1e" : "#075b96";
      context.fillText(text, 10, canvas.height / 2);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      const material = new THREE.SpriteMaterial({
        map: texture,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      });
      const sprite = new THREE.Sprite(material);
      // Sprite's stock geometry is shared by every sprite in Three. Own a
      // copy, because the viewer disposes each scene object's geometry.
      sprite.geometry = sprite.geometry.clone();
      sprite.position.fromArray(record.point(station));
      const height = this.radius * 0.025;
      sprite.scale.set((height * canvas.width) / canvas.height, height, 1);
      const isLeftLimit = record.stations[index + 1]?.x === station.x;
      const isRightLimit = record.stations[index - 1]?.x === station.x;
      sprite.center.set(isLeftLimit ? 1.05 : isRightLimit ? -0.05 : 0.5, -0.15);
      sprite.renderOrder = 12;
      sprite.userData.gravissMemberDiagramLabel = true;
      this.group.add(sprite);
      this.labels.push(sprite);
    }
    this.summary.labelsShown = this.labels.length;
  }

  // Sprite vertices are camera-facing, not the unrotated unit quad stored in
  // their geometry. Export and camera fitting must measure those drawn corners.
  forEachLabelCorner(camera, visit) {
    if (!camera) return;
    const point = new this.THREE.Vector3();
    const right = new this.THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const up = new this.THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    for (const sprite of this.labels) {
      for (const x of [-sprite.center.x, 1 - sprite.center.x]) {
        for (const y of [-sprite.center.y, 1 - sprite.center.y]) {
          point
            .copy(sprite.position)
            .addScaledVector(right, x * sprite.scale.x)
            .addScaledVector(up, y * sprite.scale.y);
          visit(point);
        }
      }
    }
  }

  bounds(camera) {
    const box = new this.THREE.Box3();
    for (const object of this.pickables) {
      object.geometry.computeBoundingBox();
      box.union(object.geometry.boundingBox);
    }
    this.forEachLabelCorner(camera, (point) => box.expandByPoint(point));
    return box;
  }

  clearLabels() {
    for (const sprite of this.labels) {
      sprite.removeFromParent();
      sprite.material.map.dispose();
      sprite.material.dispose();
      sprite.geometry.dispose();
    }
    this.labels = [];
  }

  clear() {
    this.clearLabels();
    for (const object of this.pickables) {
      object.removeFromParent();
      object.geometry.dispose();
      object.material.dispose();
    }
    this.pickables = [];
    this.records = [];
    this.summary = null;
  }

  dispose() {
    this.clear();
    this.group.removeFromParent();
  }
}

module.exports = {
  DEFAULT_MEMBER_DIAGRAM_OPTIONS,
  MemberDiagram,
  memberDiagramDirection,
  memberDiagramLabelIndices,
  memberDiagramOptions,
  memberDiagramSegments,
  formatMemberDiagram,
  stationPoint,
};
