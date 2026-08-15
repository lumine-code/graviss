const fs = require("node:fs");
const path = require("node:path");

const FRAME_PATH = path.join(__dirname, "..", "fixtures", "frame.grv");
const SHELL_PATH = path.join(__dirname, "..", "fixtures", "shell.grv");

const FRAME_MODEL = createModel("frame", FRAME_PATH, createFrameGeometry);
const SHELL_MODEL = createModel("shell", SHELL_PATH, createShellGeometry);
const TEST_MODELS = Object.freeze([FRAME_MODEL, SHELL_MODEL]);

function createModel(id, viewDocumentPath, createGeometry) {
  const viewDocument = Object.freeze(JSON.parse(fs.readFileSync(viewDocumentPath, "utf8")));
  return Object.freeze({
    id,
    title: viewDocument.title,
    format: "Spec fixture",
    viewDocument,
    viewDocumentPath,
    createGeometry,
  });
}

function createFrameGeometry() {
  const coordinates = [
    [0, 0, 0],
    [8, 0, 0],
    [0, 0, 5],
    [4, 0, 7],
    [8, 0, 5],
    [0, 5, 0],
    [8, 5, 0],
    [0, 5, 5],
    [4, 5, 7],
    [8, 5, 5],
    [0, 10, 0],
    [8, 10, 0],
    [0, 10, 5],
    [4, 10, 7],
    [8, 10, 5],
  ];
  const connectivity = [
    [1, 3],
    [3, 4],
    [4, 5],
    [5, 2],
    [6, 8],
    [8, 9],
    [9, 10],
    [10, 7],
    [11, 13],
    [13, 14],
    [14, 15],
    [15, 12],
    [3, 8],
    [4, 9],
    [5, 10],
    [8, 13],
    [9, 14],
    [10, 15],
  ];
  const supportNodes = [1, 2, 6, 7, 11, 12];
  return {
    nodes: coordinates.map(([x, y, z], index) => ({ id: index + 1, x, y, z })),
    elements: connectivity.map((nodeIds, index) => ({
      id: index + 1,
      kind: "beam",
      nodeIds,
    })),
    supports: supportNodes.map((nodeId) => ({
      id: `SUPPORT-${nodeId}`,
      nodeId,
      restraints: [true, true, true, true, true, true],
    })),
  };
}

function createShellGeometry() {
  const divisions = 70;
  const nodes = [];
  for (let row = 0; row <= divisions; row++) {
    for (let column = 0; column <= divisions; column++) {
      nodes.push({
        id: row * (divisions + 1) + column + 1,
        x: -20 + (40 * column) / divisions,
        y: -20 + (40 * row) / divisions,
        z: 0,
      });
    }
  }
  const elements = [];
  for (let row = 0; row < divisions; row++) {
    for (let column = 0; column < divisions; column++) {
      const lowerLeft = row * (divisions + 1) + column + 1;
      elements.push({
        id: elements.length + 1,
        kind: "shell",
        nodeIds: [lowerLeft, lowerLeft + 1, lowerLeft + divisions + 2, lowerLeft + divisions + 1],
      });
    }
  }
  const supportNodes = [1, 71, 4971, 5041];
  return {
    nodes,
    elements,
    supports: supportNodes.map((nodeId) => ({
      id: `SUPPORT-${nodeId}`,
      nodeId,
      restraints: [true, true, true, false, false, false],
    })),
  };
}

class TestSession {
  constructor(model) {
    this.model = model;
    this.disposed = false;
  }

  async describe() {
    const geometry = this.model.createGeometry();
    return {
      model: {
        id: this.model.id,
        title: this.model.title,
        source: this.model.format,
        coordinateSystem: { upAxis: "z", handedness: "right" },
      },
      capabilities: {
        geometry: {
          elementKinds: [...new Set(geometry.elements.map(({ kind }) => kind))],
          supports: geometry.supports.length > 0,
        },
      },
    };
  }

  async getGeometry() {
    return this.model.createGeometry();
  }

  dispose() {
    this.disposed = true;
  }
}

module.exports = {
  FRAME_MODEL,
  SHELL_MODEL,
  TEST_MODELS,
  TestSession,
  createFrameGeometry,
  createShellGeometry,
};
