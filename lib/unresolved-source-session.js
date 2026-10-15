const path = require("node:path");

class UnresolvedSourceSession {
  constructor(viewDocument, filePath, resolutionError = null) {
    this.viewDocument = viewDocument;
    this.filePath = filePath;
    this.resolutionError = resolutionError;
    this.disposed = false;
  }

  ensureActive() {
    if (this.disposed) throw new Error("The unresolved Graviss source session is closed.");
  }

  async describe() {
    this.ensureActive();
    const document = this.viewDocument.getData();
    const source =
      typeof document.source === "string" && document.source.trim() ? document.source.trim() : null;
    if (!this.filePath && !source) {
      const error = new Error("Open a model source to populate this Graviss view.");
      error.code = "GRAVISS_SOURCE_REQUIRED";
      throw error;
    }
    return {
      model: {
        id: this.filePath || source,
        // A description must name the model, and a document need not: the file
        // stands in, as it does for the pane's own name.
        title: document.title || path.basename(this.filePath || source),
        source: sourceLabel(document, this.filePath),
        coordinateSystem: { upAxis: "z", handedness: "right" },
      },
      capabilities: { geometry: true },
    };
  }

  async getGeometry() {
    this.ensureActive();
    if (this.resolutionError) throw this.resolutionError;
    throw new Error(
      `No source provider is registered for ${sourceLabel(this.viewDocument.getData(), this.filePath)}.`,
    );
  }

  dispose() {
    this.disposed = true;
  }
}

function sourceLabel(document, filePath) {
  if (typeof document.source === "string" && document.source.trim()) {
    return path.resolve(filePath ? path.dirname(filePath) : "", document.source.trim());
  }
  if (!filePath) return "a FEM model source";
  return `a same-basename FEM database beside ${path.basename(filePath)}`;
}

module.exports = { UnresolvedSourceSession, sourceLabel };
