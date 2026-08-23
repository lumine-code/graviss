const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");

describe("graviss package conventions", () => {
  it("keeps canonical metadata, discovery terms, and its background tip aligned", () => {
    expect(firstProseLine(readme)).toBe(manifest.description);
    expect(manifest.description.length).toBeLessThan(80);
    expect(manifest.keywords.length).toBeGreaterThanOrEqual(3);
    expect(manifest.keywords.length).toBeLessThanOrEqual(8);
    expect(manifest.keywords.some((keyword) => manifest.name.includes(keyword))).toBe(false);
    expect(manifest.keywords.some((keyword) => FORBIDDEN_KEYWORDS.has(keyword))).toBe(false);
    expect(Object.keys(manifest).indexOf("backgroundTips")).toBe(
      Object.keys(manifest).indexOf("engines") + 1,
    );
    // Three, because the package now has three headline features rather than
    // one: framing a model, narrowing it, and reading an analysis over it.
    expect(manifest.backgroundTips.length).toBeGreaterThanOrEqual(1);
    expect(manifest.backgroundTips.length).toBeLessThanOrEqual(3);
    // The settings view renders a schema in the order it declares, and names
    // every entry from its own title, so neither is optional.
    for (const setting of Object.values(manifest.configSchema)) {
      expect(setting.title).toBeTruthy();
      expect(setting.description).toBeTruthy();
      expect(setting.order).toBeUndefined();
    }
  });

  it("ships convention-shaped documentation, service contracts, and CI", () => {
    expect(featureBullets(readme).length).toBeGreaterThanOrEqual(3);
    expect(featureBullets(readme).length).toBeLessThanOrEqual(9);
    expect(readme).toContain("## Installation");
    expect(readme).toContain("## Commands");
    expect(readme).toContain("## Customization");
    expect(readme).toContain("## Services");
    expect(readme).not.toMatch(/keymaps|keybindings/i);
    expect(readme).not.toMatch(/!\[/);
    expect(manifest.files).toContain("docs");
    const contract = fs.readFileSync(path.join(root, "docs", "graviss.source.md"), "utf8");
    for (const heading of [
      "## Registration",
      "## Contract",
      "## Minimal example",
      "## Teardown",
      "## Versioning",
    ]) {
      expect(contract).toContain(heading);
    }
    expect(fs.existsSync(path.join(root, ".github", "workflows", "ci.yml"))).toBe(true);
  });

  it("keeps pane actions local and exposes public style properties", () => {
    // Read the way the keymap loader reads it: comments are welcome in a
    // keymap file, and this spec must not be the one place that refuses them.
    const keymapText = fs
      .readFileSync(path.join(root, "keymaps", "main.json"), "utf8")
      .replace(/^\s*\/\/.*$/gm, "");
    const keymap = JSON.parse(keymapText);
    // Two scopes, and the second one is why the panels are not `.graviss`:
    // every single letter the viewer binds would fire while a filter expression
    // was being typed if they were. Nothing global, and nothing modified - a
    // package that reached for ctrl- would be taking a key from every other
    // surface in the window.
    expect(Object.keys(keymap)).toEqual([".graviss", ".graviss-panel"]);
    expect(Object.keys(keymap[".graviss-panel"])).toEqual(["escape"]);
    for (const scope of Object.keys(keymap)) {
      expect(Object.keys(keymap[scope]).some((stroke) => /^ctrl-/.test(stroke))).toBe(false);
    }
    // A panel's root must not carry native-key-bindings either: it would put
    // every core binding above the escape that gets back to the model. The
    // inputs inside it carry their own.
    for (const source of ["graviss-panel.js", "filter-panel.js", "results-panel.js"]) {
      const text = fs.readFileSync(path.join(root, "lib", source), "utf8");
      expect(text).not.toMatch(/graviss-panel [^"'`]*native-key-bindings/);
    }
    const styles = fs.readFileSync(path.join(root, "styles", "main.css"), "utf8");
    expect(styles).toContain("--graviss-axis-x-color");
    expect(styles).toContain("--graviss-axis-y-color");
    expect(styles).toContain("--graviss-axis-z-color");
  });
});

const FORBIDDEN_KEYWORDS = new Set([
  "lumine",
  "editor",
  "package",
  "plugin",
  "extension",
  "tool",
  "tools",
  "utility",
  "code",
  "visual",
  "simple",
  "easy",
  "support",
  "helper",
  "ui",
  "files",
  "lines",
  "panes",
]);

function firstProseLine(markdown) {
  return markdown
    .split(/\r?\n/)
    .slice(1)
    .find((line) => line.trim());
}

function featureBullets(markdown) {
  const section = markdown.match(/## Features\r?\n([\s\S]*?)(?=\r?\n## )/)?.[1] || "";
  return section.match(/^- \*\*/gm) || [];
}
