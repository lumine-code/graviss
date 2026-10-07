// CSS custom properties may contain relative colors and color-mix(). Three's
// color parser cannot evaluate them; the browser resolves them in host scope.
module.exports = function resolveThemeColor(host, value, fallback) {
  if (!host.isConnected) return fallback;
  const doc = host.ownerDocument;
  const probe = doc.createElement("span");
  probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;color:inherit;";
  probe.style.color = fallback;
  probe.style.color = value;
  host.appendChild(probe);
  try {
    const color = doc.defaultView.getComputedStyle(probe).color || fallback;
    if (/^rgb\(/.test(color)) return color;
    const context = doc.createElement("canvas").getContext("2d");
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return `rgb(${r}, ${g}, ${b})`;
  } finally {
    probe.remove();
  }
};
