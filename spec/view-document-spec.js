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
      data.activeGraphicId = "plan";
    });

    expect(document.isModified()).toBe(true);
    expect(document.isInConflict()).toBe(false);
    expect(document.serialize().data.activeGraphicId).toBe("plan");
    await document.save();

    expect(document.isModified()).toBe(false);
    expect(document.isDeleted()).toBe(false);
    expect(modifiedStates).toEqual([true, false]);
    expect(savedEvents).toEqual([{ path: filePath }]);
    expect(JSON.parse(fs.readFileSync(filePath, "utf8")).activeGraphicId).toBe("plan");
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
    expect(document.getData().activeGraphicId).toBe(document.getData().graphics[0].id);
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
      data.activeGraphicId = "plan";
    }, "active-graphic");
    expect(JSON.parse(sourceBuffer.getText()).activeGraphicId).toBe("plan");
    document.update((data) => {
      data.graphics[0].appearance = "midnight";
    }, "appearance");

    expect(document.canUndo()).toBe(true);
    expect(document.canRedo()).toBe(false);
    expect(document.undo()).toBe(true);
    expect(document.getData().activeGraphicId).toBe("plan");
    expect(document.getData().graphics[0].appearance).toBe("cloud");
    expect(document.undo()).toBe(true);
    expect(document.getData().activeGraphicId).toBe("overview");
    expect(document.isModified()).toBe(false);
    expect(document.undo()).toBe(false);

    expect(document.redo()).toBe(true);
    expect(document.getData().activeGraphicId).toBe("plan");
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
      data.activeGraphicId = "plan";
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
    expect(document.getData().activeGraphicId).toBe("plan");
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

  it("validates serialized document identity and active graphic references", () => {
    const duplicate = clone(EXAMPLES[0].viewDocument);
    duplicate.graphics[1].id = duplicate.graphics[0].id;
    expect(() => validateViewDocument(duplicate)).toThrowError(/duplicated/);

    const missing = clone(EXAMPLES[0].viewDocument);
    missing.activeGraphicId = "missing";
    expect(() => validateViewDocument(missing)).toThrowError(/activeGraphicId/);

    const badSections = clone(EXAMPLES[0].viewDocument);
    badSections.graphics[0].sectionRendering = "yes";
    expect(() => validateViewDocument(badSections)).toThrowError(/sectionRendering/);

    // A document need not name itself — the pane is then named after its file.
    // Naming itself nothing is a different thing, and not allowed.
    const untitled = clone(EXAMPLES[0].viewDocument);
    delete untitled.title;
    expect(validateViewDocument(untitled)).toBe(untitled);

    const blankTitle = clone(EXAMPLES[0].viewDocument);
    blankTitle.title = "";
    expect(() => validateViewDocument(blankTitle)).toThrowError(/title/);

    // A graphic that names neither itself nor its position is named after
    // where it sits, and only its neighbours can make that ambiguous.
    const bareGraphics = { graphics: [{}, {}] };
    expect(validateViewDocument(bareGraphics)).toBe(bareGraphics);
    const normalized = normalizeViewDocument(bareGraphics);
    expect(normalized.graphics.map(({ id }) => id)).toEqual(["graphic-1", "graphic-2"]);
    expect(normalized.graphics.map(({ title }) => title)).toEqual(["Graphic 1", "Graphic 2"]);
    expect(normalized.activeGraphicId).toBe("graphic-1");

    // A derived name never collides with one that was chosen.
    const mixed = normalizeViewDocument({ graphics: [{}, { id: "graphic-1" }] });
    expect(mixed.graphics.map(({ id }) => id)).toEqual(["graphic-2", "graphic-1"]);
  });
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function waitForWatcher(document) {
  await document.whenWatcherReady();
  await new Promise((resolve) => setTimeout(resolve, 150));
}
