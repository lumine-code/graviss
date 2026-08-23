const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TextBuffer } = require("lumine");
const { TEST_MODELS: EXAMPLES } = require("./support/test-model");
const {
  GravissViewDocument,
  graphicAt,
  normalizeViewDocument,
  validateViewDocument,
} = require("../lib/view-document");

describe("GravissViewDocument", () => {
  let document;
  let directory;
  let filePath;

  beforeEach(() => {
    jasmine.useRealClock();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "graviss-view-document-"));
    filePath = path.join(directory, "model.grv");
    fs.writeFileSync(filePath, `${JSON.stringify(EXAMPLES[0].viewDocument, null, 2)}\n`);
  });

  afterEach(async () => {
    document?.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("tracks edits, saves them, and emits Lumine file-item events", async () => {
    document = GravissViewDocument.load(filePath);
    const modifiedStates = [];
    const savedEvents = [];
    document.onDidChangeModified((modified) => modifiedStates.push(modified));
    document.onDidSave((event) => savedEvents.push(event));

    document.update((data) => {
      data.activeGraphic = 1;
    });

    expect(document.isModified()).toBe(true);
    expect(document.isInConflict()).toBe(false);
    expect(document.serialize().data.activeGraphic).toBe(1);
    await document.save();

    expect(document.isModified()).toBe(false);
    expect(document.isDeleted()).toBe(false);
    expect(modifiedStates).toEqual([true, false]);
    expect(savedEvents).toEqual([{ path: filePath }]);
    expect(JSON.parse(fs.readFileSync(filePath, "utf8")).activeGraphic).toBe(1);
  });

  it("keeps its history buffer private and out of every editor registry", () => {
    const buildEditor = spyOn(lumine.workspace, "buildTextEditor").and.callThrough();
    const registerEditor = spyOn(lumine.textEditors, "add").and.callThrough();
    const paneItemsBefore = lumine.workspace.getPaneItems();
    const registeredEditorsBefore = lumine.textEditors.getEditors();

    document = GravissViewDocument.load(filePath);
    const sourceBuffer = document.getSourceBuffer();

    expect(sourceBuffer instanceof TextBuffer).toBe(true);
    expect(sourceBuffer.getPath()).toBe(filePath);
    expect(document.getPath()).toBe(sourceBuffer.getPath());
    expect(document.isModified()).toBe(sourceBuffer.isModified());
    expect(buildEditor).not.toHaveBeenCalled();
    expect(registerEditor).not.toHaveBeenCalled();
    expect(lumine.workspace.getPaneItems()).toEqual(paneItemsBefore);
    expect(lumine.textEditors.getEditors()).toEqual(registeredEditorsBefore);
    expect(lumine.textEditors.roleFor(sourceBuffer)).toBeNull();
  });

  it("opens blank files as clean implicit views and materializes JSON on the first change", async () => {
    fs.writeFileSync(filePath, " \r\n\t");
    document = GravissViewDocument.load(filePath);

    expect(document.isImplicit()).toBe(true);
    expect(document.isModified()).toBe(false);
    expect(document.getSourceBuffer().getText()).toBe(" \r\n\t");
    // What is read is whole: everything the file did not say, worked out.
    expect(document.getData()).toEqual(
      jasmine.objectContaining({ format: "graviss-view", version: 1 }),
    );
    expect(document.getData().graphics.length).toBe(1);
    expect(document.getData().activeGraphic).toBe(0);
    // A title is a name someone chose. A document made up for a blank file has
    // nobody to have chosen one, and the file's own name is not data.
    expect("title" in document.getData()).toBe(false);
    // What is stored is only what was said, which for a blank file is nothing.
    expect(document.getStoredData()).toEqual({});

    document.update((data) => {
      const graphic = graphicAt(data, 0);
      graphic.visibility ||= {};
      graphic.visibility.grid = false;
    });

    expect(document.isImplicit()).toBe(false);
    expect(document.isModified()).toBe(true);
    // The whole of what reaches the file is the one thing that was changed.
    // Everything else stays Graviss's to work out, so nothing else is written
    // down and nothing else can go stale against it.
    expect(JSON.parse(document.getSourceBuffer().getText())).toEqual({
      graphics: [{ visibility: { grid: false } }],
    });
    await document.save();
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual({
      graphics: [{ visibility: { grid: false } }],
    });
  });

  it("reads a document that says nothing and refuses one that says something wrong", () => {
    // Nothing has to be stated. The extension is what makes the file a view.
    fs.writeFileSync(filePath, "{}");
    document = GravissViewDocument.load(filePath);
    expect(document.getData().graphics.length).toBe(1);
    expect(document.getStoredData()).toEqual({});
    document.destroy();

    fs.writeFileSync(filePath, `{"format":"something-else"}`);
    expect(() => GravissViewDocument.load(filePath)).toThrowError(/format/);

    fs.writeFileSync(filePath, `{"version":2}`);
    expect(() => GravissViewDocument.load(filePath)).toThrowError(/version/);

    fs.writeFileSync(filePath, "not json");
    expect(() => GravissViewDocument.load(filePath)).toThrow();
    document = null;
  });

  it("undoes, redoes, and branches normalized view-document changes", () => {
    document = GravissViewDocument.load(filePath);
    const restoredReasons = [];
    document.onDidRestoreHistory(({ reason }) => restoredReasons.push(reason));

    const sourceBuffer = document.getSourceBuffer();
    expect(sourceBuffer instanceof TextBuffer).toBe(true);

    document.update((data) => {
      data.activeGraphic = 1;
    }, "active-graphic");
    expect(JSON.parse(sourceBuffer.getText()).activeGraphic).toBe(1);
    document.update((data) => {
      data.graphics[0].appearance = "midnight";
    }, "appearance");

    expect(document.canUndo()).toBe(true);
    expect(document.canRedo()).toBe(false);
    expect(document.undo()).toBe(true);
    expect(document.getData().activeGraphic).toBe(1);
    expect(document.getData().graphics[0].appearance).toBe("cloud");
    expect(document.undo()).toBe(true);
    expect(document.getData().activeGraphic).toBe(0);
    expect(document.isModified()).toBe(false);
    expect(document.undo()).toBe(false);

    expect(document.redo()).toBe(true);
    expect(document.getData().activeGraphic).toBe(1);
    document.update((data) => {
      data.graphics[1].visibility.grid = false;
    }, "visibility");

    expect(document.canRedo()).toBe(false);
    expect(document.redo()).toBe(false);
    expect(restoredReasons).toEqual(["undo", "undo", "redo"]);
  });

  it("tracks the saved revision through undo and redo and restores serialized history", async () => {
    document = GravissViewDocument.load(filePath);
    document.update((data) => {
      data.activeGraphic = 1;
    });
    await document.save();

    expect(document.isModified()).toBe(false);
    expect(document.undo()).toBe(true);
    expect(document.isModified()).toBe(true);
    expect(document.redo()).toBe(true);
    expect(document.isModified()).toBe(false);

    document.undo();
    const state = JSON.parse(JSON.stringify(document.serialize()));
    document.destroy();
    document = GravissViewDocument.restore(state);

    expect(document.canUndo()).toBe(false);
    expect(document.canRedo()).toBe(true);
    expect(document.redo()).toBe(true);
    expect(document.getData().activeGraphic).toBe(1);
    expect(document.isModified()).toBe(false);
  });

  it("reloads external changes while the document is clean", async () => {
    document = GravissViewDocument.load(filePath);
    await waitForWatcher(document);
    const reloaded = jasmine.createSpy("reloaded");
    document.onDidReload(reloaded);
    const diskData = clone(EXAMPLES[0].viewDocument);
    diskData.title = "Externally renamed view";
    fs.writeFileSync(filePath, JSON.stringify(diskData));

    await conditionPromise(
      () => document.getData().title === "Externally renamed view",
      "the native TextBuffer to reload the Graviss view",
    );

    expect(document.getData().title).toBe("Externally renamed view");
    expect(document.isModified()).toBe(false);
    expect(document.isInConflict()).toBe(false);
    expect(reloaded).toHaveBeenCalled();
  });

  it("watches its backing file for external changes", async () => {
    document = GravissViewDocument.load(filePath);
    await waitForWatcher(document);
    const diskData = clone(EXAMPLES[0].viewDocument);
    diskData.title = "Updated through the file watcher";

    fs.writeFileSync(filePath, JSON.stringify(diskData));
    await conditionPromise(
      () => document.getData().title === "Updated through the file watcher",
      "the external Graviss view change to reload",
    );

    expect(document.isModified()).toBe(false);
    expect(document.isInConflict()).toBe(false);
  });

  it("keeps local edits and marks a conflict when disk changes overlap them", async () => {
    document = GravissViewDocument.load(filePath);
    await waitForWatcher(document);
    const conflicts = jasmine.createSpy("conflicts");
    const warning = spyOn(lumine.notifications, "addWarning");
    const conflictDetected = new Promise((resolve) => {
      const subscription = document.onDidConflict(() => {
        conflicts();
        subscription.dispose();
        resolve();
      });
    });
    document.update((data) => {
      data.graphics[0].appearance = "midnight";
    });
    const diskData = clone(EXAMPLES[0].viewDocument);
    diskData.title = "Changed by another program";
    fs.writeFileSync(filePath, JSON.stringify(diskData));

    await conflictDetected;

    expect(document.getData().title).toBe(EXAMPLES[0].title);
    expect(document.getData().graphics[0].appearance).toBe("midnight");
    expect(document.isModified()).toBe(true);
    expect(document.isInConflict()).toBe(true);
    expect(conflicts).toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();

    await document.save();
    expect(document.isModified()).toBe(false);
    expect(document.isInConflict()).toBe(false);
    expect(JSON.parse(fs.readFileSync(filePath, "utf8")).graphics[0].appearance).toBe("midnight");
  });

  it("does not report a conflict for a watcher event without a content change", async () => {
    document = GravissViewDocument.load(filePath);
    await waitForWatcher(document);
    document.update((data) => {
      data.graphics[0].visibility.nodes = false;
    });

    fs.writeFileSync(filePath, `${JSON.stringify(EXAMPLES[0].viewDocument, null, 2)}\n`);
    await new Promise((resolve) =>
      setTimeout(resolve, document.getSourceBuffer().fileChangeDelay + 250),
    );

    expect(document.isModified()).toBe(true);
    expect(document.isInConflict()).toBe(false);
  });

  it("forwards native path, deletion, and save state", async () => {
    document = GravissViewDocument.load(filePath);
    await waitForWatcher(document);
    const renamedPath = path.join(directory, "renamed.grv");
    const pathChanges = [];
    document.onDidChangePath((changedPath) => pathChanges.push(changedPath));

    await document.saveAs(renamedPath);
    expect(document.getPath()).toBe(renamedPath);
    expect(pathChanges).toEqual([renamedPath]);
    await waitForWatcher(document);

    const deleted = new Promise((resolve) => {
      const subscription = document.onDidDelete(() => {
        subscription.dispose();
        resolve();
      });
    });
    fs.rmSync(renamedPath);
    await deleted;
    expect(document.isDeleted()).toBe(true);
    expect(document.isModified()).toBe(false);

    document.update((data) => {
      data.title = "Recreated view";
    });
    expect(document.isModified()).toBe(true);

    await document.save();
    expect(document.getPath()).toBe(renamedPath);
    expect(document.isModified()).toBe(false);
    expect(document.isDeleted()).toBe(false);
    expect(fs.existsSync(renamedPath)).toBe(true);
  });

  it("takes what a hand-written document can be read to mean", () => {
    // Position is the identity, so a repeated name is not a conflict — an `id`
    // is an alias, and the first graphic wearing it wins. This used to refuse
    // the whole document, which is how a file written by hand failed to open.
    const duplicate = clone(EXAMPLES[0].viewDocument);
    duplicate.graphics[1].id = duplicate.graphics[0].id;
    duplicate.activeGraphic = duplicate.graphics[0].id;
    expect(normalizeViewDocument(duplicate).activeGraphic).toBe(0);

    // An alias names a graphic without counting; a position names it without
    // naming it. Neither can be out of range once read.
    expect(
      normalizeViewDocument({ ...clone(EXAMPLES[0].viewDocument), activeGraphic: "plan" })
        .activeGraphic,
    ).toBe(1);
    const positions = { graphics: [{}, {}, {}] };
    expect(normalizeViewDocument({ ...positions, activeGraphic: 2 }).activeGraphic).toBe(2);
    expect(normalizeViewDocument({ ...positions, activeGraphic: 9 }).activeGraphic).toBe(2);
    expect(normalizeViewDocument({ ...positions, activeGraphic: -3 }).activeGraphic).toBe(0);
    expect(normalizeViewDocument({ ...positions, activeGraphic: "nobody" }).activeGraphic).toBe(0);
    expect(normalizeViewDocument({ ...positions, activeGraphic: 1.5 }).activeGraphic).toBe(0);

    // A value that cannot be read is replaced by what leaving it out would have
    // meant, rather than refusing to draw the model over it.
    const bad = normalizeViewDocument({
      graphics: [
        {
          title: "  ",
          id: 7,
          camera: { projection: "perspective", position: "over there" },
          appearance: "chartreuse",
          sectionRendering: "yes",
          visibility: { grid: "off", axes: true },
          printRegion: { x: -1, y: 0, width: 4, height: 4 },
          filter: { rules: [{ sign: "x", type: "group", text: "11" }] },
          results: { loadCaseId: 101, scale: -3 },
        },
      ],
    });
    expect(bad.graphics[0].title).toBe("Graphic 1");
    expect("id" in bad.graphics[0]).toBe(false);
    expect("camera" in bad.graphics[0]).toBe(false);
    expect("appearance" in bad.graphics[0]).toBe(false);
    expect("sectionRendering" in bad.graphics[0]).toBe(false);
    expect("visibility" in bad.graphics[0]).toBe(false);
    expect("printRegion" in bad.graphics[0]).toBe(false);
    // A whole block goes rather than the one field that could not be read: a
    // filter half applied is a model showing something nobody asked for.
    expect("filter" in bad.graphics[0]).toBe(false);
    expect("results" in bad.graphics[0]).toBe(false);

    // The two blocks a panel writes, kept as they were stated - IN ORDER,
    // because the rules are applied in turn and the last one that names an
    // element decides it. The expression is held verbatim rather than as
    // whatever it parsed to, because it is what the row has to show the user
    // again. `material` keeps a string expression alive so the named-value
    // grammar always has a case.
    const narrowed = normalizeViewDocument({
      graphics: [
        {
          filter: {
            rules: [
              { sign: "+", type: "group", text: "11,12,21-29" },
              { sign: "-", type: "@number", kinds: ["shell"], text: "110001" },
              { sign: "+", type: "material", text: "C30" },
            ],
          },
          results: {
            loadCaseId: 101,
            scale: "auto",
            cycle: "pingPong",
            period: 1500,
            playing: true,
            colorByDisplacement: true,
          },
        },
      ],
    });
    expect(narrowed.graphics[0].filter.rules.map(({ type }) => type)).toEqual([
      "group",
      "@number",
      "material",
    ]);
    expect(narrowed.graphics[0].filter.rules[1]).toEqual({
      sign: "-",
      type: "@number",
      kinds: ["shell"],
      text: "110001",
    });
    expect(narrowed.graphics[0].results.scale).toBe("auto");
    expect(narrowed.graphics[0].results.playing).toBe(true);
    // An empty block is a block, and says nothing rather than being refused.
    expect(normalizeViewDocument({ graphics: [{ filter: {} }] }).graphics[0].filter).toEqual({});
    // The shape this replaced is refused whole rather than kept and misread:
    // the old block was a conjunction, and no list of ordered signed rules
    // means the same thing. Loud erasure beats a plausible wrong model.
    expect(
      "filter" in
        normalizeViewDocument({
          graphics: [{ filter: { numbers: "1-10", facets: { group: [11] } } }],
        }).graphics[0],
    ).toBe(false);
    // A rule over a kind the contract does not know is a rule nobody wrote.
    expect(
      "filter" in
        normalizeViewDocument({
          graphics: [{ filter: { rules: [{ sign: "+", type: "g", kinds: ["girder"] }] } }],
        }).graphics[0],
    ).toBe(false);
    // A cycle nobody implements is not a cycle.
    expect(
      "results" in
        normalizeViewDocument({ graphics: [{ results: { cycle: "spin" } }] }).graphics[0],
    ).toBe(false);

    // What it can be read to mean, it keeps.
    const good = normalizeViewDocument({
      graphics: [{ id: "plan", title: "Roof plan", appearance: "paper", sectionRendering: false }],
    });
    expect(good.graphics[0]).toEqual(
      jasmine.objectContaining({
        id: "plan",
        title: "Roof plan",
        appearance: "paper",
        sectionRendering: false,
      }),
    );

    // Graphics that are not graphics are not graphics, and a document with none
    // left still has the one that saying nothing means.
    expect(normalizeViewDocument({ graphics: [null, 7, "x"] }).graphics.length).toBe(1);
    expect(normalizeViewDocument({ graphics: "no" }).graphics.length).toBe(1);

    // The two things that still make a document unreadable rather than merely
    // incomplete, because reading them hopefully would be guessing.
    expect(() => validateViewDocument({ format: "something-else" })).toThrowError(/format/);
    expect(() => validateViewDocument({ version: 2 })).toThrowError(/version/);
    expect(() => validateViewDocument([])).toThrowError(/must be an object/);
    expect(validateViewDocument({})).toEqual({});
  });
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function waitForWatcher(document) {
  await document.whenWatcherReady();
  await new Promise((resolve) => setTimeout(resolve, 150));
}
