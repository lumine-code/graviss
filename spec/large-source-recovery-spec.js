const { TextBuffer } = require("lumine");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { GravissViewDocument } = require("../lib/view-document");

function giantSource() {
  let source = TextBuffer.createTextSnapshot("x".repeat(32768));
  while (source.canMaterialize()) source = source.replace(source.length, source.length, source);
  return source.replace(source.length, source.length, "\r\n😀e\u0301");
}

describe("large Graviss raw-source recovery", () => {
  let documents, directory;
  beforeEach(() => {
    jasmine.useRealClock();
    documents = [];
  });
  afterEach(async () => {
    for (const document of documents) document.destroy();
    await lumine.fileWatchClient.settlePendingTeardown();
    if (directory) {
      const root = fs.realpathSync(os.tmpdir()),
        target = fs.realpathSync(directory),
        relative = path.relative(root, target);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
        throw new Error("Unsafe fixture path");
      fs.rmSync(target, { recursive: true, force: true });
      directory = null;
    }
  });
  function create(data = { title: "last valid" }) {
    const document = new GravissViewDocument({ data });
    documents.push(document);
    return document;
  }

  it("checks raw length before parsing and preserves oversized source plus undo without base-text getters", () => {
    const document = create(),
      buffer = document.getSourceBuffer(),
      source = giantSource();
    const read = spyOn(buffer, "getText").and.throwError("Whole raw source");
    const history = buffer.getHistory.bind(buffer);
    spyOn(buffer, "getHistory").and.callFake((...args) => {
      const result = history(...args);
      Object.defineProperty(result, "baseText", {
        get() {
          throw new Error("Lazy base text");
        },
      });
      return result;
    });
    buffer.setTextInRange(buffer.getRange(), source, { normalizeLineEndings: false });
    expect(document.sourceError.code).toBe("ERR_GRAVISS_SOURCE_LIMIT");
    const state = document.serialize();
    expect(state.sourceHistory.textSnapshot).toBe(buffer.getTextSnapshot());
    expect(read).not.toHaveBeenCalled();
    const restored = GravissViewDocument.restore(state);
    documents.push(restored);
    expect(restored.getSourceBuffer().getTextSnapshot().equals(source)).toBe(true);
    expect(restored.getData().title).toBe("last valid");
    const mutator = jasmine.createSpy("stale view edit");
    spyOn(lumine.notifications, "addWarning");
    expect(restored.update(mutator)).toBe(false);
    expect(mutator).not.toHaveBeenCalled();
    expect(restored.undo()).toBe(true);
    expect(restored.sourceError).toBeNull();
    expect(restored.getData().title).toBe("last valid");
    expect(restored.redo()).toBe(true);
    expect(restored.getSourceBuffer().getTextSnapshot().equals(source)).toBe(true);
  });

  it("keeps invalid small JSON in a portable legacy state and blocks view edits", () => {
    const document = create();
    document.getSourceBuffer().setText("{ invalid 😀\r\n");
    const state = JSON.parse(JSON.stringify(document.serialize()));
    const restored = GravissViewDocument.restore(state);
    documents.push(restored);
    expect(restored.getSourceBuffer().getText()).toBe("{ invalid 😀\r\n");
    expect(restored.sourceError).toBeTruthy();
    expect(
      restored.update((data) => {
        data.title = "overwrite";
      }),
    ).toBe(false);
    expect(restored.getStoredData().title).toBe("last valid");
    expect(restored.undo()).toBe(true);
    expect(restored.getStoredData().title).toBe("last valid");
  });

  it("retains dirty raw history when the disk file changes independently", () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "graviss-source-recovery-"));
    const filePath = path.join(directory, "view.grv");
    fs.writeFileSync(filePath, '{"title":"saved"}\n');
    const document = GravissViewDocument.load(filePath);
    documents.push(document);
    document.getSourceBuffer().setText("{ invalid local edit\r\n");
    const state = JSON.parse(JSON.stringify(document.serialize()));
    document.destroy();
    fs.writeFileSync(filePath, '{"title":"external"}\n');
    const restored = GravissViewDocument.restore(state);
    documents.push(restored);
    expect(restored.getFileState()).toBe("conflicted");
    expect(restored.getSourceBuffer().getText()).toBe("{ invalid local edit\r\n");
    expect(restored.undo()).toBe(true);
    expect(restored.getData().title).toBe("saved");
    expect(fs.readFileSync(filePath, "utf8")).toBe('{"title":"external"}\n');
  });

  it("restores saved invalid source history through the main document factory", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "graviss-invalid-saved-"));
    const filePath = path.join(directory, "view.grv");
    fs.writeFileSync(filePath, '{"title":"saved"}\n');
    const document = GravissViewDocument.load(filePath);
    documents.push(document);
    document.getSourceBuffer().setText("{ invalid saved source\n");
    await document.save();
    const state = JSON.parse(JSON.stringify(document.serialize()));
    expect(state.fileState).toBe("unmodified");
    document.destroy();
    const restored = require("../lib/main").createViewDocument({ filePath, state });
    documents.push(restored);
    expect(restored.getSourceBuffer().getText()).toBe("{ invalid saved source\n");
    expect(restored.undo()).toBe(true);
    expect(restored.getData().title).toBe("saved");
  });

  it("keeps newer invalid disk source while retaining the clean session's undo baseline", () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "graviss-new-disk-source-"));
    const filePath = path.join(directory, "view.grv");
    fs.writeFileSync(filePath, '{"title":"saved"}\n');
    const document = GravissViewDocument.load(filePath);
    documents.push(document);
    const state = JSON.parse(JSON.stringify(document.serialize()));
    delete state.sourceError;
    document.destroy();
    fs.writeFileSync(filePath, "{ newer external source\n");
    const restored = require("../lib/main").createViewDocument({ filePath, state });
    documents.push(restored);
    expect(restored.getSourceBuffer().getText()).toBe("{ newer external source\n");
    expect(restored.getFileState()).toBe("unmodified");
    expect(restored.undo()).toBe(true);
    expect(restored.getData().title).toBe("saved");
    expect(fs.readFileSync(filePath, "utf8")).toBe("{ newer external source\n");
  });

  it("rejects an oversized configuration before its buffer string getter", () => {
    const buffer = new TextBuffer({ text: giantSource() });
    spyOn(TextBuffer, "loadSync").and.returnValue(buffer);
    const read = spyOn(buffer, "getText").and.throwError("Whole file text");
    expect(() => GravissViewDocument.load(path.join(os.tmpdir(), "oversized.grv"))).toThrowError(
      /source budget/,
    );
    expect(read).not.toHaveBeenCalled();
    expect(buffer.isDestroyed()).toBe(true);
  });

  it("keeps the previous model when raw normalization exceeds its structural budget", () => {
    const document = create(),
      buffer = document.getSourceBuffer();
    const text = JSON.stringify({ graphics: Array(60000).fill({}) });
    buffer.setText(text);
    expect(document.sourceError.code).toBe("ERR_GRAVISS_SOURCE_LIMIT");
    expect(document.getStoredData().title).toBe("last valid");
    expect(document.getData().title).toBe("last valid");
    expect(buffer.getText()).toBe(text);
  });

  it("opens an oversized view configuration through the explicit text opener", async () => {
    const main = require("../lib/main");
    const filePath = path.join(os.tmpdir(), "configuration.grv"),
      raw = {};
    spyOn(main, "createFileViewer").and.callFake(() => {
      throw require("../lib/view-source-budget").sourceLimitError();
    });
    spyOn(lumine.workspace, "open").and.resolveTo(raw);
    spyOn(lumine.notifications, "addWarning");
    expect(await main.openFileViewer(filePath)).toBe(raw);
    expect(lumine.workspace.open).toHaveBeenCalledWith(filePath, { opener: "text-editor" });
  });

  it("checks boxed metadata strings before enumerating their character properties", () => {
    // Exercise native JSON boxed-string behavior.
    const value = new String("x".repeat(12 * 1024 * 1024));
    const keys = Object.keys;
    spyOn(Object, "keys").and.callFake((item) => {
      if (item === value) throw new Error("Boxed source properties must not be enumerated");
      return keys(item);
    });
    expect(() => require("../lib/view-source-budget").stringify({ value })).toThrowError(
      /source budget/,
    );
  });

  it("compares an oversized quick-filter draft without materializing it", () => {
    const { QuickFilterControl } = require("../lib/quick-filter-control");
    const viewer = {
      element: document.createElement("div"),
      quickFilterText: "",
      quickFilterAliases: new Map(),
      applyQuickFilter: jasmine.createSpy("apply"),
    };
    const control = new QuickFilterControl(viewer);
    const read = spyOn(control.editor, "getText").and.throwError("Whole draft");
    try {
      control.editor
        .getBuffer()
        .setTextInRange(control.editor.getBuffer().getRange(), giantSource());
      control.updateDraft();
      lumine.commands.dispatch(control.editor.element, "core:confirm");
      expect(read).not.toHaveBeenCalled();
      expect(viewer.applyQuickFilter).not.toHaveBeenCalled();
      expect(control.error.textContent).toContain("64 Ki");
    } finally {
      control.destroy();
    }
  });
});
