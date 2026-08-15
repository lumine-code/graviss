const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const GravissView = require("../lib/graviss-view");
const { APPEARANCE_IDS } = require("../lib/appearance");
const { CAMERA_VIEW_IDS } = require("../lib/camera-navigation");
const {
  FRAME_MODEL,
  SHELL_MODEL,
  TEST_MODELS,
  TestSession,
  createFrameGeometry,
} = require("./support/test-model");

const MAIN_EXAMPLE = FRAME_MODEL;
const MAIN_EXAMPLE_URI = MAIN_EXAMPLE.viewDocumentPath;
const SHELL_EXAMPLE = SHELL_MODEL;
const SHELL_EXAMPLE_URI = SHELL_EXAMPLE.viewDocumentPath;

function createMain1Geometry() {
  return createFrameGeometry();
}

function normalizedCameraZ(renderer) {
  const position = renderer.camera.position;
  const target = renderer.controls.target;
  const x = position.x - target.x;
  const y = position.y - target.y;
  const z = position.z - target.z;
  return z / Math.hypot(x, y, z);
}

describe("graviss", () => {
  let mainModule;
  let sourceProviderDisposable;

  function createFixtureViewer(model, options = {}) {
    const viewDocument = mainModule.createViewDocument({
      filePath: model.viewDocumentPath,
      state: options.viewDocumentState,
      fallbackData: model.viewDocument,
    });
    return mainModule.createViewer(new TestSession(model), {
      uri: model.viewDocumentPath,
      title: model.title,
      restorable: true,
      viewDocument,
      activeGraphicId: options.activeGraphicId || viewDocument.getData().activeGraphicId,
    });
  }

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    const pack = await lumine.packages.activatePackage("graviss");
    mainModule = pack.mainModule;
    sourceProviderDisposable = mainModule.consumeGravissSource({
      id: "spec-models",
      createSession({ filePath }) {
        const model = TEST_MODELS.find(({ viewDocumentPath }) => viewDocumentPath === filePath);
        return model ? new TestSession(model) : null;
      },
    });
  });

  afterEach(async () => {
    sourceProviderDisposable.dispose();
    await lumine.packages.deactivatePackage("graviss");
  });

  it("opens a provider-backed view document", async () => {
    const item = await lumine.workspace.open(MAIN_EXAMPLE_URI, { searchAllPanes: true });
    expect(item instanceof GravissView).toBe(true);
    expect(item.getURI()).toBe(MAIN_EXAMPLE_URI);
    expect(item.getTitle()).toBe(MAIN_EXAMPLE.title);
    expect(item.getIconName()).toBe("graph");
    expect(item.serialize()).toEqual(
      jasmine.objectContaining({
        deserializer: "GravissView",
        uri: MAIN_EXAMPLE_URI,
        activeGraphicId: "overview",
        viewDocument: jasmine.objectContaining({
          filePath: MAIN_EXAMPLE.viewDocumentPath,
          modified: false,
          conflicted: false,
          deleted: false,
        }),
      }),
    );
    expect(item.getPath()).toBe(MAIN_EXAMPLE.viewDocumentPath);
    expect(item.getSaveDialogOptions().filters).toEqual([
      { name: "Graviss view", extensions: ["grv"] },
    ]);

    await conditionPromise(
      () => item.renderer != null || !item.element.querySelector(".graviss-error").hidden,
      "the Three.js scene to initialize",
    );
    const renderedError = item.element.querySelector(".graviss-error-message").textContent;
    if (!item.renderer) fail(`Renderer initialization failed: ${renderedError}`);
    expect(item.renderer.getSceneSummary()).toEqual({
      members: 18,
      shells: 0,
      nodes: 15,
      supports: 6,
      pickables: 3,
    });
    expect(item.renderer.hovered).toBeUndefined();
    expect(item.renderer.colors.hover).toBeUndefined();
    spyOn(item.renderer, "pick").and.callThrough();
    item.renderer.canvasRenderer.domElement.dispatchEvent(new MouseEvent("pointermove"));
    expect(item.renderer.pick).not.toHaveBeenCalled();
    expect(item.element.querySelector(".graviss-inspector")).toBeNull();
    expect(item.element.querySelector(".graviss-inspector-toggle")).toBeNull();
    expect(item.element.querySelector(".graviss-hud")).toBeNull();
    const viewCube = item.element.querySelector(".graviss-view-cube");
    expect(viewCube.dataset.faceTargets).toBe("6");
    expect(viewCube.dataset.edgeTargets).toBe("12");
    expect(viewCube.dataset.cornerTargets).toBe("8");
    expect(viewCube.dataset.selectedView).toBe("");
    const axisGizmo = item.element.querySelector(".graviss-axis-gizmo");
    expect(item.renderer.axes.position.toArray()).toEqual([0, 0, 0]);
    expect(axisGizmo.dataset.cameraOrientation).toMatch(/.+/);
    expect(axisGizmo.hidden).toBe(true);
    const previousGraphic = item.element.querySelector('[data-action="previous-graphic"]');
    const nextGraphic = item.element.querySelector('[data-action="next-graphic"]');
    const graphicCounter = item.element.querySelector(".graviss-graphic-counter");
    const frameRateCounter = item.element.querySelector(".graviss-fps-counter");
    const toolbar = item.element.querySelector(".graviss-toolbar");
    expect(item.element.querySelector(".graviss-toolbar").classList.contains("btn-toolbar")).toBe(
      true,
    );
    expect(
      [...toolbar.querySelectorAll("button")].every((button) => !button.textContent.trim()),
    ).toBe(true);
    expect(toolbar.querySelector("input")).toBeNull();
    expect(toolbar.querySelector(".graviss-graphic-title")).toBeNull();
    const toolbarButtons = [...toolbar.querySelectorAll("button")];
    const perspectiveButton = toolbar.querySelector('[data-projection="perspective"]');
    const orthographicButton = toolbar.querySelector('[data-projection="orthographic"]');
    const isometricButton = toolbar.querySelector('[data-view="iso"]');
    expect(perspectiveButton.closest(".btn-group")).toBe(orthographicButton.closest(".btn-group"));
    expect(perspectiveButton.closest(".btn-group")).not.toBe(isometricButton.closest(".btn-group"));
    expect(perspectiveButton.closest(".graviss-projection-actions")).not.toBeNull();
    expect(
      toolbarButtons.every(
        (button) =>
          button.classList.contains("graviss-toolbar-button") &&
          button.querySelector(":scope > svg.icon.graviss-toolbar-icon[aria-hidden='true']"),
      ),
    ).toBe(true);
    expect(
      toolbarButtons.every((button) =>
        [...button.classList].every((className) => !className.startsWith("icon-")),
      ),
    ).toBe(true);
    expect(
      toolbarButtons.map((button) =>
        // The element-detail button carries one icon per level and shows the
        // level on screen, so it contributes that icon rather than its first.
        button.dataset.detail
          ? `detail-${button.dataset.detail}`
          : button.querySelector(".graviss-toolbar-icon").dataset.icon,
      ),
    ).toEqual([
      "previous-graphic",
      "next-graphic",
      "fit",
      "isometric",
      "top",
      "front",
      "right",
      "perspective",
      "orthographic",
      "detail-section",
      "members",
      "shells",
      "nodes",
      "supports",
      "mesh",
      "grid",
      "axes",
      "local-axes",
      "background",
    ]);
    expect(toolbarButtons.every((button) => !button.getAttribute("title"))).toBe(true);
    for (const button of toolbarButtons) {
      const tooltips = lumine.tooltips.findTooltips(button);
      expect(tooltips.length).toBe(1);
      expect(tooltips[0].options.keyBindingCommand).toBe(button.dataset.command);
      expect(tooltips[0].options.keyBindingTarget).toBe(button);
      expect(tooltips[0].options.title.call(button)).toContain(button.getAttribute("aria-label"));
    }
    const fitButton = toolbar.querySelector('[data-command="graviss:fit-view"]');
    expect(lumine.tooltips.findTooltips(fitButton)[0].options.title.call(fitButton)).toContain(
      '<span class="keystroke">F</span>',
    );
    expect(previousGraphic.querySelector('[data-icon="previous-graphic"]')).not.toBeNull();
    expect(nextGraphic.querySelector('[data-icon="next-graphic"]')).not.toBeNull();
    expect(previousGraphic.closest(".btn-group")).toBe(nextGraphic.closest(".btn-group"));
    expect(toolbar.querySelector('[data-visible="nodes"] [data-icon="nodes"]')).not.toBeNull();
    expect(item.element.querySelector(".graviss-graphic-actions").getAttribute("aria-label")).toBe(
      "3D overview, graphic 1 of 3",
    );
    expect(graphicCounter.textContent).toBe("1/3");
    expect(graphicCounter.dataset.tooltip).toBe("3D overview");
    expect(lumine.tooltips.findTooltips(graphicCounter).length).toBe(1);
    // The renderer may already have drawn a frame by this point \u2014 whether it
    // has depends on how fast requestAnimationFrame runs in the test window \u2014
    // so the idle reading is asserted from an explicit reset rather than from
    // whatever the meter happens to be showing.
    item.updateFrameRate(null);
    expect(frameRateCounter.textContent).toBe("\u2014 FPS");
    expect(frameRateCounter.dataset.active).toBe("false");
    expect(lumine.tooltips.findTooltips(frameRateCounter).length).toBe(1);
    item.updateFrameRate(59.6);
    expect(frameRateCounter.textContent).toBe("60 FPS");
    expect(frameRateCounter.dataset.active).toBe("true");
    expect(frameRateCounter.getAttribute("aria-label")).toBe(
      "Render frame rate 60 frames per second",
    );
    item.updateFrameRate(null);
    expect(frameRateCounter.textContent).toBe("\u2014 FPS");
    expect(frameRateCounter.dataset.active).toBe("false");
    expect(lumine.tooltips.findTooltips(viewCube).length).toBe(1);
    expect(
      [...item.element.querySelectorAll("[title]")].every(
        (element) => !element.getAttribute("title"),
      ),
    ).toBe(true);

    previousGraphic.click();
    expect(item.activeGraphic.id).toBe("frame-elevation");
    expect(graphicCounter.textContent).toBe("3/3");
    expect(item.element.querySelector(".graviss-graphic-actions").getAttribute("aria-label")).toBe(
      "Frame elevation, graphic 3 of 3",
    );
    nextGraphic.click();
    expect(item.activeGraphic.id).toBe("overview");
    nextGraphic.click();
    expect(item.activeGraphic.id).toBe("plan");
    expect(graphicCounter.textContent).toBe("2/3");
    expect(item.element.querySelector(".graviss-graphic-actions").getAttribute("aria-label")).toBe(
      "Roof plan, graphic 2 of 3",
    );
    expect(item.element.dataset.appearance).toBe("paper");
    const backgroundButton = item.element.querySelector('[data-action="background"]');
    expect(
      backgroundButton.closest(".block").classList.contains("graviss-background-control"),
    ).toBe(true);
    expect(backgroundButton.querySelector('[data-icon="background"]')).not.toBeNull();
    expect(backgroundButton.dataset.appearance).toBe("paper");
    expect(toolbar.querySelectorAll('[data-action="background"]').length).toBe(1);
    expect(toolbar.querySelector("[data-appearance-option]")).toBeNull();
    expect(item.backgroundList).toBeNull();
    backgroundButton.click();
    expect(item.backgroundList.isVisible()).toBe(true);
    expect(backgroundButton.getAttribute("aria-expanded")).toBe("true");
    expect(item.backgroundList.items.map(({ id }) => id)).toEqual([
      "auto",
      "cloud",
      "midnight",
      "paper",
      "white",
    ]);
    const whiteBackgroundList = item.backgroundList;
    item.backgroundList.selectIndex(4);
    item.backgroundList.confirmSelection();
    expect(item.element.dataset.appearance).toBe("white");
    expect(item.backgroundList).toBeNull();
    expect(whiteBackgroundList.destroyed).toBe(true);
    expect(backgroundButton.getAttribute("aria-expanded")).toBe("false");
    expect(backgroundButton.dataset.appearance).toBe("white");
    backgroundButton.click();
    item.backgroundList.selectIndex(3);
    item.backgroundList.confirmSelection();
    expect(item.element.dataset.appearance).toBe("paper");
    expect(item.renderer.projection).toBe("orthographic");
    expect(
      item.element.querySelector('[data-projection="orthographic"]').classList.contains("selected"),
    ).toBe(true);
    expect(
      Math.hypot(
        item.renderer.camera.position.x - 4,
        item.renderer.camera.position.y - 5,
        item.renderer.camera.position.z - 25,
      ),
    ).toBeLessThan(1e-4);
    expect(item.renderer.meshes.nodes.visible).toBe(false);
    expect(item.element.querySelector('[data-visible="nodes"]').getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(
      item.element.querySelector('[data-visible="nodes"]').classList.contains("selected"),
    ).toBe(false);
    const nodesButton = item.element.querySelector('[data-visible="nodes"]');
    expect(lumine.tooltips.findTooltips(nodesButton)[0].options.title.call(nodesButton)).toContain(
      "Show nodes",
    );
    item.element.querySelector('[data-view="top"]').click();
    expect(item.renderer.camera.up.toArray()).toEqual([0, 0, 1]);
    item.renderer.controls.rotateUp(-0.35);
    const polarZBefore = normalizedCameraZ(item.renderer);
    item.renderer.controls.rotateLeft(0.6);
    expect(normalizedCameraZ(item.renderer)).toBeCloseTo(polarZBefore, 10);
    expect(item.renderer.camera.up.toArray()).toEqual([0, 0, 1]);
    item.element.querySelector('[data-projection="perspective"]').click();
    expect(item.renderer.projection).toBe("perspective");
    expect(
      item.element.querySelector('[data-projection="perspective"]').classList.contains("selected"),
    ).toBe(true);
    expect(item.isModified()).toBe(true);
    expect(item.shouldPromptToSave()).toBe(true);
    expect(item.serialize().viewDocument.data.activeGraphicId).toBe("plan");
    expect(item.serialize().viewDocument.data.graphics[1].camera.projection).toBe("perspective");

    const restored = mainModule.deserialize(item.serialize());
    expect(restored instanceof GravissView).toBe(true);
    expect(restored.getURI()).toBe(MAIN_EXAMPLE_URI);
    expect(restored.activeGraphic.id).toBe("plan");
    expect(restored.serialize().activeGraphicId).toBe("plan");
    expect(restored.isModified()).toBe(true);
    restored.destroy();
  });

  it("renders signed model coordinates without rewriting them", async () => {
    const geometry = createFrameGeometry();
    const session = {
      async describe() {
        return {
          model: {
            id: "downward-z",
            title: "Downward Z model",
            source: "Spec fixture",
            coordinateSystem: { upAxis: "-z", handedness: "right", gravityAxis: "+z" },
          },
          capabilities: { geometry: { elementKinds: ["beam"], supports: true } },
        };
      },
      async getGeometry() {
        return geometry;
      },
      dispose() {},
    };
    const item = mainModule.createViewer(session, { title: "Downward Z model" });

    try {
      await conditionPromise(
        () => item.renderer != null || !item.element.querySelector(".graviss-error").hidden,
        "the downward-Z model to initialize",
      );
      expect(item.renderer).not.toBeNull();
      expect(item.geometry.nodes[3]).toEqual(jasmine.objectContaining({ x: 4, y: 0, z: 7 }));
      expect(item.renderer.coordinateSystem.upAxis).toBe("-z");
      expect(item.renderer.worldUp.toArray()).toEqual([0, 0, -1]);

      item.renderer.setStandardView("top");
      const cameraDirection = item.renderer.camera.position
        .clone()
        .sub(item.renderer.controls.target)
        .normalize();
      expect(cameraDirection.z).toBeCloseTo(-1, 6);
      expect(item.renderer.camera.up.toArray()).toEqual([0, 0, -1]);
      const cameraInverse = item.renderer.camera.quaternion.clone().invert();
      const screenX = new item.renderer.THREE.Vector3(1, 0, 0).applyQuaternion(cameraInverse);
      const screenUp = new item.renderer.THREE.Vector3(0, -1, 0).applyQuaternion(cameraInverse);
      expect(screenX.x).toBeGreaterThan(0);
      expect(screenX.y).toBeCloseTo(0, 6);
      expect(screenUp.x).toBeCloseTo(0, 6);
      expect(screenUp.y).toBeGreaterThan(0);

      item.renderer.applyCameraState({
        projection: "orthographic",
        position: [4, 0, -10],
        target: [4, 0, 0],
        up: [0, -1, 0],
        frustumHeight: 10,
      });
      const restoredInverse = item.renderer.camera.quaternion.clone().invert();
      const restoredX = new item.renderer.THREE.Vector3(1, 0, 0).applyQuaternion(restoredInverse);
      const restoredUp = new item.renderer.THREE.Vector3(0, -1, 0).applyQuaternion(restoredInverse);
      expect(restoredX.y).toBeCloseTo(0, 6);
      expect(restoredUp.x).toBeCloseTo(0, 6);
      expect(restoredUp.y).toBeGreaterThan(0);

      const supportMatrix = new item.renderer.THREE.Matrix4();
      const supportPosition = new item.renderer.THREE.Vector3();
      item.renderer.meshes.supports.getMatrixAt(0, supportMatrix);
      supportPosition.setFromMatrixPosition(supportMatrix);
      expect(supportPosition.x).toBe(0);
      expect(supportPosition.y).toBe(0);
      expect(supportPosition.z).toBeCloseTo(0.27, 6);
    } finally {
      item.destroy();
    }
  });

  it("renders section profiles and element-local axes", async () => {
    const geometry = {
      nodes: [
        { id: 1, x: 0, y: 0, z: 0 },
        { id: 2, x: 4, y: 0, z: 0 },
      ],
      sections: [
        {
          id: "R1",
          name: "200 x 300",
          area: 0.06,
          shape: { kind: "rectangle", width: 0.2, height: 0.3 },
        },
      ],
      elements: [
        {
          id: 10,
          kind: "beam",
          nodeIds: [1, 2],
          sectionId: "R1",
          localAxes: { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
        },
      ],
      supports: [],
    };
    const session = {
      async describe() {
        return {
          model: {
            id: "sections",
            title: "Section rendering",
            source: "Spec",
            coordinateSystem: { upAxis: "z", handedness: "right" },
          },
          capabilities: {
            geometry: {
              elementKinds: ["beam"],
              supports: false,
              sections: true,
              localAxes: true,
            },
          },
        };
      },
      async getGeometry() {
        return geometry;
      },
      dispose() {},
    };
    const item = mainModule.createViewer(session, { title: "Section rendering" });
    jasmine.attachToDOM(item.element);
    await conditionPromise(() => item.renderer != null, "the section scene to initialize");

    const memberMesh = item.renderer.pickables.find(
      (mesh) => mesh.userData.gravissColorKey === "element",
    );
    expect(item.getGeometrySummary()).toEqual({
      nodes: 2,
      members: 1,
      shells: 0,
      supports: 0,
      sections: 1,
    });
    expect(memberMesh.geometry.type).toBe("BoxGeometry");
    // An instanced geometry carries no colour attribute. Declaring vertex
    // colours anyway makes the vertex shader read that missing attribute as
    // black and swallow the instance colour, which renders every member, node
    // and support as a black silhouette.
    for (const mesh of [memberMesh, item.renderer.meshes.nodes, item.renderer.meshes.supports]) {
      if (!mesh) continue;
      expect(mesh.isInstancedMesh).toBe(true);
      expect(mesh.geometry.getAttribute("color")).toBeUndefined();
      expect(mesh.material.vertexColors).toBe(false);
      expect(mesh.instanceColor).not.toBeNull();
    }
    const sectionCases = [
      [{ kind: "tube", diameter: 0.4, thickness: 0.02 }, [1, 0.4, 0.4]],
      [
        {
          kind: "tee",
          webWidth: 0.1,
          height: 0.5,
          flangeWidth: 0.3,
          flangeThickness: 0.08,
        },
        [1, 0.3, 0.5],
      ],
      [
        {
          kind: "polygon",
          points: [
            [-0.2, -0.1],
            [0.2, -0.1],
            [0.1, 0.15],
            [-0.1, 0.15],
          ],
        },
        [1, 0.4, 0.25],
      ],
    ];
    for (const [shape, expectedSize] of sectionCases) {
      const sectionGeometry = item.renderer.createSectionGeometry(shape);
      sectionGeometry.computeBoundingBox();
      const size = sectionGeometry.boundingBox.getSize(new item.renderer.THREE.Vector3());
      expect(size.x).toBeCloseTo(expectedSize[0], 6);
      expect(size.y).toBeCloseTo(expectedSize[1], 6);
      expect(size.z).toBeCloseTo(expectedSize[2], 6);
      sectionGeometry.dispose();
    }
    expect(item.renderer.localAxes.visible).toBe(false);
    item.setVisibility("localAxes", true);
    expect(item.renderer.localAxes.visible).toBe(true);
    expect(item.element.querySelector('[data-visible="localAxes"]').classList).toContain(
      "selected",
    );
    // Local axes sit at the element centres and are geometry like any other, so
    // an opaque section in front of one has to hide it.
    expect(item.renderer.localAxes.material.depthTest).toBe(true);

    // A member is drawn at whichever level the detail cycle is on, and an area
    // element only gains its thickness at the last one. The toolbar button
    // shows the level on screen.
    const detailButton = item.element.querySelector('[data-action="element-detail"]');
    expect(item.getElementDetail()).toBe("section");
    expect(detailButton.dataset.detail).toBe("section");
    expect(item.cycleElementDetail()).toBe("full");
    expect(detailButton.dataset.detail).toBe("full");
    expect(detailButton.getAttribute("aria-label")).toBe("Draw elements as full");
    expect(item.cycleElementDetail()).toBe("axis");
    expect(detailButton.dataset.detail).toBe("axis");
    expect(
      item.renderer.pickables.find((mesh) => mesh.userData.gravissColorKey === "element").geometry
        .type,
    ).toBe("CylinderGeometry");
    expect(item.setElementDetail("section")).toBe("section");

    const matrix = new item.renderer.THREE.Matrix4();
    const position = new item.renderer.THREE.Vector3();
    item.renderer.meshes.nodes.getMatrixAt(0, matrix);
    position.setFromMatrixPosition(matrix);
    expect(position.toArray()).toEqual([0, 0, 0]);
    item.destroy();
  });

  it("debounces wheel zoom into one camera history snapshot", async () => {
    const item = await lumine.workspace.open(MAIN_EXAMPLE_URI, { searchAllPanes: true });
    await conditionPromise(
      () => item.renderer != null || !item.element.querySelector(".graviss-error").hidden,
      "the Three.js scene to initialize",
    );
    const renderedError = item.element.querySelector(".graviss-error-message").textContent;
    if (!item.renderer) fail(`Renderer initialization failed: ${renderedError}`);

    const updateCamera = spyOn(item, "updateCamera").and.callThrough();
    const canvas = item.renderer.canvasRenderer.domElement;
    for (let index = 0; index < 4; index += 1) {
      canvas.dispatchEvent(
        new window.WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          clientX: 120,
          clientY: 90,
          deltaY: 100,
        }),
      );
    }

    expect(updateCamera).not.toHaveBeenCalled();
    expect(item.isModified()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(updateCamera).toHaveBeenCalledTimes(1);
    expect(item.isModified()).toBe(true);
    expect(item.canUndo()).toBe(true);

    expect(item.undo()).toBe(true);
    expect(item.isModified()).toBe(false);
    for (let index = 0; index < 2; index += 1) {
      canvas.dispatchEvent(
        new window.WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          clientX: 120,
          clientY: 90,
          deltaY: -100,
        }),
      );
    }
    expect(updateCamera).toHaveBeenCalledTimes(1);
    const serialized = item.serialize();
    expect(updateCamera).toHaveBeenCalledTimes(2);
    expect(serialized.viewDocument.data.graphics[0].camera).toEqual(
      item.renderer.captureCameraState(),
    );
  });

  it("serializes modified canvas state without prompting during window shutdown", async () => {
    const item = await lumine.workspace.open(MAIN_EXAMPLE_URI, { searchAllPanes: true });
    await conditionPromise(
      () => item.renderer != null || !item.element.querySelector(".graviss-error").hidden,
      "the Three.js scene to initialize",
    );
    const renderedError = item.element.querySelector(".graviss-error-message").textContent;
    if (!item.renderer) fail(`Renderer initialization failed: ${renderedError}`);

    item.setAppearance("midnight");
    const stateStoreConnected = spyOn(lumine.stateStore, "isConnected").and.returnValue(true);

    expect(item.shouldPromptToSave()).toBe(true);
    expect(item.shouldPromptToSave({ windowCloseRequested: true, projectHasPaths: true })).toBe(
      false,
    );
    expect(item.shouldPromptToSave({ windowCloseRequested: true, projectHasPaths: false })).toBe(
      true,
    );
    stateStoreConnected.and.returnValue(false);
    expect(item.shouldPromptToSave({ windowCloseRequested: true, projectHasPaths: true })).toBe(
      true,
    );

    stateStoreConnected.and.returnValue(true);
    const serialized = item.serialize();
    expect(serialized.viewDocument.modified).toBe(true);
    expect(serialized.viewDocument.data.graphics[0].appearance).toBe("midnight");
    const restored = mainModule.deserialize(serialized);
    expect(restored.isModified()).toBe(true);
    expect(restored.appearance).toBe("midnight");
    restored.destroy();

    spyOn(item, "isInConflict").and.returnValue(true);
    expect(item.shouldPromptToSave({ windowCloseRequested: true, projectHasPaths: true })).toBe(
      true,
    );
  });

  it("exposes viewer actions as commands only inside a Graviss pane", async () => {
    const item = await lumine.workspace.open(MAIN_EXAMPLE_URI, { searchAllPanes: true });
    await conditionPromise(
      () => item.renderer != null || !item.element.querySelector(".graviss-error").hidden,
      "the Three.js scene to initialize",
    );
    const renderedError = item.element.querySelector(".graviss-error-message").textContent;
    if (!item.renderer) fail(`Renderer initialization failed: ${renderedError}`);

    const viewerCommandNames = new Set(
      lumine.commands.findCommands({ target: item.element }).map(({ name }) => name),
    );
    const workspaceCommandNames = new Set(
      lumine.commands
        .findCommands({ target: lumine.workspace.getElement() })
        .map(({ name }) => name),
    );
    for (const button of item.element.querySelectorAll("button[data-command]")) {
      expect(viewerCommandNames).toContain(button.dataset.command);
    }
    for (const viewId of CAMERA_VIEW_IDS) {
      expect(viewerCommandNames).toContain(`graviss:view-${viewId}`);
    }
    for (const appearance of ["auto", ...APPEARANCE_IDS]) {
      expect(viewerCommandNames).toContain(`graviss:background-${appearance}`);
    }
    for (const commandName of [
      "graviss:move-left",
      "graviss:move-right",
      "graviss:move-up",
      "graviss:move-down",
      "graviss:rotate-left",
      "graviss:rotate-right",
      "graviss:rotate-up",
      "graviss:rotate-down",
      "graviss:zoom-in",
      "graviss:zoom-out",
    ]) {
      expect(viewerCommandNames).toContain(commandName);
    }
    expect(viewerCommandNames).toContain("graviss:toggle-projection");
    expect(viewerCommandNames).toContain("graviss:activate-graphic");
    expect(workspaceCommandNames).not.toContain("graviss-meshio:open-example");
    expect(workspaceCommandNames).toContain("graviss:open-source");
    expect(workspaceCommandNames).not.toContain("graviss:fit-view");
    expect(workspaceCommandNames).not.toContain("graviss:next-graphic");

    lumine.commands.dispatch(lumine.workspace.getElement(), "graviss:next-graphic");
    expect(item.activeGraphic.id).toBe("overview");
    const escapedCommand = jasmine.createSpy("escapedCommand");
    const outerCommand = lumine.commands.add(
      "lumine-workspace",
      "graviss:next-graphic",
      escapedCommand,
    );
    const dispatchCommand = spyOn(item, "dispatchCommand").and.callThrough();
    item.element.querySelector('[data-action="next-graphic"]').click();
    expect(dispatchCommand).toHaveBeenCalledWith("graviss:next-graphic");
    expect(item.activeGraphic.id).toBe("plan");
    expect(escapedCommand).not.toHaveBeenCalled();
    outerCommand.dispose();

    const cameraPositionBeforeCubeClick = item.renderer.camera.position.toArray();
    const updateCamera = spyOn(item, "updateCamera").and.callThrough();
    item.renderer.viewCube.onSelect("back");
    expect(dispatchCommand).toHaveBeenCalledWith("graviss:view-back", { animate: true });
    expect(item.renderer.viewCube.selectedView).toBe("back");
    expect(item.renderer.cameraAnimationFrame).not.toBeNull();
    expect(item.renderer.camera.position.toArray()).toEqual(cameraPositionBeforeCubeClick);
    await conditionPromise(
      () => item.renderer.cameraAnimationFrame == null,
      "the view-cube camera animation to finish",
    );
    const cameraOffset = item.renderer.camera.position.clone().sub(item.renderer.controls.target);
    cameraOffset.normalize();
    expect(cameraOffset.x).toBeCloseTo(0, 10);
    expect(cameraOffset.y).toBeCloseTo(1, 10);
    expect(cameraOffset.z).toBeCloseTo(0, 10);
    expect(updateCamera).toHaveBeenCalledTimes(1);
    expect(
      item.serialize().viewDocument.data.graphics.find(({ id }) => id === item.activeGraphic.id)
        .camera,
    ).toEqual(item.renderer.captureCameraState());
    lumine.commands.dispatch(item.element, "graviss:toggle-nodes");
    expect(item.renderer.meshes.nodes.visible).toBe(true);
    lumine.commands.dispatch(item.element, "graviss:background-midnight");
    expect(item.element.dataset.appearance).toBe("midnight");
  });

  it("moves, rotates, and zooms through pane-scoped keyboard commands", async () => {
    const item = await lumine.workspace.open(MAIN_EXAMPLE_URI, { searchAllPanes: true });
    await conditionPromise(
      () => item.renderer != null || !item.element.querySelector(".graviss-error").hidden,
      "the Three.js scene to initialize",
    );
    const renderedError = item.element.querySelector(".graviss-error-message").textContent;
    if (!item.renderer) fail(`Renderer initialization failed: ${renderedError}`);

    const keystrokesFor = (command) =>
      lumine.keymaps
        .findKeyBindings({ command, target: item.renderer.canvasRenderer.domElement })
        .map(({ keystrokes }) => keystrokes)
        .sort();
    expect(keystrokesFor("graviss:move-left")).toEqual(["left"]);
    expect(keystrokesFor("graviss:move-right")).toEqual(["right"]);
    expect(keystrokesFor("graviss:move-up")).toEqual(["up"]);
    expect(keystrokesFor("graviss:move-down")).toEqual(["down"]);
    const commandModifier = process.platform === "darwin" ? "cmd" : "ctrl";
    expect(keystrokesFor("graviss:rotate-left")).toEqual([`${commandModifier}-left`]);
    expect(keystrokesFor("graviss:rotate-right")).toEqual([`${commandModifier}-right`]);
    expect(keystrokesFor("graviss:rotate-up")).toEqual([`${commandModifier}-up`]);
    expect(keystrokesFor("graviss:rotate-down")).toEqual([`${commandModifier}-down`]);
    expect(keystrokesFor("graviss:zoom-in")).toEqual(["+", "="]);
    expect(keystrokesFor("graviss:zoom-out")).toEqual(["-", "_"]);
    expect(keystrokesFor("graviss:previous-graphic")).toEqual(["["]);
    expect(keystrokesFor("graviss:next-graphic")).toEqual(["]"]);
    expect(keystrokesFor("graviss:fit-view")).toEqual(["f"]);
    expect(keystrokesFor("graviss:view-isometric")).toEqual(["i"]);
    expect(keystrokesFor("graviss:view-top")).toEqual(["t"]);
    expect(keystrokesFor("graviss:view-front")).toEqual(["e"]);
    expect(keystrokesFor("graviss:view-right")).toEqual(["r"]);
    expect(keystrokesFor("graviss:projection-perspective")).toEqual(["p"]);
    expect(keystrokesFor("graviss:projection-orthographic")).toEqual(["o"]);
    expect(keystrokesFor("graviss:toggle-members")).toEqual(["m"]);
    expect(keystrokesFor("graviss:toggle-shells")).toEqual(["s"]);
    expect(keystrokesFor("graviss:toggle-nodes")).toEqual(["n"]);
    expect(keystrokesFor("graviss:toggle-supports")).toEqual(["u"]);
    expect(keystrokesFor("graviss:toggle-mesh")).toEqual(["w"]);
    expect(keystrokesFor("graviss:toggle-grid")).toEqual(["g"]);
    expect(keystrokesFor("graviss:toggle-axes")).toEqual(["a"]);
    expect(keystrokesFor("graviss:toggle-local-axes")).toEqual(["l"]);
    expect(keystrokesFor("graviss:choose-background")).toEqual(["b"]);

    const updateCamera = spyOn(item, "updateCamera").and.callThrough();
    const initialOffset = item.renderer.camera.position.clone().sub(item.renderer.controls.target);
    const initialTarget = item.renderer.controls.target.clone();
    lumine.commands.dispatch(item.element, "graviss:move-left");
    const movedOffset = item.renderer.camera.position.clone().sub(item.renderer.controls.target);
    expect(item.renderer.controls.target.equals(initialTarget)).toBe(false);
    expect(movedOffset.distanceTo(initialOffset)).toBeLessThan(1e-8);

    const targetBeforeRotation = item.renderer.controls.target.clone();
    const positionBeforeRotation = item.renderer.camera.position.clone();
    lumine.commands.dispatch(item.element, "graviss:rotate-left");
    expect(item.renderer.controls.target.distanceTo(targetBeforeRotation)).toBeLessThan(1e-8);
    expect(item.renderer.camera.position.distanceTo(positionBeforeRotation)).toBeGreaterThan(0.1);

    const distanceBeforeZoom = item.renderer.camera.position.distanceTo(
      item.renderer.controls.target,
    );
    lumine.commands.dispatch(item.element, "graviss:zoom-in");
    const distanceAfterZoomIn = item.renderer.camera.position.distanceTo(
      item.renderer.controls.target,
    );
    expect(distanceAfterZoomIn).toBeLessThan(distanceBeforeZoom);
    lumine.commands.dispatch(item.element, "graviss:zoom-out");
    expect(item.renderer.camera.position.distanceTo(item.renderer.controls.target)).toBeCloseTo(
      distanceBeforeZoom,
      8,
    );

    expect(updateCamera).toHaveBeenCalledTimes(4);
    expect(item.serialize().viewDocument.data.graphics[0].camera).toEqual(
      item.renderer.captureCameraState(),
    );
  });

  it("renders the large quadrilateral shell example as one pickable surface", async () => {
    const item = await lumine.workspace.open(SHELL_EXAMPLE_URI, { searchAllPanes: true });
    await conditionPromise(
      () => item.renderer != null || !item.element.querySelector(".graviss-error").hidden,
      "the shell scene to initialize",
    );
    const renderedError = item.element.querySelector(".graviss-error-message").textContent;
    if (!item.renderer) fail(`Shell renderer initialization failed: ${renderedError}`);

    expect(item.getTitle()).toBe(SHELL_EXAMPLE.title);
    expect(item.renderer.getSceneSummary()).toEqual({
      members: 0,
      shells: 4900,
      nodes: 5041,
      supports: 4,
      pickables: 3,
    });
    expect(item.renderer.meshes.members).toBeUndefined();
    expect(item.renderer.meshes.shells.isMesh).toBe(true);
    expect(item.renderer.meshes.shells.userData.gravissEntityRanges.length).toBe(4900);
    expect([...item.renderer.meshes.shells.userData.gravissFaceToEntityIndex.slice(0, 4)]).toEqual([
      0, 0, 1, 1,
    ]);
    expect(item.renderer.meshes.shells.geometry.getAttribute("position").count).toBe(29400);
    expect(item.renderer.meshes.nodes.visible).toBe(false);
    expect(item.element.querySelector('[data-visible="shells"]').getAttribute("aria-pressed")).toBe(
      "true",
    );

    // Mesh lines are a layer of their own over the surfaces they describe.
    const edges = item.renderer.meshes.shells.userData.gravissEdges;
    expect(item.renderer.meshes.mesh).toBe(edges);
    expect(edges.visible).toBe(true);
    expect(item.setVisibility("mesh", false)).toBe(false);
    expect(edges.visible).toBe(false);
    expect(item.renderer.meshes.shells.visible).toBe(true);
    expect(item.element.querySelector('[data-visible="mesh"]').getAttribute("aria-pressed")).toBe(
      "false",
    );

    // At axis level the same segments are the element itself rather than a mesh
    // drawn over one, so the switch leaves them alone and nothing disappears.
    expect(item.setElementDetail("axis")).toBe("axis");
    const axisEdges = item.renderer.meshes.shells.userData.gravissEdges;
    expect(axisEdges.visible).toBe(true);
    expect(item.renderer.meshes.shells.material.visible).toBe(false);
    expect(item.setElementDetail("section")).toBe("section");
    expect(item.renderer.meshes.shells.userData.gravissEdges.visible).toBe(false);
    expect(item.setVisibility("mesh", true)).toBe(true);
    expect(item.renderer.meshes.shells.userData.gravissEdges.visible).toBe(true);
  });

  it("opens .grv file paths as deduplicated canvas items and restores them", async () => {
    const item = await lumine.workspace.open(MAIN_EXAMPLE.viewDocumentPath, {
      searchAllPanes: true,
    });

    expect(item instanceof GravissView).toBe(true);
    expect(item.getURI()).toBe(MAIN_EXAMPLE.viewDocumentPath);
    expect(item.getPath()).toBe(MAIN_EXAMPLE.viewDocumentPath);
    expect(item.getTitle()).toBe(MAIN_EXAMPLE.title);
    expect(
      await lumine.workspace.open(MAIN_EXAMPLE.viewDocumentPath, { searchAllPanes: true }),
    ).toBe(item);

    const state = item.serialize();
    expect(state.uri).toBe(MAIN_EXAMPLE.viewDocumentPath);
    const restored = mainModule.deserialize(state);
    expect(restored instanceof GravissView).toBe(true);
    expect(restored.getURI()).toBe(MAIN_EXAMPLE.viewDocumentPath);
    restored.destroy();
  });

  it("opens an empty .grv file as a fitted provider-backed canvas", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "graviss-empty-view-"));
    const viewPath = path.join(directory, "empty-model.grv");
    fs.writeFileSync(viewPath, "");
    const model = {
      id: "empty-model",
      title: "Provider model",
      format: "Spec fixture",
      createGeometry: createFrameGeometry,
    };
    const registration = mainModule.consumeGravissSource({
      id: "spec-empty-model",
      createSession: ({ filePath }) => (filePath === viewPath ? new TestSession(model) : null),
    });
    let item;

    try {
      item = await lumine.workspace.open(viewPath, { searchAllPanes: true });
      await conditionPromise(
        () => item.renderer != null || !item.element.querySelector(".graviss-error").hidden,
        "the empty Graviss view to initialize",
      );

      expect(item instanceof GravissView).toBe(true);
      expect(item.renderer).not.toBeNull();
      expect(item.getTitle()).toBe("empty-model");
      expect(item.viewDocument.isImplicit()).toBe(true);
      expect(item.isModified()).toBe(false);
      expect(item.renderer.controls.target.toArray()).toEqual([4, 5, 3.5]);

      item.toggleVisibility("grid");
      expect(item.viewDocument.isImplicit()).toBe(false);
      expect(item.isModified()).toBe(true);
      expect(JSON.parse(item.viewDocument.getSourceBuffer().getText()).format).toBe("graviss-view");
    } finally {
      registration.dispose();
      if (item) await lumine.workspace.paneForItem(item)?.destroyItem(item, true);
      await new Promise((resolve) => setTimeout(resolve, 50));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses the last active graphic stored by the view document when reopening", () => {
    const first = createFixtureViewer(MAIN_EXAMPLE);
    first.activateGraphic("plan");
    const viewDocumentState = first.serialize().viewDocument;
    first.destroy();

    const reopened = createFixtureViewer(MAIN_EXAMPLE, { viewDocumentState });
    expect(reopened.activeGraphic.id).toBe("plan");
    expect(reopened.serialize().viewDocument.data.activeGraphicId).toBe("plan");
    reopened.destroy();
  });

  it("terminates pending state when a view becomes modified", async () => {
    const item = await lumine.workspace.open(MAIN_EXAMPLE.viewDocumentPath, {
      pending: true,
      searchAllPanes: true,
    });
    const pane = lumine.workspace.paneForItem(item);
    const didTerminate = jasmine.createSpy("didTerminate");
    item.onDidTerminatePendingState(didTerminate);

    expect(pane.getPendingItem()).toBe(item);
    expect(item.isModified()).toBe(false);

    item.activateGraphic("plan");

    expect(item.isModified()).toBe(true);
    expect(pane.getPendingItem()).toBeNull();
    expect(didTerminate).toHaveBeenCalledTimes(1);

    item.activateGraphic("frame-elevation");
    expect(didTerminate).toHaveBeenCalledTimes(1);
  });

  it("routes Lumine undo and redo commands to the active view document", async () => {
    const item = await lumine.workspace.open(MAIN_EXAMPLE.viewDocumentPath, {
      searchAllPanes: true,
    });

    expect(item.activeGraphic.id).toBe("overview");
    item.activateGraphic("plan");
    expect(item.activeGraphic.id).toBe("plan");
    expect(item.canUndo()).toBe(true);

    lumine.commands.dispatch(item.element, "core:undo");
    expect(item.activeGraphic.id).toBe("overview");
    expect(item.isModified()).toBe(false);
    expect(item.canRedo()).toBe(true);

    lumine.commands.dispatch(item.element, "core:redo");
    expect(item.activeGraphic.id).toBe("plan");
    expect(item.isModified()).toBe(true);
  });

  it("reserves the viewport context menu gesture for right-button panning", async () => {
    const item = await lumine.workspace.open(MAIN_EXAMPLE.viewDocumentPath, {
      searchAllPanes: true,
    });
    const workspaceElement = lumine.workspace.getElement();
    const bubbled = jasmine.createSpy("context menu bubbled");
    workspaceElement.addEventListener("contextmenu", bubbled);

    try {
      const viewportEvent = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
      });
      item.element.querySelector(".graviss-canvas-host").dispatchEvent(viewportEvent);

      expect(viewportEvent.defaultPrevented).toBe(true);
      expect(bubbled).not.toHaveBeenCalled();

      item.element
        .querySelector(".graviss-toolbar")
        .dispatchEvent(
          new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }),
        );
      expect(bubbled).toHaveBeenCalledTimes(1);
    } finally {
      workspaceElement.removeEventListener("contextmenu", bubbled);
    }
  });

  it("opens a selected .grv source in a JSON editor without invoking the canvas opener", async () => {
    await lumine.packages.activatePackage("language-json");
    const canvas = await lumine.workspace.open(MAIN_EXAMPLE.viewDocumentPath, {
      searchAllPanes: true,
    });
    const tree = document.createElement("div");
    tree.className = "tree-view";
    const file = document.createElement("div");
    file.className = "file";
    file.dataset.path = MAIN_EXAMPLE.viewDocumentPath;
    tree.appendChild(file);
    const treeDisposable = mainModule.consumeTreeViewSelection({
      selectedPaths: () => [MAIN_EXAMPLE.viewDocumentPath],
    });

    const editor = await mainModule.openSourceCommand({ target: file });

    expect(canvas instanceof GravissView).toBe(true);
    expect(lumine.workspace.isTextEditor(editor)).toBe(true);
    expect(editor).not.toBe(canvas);
    expect(editor.getPath()).toBe(MAIN_EXAMPLE.viewDocumentPath);
    expect(editor.getGrammar().scopeName).toBe("source.json");
    expect(editor.getText()).toContain('"format": "graviss-view"');
    expect(await mainModule.openSource(MAIN_EXAMPLE.viewDocumentPath)).toBe(editor);

    treeDisposable.dispose();
    await lumine.workspace.paneForItem(editor).destroyItem(editor, true);
  });

  it("declares its workspace commands and tree-view context menu", () => {
    const manifest = require("../package.json");
    const menus = require("../menus/graviss.json");
    const contextItems = menus["context-menu"]['.tree-view .file[data-path$=".grv"]'];
    const commands = lumine.commands
      .findCommands({ target: lumine.workspace.getElement() })
      .map(({ name }) => name);

    expect(manifest.activationCommands).toBeUndefined();
    expect(manifest.consumedServices["tree-view.selection"]).toBeDefined();
    expect(commands).toContain("graviss:open-source");
    expect(menus.menu[0].submenu[0].submenu).toContain(
      jasmine.objectContaining({ label: "Open Source", command: "graviss:open-source" }),
    );
    expect(contextItems).toContain(
      jasmine.objectContaining({ label: "Open Source", command: "graviss:open-source" }),
    );
  });

  it("consumes source providers and owns viewer creation itself", () => {
    const calls = [];
    const session = {
      async describe() {
        calls.push("describe");
        return {
          model: {
            id: "service-model",
            title: "Service Model",
            source: "Spec provider",
            coordinateSystem: { upAxis: "z" },
          },
          capabilities: { geometry: true },
        };
      },
      async getGeometry() {
        calls.push("getGeometry");
        return createMain1Geometry();
      },
      dispose() {
        calls.push("dispose");
      },
    };
    expect(mainModule.provideGraviss).toBeUndefined();
    expect(mainModule.registerSourceProvider).toBeUndefined();

    const viewer = mainModule.createViewer(session, { title: "Service Test" });
    expect(viewer instanceof GravissView).toBe(true);
    expect(viewer.getTitle()).toBe("Service Test");
    expect(viewer.serialize()).toBeNull();
    expect(viewer.element.querySelector(".graviss-graphic-actions").hidden).toBe(true);
    viewer.destroy();
    expect(calls[0]).toBe("describe");
    expect(calls).toContain("dispose");
  });

  it("rejects a malformed graviss.source provider", () => {
    expect(() => mainModule.consumeGravissSource({ createSession() {} })).toThrowError(
      /provider\.id/,
    );
    expect(() => mainModule.consumeGravissSource({ id: "broken" })).toThrowError(/createSession/);
  });

  it("reloads the model when a source reports that it changed", async () => {
    let notify = null;
    const model = {
      id: "changing-model",
      title: "Changing model",
      format: "Spec fixture",
      createGeometry: createFrameGeometry,
    };
    const session = new TestSession(model);
    session.onDidChange = (callback) => {
      notify = callback;
      return { dispose: () => (notify = null) };
    };
    spyOn(session, "getGeometry").and.callThrough();
    const viewer = mainModule.createViewer(session, { title: "Changing" });
    try {
      await conditionPromise(() => viewer.renderer, "the model to load");
      expect(typeof notify).toBe("function");
      const geometryReads = session.getGeometry.calls.count();

      // Every scope Graviss understands rebuilds the scene, and the camera the
      // view document holds survives the rebuild.
      notify({ scope: "geometry" });
      await conditionPromise(
        () => session.getGeometry.calls.count() > geometryReads,
        "the model to reload after a geometry change",
      );

      const geometryReloads = session.getGeometry.calls.count();
      notify({ scope: "all" });
      await conditionPromise(
        () => session.getGeometry.calls.count() > geometryReloads,
        "the model to reload after a whole-source change",
      );

      expect(() => notify({ scope: "loadCases" })).toThrowError(/scope/);
      expect(() => notify({ scope: "everything" })).toThrowError(/scope/);
    } finally {
      viewer.destroy();
    }
    expect(notify).toBeNull();
  });

  it("provides named graphics to navigation-panel and activates selections", () => {
    const adapter = mainModule.provideNavigationAdapter();
    const viewer = createFixtureViewer(MAIN_EXAMPLE);
    const updates = [];

    expect(adapter.handlesItem(viewer)).toBe(true);
    expect(adapter.handlesItem({})).toBe(false);
    const disposable = adapter.observeHeaders(viewer, (headers, options) => {
      updates.push({ headers, options });
    });

    expect(updates[0].options).toEqual({ instant: true });
    expect(updates[0].headers.map(({ text }) => text)).toEqual([
      "3D overview",
      "Roof plan",
      "Frame elevation",
    ]);
    expect(updates[0].headers.find(({ currentCount }) => currentCount === 1).graphicId).toBe(
      "overview",
    );

    spyOn(viewer, "focus");
    const dispatchCommand = spyOn(viewer, "dispatchCommand").and.callThrough();
    expect(adapter.navigateTo(viewer, updates[0].headers[1], { focus: false })).toBe(true);
    expect(dispatchCommand).toHaveBeenCalled();
    const [commandName, detail] = dispatchCommand.calls.mostRecent().args;
    expect(commandName).toBe("graviss:activate-graphic");
    expect(detail.graphicId).toBe("plan");
    expect(detail.activated).toBe(true);
    expect(viewer.activeGraphic.id).toBe("plan");
    expect(viewer.focus).not.toHaveBeenCalled();
    expect(updates.at(-1).headers.find(({ currentCount }) => currentCount === 1).graphicId).toBe(
      "plan",
    );

    expect(adapter.navigateTo(viewer, updates[0].headers[2])).toBe(true);
    expect(viewer.activeGraphic.id).toBe("frame-elevation");
    expect(viewer.focus).toHaveBeenCalled();
    expect(adapter.navigateTo(viewer, { graphicId: "missing" })).toBe(false);

    const updateCount = updates.length;
    disposable.dispose();
    viewer.activateGraphic("overview");
    expect(updates.length).toBe(updateCount);
    viewer.destroy();
  });

  it("shows source errors inside the pane", async () => {
    const session = {
      async describe() {
        throw new Error("The engineering database is unavailable.");
      },
      async getGeometry() {
        return createMain1Geometry();
      },
      dispose: jasmine.createSpy("dispose"),
    };
    const viewer = mainModule.createViewer(session);
    await conditionPromise(
      () => !viewer.element.querySelector(".graviss-error").hidden,
      "the model error to appear",
    );
    expect(viewer.element.querySelector(".graviss-error-message").textContent).toContain(
      "database is unavailable",
    );
    viewer.destroy();
    expect(session.dispose).toHaveBeenCalled();
  });

  it("can dispose before a source finishes loading", async () => {
    let releaseDescribe;
    const session = {
      describe: () => new Promise((resolve) => (releaseDescribe = resolve)),
      getGeometry: jasmine.createSpy("getGeometry"),
      dispose: jasmine.createSpy("dispose"),
    };
    const viewer = mainModule.createViewer(session);
    viewer.destroy();
    releaseDescribe({});
    await Promise.resolve();
    expect(session.getGeometry).not.toHaveBeenCalled();
    expect(session.dispose).toHaveBeenCalled();
  });
});
