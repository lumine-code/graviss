const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Disposable } = require("lumine");

describe("Source changes while a model loads", () => {
  let root, viewPath, previousPaths, viewer, lease, changed, finish, calls, currentGeometry;
  const initialGeometry = {
    nodes: [
      { id: 1, x: 0, y: 0, z: 0 },
      { id: 2, x: 1, y: 0, z: 0 },
    ],
    elements: [{ id: 1, kind: "beam", nodeIds: [1, 2] }],
  };
  const updatedGeometry = {
    nodes: [...initialGeometry.nodes, { id: 3, x: 2, y: 0, z: 0 }],
    elements: [...initialGeometry.elements, { id: 2, kind: "beam", nodeIds: [2, 3] }],
  };

  async function until(condition) {
    const deadline = Date.now() + 10000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("Owned model did not finish loading.");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  beforeEach(async () => {
    jasmine.useRealClock();
    for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
      spyOn(lumine.shell, method).and.returnValue(Promise.resolve());
    spyOn(lumine.application, "openWindow").and.returnValue(Promise.resolve());
    root = fs.mkdtempSync(path.join(os.tmpdir(), "graviss-source-change-"));
    viewPath = path.join(root, "model.grv");
    fs.writeFileSync(viewPath, "{}\n");
    previousPaths = lumine.project.getPaths();
    lumine.project.setPaths([root]);
    const workspace = lumine.workspace.getElement();
    workspace.style.width = "800px";
    workspace.style.height = "400px";
    jasmine.attachToDOM(workspace);
    await lumine.packages.activatePackage("graviss");
    calls = 0;
    currentGeometry = initialGeometry;
  });

  afterEach(async () => {
    finish?.(initialGeometry);
    viewer?.destroy();
    lease?.dispose();
    if (lumine.packages.isPackageActive("graviss"))
      await lumine.packages.deactivatePackage("graviss");
    if (lumine.packages.isPackageLoaded("graviss")) await lumine.packages.unloadPackage("graviss");
    lumine.project.setPaths(previousPaths);
    await lumine.fileWatchClient.settlePendingTeardown();
    const temporary = fs.realpathSync(os.tmpdir());
    const target = fs.realpathSync(root);
    const relative = path.relative(temporary, target);
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`)
    )
      throw new Error("Fixture cleanup escaped the private temporary directory.");
    fs.unlinkSync(path.join(target, "model.grv"));
    fs.rmdirSync(target);
    viewer = lease = changed = finish = root = currentGeometry = null;
  });

  async function open(holdFirst) {
    const session = {
      describe: async () => ({
        model: {
          id: "owned",
          title: "Owned model",
          source: "Fixture",
          coordinateSystem: { upAxis: "z" },
        },
        capabilities: { geometry: true },
      }),
      getGeometry: () => {
        calls++;
        return holdFirst && calls === 1
          ? new Promise((resolve) => {
              finish = resolve;
            })
          : Promise.resolve(currentGeometry);
      },
      onDidChange: (callback) => {
        changed = callback;
        return new Disposable(() => {
          if (changed === callback) changed = null;
        });
      },
      dispose: () => {},
    };
    lease = lumine.packages.serviceHub.provide("graviss.source", "1.0.0", {
      id: "owned-source",
      createSession: ({ filePath }) => (filePath === viewPath ? session : null),
    });
    viewer = await lumine.workspace.open(viewPath);
    await until(() => changed && (holdFirst ? finish : viewer.renderer && !viewer.loading));
  }

  it("reloads the latest geometry once after changes arrive during the first read", async () => {
    await open(true);
    currentGeometry = updatedGeometry;
    changed({ scope: "geometry" });
    changed({ scope: "all" });
    finish(initialGeometry);
    await until(() => viewer.renderer && !viewer.loading);
    expect(viewer.renderer.getSceneSummary().members).toBe(2);
    expect(viewer.renderer.getSceneSummary().nodes).toBe(3);
    expect(calls).toBe(2);
  });

  it("continues reloading a source change after the current scene is ready", async () => {
    await open(false);
    expect(viewer.renderer.getSceneSummary().members).toBe(1);
    currentGeometry = updatedGeometry;
    changed({ scope: "geometry" });
    await until(() => viewer.renderer && !viewer.loading);
    expect(viewer.renderer.getSceneSummary().members).toBe(2);
    expect(calls).toBe(2);
  });
});
