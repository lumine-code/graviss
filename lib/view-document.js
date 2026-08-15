const path = require("node:path");
const { CompositeDisposable, Emitter, TextBuffer } = require("lumine");
const { APPEARANCE_IDS } = require("./appearance");
const { validateCameraState } = require("./camera-navigation");

const MAX_HISTORY_STATES = 100;

class GravissViewDocument {
  constructor({
    data,
    filePath = null,
    restoredState = null,
    sourceBuffer = null,
    implicit = false,
  }) {
    this.emitter = new Emitter();
    this.sourceSubscriptions = new CompositeDisposable();
    this.destroyed = false;
    this.reloading = false;
    this.restoredConflict = Boolean(restoredState?.conflicted);
    this.restoredDeleted = Boolean(restoredState?.deleted);
    this.implicit = Boolean(implicit);
    this.data = cloneViewDocument(validateViewDocument(data));
    this.sourceBuffer = sourceBuffer || this.createSourceBuffer(filePath);
    this.restoreSourceHistory(restoredState?.sourceHistory);
    this.lastReportedModified = this.sourceBuffer.isModified();
    this.subscribeToSourceBuffer();
  }

  static load(filePath) {
    const absolutePath = path.resolve(filePath);
    const sourceBuffer = TextBuffer.loadSync(absolutePath, {
      ...nativeBufferOptions(),
      mustExist: true,
    });
    try {
      const parsed = parseViewDocumentText(sourceBuffer.getText(), absolutePath);
      return new GravissViewDocument({
        data: parsed.data,
        sourceBuffer,
        implicit: parsed.implicit,
      });
    } catch (error) {
      sourceBuffer.destroy();
      throw error;
    }
  }

  static restore(state, { fallbackData, fallbackPath = null } = {}) {
    if (!state || typeof state !== "object") {
      throw new TypeError("A serialized Graviss view document state is required");
    }
    return new GravissViewDocument({
      data: state.data || fallbackData,
      filePath: state.filePath || fallbackPath,
      restoredState: state,
    });
  }

  createSourceBuffer(filePath) {
    const text = formatViewDocument(this.data);
    if (!filePath) return new TextBuffer({ text, ...nativeBufferOptions() });

    const buffer = TextBuffer.loadSync(path.resolve(filePath), nativeBufferOptions());
    let diskData;
    try {
      const parsed = parseViewDocumentText(buffer.getText(), filePath);
      diskData = parsed.data;
      this.implicit = parsed.implicit;
    } catch {
      diskData = null;
    }
    if (!diskData || fingerprint(diskData) !== fingerprint(this.data)) {
      buffer.setTextViaDiff(text);
      buffer.clearUndoStack();
      this.implicit = false;
    }
    return buffer;
  }

  restoreSourceHistory(sourceHistory) {
    const buffer = this.sourceBuffer;
    if (
      sourceHistory?.text === buffer.getText() &&
      sourceHistory.history &&
      typeof buffer.restoreDefaultHistoryProvider === "function"
    ) {
      try {
        buffer.restoreDefaultHistoryProvider(sourceHistory.history);
      } catch {
        buffer.clearUndoStack();
      }
    }
  }

  subscribeToSourceBuffer() {
    const buffer = this.sourceBuffer;
    this.sourceSubscriptions.add(
      buffer.onDidChange(() => {
        if (!this.writingSource && !this.reloading) this.applySourceText("source-change");
      }),
      buffer.onWillReload(() => {
        this.reloading = true;
      }),
      buffer.onDidReload(() => {
        this.reloading = false;
        this.restoredConflict = false;
        this.restoredDeleted = false;
        if (this.applySourceText("reload")) this.emitter.emit("did-reload", this.data);
      }),
      buffer.onDidChangeModified((modified) => this.publishModifiedState(modified)),
      buffer.onDidConflict(() => {
        this.restoredConflict = false;
        this.emitter.emit("did-conflict");
      }),
      buffer.onDidDelete(() => {
        this.restoredDeleted = false;
        this.emitter.emit("did-delete");
        this.publishModifiedState();
      }),
      buffer.onDidChangePath((filePath) => {
        this.restoredDeleted = false;
        this.emitter.emit("did-change-path", filePath);
      }),
      buffer.onDidSave((event) => {
        this.restoredConflict = false;
        this.restoredDeleted = false;
        this.emitter.emit("did-save", event);
      }),
    );
  }

  serializeSourceHistory() {
    const buffer = this.sourceBuffer;
    if (!buffer?.getHistory) return null;
    try {
      return {
        text: buffer.getText(),
        history: serializeHistory(buffer.getHistory(MAX_HISTORY_STATES)),
      };
    } catch {
      return null;
    }
  }

  getData() {
    return this.data;
  }

  isImplicit() {
    return this.implicit;
  }

  getPath() {
    return this.sourceBuffer?.getPath() || null;
  }

  isModified() {
    return this.sourceBuffer?.isModified() || false;
  }

  isInConflict() {
    return this.restoredConflict || this.sourceBuffer?.isInConflict() || false;
  }

  isDeleted() {
    return this.restoredDeleted || this.sourceBuffer?.isDeleted() || false;
  }

  serialize() {
    return {
      filePath: this.getPath(),
      data: cloneViewDocument(this.data),
      modified: this.isModified(),
      conflicted: this.isInConflict(),
      deleted: this.isDeleted(),
      sourceHistory: this.serializeSourceHistory(),
    };
  }

  update(mutator, reason = "view-change") {
    if (this.destroyed) throw new Error("The Graviss view document has been destroyed.");
    if (typeof mutator !== "function") throw new TypeError("A document update requires a function");
    const next = cloneViewDocument(this.data);
    const before = fingerprint(next);
    mutator(next);
    validateViewDocument(next);
    const after = fingerprint(next);
    if (after === before) return false;
    this.commitSourceData(next, reason);
    return true;
  }

  commitSourceData(data, reason) {
    const text = formatViewDocument(data);
    const buffer = this.sourceBuffer;
    if (text === buffer.getText()) return false;
    const write = () => buffer.setTextViaDiff(text);
    this.writingSource = true;
    try {
      buffer.transact(write);
    } finally {
      this.writingSource = false;
    }
    this.applySourceText(reason);
    this.publishModifiedState();
    return true;
  }

  applySourceText(reason) {
    let parsed;
    try {
      parsed = parseViewDocumentText(this.sourceBuffer.getText(), this.getPath());
    } catch (error) {
      this.sourceError = error;
      return false;
    }
    this.sourceError = null;
    this.implicit = parsed.implicit;
    this.data = cloneViewDocument(parsed.data);
    if (reason === "undo" || reason === "redo") {
      this.emitter.emit("did-restore-history", { reason, data: this.data });
    }
    this.emitter.emit("did-change", { reason, data: this.data });
    return true;
  }

  canUndo() {
    return this.sourceBuffer.getHistory(1).undoStack.some(({ type }) => type === "transaction");
  }

  canRedo() {
    return this.sourceBuffer.getHistory(1).redoStack.some(({ type }) => type === "transaction");
  }

  undo() {
    return this.performHistory("undo");
  }

  redo() {
    return this.performHistory("redo");
  }

  performHistory(direction) {
    const buffer = this.sourceBuffer;
    this.writingSource = true;
    let changed;
    try {
      changed = buffer[direction]();
    } finally {
      this.writingSource = false;
    }
    if (changed) {
      this.applySourceText(direction);
      this.publishModifiedState();
    }
    return changed;
  }

  getSourceBuffer() {
    return this.sourceBuffer;
  }

  publishModifiedState(modified = this.isModified()) {
    const next = Boolean(modified);
    if (next === this.lastReportedModified) return;
    this.lastReportedModified = next;
    this.emitter.emit("did-change-modified", next);
  }

  setPath(filePath) {
    if (typeof filePath !== "string" || !filePath.trim()) {
      throw new TypeError("A Graviss view document path must be a non-empty string");
    }
    return this.sourceBuffer.setPath(path.resolve(filePath));
  }

  whenWatcherReady() {
    return this.sourceBuffer?.getFileWatchStartPromise?.() || Promise.resolve();
  }

  save() {
    if (!this.getPath()) throw new Error("The Graviss view document has no file path.");
    return this.sourceBuffer.save();
  }

  saveAs(filePath) {
    if (typeof filePath !== "string" || !filePath.trim()) return false;
    return this.sourceBuffer.saveAs(path.resolve(filePath));
  }

  onDidChange(callback) {
    return this.emitter.on("did-change", callback);
  }

  onDidReload(callback) {
    return this.emitter.on("did-reload", callback);
  }

  onDidRestoreHistory(callback) {
    return this.emitter.on("did-restore-history", callback);
  }

  onDidChangeModified(callback) {
    return this.emitter.on("did-change-modified", callback);
  }

  onDidConflict(callback) {
    return this.emitter.on("did-conflict", callback);
  }

  onDidDelete(callback) {
    return this.emitter.on("did-delete", callback);
  }

  onDidChangePath(callback) {
    return this.emitter.on("did-change-path", callback);
  }

  onDidSave(callback) {
    return this.emitter.on("did-save", callback);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.sourceSubscriptions.dispose();
    this.sourceBuffer?.destroy();
    this.sourceBuffer = null;
    this.emitter.dispose();
  }
}

function nativeBufferOptions() {
  return {
    maxUndoEntries: MAX_HISTORY_STATES,
    shouldDestroyOnFileDelete: () => false,
  };
}

function formatViewDocument(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}

function parseViewDocumentText(text, filePath = null) {
  if (typeof text !== "string") throw new TypeError("Graviss view source must be text");
  if (!text.trim()) {
    return { data: createDefaultViewDocument(filePath), implicit: true };
  }
  return { data: validateViewDocument(JSON.parse(text)), implicit: false };
}

function createDefaultViewDocument(filePath = null) {
  const extension = filePath ? path.extname(filePath) : "";
  const title = filePath ? path.basename(filePath, extension) : "Untitled";
  return {
    format: "graviss-view",
    version: 1,
    title: title || "Untitled",
    activeGraphicId: "overview",
    graphics: [
      {
        id: "overview",
        title: "3D overview",
        camera: {
          projection: "perspective",
          position: [10, -10, 10],
          target: [0, 0, 0],
          up: [0, 0, 1],
          fieldOfView: 42,
        },
        appearance: "auto",
        sectionRendering: true,
        visibility: {
          members: true,
          shells: true,
          nodes: false,
          supports: true,
          mesh: true,
          grid: true,
          axes: true,
          localAxes: false,
        },
      },
    ],
  };
}

function serializeHistory(history) {
  return {
    baseText: history.baseText,
    nextCheckpointId: history.nextCheckpointId,
    undoStack: history.undoStack.map(serializeHistoryEntry),
    redoStack: history.redoStack.map(serializeHistoryEntry),
  };
}

function serializeHistoryEntry(entry) {
  if (entry.type === "transaction") {
    return { ...entry, markersBefore: {}, markersAfter: {} };
  }
  if (entry.type === "checkpoint") return { ...entry, markers: {} };
  return entry;
}

function validateViewDocument(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new TypeError("A Graviss view document must be an object");
  }
  if (document.format !== "graviss-view" || document.version !== 1) {
    throw new RangeError("Unsupported Graviss view document format or version");
  }
  if (typeof document.title !== "string" || !document.title) {
    throw new TypeError("A Graviss view document requires a title");
  }
  if (!Array.isArray(document.graphics) || document.graphics.length === 0) {
    throw new TypeError("A Graviss view document requires at least one graphic");
  }
  const ids = new Set();
  for (const [index, graphic] of document.graphics.entries()) {
    if (!graphic || typeof graphic !== "object" || Array.isArray(graphic)) {
      throw new TypeError(`Graviss graphic ${index} must be an object`);
    }
    if (typeof graphic.id !== "string" || !graphic.id) {
      throw new TypeError(`Graviss graphic ${index} requires an ID`);
    }
    if (ids.has(graphic.id)) throw new TypeError(`Graviss graphic ID ${graphic.id} is duplicated`);
    ids.add(graphic.id);
    if (typeof graphic.title !== "string" || !graphic.title) {
      throw new TypeError(`Graviss graphic ${graphic.id} requires a title`);
    }
    validateCameraState(graphic.camera);
    if (
      graphic.appearance != null &&
      graphic.appearance !== "auto" &&
      !APPEARANCE_IDS.includes(graphic.appearance)
    ) {
      throw new RangeError(`Graviss graphic ${graphic.id} has an unsupported appearance`);
    }
    if (
      graphic.visibility != null &&
      (!graphic.visibility ||
        typeof graphic.visibility !== "object" ||
        Array.isArray(graphic.visibility) ||
        Object.values(graphic.visibility).some((visible) => typeof visible !== "boolean"))
    ) {
      throw new TypeError(`Graviss graphic ${graphic.id} visibility values must be boolean`);
    }
    if (graphic.sectionRendering != null && typeof graphic.sectionRendering !== "boolean") {
      throw new TypeError(`Graviss graphic ${graphic.id} sectionRendering must be boolean`);
    }
  }
  if (!ids.has(document.activeGraphicId)) {
    throw new RangeError("Graviss activeGraphicId must reference a graphic");
  }
  return document;
}

function cloneViewDocument(document) {
  return JSON.parse(JSON.stringify(document));
}

function fingerprint(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

module.exports = { GravissViewDocument, cloneViewDocument, validateViewDocument };
