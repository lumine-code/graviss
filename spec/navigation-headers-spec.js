const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CompositeDisposable, Emitter } = require("lumine");

describe("Graviss navigation headers", () => {
  let directory, filePath, viewDocument, viewer, observation, publications;

  beforeEach(() => {
    jasmine.useRealClock();
    const GravissView = require("../lib/graviss-view");
    const { GravissViewDocument } = require("../lib/view-document");
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "graviss-navigation-headers-"));
    filePath = path.join(directory, "model.grv");
    fs.writeFileSync(
      filePath,
      JSON.stringify({ graphics: [{ title: "First" }, { title: "Second" }], activeGraphic: 0 }),
    );
    viewDocument = GravissViewDocument.load(filePath);
    // Use the real document subscriptions and navigation methods without
    // loading a geometry source or creating a WebGL renderer.
    viewer = Object.assign(Object.create(GravissView.prototype), {
      viewDocument,
      graphics: viewDocument.getData().graphics,
      activeGraphicIndex: 0,
      cameraStates: new Map(),
      emitter: new Emitter(),
      subscriptions: new CompositeDisposable(),
      options: {},
    });
    spyOn(viewer, "updateGraphicControls");
    spyOn(viewer, "applyActiveGraphic");
    viewer.bindViewDocument();
    publications = [];
    observation = viewer.observeNavigationHeaders((headers) => {
      publications.push(
        headers.map(({ text, currentCount, stackCount }) => ({ text, currentCount, stackCount })),
      );
    });
  });

  afterEach(async () => {
    observation?.dispose();
    viewer?.subscriptions.dispose();
    viewer?.emitter.dispose();
    viewDocument?.destroy();
    await lumine.fileWatchClient.settlePendingTeardown();
    await fs.promises.rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 50,
    });
  });

  function expected(titles, activeIndex) {
    return titles.map((text, index) => ({
      text,
      currentCount: index === activeIndex ? 1 : 0,
      stackCount: index === activeIndex ? 1 : 0,
    }));
  }

  it("publishes the initial complete graphic list synchronously", () => {
    expect(publications).toEqual([expected(["First", "Second"], 0)]);
  });

  it("publishes one complete snapshot with the restored active graphic after a file reload", async () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        graphics: [{ title: "Reloaded first" }, { title: "Reloaded second" }],
        activeGraphic: 1,
      }),
    );
    await viewDocument.getSourceBuffer().reload();

    expect(publications).toEqual([
      expected(["First", "Second"], 0),
      expected(["Reloaded first", "Reloaded second"], 1),
    ]);
    expect(viewer.activeGraphicIndex).toBe(1);
  });

  it("publishes one consistent snapshot for each history restoration", () => {
    viewDocument.update((data) => {
      data.graphics[0].title = "Edited first";
      data.graphics[1].title = "Edited second";
      data.activeGraphic = 1;
    });
    viewer.activateGraphic(1);
    publications.length = 0;

    expect(viewDocument.undo()).toBe(true);
    expect(publications).toEqual([expected(["First", "Second"], 0)]);
    expect(viewer.activeGraphicIndex).toBe(0);

    expect(viewDocument.redo()).toBe(true);
    expect(publications).toEqual([
      expected(["First", "Second"], 0),
      expected(["Edited first", "Edited second"], 1),
    ]);
    expect(viewer.activeGraphicIndex).toBe(1);
  });
});
