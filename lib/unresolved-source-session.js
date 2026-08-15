const path = require("node:path");

class UnresolvedSourceSession {
  constructor(viewDocument, filePath) {
    this.viewDocument = viewDocument;
    this.filePath = filePath;
    this.disposed = false;
  }

  ensureActive() {
    if (this.disposed) throw new Error("The unresolved Graviss source session is closed.");
  }

  async describe() {
    this.ensureActive();
    const document = this.viewDocument.getData();
    return {
      model: {
        id: this.filePath,
        title: document.title,
        source: sourceLabel(document, this.filePath),
        coordinateSystem: { upAxis: "z", handedness: "right" },
      },
      capabilities: { geometry: true },
    };
  }

  async getGeometry() {
    this.ensureActive();
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
    return path.resolve(path.dirname(filePath), document.source.trim());
  }
  return `a same-basename FEM database beside ${path.basename(filePath)}`;
}

module.exports = { UnresolvedSourceSession, sourceLabel };
