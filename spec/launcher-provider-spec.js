const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

describe("Graviss launcher provider", () => {
  let main, items, directory;

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    main = (await lumine.packages.activatePackage("graviss")).mainModule;
    items = [];
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "graviss-launcher-"));
  });

  afterEach(async () => {
    for (const item of items) item.destroy();
    await lumine.packages.deactivatePackage("graviss");
    await lumine.fileWatchClient.settlePendingTeardown();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function create() {
    const item = main.provideLauncher().create();
    items.push(item);
    return item;
  }

  it("creates an unopened center document without inventing a model", async () => {
    const pane = lumine.workspace.getActivePane();
    const activeItem = lumine.workspace.getActivePaneItem();
    const before = lumine.workspace.getPaneItems();
    const provider = main.provideLauncher();
    expect(provider.id).toBe("graviss");
    expect(provider.label).toBe("Graviss");
    const source = jasmine.createSpy("createSession");
    const registration = main.consumeGravissSource({ id: "spec-source", createSession: source });
    try {
      const item = create();
      await conditionPromise(() => !item.loading);
      expect(item.getPath()).toBeNull();
      expect(item.getTitle()).toBe("Untitled");
      expect(item.getSaveDialogOptions().defaultPath).toMatch(/Untitled\.grv$/);
      expect(item.getAllowedLocations()).toEqual(["center"]);
      expect(item.getDefaultLocation()).toBe("center");
      expect(item.viewDocument.getStoredData()).toEqual({});
      expect(item.graphics.map(({ title }) => title)).toEqual(["Graphic 1"]);
      expect(item.renderer).toBeNull();
      expect(item.description).toBeNull();
      expect(item.geometry).toBeNull();
      expect(item.element.querySelector(".graviss-error strong").textContent).toBe(
        "New Graviss View",
      );
      expect(item.element.querySelector('[data-action="open-model-source"]').textContent).toBe(
        "Open Model Source…",
      );
      expect(source).not.toHaveBeenCalled();
      expect(lumine.workspace.paneForItem(item)).toBeUndefined();
      expect(lumine.workspace.getPaneItems()).toEqual(before);
      expect(lumine.workspace.getActivePane()).toBe(pane);
      expect(lumine.workspace.getActivePaneItem()).toBe(activeItem);
    } finally {
      registration.dispose();
    }
  });

  it("rejects cancellation before retaining a document or source session", () => {
    const controller = new AbortController();
    controller.abort();
    const before = main.viewers.size;
    expect(() => main.provideLauncher().create({ signal: controller.signal })).toThrow();
    expect(main.viewers.size).toBe(before);
  });

  it("saves a new document through Save As and restores the saved path", async () => {
    const item = create();
    const filePath = path.join(directory, "analysis.grv");
    await lumine.workspace.open(item, { location: "center" });
    const pane = lumine.workspace.paneForItem(item);
    const saveAs = spyOn(pane, "saveItemAs").and.callFake((current) => current.saveAs(filePath));

    await item.save();
    expect(saveAs).toHaveBeenCalledWith(item);
    expect(item.getPath()).toBe(filePath);
    expect(item.getURI()).toBe(filePath);
    expect(item.getTitle()).toBe("analysis.grv");
    expect(item.getFileState()).toBe("unmodified");
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual({});
    const restored = main.deserialize(item.serialize());
    items.push(restored);
    expect(restored.getPath()).toBe(filePath);
    expect(restored.getTitle()).toBe("analysis.grv");
    expect(restored.viewDocument.getStoredData()).toEqual({});

    restored.viewDocument.update((data) => {
      data.title = "Saved view";
    });
    await restored.save();
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual({ title: "Saved view" });
    const secondPath = path.join(directory, "copy.grv");
    await restored.saveAs(secondPath);
    expect(restored.getPath()).toBe(secondPath);
    expect(JSON.parse(fs.readFileSync(secondPath, "utf8"))).toEqual({ title: "Saved view" });
  });

  it("restores an unsaved document with its edits and undo history", () => {
    const item = create();
    item.viewDocument.update((data) => {
      data.title = "Working view";
    });
    const state = item.serialize();
    expect(state.viewDocument.filePath).toBeNull();
    const restored = main.deserialize(state);
    items.push(restored);
    expect(restored.getPath()).toBeNull();
    expect(restored.getURI()).toBe(item.getURI());
    expect(restored.getTitle()).toBe("Working view");
    expect(restored.viewDocument.getStoredData()).toEqual({ title: "Working view" });
    expect(restored.undo()).toBe(true);
    expect(restored.viewDocument.getStoredData()).toEqual({});
    expect(restored.redo()).toBe(true);
    expect(restored.viewDocument.getStoredData()).toEqual({ title: "Working view" });
  });

  it("shares a new document between pane copies and releases it after the final copy", async () => {
    const item = create();
    const viewDocument = item.viewDocument;
    const session = item.session;
    const copy = item.copy();
    items.push(copy);
    expect(copy.viewDocument).toBe(viewDocument);
    expect(copy.session).toBe(session);
    const filePath = path.join(directory, "shared.grv");
    await copy.saveAs(filePath);
    expect(item.getPath()).toBe(filePath);
    expect(item.getTitle()).toBe("shared.grv");
    expect(copy.getTitle()).toBe("shared.grv");
    const copySession = copy.session;
    expect(session.disposed).toBe(true);
    item.destroy();
    expect(viewDocument.destroyed).toBe(false);
    expect(copySession.disposed).toBe(false);
    copy.destroy();
    expect(viewDocument.destroyed).toBe(true);
    expect(copySession.disposed).toBe(true);
  });

  it("can choose a source before saving and persists its absolute reference", async () => {
    const item = create();
    await conditionPromise(() => !item.loading);
    const sourcePath = path.join(directory, "model.cdb");
    const session = {
      describe: () => new Promise(() => {}),
      getGeometry: jasmine.createSpy("getGeometry"),
      dispose: jasmine.createSpy("dispose"),
    };
    const createSession = jasmine.createSpy("createSession").and.returnValue(session);
    const registration = main.consumeGravissSource({ id: "spec-model", createSession });
    spyOn(lumine.window, "showOpenDialog").and.resolveTo({
      canceled: false,
      filePaths: [sourcePath],
    });
    try {
      const emptySession = item.session;
      expect(await main.openModelSource(item)).toBe(true);
      expect(createSession).toHaveBeenCalledWith({
        viewDocument: item.viewDocument,
        filePath: null,
      });
      expect(item.viewDocument.getStoredData()).toEqual({ source: sourcePath });
      expect(item.session).toBe(session);
      expect(emptySession.disposed).toBe(true);
      expect(item.getPath()).toBeNull();
      const filePath = path.join(directory, "saved.grv");
      await item.saveAs(filePath);
      expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual({ source: sourcePath });
      expect(createSession.calls.mostRecent().args[0].filePath).toBe(filePath);
    } finally {
      registration.dispose();
    }
  });

  it("invalidates the previous service generation and closes its unopened items", async () => {
    const previous = main.provideLauncher();
    const item = create();
    const document = item.viewDocument;
    await lumine.packages.unloadPackage("graviss");
    expect(item.destroyed).toBe(true);
    expect(document.destroyed).toBe(true);
    expect(() => previous.create()).toThrowError(/no longer active/);
    main = (await lumine.packages.activatePackage("graviss")).mainModule;
    expect(() => previous.create()).toThrowError(/no longer active/);
    const replacement = create();
    expect(main.viewers.has(replacement)).toBe(true);
  });

  it("attaches the model-source chooser to a new view's auxiliary presentation", async () => {
    const item = create();
    const workspace = lumine.workspace;
    const extra = await workspace.openEditorWindow({ show: false });
    const mainDialog = spyOn(workspace.getMainWindow(), "showOpenDialog");
    const extraDialog = spyOn(extra, "showOpenDialog").and.resolveTo({
      canceled: true,
      filePaths: [],
    });
    try {
      await workspace.open(item, {
        pane: extra.getEditorContainer().getActivePane(),
        activatePane: false,
        activateItem: false,
      });
      expect(workspace.getWindowForElement(item.element)).toBe(extra);
      expect(await main.openModelSource(item)).toBe(false);
      expect(extraDialog).toHaveBeenCalledOnceWith({
        title: "Open FEM Model Source",
        properties: ["openFile"],
      });
      expect(mainDialog).not.toHaveBeenCalled();
      expect(item.viewDocument.getStoredData()).toEqual({});
    } finally {
      await workspace.discardEditorWindows();
    }
  });
});
