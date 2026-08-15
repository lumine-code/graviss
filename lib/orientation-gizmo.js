const GLOBAL_AXES = Object.freeze({
  x: Object.freeze([1, 0, 0]),
  y: Object.freeze([0, 1, 0]),
  z: Object.freeze([0, 0, 1]),
});

function projectGlobalAxes(THREE, cameraQuaternion) {
  if (!cameraQuaternion?.isQuaternion) {
    throw new TypeError("Axis projection requires a Three.js camera quaternion");
  }
  const inverseCameraRotation = cameraQuaternion.clone().invert();
  return Object.fromEntries(
    Object.entries(GLOBAL_AXES).map(([axis, direction]) => {
      const cameraDirection = new THREE.Vector3(...direction).applyQuaternion(
        inverseCameraRotation,
      );
      return [axis, { x: cameraDirection.x, y: -cameraDirection.y, depth: cameraDirection.z }];
    }),
  );
}

class OrientationGizmo {
  constructor(THREE, element, options = {}) {
    if (!element?.querySelector) {
      throw new TypeError("Orientation gizmo requires an HTML element");
    }
    this.THREE = THREE;
    this.element = element;
    this.origin = options.origin || 42;
    this.length = options.length || 27;
    this.axes = Object.fromEntries(
      Object.keys(GLOBAL_AXES).map((axis) => {
        const group = element.querySelector(`[data-gizmo-axis="${axis}"]`);
        if (!group) throw new TypeError(`Orientation gizmo is missing the ${axis} axis`);
        return [
          axis,
          {
            group,
            line: group.querySelector("line"),
            tip: group.querySelector("circle"),
            label: group.querySelector("text"),
          },
        ];
      }),
    );
    this.signature = "";
  }

  update(cameraQuaternion) {
    const signature = cameraQuaternion
      .toArray()
      .map((value) => value.toFixed(6))
      .join(":");
    if (signature === this.signature) return false;
    this.signature = signature;
    this.element.dataset.cameraOrientation = signature;
    const projected = projectGlobalAxes(this.THREE, cameraQuaternion);
    const order = Object.entries(projected).sort((left, right) => left[1].depth - right[1].depth);
    for (const [axis, direction] of order) {
      const parts = this.axes[axis];
      const endX = this.origin + direction.x * this.length;
      const endY = this.origin + direction.y * this.length;
      const projectedLength = Math.hypot(direction.x, direction.y);
      const labelScale = projectedLength > 0.12 ? 6 / projectedLength : 0;
      setAttributes(parts.line, {
        x1: this.origin,
        y1: this.origin,
        x2: endX,
        y2: endY,
      });
      setAttributes(parts.tip, { cx: endX, cy: endY });
      setAttributes(parts.label, {
        x: projectedLength > 0.12 ? endX + direction.x * labelScale : this.origin + 7,
        y: projectedLength > 0.12 ? endY + direction.y * labelScale : this.origin - 7,
      });
      parts.group.classList.toggle("is-toward", direction.depth > 0.2);
      parts.group.classList.toggle("is-away", direction.depth < -0.2);
      parts.group.dataset.depth = direction.depth.toFixed(4);
      parts.group.parentElement.append(parts.group);
    }
    return true;
  }
}

function setAttributes(element, attributes) {
  if (!element?.setAttribute) {
    throw new TypeError("Orientation gizmo contains an invalid SVG part");
  }
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, Number(value).toFixed(3));
  }
}

module.exports = { OrientationGizmo, projectGlobalAxes };
