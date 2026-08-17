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
    // Two documents, and the difference between them is the whole point: the
    // stored one is what the file says, and only ever gains what somebody
    // changed; the read one is that plus everything Graviss works out for
    // itself. Writing the read one back would fill a file somebody kept short
    // with every answer they were happy to leave to us.
    this.setStored(validateViewDocument(data));
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
      const parsed = parseViewDocumentText(sourceBuffer.getText());
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
    const text = formatViewDocument(this.stored);
    if (!filePath) return new TextBuffer({ text, ...nativeBufferOptions() });

    const buffer = TextBuffer.loadSync(path.resolve(filePath), nativeBufferOptions());
    let diskData;
    try {
      const parsed = parseViewDocumentText(buffer.getText());
      diskData = parsed.data;
      this.implicit = parsed.implicit;
    } catch {
      diskData = null;
    }
    if (!diskData || fingerprint(diskData) !== fingerprint(this.stored)) {
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

  setStored(stored) {
    this.stored = cloneViewDocument(stored);
    this.data = normalizeViewDocument(this.stored);
    return this.data;
  }

  getData() {
    return this.data;
  }

  // What the file holds, as against what the view reads. Only the parts
  // somebody set are in here.
  getStoredData() {
    return this.stored;
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
      data: cloneViewDocument(this.stored),
      modified: this.isModified(),
      conflicted: this.isInConflict(),
      deleted: this.isDeleted(),
      sourceHistory: this.serializeSourceHistory(),
    };
  }

  update(mutator, reason = "view-change") {
    if (this.destroyed) throw new Error("The Graviss view document has been destroyed.");
    if (typeof mutator !== "function") throw new TypeError("A document update requires a function");
    // The mutator is handed what the file says, not what the view reads, so a
    // change adds only itself and everything left unsaid stays unsaid.
    const next = cloneViewDocument(this.stored);
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
      parsed = parseViewDocumentText(this.sourceBuffer.getText());
    } catch (error) {
      this.sourceError = error;
      return false;
    }
    this.sourceError = null;
    this.implicit = parsed.implicit;
    this.setStored(parsed.data);
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

function parseViewDocumentText(text) {
  if (typeof text !== "string") throw new TypeError("Graviss view source must be text");
  // A blank file says nothing, and a document that says nothing is `{}`. The
  // default view is what saying nothing means, so there is no default document
  // to write down anywhere.
  if (!text.trim()) return { data: {}, implicit: true };
  return { data: validateViewDocument(JSON.parse(text)), implicit: false };
}

// A document says what somebody decided, and nothing else: the file's own name
// is not a title, position one is not an identity, and a view that was never
// posed has no camera. What a document leaves out is worked out here, so that
// everything downstream can still assume a whole one.
//
// The camera is the one thing never invented. It comes from the size of the
// model, which is not known until the geometry has loaded, so an absent camera
// stays absent and the view fits itself instead — and the fit is written down
// the first time anything else about the graphic changes.
function normalizeViewDocument(document) {
  const declared =
    Array.isArray(document.graphics) && document.graphics.length ? document.graphics : [{}];
  const taken = new Set(declared.map((graphic) => graphic.id).filter(Boolean));
  let counter = 0;
  const graphics = declared.map((graphic, index) => {
    let id = graphic.id;
    while (!id) {
      counter += 1;
      const candidate = `graphic-${counter}`;
      if (!taken.has(candidate)) id = candidate;
    }
    taken.add(id);
    return { ...graphic, id, title: graphic.title || `Graphic ${index + 1}` };
  });
  const normalized = { format: "graviss-view", version: 1, ...document, graphics };
  if (!graphics.some(({ id }) => id === normalized.activeGraphicId)) {
    normalized.activeGraphicId = graphics[0].id;
  }
  return normalized;
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
  // Nothing here has to be said. The `.grv` extension is what makes a file a
  // Graviss view; a `format` written inside one only ever repeated that. What
  // is said still has to be true, so a document claiming to be something else,
  // or a version this build does not know, is refused rather than read
  // hopefully.
  if ("format" in document && document.format !== "graviss-view") {
    throw new RangeError("Unsupported Graviss view document format");
  }
  if ("version" in document && document.version !== 1) {
    throw new RangeError("Unsupported Graviss view document version");
  }
  // A title is a name a person chose for the model, and most documents have no
  // reason to carry one: without it the pane is named after its file, the way
  // every other editor names a pane. Present, it has to say something.
  if ("title" in document && (typeof document.title !== "string" || !document.title)) {
    throw new TypeError("A Graviss view document title must be a non-empty string");
  }
  if ("graphics" in document && !Array.isArray(document.graphics)) {
    throw new TypeError("Graviss graphics must be an array");
  }
  const graphics = document.graphics || [];
  const ids = new Set();
  for (const [index, graphic] of graphics.entries()) {
    if (!graphic || typeof graphic !== "object" || Array.isArray(graphic)) {
      throw new TypeError(`Graviss graphic ${index} must be an object`);
    }
    // A graphic that does not name itself is named after its position, which
    // is only ambiguous against another that names itself the same thing.
    if ("id" in graphic && (typeof graphic.id !== "string" || !graphic.id)) {
      throw new TypeError(`Graviss graphic ${index} ID must be a non-empty string`);
    }
    if (graphic.id) {
      if (ids.has(graphic.id))
        throw new TypeError(`Graviss graphic ID ${graphic.id} is duplicated`);
      ids.add(graphic.id);
    }
    if ("title" in graphic && (typeof graphic.title !== "string" || !graphic.title)) {
      throw new TypeError(`Graviss graphic ${index} title must be a non-empty string`);
    }
    // No camera means the view was never posed, so it fits the model instead.
    if (graphic.camera != null) validateCameraState(graphic.camera);
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
    if (graphic.printRegion != null) {
      const { x, y, width, height } = graphic.printRegion;
      const fraction = (value) => Number.isFinite(value) && value >= 0 && value <= 1;
      if (
        !fraction(x) ||
        !fraction(y) ||
        !(width > 0) ||
        !(height > 0) ||
        !fraction(width) ||
        !fraction(height) ||
        x + width > 1.0001 ||
        y + height > 1.0001
      ) {
        throw new RangeError(
          `Graviss graphic ${graphic.id} printRegion must be a rectangle inside the viewport, in fractions of it`,
        );
      }
    }
  }
  // Which graphic is active is only worth stating when there is more than one,
  // and it is checked against the graphics that named themselves — the rest are
  // named after their position, and only once the document has been normalized.
  if (document.activeGraphicId != null) {
    if (typeof document.activeGraphicId !== "string" || !document.activeGraphicId) {
      throw new TypeError("Graviss activeGraphicId must be a non-empty string");
    }
    if (ids.size === graphics.length && !ids.has(document.activeGraphicId)) {
      throw new RangeError("Graviss activeGraphicId must reference a graphic");
    }
  }
  return document;
}

// Where a graphic is written in a stored document, made if it is not there. An
// update is handed the document the file holds, and a graphic nobody has
// changed yet is not in it — a file that named one graphic and left the rest to
// Graviss still needs somewhere to put the first change to the second one.
// Addressed by position, because position is the one thing a stored graphic and
// the read one are certain to agree on: a graphic that never named itself is
// named after where it sits.
function graphicAt(document, index) {
  if (!Array.isArray(document.graphics)) document.graphics = [];
  while (document.graphics.length <= index) document.graphics.push({});
  return document.graphics[index];
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

module.exports = {
  GravissViewDocument,
  cloneViewDocument,
  graphicAt,
  normalizeViewDocument,
  validateViewDocument,
};
