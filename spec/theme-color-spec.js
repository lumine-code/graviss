const resolveThemeColor = require("../lib/theme-color");
const { loadThreeRuntime } = require("../lib/three-runtime");
const { GravissRenderer: Renderer } = require("../lib/renderer");

describe("Graviss CSS theme colors", () => {
  let host;
  let THREE;

  beforeEach(async () => {
    host = document.createElement("div");
    jasmine.attachToDOM(host);
    ({ THREE } = await loadThreeRuntime());
  });

  afterEach(() => host.remove());

  it("resolves modern CSS expressions in host scope before passing them to Three", () => {
    host.style.setProperty("--test-base", "rgb(12, 34, 56)");
    host.style.setProperty(
      "--graviss-selected",
      "color-mix(in srgb, var(--test-base) 100%, white)",
    );
    const renderer = { host, THREE };
    const appearance = Renderer.prototype.resolveAppearance.call(renderer, { selected: 0xffffff });
    expect(appearance.selected).toBe(0x0c2238);
    const source = "rgb(from var(--test-base) calc(r + 1) g b)";
    expect(new THREE.Color().setStyle(resolveThemeColor(host, source, "#fff")).getHex()).toBe(
      0x0d2238,
    );
    expect(host.children.length).toBe(0);
  });

  it("uses safe opaque fallbacks for invalid or detached CSS colors", () => {
    expect(resolveThemeColor(host, "not-a-color", "#123456")).toBe("rgb(18, 52, 86)");
    host.remove();
    expect(resolveThemeColor(host, "red", "#123456")).toBe("#123456");
  });
});
