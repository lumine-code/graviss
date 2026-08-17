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
    expect(manifest.backgroundTips).toHaveSize(1);
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
    const keymap = JSON.parse(fs.readFileSync(path.join(root, "keymaps", "graviss.json"), "utf8"));
    expect(Object.keys(keymap)).toEqual([".graviss"]);
    expect(Object.keys(keymap[".graviss"]).some((stroke) => /^ctrl-/.test(stroke))).toBe(false);
    const styles = fs.readFileSync(path.join(root, "styles", "graviss.css"), "utf8");
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
