const path = require("node:path");
const { CompositeDisposable, Emitter, TextBuffer } = require("lumine");
const { APPEARANCE_IDS } = require("./appearance");
const { CYCLE_IDS } = require("./animation");
const { validateCameraState } = require("./camera-navigation");
const { ELEMENT_KINDS } = require("./validation");

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
// A graphic is identified by where it is in the list, and by nothing else. It
// used to carry a name of its own, which a file written by hand or by another
// tool could repeat — and two graphics called the same thing is a question with
// no answer, so the whole document was refused over it. A position cannot
// collide with anything, cannot be misspelt, and does not have to be invented
// for a graphic that never named itself.
//
// Everything a graphic states is taken only if it makes sense; the rest falls
// back to what an unstated one would have meant. A file nobody could write by
// hand is not much use, and refusing to draw anything over one bad number in
// one graphic is not a reading of it that helps.
function normalizeViewDocument(document) {
  const declared = Array.isArray(document.graphics) ? document.graphics.filter(isObject) : [];
  const graphics = (declared.length ? declared : [{}]).map((graphic, index) => ({
    ...graphic,
    title: isName(graphic.title) ? graphic.title : `Graphic ${index + 1}`,
    ...pick("id", graphic.id, isName),
    ...pick("camera", graphic.camera, isCamera),
    ...pick("appearance", graphic.appearance, isAppearance),
    ...pick("visibility", graphic.visibility, isVisibility),
    ...pick("sectionRendering", graphic.sectionRendering, isBoolean),
    ...pick("backgroundGradient", graphic.backgroundGradient, isBoolean),
    ...pick("symbolSize", graphic.symbolSize, isSymbolSize),
    ...pick("printRegion", graphic.printRegion, isPrintRegion),
    ...pick("filter", graphic.filter, isFilter),
    ...pick("results", graphic.results, isResults),
  }));
  // Cloned on the way out so that a value normalization had to erase leaves no
  // key behind for a caller to trip over.
  return cloneViewDocument({
    format: "graviss-view",
    version: 1,
    ...document,
    graphics,
    activeGraphic: resolveActiveGraphic(document.activeGraphic, graphics),
  });
}

// A stated value when it can be read, and an erasure when it cannot: the
// graphic has already been spread, so leaving the key out would keep the value
// that could not be read rather than replace it. The undefined is dropped when
// the normalized document is cloned.
function pick(key, value, accepts) {
  if (value == null) return {};
  return accepts(value) ? { [key]: value } : { [key]: undefined };
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isName(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isBoolean(value) {
  return typeof value === "boolean";
}

function isCamera(value) {
  try {
    validateCameraState(value);
    return true;
  } catch {
    return false;
  }
}

function isAppearance(value) {
  return value === "auto" || APPEARANCE_IDS.includes(value);
}

// A length in metres, so it is a number that is not negative — zero being a
// real answer, and the renderer holding it to the range it will draw.
function isSymbolSize(value) {
  return Number.isFinite(value) && value >= 0;
}

function isVisibility(value) {
  return isObject(value) && Object.values(value).every(isBoolean);
}

// A window cut through the camera's view: a centre and extents in absolute
// tangents about the view axis — angles, in the units the field of view is a
// pair of. The stored camera and this window determine the picture
// completely, with no pane anywhere in the definition, so every window size
// and a batch render produce the same picture; and because the window rides
// the view axis, no camera action can move it on the screen.
function isPrintRegion(value) {
  if (!isObject(value)) return false;
  const { center, width, height } = value;
  return (
    Array.isArray(center) &&
    center.length === 2 &&
    center.every(Number.isFinite) &&
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0
  );
}

// Which elements a user narrowed the model down to, as the ordered list of
// signed rules the panel shows.
//
// An array because ORDER IS THE MEANING: the rules are applied in turn and the
// last one that names an element decides it, so the same two rules the other
// way round are a different model. That is also what makes a reorder a change
// the document notices - `canonicalize` maps arrays, so it fingerprints order.
//
// An expression is kept verbatim rather than as whatever it parsed to. It is
// what the row has to show the user again, and a source that renumbers between
// two openings should filter by what was asked for, not by the numbers it meant
// last time.
//
// A rule naming a dimension this model has not got is NOT refused here. The
// document is read before the geometry is, so there is nothing to check it
// against; the panel says so on the row instead, and the rule keeps its place.
function isFilter(value) {
  if (!isObject(value)) return false;
  // The shape this replaced. Refusing it outright is what makes an old block
  // vanish rather than sit in the file waiting to be read as something it is
  // not: the old block was a conjunction, and no list of ordered signed rules
  // means the same thing.
  if (value.numbers != null || value.facets != null) return false;
  if (value.rules == null) return true;
  return Array.isArray(value.rules) && value.rules.every(isFilterRule);
}

function isFilterRule(value) {
  if (!isObject(value)) return false;
  if (value.sign !== "+" && value.sign !== "-") return false;
  if (typeof value.type !== "string" || !value.type) return false;
  if (value.text != null && typeof value.text !== "string") return false;
  if (value.kinds != null) {
    if (!Array.isArray(value.kinds) || !value.kinds.length) return false;
    if (!value.kinds.every((kind) => ELEMENT_KINDS.has(kind))) return false;
  }
  return true;
}

// What is being shown of the analysis, and how. A scale of `"auto"` is the
// viewer choosing one rather than a number it happened to choose last time: a
// document reopened against a rerun model should amplify what that run actually
// produced.
//
// `playing` is kept because a graphic saved animating is a thing to want back -
// a mode shape is barely legible standing still - and because the alternative
// is that an animated view cannot be saved at all.
function isResults(value) {
  if (!isObject(value)) return false;
  if (value.loadCaseId != null && !isId(value.loadCaseId)) return false;
  if (
    value.scale != null &&
    value.scale !== "auto" &&
    !(Number.isFinite(value.scale) && value.scale >= 0)
  )
    return false;
  if (value.cycle != null && !CYCLE_IDS.includes(value.cycle)) return false;
  if (value.period != null && !(Number.isFinite(value.period) && value.period > 0)) return false;
  if (value.playing != null && !isBoolean(value.playing)) return false;
  if (value.colorByDisplacement != null && !isBoolean(value.colorByDisplacement)) return false;
  return true;
}

// What the contract calls an Id: a name or a number, and nothing else, because
// those are the two things a source can key its own things by.
function isId(value) {
  return isName(value) || Number.isFinite(value);
}

// Which graphic is showing, as a position. A name may be used instead, matched
// against the `id` a graphic may carry as an alias for exactly this — a file
// written by hand can then say which graphic it means without counting. Two
// graphics sharing an alias is not an error, because an alias is not an
// identity: the first one wins, which is a real answer rather than a refusal to
// open the file. Out of range, unmatched, or not a whole number means the
// first graphic; there is no reading of a missing one better than a real one.
function resolveActiveGraphic(value, graphics) {
  if (isName(value)) {
    const matched = graphics.findIndex((graphic) => graphic.id === value);
    return matched >= 0 ? matched : 0;
  }
  if (!Number.isInteger(value)) return 0;
  return Math.min(Math.max(value, 0), graphics.length - 1);
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
  if (!isObject(document)) {
    throw new TypeError("A Graviss view document must be an object");
  }
  // The only two things a document can say that make it unreadable rather than
  // merely incomplete. Everything else it states is taken if it can be read and
  // replaced by what an unstated value would have meant if it cannot, because
  // these files are written by hand and by other tools, and refusing to draw
  // anything over one bad number helps nobody. A document naming a format that
  // is not this one, or a version this build does not know, is a different
  // matter: reading it hopefully would be guessing at what it meant.
  if ("format" in document && document.format !== "graviss-view") {
    throw new RangeError("Unsupported Graviss view document format");
  }
  if ("version" in document && document.version !== 1) {
    throw new RangeError("Unsupported Graviss view document version");
  }
  return document;
}

// The stored graphics, held to the entries the read view counts. Normalization
// keeps only the entries that are objects, so a stored list carrying junk — a
// null, a number, a string — numbers its graphics differently from the read
// one, and a write aimed at read position two would land on stored junk. Every
// edit rewrites the file anyway, so the junk goes with the first change.
function storedGraphics(document) {
  const declared = Array.isArray(document.graphics) ? document.graphics : [];
  document.graphics = declared.filter(isObject);
  return document.graphics;
}

// Where a graphic is written in a stored document, made if it is not there. An
// update is handed the document the file holds, and a graphic nobody has
// changed yet is not in it — a file that named one graphic and left the rest to
// Graviss still needs somewhere to put the first change to the second one.
// Addressed by position, because position is the one thing a stored graphic and
// the read one are certain to agree on: a graphic that never named itself is
// named after where it sits.
function graphicAt(document, index) {
  const graphics = storedGraphics(document);
  while (graphics.length <= index) graphics.push({});
  return graphics[index];
}

// A new graphic states nothing, exactly like one a hand-written file left
// blank: everything about it is worked out until somebody changes it. The
// graphics before it are materialized so the position it takes is real.
function insertGraphicAt(document, index) {
  const graphics = storedGraphics(document);
  while (graphics.length < index) graphics.push({});
  graphics.splice(index, 0, {});
  return graphics[index];
}

function removeGraphicAt(document, index) {
  const graphics = storedGraphics(document);
  if (index < 0 || index >= graphics.length) return false;
  graphics.splice(index, 1);
  return true;
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
  insertGraphicAt,
  normalizeViewDocument,
  removeGraphicAt,
  validateViewDocument,
};
