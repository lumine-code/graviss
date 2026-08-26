const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { FileState } = require("lumine");
const GravissView = require("../lib/graviss-view");
const { APPEARANCE_IDS, appearanceDefinition } = require("../lib/appearance");
const { CAMERA_VIEW_IDS } = require("../lib/camera-navigation");
const {
  FRAME_MODEL,
  SHELL_MODEL,
  TEST_MODELS,
  TestSession,
  createFrameGeometry,
} = require("./support/test-model");
const { entityIndexAtVertex } = require("../lib/renderer");
const { compileRules } = require("../lib/filter-rules");
const { buildSubjects, subjectsByKey } = require("../lib/filter-types");

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
      activeGraphic: options.activeGraphic ?? viewDocument.getData().activeGraphic,
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
        activeGraphic: 0,
        viewDocument: jasmine.objectContaining({
          filePath: MAIN_EXAMPLE.viewDocumentPath,
          fileState: FileState.UNMODIFIED,
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
    // Fills carry no polygon offset and lose depth ties instead: any sink,
    // however small, is worth its size over the dihedral wherever two bodies
    // graze — a tail of foreign mesh lines past the intersection, stretching
    // as the view flattens along it. Lines draw first and write true depth,
    // so the strict test is all a fill needs.
    // Members alone WIN ties: an eccentric girder's face lies exactly in the
    // slab's plane, where no strict test can put the flange over the slab's
    // mesh lines — and where the tie happens, the member is the physical
    // thing being looked at.
    const memberFill = item.renderer.memberMaterial;
    expect(memberFill.polygonOffset).toBe(false);
    expect(memberFill.depthFunc).toBe(item.renderer.THREE.LessEqualDepth);
    // The visibility chain, resolved with no epsilon anywhere: member fills
    // draw after the ordinary lines and win their ties, marking the pixels
    // they visibly claim in the stencil; the shell fill draws after them,
    // losing ties to its own lines and taking the mark back wherever it wins
    // a pixel; and the member contours draw last, only on marks that
    // survived — so an arris finishes exactly where the visible member
    // surface does, however thin a sliver of the body protrudes.
    const memberMeshes = item.renderer.meshes.members.children.filter((child) => child.isMesh);
    expect(memberMeshes.length).toBeGreaterThan(0);
    expect(memberMeshes.every((mesh) => mesh.renderOrder === 2)).toBe(true);
    // Instanced: the section once, the members as placements. A contour reads
    // the same matrix buffer its fill does, so the two evaluate an identical
    // transform and the arris needs no epsilon to win its tie.
    expect(memberMeshes.every((mesh) => mesh.isInstancedMesh)).toBe(true);
    expect(memberFill.stencilWrite).toBe(true);
    expect(memberFill.stencilRef).toBe(1);
    expect(memberFill.stencilZPass).toBe(item.renderer.THREE.ReplaceStencilOp);
    expect(item.renderer.memberContours.length).toBeGreaterThan(0);
    expect(
      item.renderer.memberContours.every(
        (contours) =>
          contours.renderOrder === 5 &&
          contours.material.transparent === false &&
          contours.material.depthWrite === true &&
          contours.material.stencilWrite === true &&
          contours.material.stencilWriteMask === 0 &&
          contours.material.stencilFunc === item.renderer.THREE.EqualStencilFunc &&
          contours.material.stencilRef === 1,
      ),
    ).toBe(true);
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
    // The toolbar takes no free text: every control is a button, a picker, or
    // the one number that sizes the marks.
    expect(toolbar.querySelector('input:not([type="number"])')).toBeNull();
    expect(toolbar.querySelector(".graviss-graphic-title")).toBeNull();
    const symbolInput = toolbar.querySelector(".graviss-symbol-input");
    expect(symbolInput).not.toBeNull();
    expect(symbolInput.getAttribute("aria-label")).toBe("Symbol size in millimetres");
    expect(symbolInput.min).toBe("0");
    expect(symbolInput.max).toBe("1000");
    // "any", not a number: a step constrains what counts as a valid value, and
    // a mark sized from the model is any length at all — a numeric step left
    // the field sitting in the browser's red :invalid state.
    expect(symbolInput.step).toBe("any");
    expect(symbolInput.validity.valid).toBe(true);
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
      toolbarButtons.map((button) => button.querySelector(".graviss-toolbar-icon").dataset.icon),
    ).toEqual([
      "previous-graphic",
      "next-graphic",
      "add-graphic",
      "delete-graphic",
      "fit",
      "isometric",
      "top",
      "front",
      "right",
      "perspective",
      "orthographic",
      "gradient",
      "background",
      "sections",
      "members",
      "shells",
      "nodes",
      "supports",
      "springs",
      "couplings",
      "mesh",
      "grid",
      "axes",
      "local-axes",
      "filter-panel",
      "results-panel",
      "save-image",
      "copy-image",
      "open-source",
    ]);
    // The bar is split by the scope a control acts at — the set of graphics,
    // the picture the active graphic composes, the layers inside it — with
    // everything document- or renderer-wide held apart in the tail.
    expect(
      [...toolbar.querySelectorAll(":scope > .graviss-toolbar-region")].map((region) =>
        region.getAttribute("aria-label"),
      ),
    ).toEqual(["Graphics", "Picture", "Layers", "Panels", "Output, document and renderer"]);
    const regionOf = (selector) =>
      toolbar.querySelector(selector).closest(".graviss-toolbar-region").getAttribute("aria-label");
    expect(regionOf('[data-action="add-graphic"]')).toBe("Graphics");
    expect(regionOf('[data-action="background"]')).toBe("Picture");
    expect(regionOf('[data-visible="members"]')).toBe("Layers");
    expect(regionOf(".graviss-symbol-input")).toBe("Layers");
    // The panels are their own region rather than part of the tail: a dock
    // surface is not output, not the document and not the renderer, and the
    // region is what pushes the whole right-hand run away from the controls
    // that compose the picture.
    expect(regionOf('[data-action="filter-panel"]')).toBe("Panels");
    expect(regionOf('[data-action="results-panel"]')).toBe("Panels");
    expect(regionOf('[data-action="save-as-image"]')).toBe("Output, document and renderer");
    expect(regionOf('[data-action="open-source"]')).toBe("Output, document and renderer");
    expect(toolbar.querySelector(".graviss-toolbar-tail .graviss-fps-counter")).not.toBeNull();
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
    const addGraphicButton = toolbar.querySelector('[data-action="add-graphic"]');
    const deleteGraphicButton = toolbar.querySelector('[data-action="delete-graphic"]');
    expect(addGraphicButton.closest(".btn-group")).toBe(deleteGraphicButton.closest(".btn-group"));
    expect(addGraphicButton.closest(".btn-group")).not.toBe(previousGraphic.closest(".btn-group"));
    expect(previousGraphic.disabled).toBe(false);
    expect(nextGraphic.disabled).toBe(false);
    expect(addGraphicButton.disabled).toBe(false);
    expect(deleteGraphicButton.disabled).toBe(false);
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
    expect(item.activeGraphic.title).toBe("Frame elevation");
    expect(graphicCounter.textContent).toBe("3/3");
    expect(item.element.querySelector(".graviss-graphic-actions").getAttribute("aria-label")).toBe(
      "Frame elevation, graphic 3 of 3",
    );
    nextGraphic.click();
    expect(item.activeGraphic.title).toBe("3D overview");
    nextGraphic.click();
    expect(item.activeGraphic.title).toBe("Roof plan");
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
    expect(item.getFileState()).toBe(FileState.MODIFIED);
    expect(item.shouldPromptToSave()).toBe(true);
    expect(item.serialize().viewDocument.data.activeGraphic).toBe(1);
    expect(item.serialize().viewDocument.data.graphics[1].camera.projection).toBe("perspective");

    const restored = mainModule.deserialize(item.serialize());
    expect(restored instanceof GravissView).toBe(true);
    expect(restored.getURI()).toBe(MAIN_EXAMPLE_URI);
    expect(restored.activeGraphic.title).toBe("Roof plan");
    expect(restored.serialize().activeGraphic).toBe(1);
    expect(restored.getFileState()).toBe(FileState.MODIFIED);
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
      // Hung below the node along the model's own up axis, which points down
      // here — and hung by its own size rather than by a fixed distance, so it
      // meets the node at whatever size the symbols are drawn.
      expect(supportPosition.z).toBeGreaterThan(0);
      const hung = supportPosition.z;
      item.renderer.setSymbolSize(item.renderer.getSymbolSize() * 2);
      item.renderer.meshes.supports.getMatrixAt(0, supportMatrix);
      supportPosition.setFromMatrixPosition(supportMatrix);
      expect(supportPosition.z).toBeCloseTo(hung * 2, 6);
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
    // The member fill is instanced: the section is uploaded once and each
    // member is sixteen floats of placement. Baking it vertex by vertex cost a
    // fifth of a second a frame on a real model, which is not something an
    // animation can pay. One rectangle section is the twelve triangles of its
    // box, uploaded once however many members share it.
    expect(memberMesh.isInstancedMesh).toBe(true);
    expect(memberMesh.count).toBe(1);
    // A box is indexed, so its twelve triangles are twenty-four vertices.
    expect(memberMesh.geometry.getAttribute("position").count).toBe(24);
    // An instanced geometry carries no colour attribute: declaring vertex
    // colours anyway would make the shader read the missing attribute as black
    // and swallow the instance colour.
    expect(memberMesh.geometry.getAttribute("color")).toBeUndefined();
    expect(memberMesh.material.vertexColors).toBe(false);
    // Ranges count instances now, not vertices — one member is one segment
    // until it bends.
    expect(memberMesh.userData.gravissEntityRanges).toEqual([{ start: 0, count: 1 }]);
    // The contours read the very same matrix buffer, which is what keeps an
    // arris on its fill to the bit with no offset and no inflation: two buffers
    // holding the same numbers would still be two roundings.
    const memberArris = item.renderer.memberContours[0];
    expect(memberArris.geometry.getAttribute("instanceMatrix")).toBe(memberMesh.instanceMatrix);
    expect(memberArris.material.defines.USE_INSTANCING).toBe("");
    // The marks stay instanced, and an instanced geometry carries no colour
    // attribute: declaring vertex colours anyway would make the shader read
    // the missing attribute as black and swallow the instance colour.
    for (const mesh of [item.renderer.meshes.nodes, item.renderer.meshes.supports]) {
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
      // A welded plate girder: a web trimmed to the inner face of each flange,
      // so the three bands abut and the section stands 2 x 0.5065 + 0.017 deep
      // rather than the 0.996 of the web's own run.
      [
        {
          kind: "plates",
          plates: [
            { from: [0, -0.498], to: [0, 0.498], thickness: 0.01 },
            { from: [-0.13, -0.5065], to: [0.13, -0.5065], thickness: 0.017 },
            { from: [-0.13, 0.5065], to: [0.13, 0.5065], thickness: 0.017 },
          ],
        },
        [1, 0.26, 1.03],
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

    // There are two display modes: line elements either carry their extruded
    // cross-section or are drawn as lines.
    const sectionButton = item.element.querySelector('[data-action="toggle-sections"]');
    expect(item.isSectionRenderingEnabled()).toBe(true);
    expect(sectionButton.getAttribute("aria-pressed")).toBe("true");

    expect(item.toggleSectionRendering()).toBe(false);
    expect(sectionButton.getAttribute("aria-pressed")).toBe("false");
    expect(sectionButton.getAttribute("aria-label")).toBe("Draw elements with their sections");
    // Without section rendering a line element is a line, not a thin solid.
    const memberLines = item.renderer.pickables.find(
      (mesh) => mesh.userData.gravissColorKey === "element",
    );
    expect(memberLines.isLineSegments).toBe(true);
    expect(memberLines.geometry.getAttribute("position").count).toBe(2);
    expect(memberLines.userData.gravissEntityRanges).toEqual([{ start: 0, count: 2 }]);

    expect(item.toggleSectionRendering()).toBe(true);
    expect(sectionButton.getAttribute("aria-pressed")).toBe("true");
    // Instanced, and the contours read the same matrix buffer, so the two tie
    // exactly: one box section is uploaded once and the member is a placement.
    const rebuiltMember = item.renderer.pickables.find(
      (mesh) => mesh.userData.gravissColorKey === "element",
    );
    expect(rebuiltMember.isInstancedMesh).toBe(true);
    expect(rebuiltMember.count).toBe(1);
    expect(rebuiltMember.geometry.getAttribute("position").count).toBe(24);

    // Rendered members carry their section contours in the mesh-line layer:
    // the twelve edges of the unit box, stamped by the element's own matrix.
    expect(item.renderer.memberContours.length).toBe(1);
    const contours = item.renderer.memberContours[0];
    expect(contours.isLineSegments).toBe(true);
    expect(contours.geometry.getAttribute("position").count).toBe(24);
    expect(contours.visible).toBe(true);
    item.setVisibility("mesh", false);
    expect(contours.visible).toBe(false);
    item.setVisibility("mesh", true);
    expect(contours.visible).toBe(true);

    const matrix = new item.renderer.THREE.Matrix4();
    const position = new item.renderer.THREE.Vector3();
    item.renderer.meshes.nodes.getMatrixAt(0, matrix);
    position.setFromMatrixPosition(matrix);
    expect(position.toArray()).toEqual([0, 0, 0]);
    item.destroy();
  });

  it("gives a thick area element its thickness only while sections render", async () => {
    const geometry = {
      nodes: [
        { id: 1, x: 0, y: 0, z: 0 },
        { id: 2, x: 1, y: 0, z: 0 },
        { id: 3, x: 1, y: 1, z: 0 },
        { id: 4, x: 0, y: 1, z: 0 },
      ],
      sections: [],
      elements: [{ id: 20, kind: "shell", nodeIds: [1, 2, 3, 4], thickness: 0.2 }],
      supports: [],
    };
    const session = {
      async describe() {
        return {
          model: {
            id: "thick-shell",
            title: "Thick shell",
            source: "Spec",
            coordinateSystem: { upAxis: "z", handedness: "right" },
          },
          capabilities: { geometry: { elementKinds: ["shell"], supports: false } },
        };
      },
      async getGeometry() {
        return geometry;
      },
      dispose() {},
    };
    const item = mainModule.createViewer(session, { title: "Thick shell" });
    jasmine.attachToDOM(item.element);
    await conditionPromise(() => item.renderer != null, "the thick-shell scene to initialize");

    const zSpan = () => {
      const positions = item.renderer.meshes.shells.geometry.getAttribute("position");
      let minimum = Infinity;
      let maximum = -Infinity;
      for (let index = 0; index < positions.count; index += 1) {
        minimum = Math.min(minimum, positions.getZ(index));
        maximum = Math.max(maximum, positions.getZ(index));
      }
      return maximum - minimum;
    };

    // Section rendering draws a closed solid: both faces half the thickness
    // either side, plus a side face for each of the four perimeter edges.
    expect(item.renderer.meshes.shells.geometry.getAttribute("position").count).toBe(36);
    expect(zSpan()).toBeCloseTo(0.2, 6);

    // Without it the element is its reference surface alone.
    expect(item.toggleSectionRendering()).toBe(false);
    expect(item.renderer.meshes.shells.geometry.getAttribute("position").count).toBe(6);
    expect(zSpan()).toBe(0);
    item.destroy();
  });

  it("closes only the exposed perimeter of a run of thick elements", async () => {
    const buildViewer = async (thicknesses) => {
      const geometry = {
        nodes: [
          { id: 1, x: 0, y: 0, z: 0 },
          { id: 2, x: 1, y: 0, z: 0 },
          { id: 3, x: 1, y: 1, z: 0 },
          { id: 4, x: 0, y: 1, z: 0 },
          { id: 5, x: 2, y: 0, z: 0 },
          { id: 6, x: 2, y: 1, z: 0 },
        ],
        sections: [],
        elements: [
          { id: 30, kind: "shell", nodeIds: [1, 2, 3, 4], thickness: thicknesses[0] },
          { id: 31, kind: "shell", nodeIds: [2, 5, 6, 3], thickness: thicknesses[1] },
        ],
        supports: [],
      };
      const session = {
        async describe() {
          return {
            model: {
              id: "shell-run",
              title: "Shell run",
              source: "Spec",
              coordinateSystem: { upAxis: "z", handedness: "right" },
            },
            capabilities: { geometry: { elementKinds: ["shell"], supports: false } },
          };
        },
        async getGeometry() {
          return geometry;
        },
        dispose() {},
      };
      const item = mainModule.createViewer(session, { title: "Shell run" });
      jasmine.attachToDOM(item.element);
      await conditionPromise(() => item.renderer != null, "the shell-run scene to initialize");
      return item;
    };

    // Two elements continuing through their seam: the walls either would put
    // there coincide exactly, twins the depth buffer cannot order, so neither
    // is drawn — three exposed side faces each beside the four parallel-face
    // triangles, thirty vertices per element.
    const continuous = await buildViewer([0.2, 0.2]);
    expect(continuous.renderer.meshes.shells.geometry.getAttribute("position").count).toBe(60);
    const shellFill = continuous.renderer.meshes.shells.material;
    expect(shellFill.polygonOffset).toBe(false);
    expect(shellFill.depthFunc).toBe(continuous.renderer.THREE.LessDepth);
    // Winning a pixel takes the member mark away, so no arris outlives the
    // surface that hid its member.
    expect(shellFill.stencilWrite).toBe(true);
    expect(shellFill.stencilRef).toBe(0);
    expect(shellFill.stencilZPass).toBe(continuous.renderer.THREE.ReplaceStencilOp);
    continuous.destroy();

    // A genuine step keeps both walls: its corners differ by the length of the
    // step, so each element still closes its own body with all four.
    const stepped = await buildViewer([
      [0.2, 0.2, 0.2, 0.2],
      [0.3, 0.3, 0.3, 0.3],
    ]);
    expect(stepped.renderer.meshes.shells.geometry.getAttribute("position").count).toBe(72);
    stepped.destroy();

    // Depth resolution does not fall as the camera backs away: from outside
    // everything drawable the near plane rides up to its front instead of
    // trailing at a thousandth of the target distance. The front is a box, not
    // a sphere — hovering over the middle of a long deck is outside the box by
    // exactly the height above it.
    const viewer = await buildViewer([0.2, 0.2]);
    const renderer = viewer.renderer;
    const box = renderer.computeSceneBox();
    const middle = box.getCenter(new renderer.THREE.Vector3());
    renderer.controls.target.copy(middle);
    renderer.camera.position.set(middle.x, middle.y, box.max.z + 5);
    renderer.updateDepthRange();
    let distance = renderer.camera.position.distanceTo(renderer.controls.target);
    expect(renderer.camera.far).toBeCloseTo(distance + renderer.bounds.radius * 20, 5);
    expect(renderer.camera.near).toBeCloseTo(5 * 0.9, 5);

    // Far out the ride is held under a third of far, so the camera-centred sky
    // keeps a shell between the planes to sit in.
    renderer.camera.position.set(middle.x, middle.y, box.max.z + 500);
    renderer.updateDepthRange();
    distance = renderer.camera.position.distanceTo(renderer.controls.target);
    expect(renderer.camera.near).toBeCloseTo((distance + renderer.bounds.radius * 20) / 3, 5);
    expect(renderer.camera.near * 2).toBeLessThan(renderer.camera.far);

    // Inside the box nothing rides: the old floor keeps close work unclipped.
    renderer.camera.position.set(middle.x + 0.2, middle.y, middle.z);
    renderer.updateDepthRange();
    const inside = renderer.camera.position.distanceTo(renderer.controls.target);
    const insideFar = inside + renderer.bounds.radius * 20;
    expect(renderer.camera.far).toBeCloseTo(insideFar, 6);
    expect(renderer.camera.near).toBeCloseTo(Math.max(insideFar / 10000, inside / 1000), 6);
    viewer.destroy();
  });

  it("returns to a graphic with the camera it holds now, not the one it opened with", async () => {
    const item = await lumine.workspace.open(MAIN_EXAMPLE_URI, { searchAllPanes: true });
    await conditionPromise(() => item.renderer != null, "the Three.js scene to initialize");

    const original = item.renderer.captureCameraState();
    item.renderer.moveCamera("left");
    item.renderer.moveCamera("up");
    const moved = item.renderer.captureCameraState();
    expect(moved.position).not.toEqual(original.position);

    item.switchGraphic(1);
    item.switchGraphic(-1);

    expect(item.activeGraphic.title).toBe("3D overview");
    expect(item.renderer.captureCameraState().position).toEqual(moved.position);
    expect(item.renderer.captureCameraState().target).toEqual(moved.target);
  });

  it("keeps every view setting per graphic across switches", async () => {
    const item = await lumine.workspace.open(MAIN_EXAMPLE_URI, { searchAllPanes: true });
    await conditionPromise(() => item.renderer != null, "the Three.js scene to initialize");
    expect(item.activeGraphic.title).toBe("3D overview");

    // Give the first graphic a distinct state of every kind.
    item.toggleSectionRendering();
    item.setVisibility("nodes", false);
    item.setAppearance("midnight");
    expect(item.isSectionRenderingEnabled()).toBe(false);

    // The second graphic keeps its own document state, untouched by the first.
    item.switchGraphic(1);
    expect(item.activeGraphic.title).not.toBe("3D overview");
    expect(item.isSectionRenderingEnabled()).toBe(true);
    expect(item.renderer.isSectionRendering()).toBe(true);
    expect(
      item.element.querySelector('[data-action="toggle-sections"]').getAttribute("aria-pressed"),
    ).toBe("true");

    // Returning restores the first graphic's complete state.
    item.switchGraphic(-1);
    expect(item.activeGraphic.title).toBe("3D overview");
    expect(item.isSectionRenderingEnabled()).toBe(false);
    expect(item.renderer.isSectionRendering()).toBe(false);
    expect(item.isVisible("nodes")).toBe(false);
    expect(item.renderer.activeAppearance).toBe("midnight");

    // The state lives in the document, so it survives serialization too.
    const graphic = item.viewDocument.getData().graphics.find(({ id }) => id === "overview");
    expect(graphic.sectionRendering).toBe(false);
    expect(graphic.visibility.nodes).toBe(false);
    expect(graphic.appearance).toBe("midnight");
  });

  it("adds and deletes graphics from the toolbar, one document edit each", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "graviss-graphic-edit-"));
    const viewPath = path.join(directory, "model.grv");
    fs.writeFileSync(viewPath, "{}\n");
    const providerDisposable = mainModule.consumeGravissSource({
      id: "graphic-edit-models",
      createSession: ({ filePath }) =>
        filePath === viewPath ? new TestSession(MAIN_EXAMPLE) : null,
    });

    const item = await lumine.workspace.open(viewPath, { searchAllPanes: true });
    await conditionPromise(() => item.renderer != null, "the Three.js scene to initialize");
    const toolbar = item.element.querySelector(".graviss-toolbar");
    const counter = toolbar.querySelector(".graviss-graphic-counter");
    const previous = toolbar.querySelector('[data-action="previous-graphic"]');
    const next = toolbar.querySelector('[data-action="next-graphic"]');
    const add = toolbar.querySelector('[data-action="add-graphic"]');
    const remove = toolbar.querySelector('[data-action="delete-graphic"]');

    // A single-graphic document keeps every graphic control on screen; what
    // cannot be done yet is disabled rather than gone.
    expect(item.element.querySelector(".graviss-graphic-actions").hidden).toBe(false);
    expect(counter.textContent).toBe("1/1");
    expect(previous.disabled).toBe(true);
    expect(next.disabled).toBe(true);
    expect(add.disabled).toBe(false);
    expect(remove.disabled).toBe(true);

    // Deleting the only graphic is refused with a reason, not performed.
    const warned = spyOn(lumine.notifications, "addWarning").and.callThrough();
    expect(item.deleteGraphic()).toBe(false);
    expect(warned).toHaveBeenCalledWith("Graviss cannot delete the only graphic", {
      detail: "A view keeps at least one graphic. Add another before deleting this one.",
    });

    // Adding writes one blank graphic after the active one and shows it. The
    // new graphic states nothing, so the file gains exactly two empty objects
    // and a position — everything else stays worked out.
    add.click();
    expect(counter.textContent).toBe("2/2");
    expect(item.activeGraphic.title).toBe("Graphic 2");
    expect(item.getFileState()).toBe(FileState.MODIFIED);
    expect(previous.disabled).toBe(false);
    expect(next.disabled).toBe(false);
    expect(remove.disabled).toBe(false);
    expect(item.viewDocument.getStoredData()).toEqual({ graphics: [{}, {}], activeGraphic: 1 });

    // Deleting takes the active graphic out; its neighbour takes its place.
    remove.click();
    expect(counter.textContent).toBe("1/1");
    expect(item.viewDocument.getStoredData().graphics).toEqual([{}]);
    expect(item.viewDocument.getStoredData().activeGraphic).toBe(0);
    expect(remove.disabled).toBe(true);

    // Each edit is one undo step of the document.
    item.undo();
    expect(counter.textContent).toBe("2/2");
    expect(item.activeGraphic.title).toBe("Graphic 2");
    item.undo();
    expect(counter.textContent).toBe("1/1");
    expect(item.viewDocument.getStoredData()).toEqual({});

    providerDisposable.dispose();
  });

  it("marks the canvas conflicted when the source is saved under pending edits", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "graviss-conflict-"));
    const viewPath = path.join(directory, "model.grv");
    fs.writeFileSync(viewPath, `${JSON.stringify(MAIN_EXAMPLE.viewDocument, null, 2)}\n`);
    const providerDisposable = mainModule.consumeGravissSource({
      id: "conflict-models",
      createSession: ({ filePath }) =>
        filePath === viewPath ? new TestSession(MAIN_EXAMPLE) : null,
    });

    const item = await lumine.workspace.open(viewPath, { searchAllPanes: true });
    await conditionPromise(() => item.renderer != null, "the Three.js scene to initialize");
    await item.viewDocument.whenWatcherReady();
    const editor = await mainModule.openSource(viewPath);
    expect(item.getFileState()).toBe(FileState.UNMODIFIED);

    // Camera moves make the canvas modified, exactly like typing in an editor.
    item.renderer.moveCamera("left");
    item.flushPendingCameraHistory();
    expect(item.getFileState()).toBe(FileState.MODIFIED);

    // Saving the source editor changes the file under those pending edits.
    const edited = JSON.parse(editor.getText());
    edited.title = "Edited on disk";
    editor.setText(`${JSON.stringify(edited, null, 2)}\n`);
    await editor.save();
    await conditionPromise(
      () => item.getFileState() === FileState.CONFLICTED,
      "the canvas to report the conflict",
    );

    expect(item.getFileState()).toBe(FileState.CONFLICTED);
    expect(item.serialize().viewDocument.fileState).toBe(FileState.CONFLICTED);

    // The pane save flow resolves the conflict the way it does for an editor:
    // it asks, cancel aborts the save, and overwrite commits the canvas state.
    lumine.config.set("core.promptOnSaveConflictedFile", true);
    const pane = lumine.workspace.paneForItem(item);
    const confirm = spyOn(pane.applicationDelegate, "confirm").and.resolveTo(1);
    let cancelled = null;
    await pane.saveItem(item).catch((error) => (cancelled = error));
    expect(confirm).toHaveBeenCalled();
    expect(cancelled?.constructor?.name).toBe("SaveConflictedError");
    expect(JSON.parse(fs.readFileSync(viewPath, "utf8")).title).toBe("Edited on disk");
    expect(item.getFileState()).toBe(FileState.CONFLICTED);

    confirm.and.resolveTo(0);
    await pane.saveItem(item);
    expect(item.getFileState()).toBe(FileState.UNMODIFIED);
    expect(JSON.parse(fs.readFileSync(viewPath, "utf8")).title).toBe(MAIN_EXAMPLE.title);

    // Deleting the file keeps the canvas open, like an editor tab, and one
    // plain save writes the document back to its previous path. The settled
    // state arrives with the file-state event, not with the raw filesystem check.
    const deleted = new Promise((resolve) => {
      const subscription = item.onDidChangeFileState((fileState) => {
        if (fileState !== FileState.REMOVED) return;
        subscription.dispose();
        resolve();
      });
    });
    fs.rmSync(viewPath);
    await deleted;
    expect(item.getFileState()).toBe(FileState.REMOVED);
    expect(lumine.workspace.paneForItem(item)).toBe(pane);
    expect(item.shouldPromptToSave()).toBe(true);

    await item.save();
    expect(fs.existsSync(viewPath)).toBe(true);
    expect(item.getFileState()).toBe(FileState.UNMODIFIED);
    expect(JSON.parse(fs.readFileSync(viewPath, "utf8")).title).toBe(MAIN_EXAMPLE.title);

    providerDisposable.dispose();
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
    expect(item.getFileState()).toBe(FileState.UNMODIFIED);
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(updateCamera).toHaveBeenCalledTimes(1);
    expect(item.getFileState()).toBe(FileState.MODIFIED);
    expect(item.canUndo()).toBe(true);

    expect(item.undo()).toBe(true);
    expect(item.getFileState()).toBe(FileState.UNMODIFIED);
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
    expect(serialized.viewDocument.fileState).toBe(FileState.MODIFIED);
    expect(serialized.viewDocument.data.graphics[0].appearance).toBe("midnight");
    const restored = mainModule.deserialize(serialized);
    expect(restored.getFileState()).toBe(FileState.MODIFIED);
    expect(restored.appearance).toBe("midnight");
    restored.destroy();

    const fileState = spyOn(item, "getFileState").and.returnValue(FileState.CONFLICTED);
    expect(item.shouldPromptToSave({ windowCloseRequested: true, projectHasPaths: true })).toBe(
      true,
    );
    fileState.and.returnValue(FileState.REMOVED);
    expect(item.shouldPromptToSave({ windowCloseRequested: true, projectHasPaths: true })).toBe(
      true,
    );
    lumine.config.set("core.promptOnCloseDirtyBuffer", false);
    expect(item.shouldPromptToSave()).toBe(false);
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
    expect(workspaceCommandNames).toContain("graviss:open-source-on-right");
    expect(workspaceCommandNames).not.toContain("graviss:fit-view");
    expect(workspaceCommandNames).not.toContain("graviss:next-graphic");

    lumine.commands.dispatch(lumine.workspace.getElement(), "graviss:next-graphic");
    expect(item.activeGraphic.title).toBe("3D overview");
    const escapedCommand = jasmine.createSpy("escapedCommand");
    const outerCommand = lumine.commands.add(
      "lumine-workspace",
      "graviss:next-graphic",
      escapedCommand,
    );
    const dispatchCommand = spyOn(item, "dispatchCommand").and.callThrough();
    item.element.querySelector('[data-action="next-graphic"]').click();
    expect(dispatchCommand).toHaveBeenCalledWith("graviss:next-graphic");
    expect(item.activeGraphic.title).toBe("Roof plan");
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
    expect(item.serialize().viewDocument.data.graphics[item.activeGraphicIndex].camera).toEqual(
      item.renderer.captureCameraState(),
    );
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
    expect(keystrokesFor("graviss:rotate-left")).toEqual(["alt-left"]);
    expect(keystrokesFor("graviss:rotate-right")).toEqual(["alt-right"]);
    expect(keystrokesFor("graviss:rotate-up")).toEqual(["alt-up"]);
    expect(keystrokesFor("graviss:rotate-down")).toEqual(["alt-down"]);
    expect(keystrokesFor("graviss:zoom-in")).toEqual(["+", "="]);
    expect(keystrokesFor("graviss:zoom-out")).toEqual(["-", "_"]);
    expect(keystrokesFor("graviss:previous-graphic")).toEqual(["["]);
    expect(keystrokesFor("graviss:next-graphic")).toEqual(["]"]);
    expect(keystrokesFor("graviss:fit-view")).toEqual(["f"]);
    expect(keystrokesFor("graviss:view-isometric")).toEqual(["i"]);
    expect(keystrokesFor("graviss:view-top")).toEqual(["t"]);
    expect(keystrokesFor("graviss:view-front")).toEqual(["e"]);
    expect(keystrokesFor("graviss:view-right")).toEqual(["r"]);
    expect(keystrokesFor("graviss:perspective-projection")).toEqual(["p"]);
    expect(keystrokesFor("graviss:orthographic-projection")).toEqual(["o"]);
    expect(keystrokesFor("graviss:toggle-members")).toEqual(["m"]);
    expect(keystrokesFor("graviss:toggle-shells")).toEqual(["s"]);
    expect(keystrokesFor("graviss:toggle-nodes")).toEqual(["n"]);
    expect(keystrokesFor("graviss:toggle-supports")).toEqual(["u"]);
    expect(keystrokesFor("graviss:toggle-mesh")).toEqual(["w"]);
    expect(keystrokesFor("graviss:toggle-grid")).toEqual(["g"]);
    expect(keystrokesFor("graviss:toggle-axes")).toEqual(["a"]);
    expect(keystrokesFor("graviss:toggle-local-axes")).toEqual(["l"]);
    expect(keystrokesFor("graviss:toggle-section-rendering")).toEqual(["d"]);
    expect(keystrokesFor("graviss:choose-background")).toEqual(["b"]);

    // A binding that exists is not yet a binding that fires: core resolves
    // every arrow under .native-key-bindings to native! at higher specificity
    // than the package keymap, so that class on the root killed the camera
    // keys while findKeyBindings still reported them. The root must stay
    // clear of it; the symbol field carries it alone, keeping its own arrows
    // native while it has focus.
    expect(item.element.classList.contains("native-key-bindings")).toBe(false);
    expect(
      item.element.querySelector(".graviss-symbol-input").classList.contains("native-key-bindings"),
    ).toBe(true);
    const pressOnRoot = (key) => {
      const event = lumine.keymaps.constructor.buildKeydownEvent(key, {
        target: item.element,
      });
      lumine.keymaps.handleKeyboardEvent(event);
    };
    const targetBeforeArrow = item.renderer.controls.target.clone();
    pressOnRoot("left");
    expect(item.renderer.controls.target.equals(targetBeforeArrow)).toBe(false);
    const positionBeforeAltArrow = item.renderer.camera.position.clone();
    const targetBeforeAltArrow = item.renderer.controls.target.clone();
    pressOnRoot("alt-left");
    expect(item.renderer.controls.target.distanceTo(targetBeforeAltArrow)).toBeLessThan(1e-8);
    expect(item.renderer.camera.position.distanceTo(positionBeforeAltArrow)).toBeGreaterThan(0.1);

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
    // A model of nothing but shells still owns the switch that hides members,
    // and that switch works through what is registered — so the group is there
    // and empty rather than missing, or the toolbar would show members as shown
    // with nothing answering for them.
    expect(item.renderer.meshes.members.children.length).toBe(0);
    item.renderer.setVisibility("members", false);
    expect(item.renderer.meshes.members.visible).toBe(false);
    item.renderer.setVisibility("members", true);
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
    // Opaque and depth-writing: a translucent line would render after every
    // opaque body, where nothing can be drawn back over it — softness comes
    // from the mixed ink instead, and the depth lets a nearer body cover
    // exactly the lines it stands in front of.
    const edges = item.renderer.meshes.shells.userData.gravissEdges;
    expect(item.renderer.meshes.mesh).toBe(edges);
    expect(edges.material.transparent).toBe(false);
    expect(edges.material.depthWrite).toBe(true);
    expect(edges.renderOrder).toBe(1);
    // After the member fills and their contours, whose flush faces and
    // arrises must claim their band before the tie-losing shell fill arrives.
    expect(item.renderer.meshes.shells.renderOrder).toBe(4);
    expect(edges.visible).toBe(true);
    expect(item.setVisibility("mesh", false)).toBe(false);
    expect(edges.visible).toBe(false);
    expect(item.renderer.meshes.shells.visible).toBe(true);
    expect(item.element.querySelector('[data-visible="mesh"]').getAttribute("aria-pressed")).toBe(
      "false",
    );

    // Switching section rendering off takes the extrusion away from line
    // elements. An area element is still drawn as its area, and the mesh-line
    // switch keeps whatever state it was left in across the rebuild.
    expect(item.toggleSectionRendering()).toBe(false);
    expect(item.renderer.meshes.shells.visible).toBe(true);
    expect(item.renderer.meshes.shells.material.visible).toBe(true);
    expect(item.renderer.meshes.shells.userData.gravissEdges.visible).toBe(false);
    expect(item.setVisibility("mesh", true)).toBe(true);
    expect(item.renderer.meshes.shells.userData.gravissEdges.visible).toBe(true);
    expect(item.toggleSectionRendering()).toBe(true);
    expect(item.renderer.meshes.shells.material.visible).toBe(true);
    expect(item.renderer.meshes.shells.userData.gravissEdges.visible).toBe(true);
    // A rebuild outside applyTheme must not reset the mesh lines to white.
    const definition = appearanceDefinition(item.renderer.activeAppearance);
    expect(item.renderer.meshes.shells.userData.gravissEdges.material.color.getHex()).toBe(
      item.renderer.mixedLineColor(definition.shellEdge, definition.shell),
    );
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
      // A blank document names nothing, so the pane is named after its file
      // the way every other editor names one.
      expect(item.getTitle()).toBe("empty-model.grv");
      expect(item.viewDocument.getData().title).toBeUndefined();
      expect(item.viewDocument.isImplicit()).toBe(true);
      expect(item.getFileState()).toBe(FileState.UNMODIFIED);
      expect(item.renderer.controls.target.toArray()).toEqual([4, 5, 3.5]);

      item.toggleVisibility("grid");
      expect(item.viewDocument.isImplicit()).toBe(false);
      expect(item.getFileState()).toBe(FileState.MODIFIED);
      // Only what was touched reaches the file: no format, no version, no ids,
      // titles or camera Graviss worked out for itself.
      expect(JSON.parse(item.viewDocument.getSourceBuffer().getText())).toEqual({
        graphics: [{ visibility: { grid: false } }],
      });
    } finally {
      registration.dispose();
      if (item) await lumine.workspace.paneForItem(item)?.destroyItem(item, true);
      await new Promise((resolve) => setTimeout(resolve, 50));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("puts back every switch the graphic before it moved, not only the ones it names", async () => {
    const viewer = createFixtureViewer(MAIN_EXAMPLE);
    try {
      await conditionPromise(() => viewer.renderer != null, "the Three.js scene to initialize");
      // A graphic restores every switch the one before it moved, not only the
      // ones it names - one nobody restores is one left where the last graphic
      // had it.
      viewer.toggleVisibility("springs");
      viewer.toggleVisibility("localAxes");
      expect(viewer.renderer.visibility.springs).toBe(false);
      expect(viewer.renderer.visibility.localAxes).toBe(true);

      viewer.activateGraphic(1);
      expect(viewer.renderer.visibility.springs).toBe(true);
      expect(viewer.renderer.visibility.localAxes).toBe(false);

      viewer.activateGraphic(0);
      expect(viewer.renderer.visibility.springs).toBe(false);
      expect(viewer.renderer.visibility.localAxes).toBe(true);
    } finally {
      viewer.destroy();
    }
  });

  it("uses the last active graphic stored by the view document when reopening", () => {
    const first = createFixtureViewer(MAIN_EXAMPLE);
    first.activateGraphic(1);
    const viewDocumentState = first.serialize().viewDocument;
    first.destroy();

    const reopened = createFixtureViewer(MAIN_EXAMPLE, { viewDocumentState });
    expect(reopened.activeGraphic.title).toBe("Roof plan");
    expect(reopened.serialize().viewDocument.data.activeGraphic).toBe(1);
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
    expect(item.getFileState()).toBe(FileState.UNMODIFIED);

    item.activateGraphic(1);

    expect(item.getFileState()).toBe(FileState.MODIFIED);
    expect(pane.getPendingItem()).toBeNull();
    expect(didTerminate).toHaveBeenCalledTimes(1);

    item.activateGraphic(2);
    expect(didTerminate).toHaveBeenCalledTimes(1);
  });

  it("routes Lumine undo and redo commands to the active view document", async () => {
    const item = await lumine.workspace.open(MAIN_EXAMPLE.viewDocumentPath, {
      searchAllPanes: true,
    });

    expect(item.activeGraphic.title).toBe("3D overview");
    item.activateGraphic(1);
    expect(item.activeGraphic.title).toBe("Roof plan");
    expect(item.canUndo()).toBe(true);

    lumine.commands.dispatch(item.element, "core:undo");
    expect(item.activeGraphic.title).toBe("3D overview");
    expect(item.getFileState()).toBe(FileState.UNMODIFIED);
    expect(item.canRedo()).toBe(true);

    lumine.commands.dispatch(item.element, "core:redo");
    expect(item.activeGraphic.title).toBe("Roof plan");
    expect(item.getFileState()).toBe(FileState.MODIFIED);
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

  it("opens the source of the canvas the toolbar button belongs to", async () => {
    await lumine.packages.activatePackage("language-json");
    const canvas = await lumine.workspace.open(MAIN_EXAMPLE.viewDocumentPath, {
      searchAllPanes: true,
    });
    const button = canvas.element.querySelector('[data-action="open-source"]');
    expect(button).not.toBeNull();
    expect(button.dataset.command).toBe("graviss:open-source-on-right");
    expect(button.closest(".graviss-source-control")).not.toBeNull();

    // The command lives on the workspace, so a dispatch from inside the canvas
    // has to reach it by bubbling rather than by a second registration.
    expect(
      lumine.commands
        .findCommands({ target: button })
        .some(({ name }) => name === "graviss:open-source-on-right"),
    ).toBe(true);

    // Resolved from the dispatch target, so the button opens its own canvas's
    // source even when the active pane item is something else entirely.
    const other = await lumine.workspace.open(SHELL_EXAMPLE_URI, { searchAllPanes: true });
    expect(lumine.workspace.getActivePaneItem()).toBe(other);

    const editor = await mainModule.openSourceCommand({ target: button }, { split: "right" });

    expect(lumine.workspace.isTextEditor(editor)).toBe(true);
    expect(editor.getPath()).toBe(MAIN_EXAMPLE.viewDocumentPath);
    expect(editor.getGrammar().scopeName).toBe("source.json");
    // The button splits: the source stands beside the canvas, not over it.
    expect(lumine.workspace.paneForItem(editor)).not.toBe(lumine.workspace.paneForItem(canvas));

    await lumine.workspace.paneForItem(editor).destroyItem(editor, true);
  });

  it("covers the whole model when a print is requested without a region", async () => {
    const item = await lumine.workspace.open(MAIN_EXAMPLE_URI, { searchAllPanes: true });
    await conditionPromise(() => item.renderer != null, "the Three.js scene to initialize");
    const renderer = item.renderer;

    expect(item.getPrintRegion()).toBeNull();
    expect(item.element.querySelector(".graviss-print-region").hidden).toBe(true);

    // Without a region an image covers the whole model plus a margin, measured
    // from what is drawn rather than from where the nodes are, and regardless
    // of what the viewport is cropping away.
    const extent = renderer.projectedModelExtent();
    // The frame is centred on the middle of what the model projects to, which
    // under perspective is not quite the middle of the model itself — that is
    // what keeps the margins even rather than lopsided.
    const drawn = renderer.visibleModelBounds();
    const boxCenter = drawn.getCenter(new renderer.THREE.Vector3());
    expect(new renderer.THREE.Vector3(...extent.center).distanceTo(boxCenter)).toBeLessThan(
      drawn.getSize(new renderer.THREE.Vector3()).length(),
    );
    const derived = renderer.resolvePrintRegion(null);
    expect(derived.center).toEqual(extent.center);
    const margin = Math.max(extent.width, extent.height) * 0.02;
    expect(derived.width).toBeCloseTo(extent.width + margin * 2, 6);
    expect(derived.height).toBeCloseTo(extent.height + margin * 2, 6);

    // The derived region contains the model whatever the window is doing, so
    // resizing the viewport cannot change what a print covers.
    renderer.host.style.width = "1200px";
    renderer.host.style.height = "300px";
    renderer.resize();
    const wideExtent = renderer.projectedModelExtent();
    expect(wideExtent.width).toBeCloseTo(extent.width, 6);
    expect(wideExtent.height).toBeCloseTo(extent.height, 6);

    // A region taken from the view is written down as the whole view window:
    // centred on the view axis, two view units tall, and as wide as the pane
    // aspect makes the view. The file holds a window through the camera, not
    // a description of this pane.
    const viewport = renderer.viewportPixels();
    const half = Math.tan((renderer.camera.fov * Math.PI) / 360) / renderer.camera.zoom;
    const region = item.setPrintRegionFromView();
    expect(region.center).toEqual([0, 0]);
    expect(region.width).toBeCloseTo((2 * half * viewport.width) / viewport.height, 6);
    expect(region.height).toBeCloseTo(2 * half, 6);
    expect(item.getPrintRegion()).toEqual(region);
    expect(item.element.querySelector(".graviss-print-region").hidden).toBe(false);
    expect(
      item.viewDocument.getData().graphics.find(({ id }) => id === "overview").printRegion,
    ).toEqual(region);

    expect(item.clearPrintRegion()).toBe(true);
    expect(item.getPrintRegion()).toBeNull();
    expect(item.element.querySelector(".graviss-print-region").hidden).toBe(true);
  });

  it("keeps the drawn rectangle where it was drawn and composes through it", async () => {
    const item = await lumine.workspace.open(MAIN_EXAMPLE_URI, { searchAllPanes: true });
    await conditionPromise(() => item.renderer != null, "the Three.js scene to initialize");
    const renderer = item.renderer;
    renderer.host.style.width = "800px";
    renderer.host.style.height = "400px";
    renderer.resize();
    const targetBefore = renderer.controls.target.clone();

    // The rectangle is held in fractions of the viewport it was drawn over.
    const drawn = renderer.regionForScreenRect({ x: 200, y: 100 }, { x: 600, y: 300 });
    expect(drawn).toEqual({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
    // Drawing it moves no camera; it is a frame over the viewport, not a pick.
    expect(renderer.controls.target.distanceTo(targetBefore)).toBeCloseTo(0, 9);

    // A drag too small to have been meant as a rectangle sets nothing.
    expect(renderer.regionForScreenRect({ x: 300, y: 150 }, { x: 304, y: 250 })).toBeNull();

    // The whole gesture, through the command the palette offers. What the
    // fractions drew is stored as a window of angles about the view axis:
    // half the viewport across and down is half the view either way, centred.
    expect(item.getPrintRegion()).toBeNull();
    expect(item.selectPrintRegion()).toBe(true);
    expect(renderer.controls.enabled).toBe(false);
    renderer.endRegionSelection(drawn);
    expect(renderer.controls.enabled).toBe(true);
    const visible = renderer.visibleExtentAtTarget();
    const stored = item.getPrintRegion();
    const half = Math.tan((renderer.camera.fov * Math.PI) / 360) / renderer.camera.zoom;
    expect(stored.center[0]).toBeCloseTo(0, 9);
    expect(stored.center[1]).toBeCloseTo(0, 9);
    expect(stored.width).toBeCloseTo(2 * half, 9);
    expect(stored.height).toBeCloseTo(half, 9);

    const overlay = item.element.querySelector(".graviss-print-region");
    expect(overlay.hidden).toBe(false);
    expect(overlay.style.left).toBe("25%");
    expect(overlay.style.width).toBe("50%");

    const covered = renderer.resolvePrintRegion(stored);
    expect(covered.width).toBeCloseTo(visible.width / 2, 6);
    expect(covered.height).toBeCloseTo(visible.height / 2, 6);

    // The frame is stable on the user's screen under every camera action:
    // zooming and dollying recompose what stands inside it — the window is
    // the view's, so a closer view plots a smaller piece of the structure —
    // and can never move the frame itself.
    renderer.zoomCamera("in");
    expect(item.getPrintRegion()).toEqual(stored);
    const zoomed = renderer.resolvePrintRegion(stored);
    expect(zoomed.width).toBeLessThan(covered.width);
    item.renderer.paintPrintRegion();
    expect(overlay.style.left).toBe("25%");
    expect(overlay.style.width).toBe("50%");

    // A wheel dolly also drags the orbit target sideways, toward whatever is
    // under the pointer. The window rides the view axis, not the target, so
    // even that leaves the frame exactly where it stands.
    renderer.controls.target.x += 2;
    renderer.controls.target.y += 1;
    renderer.controls.update();
    expect(item.getPrintRegion()).toEqual(stored);
    const fractions = item.printRegionFractions();
    expect(fractions.x).toBeCloseTo(0.25, 9);
    expect(fractions.y).toBeCloseTo(0.25, 9);
    expect(fractions.width).toBeCloseTo(0.5, 9);
    expect(fractions.height).toBeCloseTo(0.5, 9);

    // Escaping a selection leaves the region the graphic already had.
    expect(item.selectPrintRegion()).toBe(true);
    renderer.endRegionSelection(null);
    expect(item.getPrintRegion()).toEqual(stored);
  });

  it("keeps every frame gesture behind the command modifier", async () => {
    const item = await lumine.workspace.open(MAIN_EXAMPLE_URI, { searchAllPanes: true });
    await conditionPromise(() => item.renderer != null, "the Three.js scene to initialize");
    const viewport = item.element.querySelector(".graviss-viewport");
    const overlay = item.element.querySelector(".graviss-print-region");
    viewport.style.width = "800px";
    viewport.style.height = "400px";
    item.renderer.resize();

    // Nothing the frame draws can stand between the pointer and the model.
    expect(overlay.children.length).toBe(0);
    expect(getComputedStyle(overlay).pointerEvents).toBe("none");

    // The stored region is metres on the target plane; the gestures work in
    // fractions of the pane, so the assertions read the region back through
    // the same conversion. The camera never moves in this spec, so the
    // fraction arithmetic is exact.
    const fractionsOf = () => item.printRegionFractions();
    const start = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
    expect(item.selectPrintRegion()).toBe(true);
    item.renderer.endRegionSelection(start);
    const startStored = item.getPrintRegion();
    expect(fractionsOf().x).toBeCloseTo(0.25, 6);
    expect(fractionsOf().width).toBeCloseTo(0.5, 6);

    const bounds = viewport.getBoundingClientRect();
    const at = (x, y) => ({ clientX: bounds.left + x, clientY: bounds.top + y });
    const modifier = process.platform === "darwin" ? { metaKey: true } : { ctrlKey: true };
    const drag = (from, to, held = modifier) => {
      viewport.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, ...held, ...from }),
      );
      window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, ...held, ...to }));
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, ...held, ...to }));
    };

    // Without the modifier the frame ignores the gesture entirely; the model
    // keeps it.
    drag(at(400, 200), at(480, 240), {});
    expect(item.getPrintRegion()).toEqual(startStored);

    // Held, a press in the middle moves the frame and keeps its size.
    drag(at(400, 200), at(480, 240));
    const moved = fractionsOf();
    const movedStored = item.getPrintRegion();
    expect(moved.x).toBeCloseTo(0.35, 6);
    expect(moved.y).toBeCloseTo(0.35, 6);
    expect(moved.width).toBeCloseTo(0.5, 6);

    // A press on a corner resizes, leaving the opposite corner where it was.
    const corner = { x: moved.x * 800, y: moved.y * 400 };
    drag(at(corner.x, corner.y), at(corner.x + 40, corner.y + 20));
    const resized = fractionsOf();
    const resizedStored = item.getPrintRegion();
    expect(resized.x).toBeCloseTo(0.4, 6);
    expect(resized.x + resized.width).toBeCloseTo(moved.x + moved.width, 6);
    expect(resized.y + resized.height).toBeCloseTo(moved.y + moved.height, 6);

    // One gesture is one undo step, not one per pointer event.
    item.undo();
    expect(item.getPrintRegion()).toEqual(movedStored);
    item.redo();
    expect(item.getPrintRegion()).toEqual(resizedStored);

    // Held and pressed outside the frame, the gesture draws a new one.
    drag(at(40, 40), at(240, 140));
    const drawn = fractionsOf();
    const drawnStored = item.getPrintRegion();
    expect(drawn.x).toBeCloseTo(0.05, 6);
    expect(drawn.width).toBeCloseTo(0.25, 6);
    expect(drawn.height).toBeCloseTo(0.25, 6);

    // The cursor names the gesture the modifier would start, and follows the
    // modifier itself rather than only the pointer: pressing it without moving
    // has to change the answer.
    const hover = (x, y, held = modifier) =>
      viewport.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, ...held, ...at(x, y) }),
      );
    const middle = { x: (drawn.x + drawn.width / 2) * 800, y: (drawn.y + drawn.height / 2) * 400 };
    hover(middle.x, middle.y, {});
    expect(viewport.dataset.regionCursor).toBeUndefined();
    hover(middle.x, middle.y);
    expect(viewport.dataset.regionCursor).toBe("move");
    hover(drawn.x * 800, drawn.y * 400);
    expect(viewport.dataset.regionCursor).toBe("nw");
    hover(760, 380);
    expect(viewport.dataset.regionCursor).toBe("create");

    // Releasing the modifier without moving the pointer clears it.
    window.dispatchEvent(
      new KeyboardEvent("keyup", {
        bubbles: true,
        key: process.platform === "darwin" ? "Meta" : "Control",
      }),
    );
    expect(viewport.dataset.regionCursor).toBeUndefined();

    // A held press outside the frame that never moves is a click, and a click
    // outside drops the frame.
    drag(at(760, 380), at(760, 380));
    expect(item.getPrintRegion()).toBeNull();
    expect(item.selectPrintRegion()).toBe(true);
    item.renderer.endRegionSelection(drawn);
    // Selected again from its own read-back fractions, so equal to rounding.
    const redrawn = item.getPrintRegion();
    expect(redrawn.center[0]).toBeCloseTo(drawnStored.center[0], 9);
    expect(redrawn.center[1]).toBeCloseTo(drawnStored.center[1], 9);
    expect(redrawn.width).toBeCloseTo(drawnStored.width, 9);
    expect(redrawn.height).toBeCloseTo(drawnStored.height, 9);

    // Holding the modifier is selection mode for as long as it is down, so the
    // frame shows its grips while a gesture is available.
    const modifierKey = process.platform === "darwin" ? "Meta" : "Control";
    expect(item.element.dataset.selectionMode).toBeUndefined();
    window.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: modifierKey, ...modifier }),
    );
    expect(item.element.dataset.selectionMode).toBe("true");
    expect(item.isInSelectionMode()).toBe(false);
    window.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: modifierKey }));
    expect(item.element.dataset.selectionMode).toBeUndefined();

    // The wheel belongs to the frame's context in selection mode, so the model
    // does not move out from under a frame being placed.
    const wheelReaches = () => {
      const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100 });
      viewport.dispatchEvent(event);
      return !event.defaultPrevented;
    };
    expect(wheelReaches()).toBe(true);
    item.setSelectionMode(true);
    expect(wheelReaches()).toBe(false);
    item.setSelectionMode(false);
    expect(wheelReaches()).toBe(true);

    // Selection mode latches the same thing on, so the gestures work with no
    // key held; leaving it hands every pointer back to the model.
    expect(item.isInSelectionMode()).toBe(false);
    item.setSelectionMode(true);
    expect(item.element.dataset.selectionMode).toBe("true");
    const inside = () => {
      const region = fractionsOf();
      return { x: (region.x + region.width / 2) * 800, y: (region.y + region.height / 2) * 400 };
    };
    const held = inside();
    drag(at(held.x, held.y), at(held.x + 40, held.y), {});
    expect(fractionsOf().x).toBeCloseTo(drawn.x + 0.05, 6);

    item.setSelectionMode(false);
    expect(item.element.dataset.selectionMode).toBeUndefined();
    const latched = item.getPrintRegion();
    const free = inside();
    drag(at(free.x, free.y), at(free.x + 40, free.y), {});
    expect(item.getPrintRegion()).toEqual(latched);

    // Right-clicking it, held, drops it; without the modifier it survives.
    const latchedFractions = fractionsOf();
    const centre = {
      x: (latchedFractions.x + latchedFractions.width / 2) * 800,
      y: (latchedFractions.y + latchedFractions.height / 2) * 400,
    };
    viewport.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, ...at(centre.x, centre.y) }),
    );
    expect(item.getPrintRegion()).toEqual(latched);
    viewport.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        ...modifier,
        ...at(centre.x, centre.y),
      }),
    );
    expect(item.getPrintRegion()).toBeNull();
    expect(overlay.hidden).toBe(true);
  });

  it("turns the model about the element under the pointer", async () => {
    const item = await lumine.workspace.open(MAIN_EXAMPLE_URI, { searchAllPanes: true });
    await conditionPromise(() => item.renderer != null, "the Three.js scene to initialize");
    const renderer = item.renderer;
    const viewport = item.element.querySelector(".graviss-viewport");
    const marker = item.element.querySelector(".graviss-orbit-pivot");
    viewport.style.width = "800px";
    viewport.style.height = "400px";
    renderer.resize();

    const canvas = renderer.canvasRenderer.domElement;
    // A dispatched pointer is not an active one, so the capture the controls
    // take on it would throw. Nothing else in the gesture depends on it.
    canvas.setPointerCapture = () => {};
    canvas.releasePointerCapture = () => {};

    const bounds = canvas.getBoundingClientRect();
    const send = (type, point, held = {}) =>
      canvas.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          button: 0,
          buttons: 1,
          pointerId: 1,
          clientX: bounds.left + point.x,
          clientY: bounds.top + point.y,
          ...held,
        }),
      );
    const screenOf = (world) => {
      renderer.camera.updateMatrixWorld(true);
      return renderer.projectToScreen(world.toArray());
    };

    // Press over a node, so the ray has something to pin to.
    const node = renderer.geometry.nodes[0];
    const over = renderer.projectToScreen([node.x, node.y, node.z]);
    const positionBefore = renderer.camera.position.clone();
    const targetBefore = renderer.controls.target.clone();
    const quaternionBefore = renderer.camera.quaternion.clone();
    const distanceBefore = positionBefore.distanceTo(targetBefore);
    const updateCamera = spyOn(item, "updateCamera").and.callThrough();
    const cameraBefore = item.serialize().viewDocument.data.graphics[0].camera;

    // Pressing pins the pivot and moves nothing at all.
    send("pointerdown", over);
    expect(renderer.orbitPivot).not.toBeNull();
    expect(renderer.camera.position.equals(positionBefore)).toBe(true);
    expect(renderer.controls.target.equals(targetBefore)).toBe(true);
    expect(renderer.camera.quaternion.equals(quaternionBefore)).toBe(true);
    expect(marker.hidden).toBe(true);

    const pivot = renderer.orbitPivot.point.clone();
    const pinned = screenOf(pivot);

    send("pointermove", { x: over.x + 60, y: over.y + 25 });
    expect(marker.hidden).toBe(false);
    expect(Number.parseFloat(marker.style.left)).toBeCloseTo(pinned.x, 2);
    expect(Number.parseFloat(marker.style.top)).toBeCloseTo(pinned.y, 2);
    send("pointermove", { x: over.x + 120, y: over.y + 50 });
    send("pointerup", { x: over.x + 120, y: over.y + 50 });
    expect(marker.hidden).toBe(true);
    expect(renderer.orbitPivot).toBeNull();

    // The contract: the point that was under the pointer is still under it.
    const settled = screenOf(pivot);
    expect(Math.hypot(settled.x - pinned.x, settled.y - pinned.y)).toBeLessThan(0.01);

    // It was a rotation and not a pan, and turning about the pointer is what
    // carries the target along with it.
    expect(renderer.camera.quaternion.angleTo(quaternionBefore)).toBeGreaterThan(0.1);
    expect(renderer.camera.position.distanceTo(renderer.controls.target)).toBeCloseTo(
      distanceBefore,
      6,
    );
    expect(renderer.controls.target.distanceTo(targetBefore)).toBeGreaterThan(1e-6);

    // One drag is one undo step, not one per pointer event.
    expect(updateCamera).toHaveBeenCalledTimes(1);
    expect(item.serialize().viewDocument.data.graphics[0].camera).toEqual(
      renderer.captureCameraState(),
    );
    item.undo();
    expect(item.serialize().viewDocument.data.graphics[0].camera).toEqual(cameraBefore);
  });

  it("zooms along the ray under the pointer", async () => {
    const item = await lumine.workspace.open(MAIN_EXAMPLE_URI, { searchAllPanes: true });
    await conditionPromise(() => item.renderer != null, "the Three.js scene to initialize");
    const renderer = item.renderer;
    const viewport = item.element.querySelector(".graviss-viewport");
    viewport.style.width = "800px";
    viewport.style.height = "400px";
    renderer.resize();

    const canvas = renderer.canvasRenderer.domElement;
    const bounds = canvas.getBoundingClientRect();
    const spin = (point, deltaY) =>
      canvas.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaY,
          clientX: bounds.left + point.x,
          clientY: bounds.top + point.y,
        }),
      );
    // The camera eases onto the depth a notch asks for, so a spec that measures
    // where it ended up has to let it get there.
    const wheel = async (point, deltaY) => {
      spin(point, deltaY);
      await conditionPromise(() => renderer.zoomFlight == null, "the zoom to settle");
    };
    const screenOf = (world) => {
      renderer.camera.updateMatrixWorld(true);
      return renderer.projectToScreen(world);
    };

    // Well away from the middle, which is where anchoring at the pointer and
    // anchoring at the viewport disagree most. A pointer event carries whole
    // pixels, so the anchor is read back from the exact pixel the wheel will
    // name rather than from the node, whose own projection falls between two.
    const node = renderer.geometry.nodes[0];
    const projected = screenOf([node.x, node.y, node.z]);
    const under = { x: Math.round(projected.x), y: Math.round(projected.y) };
    const hit = renderer.intersectionAt({
      clientX: bounds.left + under.x,
      clientY: bounds.top + under.y,
    });
    expect(hit).not.toBeNull();
    const world = hit.point.toArray();
    const anchored = screenOf(world);
    const distanceBefore = renderer.camera.position.distanceTo(renderer.controls.target);
    const positionBefore = renderer.camera.position.clone();
    const depth = new renderer.THREE.Vector3(0, 0, -1)
      .applyQuaternion(renderer.camera.quaternion)
      .dot(hit.point.clone().sub(renderer.camera.position));

    // A notch does not arrive on the frame it is turned: the camera eases onto
    // the depth it asked for.
    spin(under, -240);
    expect(renderer.zoomFlight).not.toBeNull();
    expect(renderer.camera.position.distanceTo(renderer.controls.target)).toBeGreaterThan(
      depth * 0.64,
    );
    await conditionPromise(() => renderer.zoomFlight == null, "the zoom to settle");

    expect(renderer.camera.position.distanceTo(renderer.controls.target)).toBeLessThan(
      distanceBefore,
    );
    // The step is a fraction of the gap to the surface, not of the gap to the
    // camera target: two notches close it to 0.8 squared of what it was.
    expect(renderer.camera.position.distanceTo(renderer.controls.target)).toBeCloseTo(
      depth * 0.64,
      6,
    );

    // The contract: whatever the wheel was over has not moved under it.
    const held = screenOf(world);
    expect(Math.hypot(held.x - anchored.x, held.y - anchored.y)).toBeLessThan(0.01);

    // And back out again, still anchored, and back where it started. The
    // target does not come back to where it was, because it no longer marks
    // the middle of the model — it marks what the pointer is over.
    await wheel(under, 240);
    const returned = screenOf(world);
    expect(Math.hypot(returned.x - anchored.x, returned.y - anchored.y)).toBeLessThan(0.01);
    expect(renderer.camera.position.distanceTo(positionBefore)).toBeLessThan(1e-9);
    expect(renderer.camera.position.distanceTo(renderer.controls.target)).toBeCloseTo(depth, 6);

    // A wheel carrying the command modifier belongs to the frame, not the
    // camera. A trackpad pinch arrives as exactly that with no key ever
    // pressed, so what decides it is the event and not the tracked key state.
    const settled = renderer.captureCameraState();
    const pinch = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: -240,
      ctrlKey: true,
      clientX: bounds.left + under.x,
      clientY: bounds.top + under.y,
    });
    canvas.dispatchEvent(pinch);
    expect(pinch.defaultPrevented).toBe(true);
    expect(renderer.zoomFlight).toBeNull();
    expect(renderer.captureCameraState()).toEqual(settled);

    // Without the easing a notch lands on the frame it is turned.
    lumine.config.set("graviss.smoothZoom", false);
    const stepped = renderer.camera.position.distanceTo(renderer.controls.target);
    spin(under, -120);
    expect(renderer.zoomFlight).toBeNull();
    expect(renderer.camera.position.distanceTo(renderer.controls.target)).toBeCloseTo(
      stepped * 0.8,
      6,
    );
    lumine.config.set("graviss.smoothZoom", true);
    await wheel(under, 120);

    // Turned off, the wheel pulls toward the middle and the point drifts.
    lumine.config.set("graviss.zoomTowardPointer", false);
    expect(renderer.controls.zoomToCursor).toBe(false);
    const centred = screenOf(world);
    await wheel(under, -240);
    const drifted = screenOf(world);
    expect(Math.hypot(drifted.x - centred.x, drifted.y - centred.y)).toBeGreaterThan(1);

    // An anchor is measured against the canvas, so a canvas with nothing to
    // measure has to leave the zoom unanchored rather than aim it at infinity.
    lumine.config.set("graviss.zoomTowardPointer", true);
    viewport.style.height = "0px";
    spin(under, -240);
    expect(renderer.captureCameraState().position.every(Number.isFinite)).toBe(true);
    expect(renderer.captureCameraState().target.every(Number.isFinite)).toBe(true);
  });

  it("eases an orthographic notch onto its framing, holding the point under the wheel", async () => {
    const item = await lumine.workspace.open(MAIN_EXAMPLE_URI, { searchAllPanes: true });
    await conditionPromise(() => item.renderer != null, "the Three.js scene to initialize");
    const renderer = item.renderer;
    const viewport = item.element.querySelector(".graviss-viewport");
    viewport.style.width = "800px";
    viewport.style.height = "400px";
    renderer.resize();
    renderer.setProjection("orthographic");

    const canvas = renderer.canvasRenderer.domElement;
    const bounds = canvas.getBoundingClientRect();
    const under = { x: bounds.width * 0.28, y: bounds.height * 0.34 };
    const spin = (deltaY) =>
      canvas.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaY,
          clientX: bounds.left + under.x,
          clientY: bounds.top + under.y,
        }),
      );
    const wheel = async (deltaY) => {
      spin(deltaY);
      await conditionPromise(() => renderer.zoomFlight == null, "the zoom to settle");
    };
    const framing = () => renderer.orthographicVisibleHeight();

    // An orthographic camera has no gap to close, so a notch narrows the
    // framing it draws through — and it eases onto it over several frames
    // exactly as the perspective camera eases onto a depth.
    const before = framing();
    spin(-120);
    expect(renderer.zoomFlight).not.toBeNull();
    expect(framing()).toBeGreaterThan(before * (1 - 0.2) * 1.05);
    await conditionPromise(() => renderer.zoomFlight == null, "the zoom to settle");
    expect(framing()).toBeCloseTo(before * (1 - 0.2), 6);

    // Whatever the wheel is over stays where it is, which for a parallel
    // projection means the camera slides across its own image plane.
    const world = renderer
      .unprojectPointer({
        x: (under.x / bounds.width) * 2 - 1,
        y: -(under.y / bounds.height) * 2 + 1,
      })
      .toArray();
    const screenOf = (point) => renderer.projectToScreen(point);
    const held = screenOf(world);
    await wheel(-240);
    const still = screenOf(world);
    expect(still.x).toBeCloseTo(held.x, 0);
    expect(still.y).toBeCloseTo(held.y, 0);

    // Turned off, the notch still eases; it simply stops being aimed.
    lumine.config.set("graviss.zoomTowardPointer", false);
    const centred = screenOf(world);
    await wheel(-240);
    expect(framing()).toBeLessThan(before);
    expect(
      Math.hypot(screenOf(world).x - centred.x, screenOf(world).y - centred.y),
    ).toBeGreaterThan(1);
    lumine.config.set("graviss.zoomTowardPointer", true);

    // Without the easing a notch lands on the frame it is turned.
    lumine.config.set("graviss.smoothZoom", false);
    const stepped = framing();
    spin(-120);
    expect(renderer.zoomFlight).toBeNull();
    expect(framing()).toBeCloseTo(stepped * (1 - 0.2), 6);
    lumine.config.set("graviss.smoothZoom", true);

    // However long the wheel is turned the framing stays a framing: something
    // narrower than the model's own coordinates draws nothing.
    for (let index = 0; index < 60; index += 1) spin(-360);
    await conditionPromise(() => renderer.zoomFlight == null, "the zoom to settle");
    expect(framing()).toBeGreaterThan(0);
    expect(framing()).toBeCloseTo(renderer.bounds.radius * 1e-4, 9);
    expect(renderer.captureCameraState().frustumHeight).toBeGreaterThan(0);
    for (let index = 0; index < 90; index += 1) spin(360);
    await conditionPromise(() => renderer.zoomFlight == null, "the zoom to settle");
    expect(framing()).toBeCloseTo(renderer.bounds.radius * 1e4, 3);

    // The eased value is a depth in one projection and a framing in the other,
    // so switching projections lands whatever was in flight rather than
    // carrying it across.
    spin(-360);
    expect(renderer.zoomFlight).not.toBeNull();
    renderer.setProjection("perspective");
    expect(renderer.zoomFlight).toBeNull();
    expect(renderer.captureCameraState().position.every(Number.isFinite)).toBe(true);
  });

  it("reveals and crops on resize instead of rescaling the framed view", async () => {
    const item = await lumine.workspace.open(MAIN_EXAMPLE_URI, { searchAllPanes: true });
    await conditionPromise(() => item.renderer != null, "the Three.js scene to initialize");
    const renderer = item.renderer;
    const viewport = item.element.querySelector(".graviss-viewport");
    viewport.style.width = "800px";
    viewport.style.height = "400px";
    renderer.resize();

    // A structure someone framed must stay exactly where it is on screen when
    // the pane changes height: more of the world appears above and below it,
    // rather than the same picture squeezed to the new height.
    const node = renderer.geometry.nodes[0];
    const centreOffset = () => {
      const seen = renderer.projectToScreen([node.x, node.y, node.z]);
      return {
        x: seen.x - renderer.host.clientWidth / 2,
        y: seen.y - renderer.host.clientHeight / 2,
      };
    };
    const before = centreOffset();
    const fovBefore = renderer.perspectiveCamera.fov;
    viewport.style.height = "800px";
    renderer.resize();
    const after = centreOffset();
    expect(after.x).toBeCloseTo(before.x, 3);
    expect(after.y).toBeCloseTo(before.y, 3);
    // The vertical angle follows the height, which is what holds the world a
    // pixel covers.
    expect(Math.tan((renderer.perspectiveCamera.fov * Math.PI) / 360)).toBeCloseTo(
      Math.tan((fovBefore * Math.PI) / 360) * 2,
      6,
    );

    // The orthographic projection holds its scale the same way.
    renderer.setProjection("orthographic");
    const orthoBefore = centreOffset();
    const heightBefore = renderer.orthographicHeight;
    viewport.style.height = "400px";
    renderer.resize();
    expect(renderer.orthographicHeight).toBeCloseTo(heightBefore / 2, 9);
    const orthoAfter = centreOffset();
    expect(orthoAfter.x).toBeCloseTo(orthoBefore.x, 3);
    expect(orthoAfter.y).toBeCloseTo(orthoBefore.y, 3);
  });

  it("keeps a floor under the camera however long the wheel is turned", async () => {
    const item = await lumine.workspace.open(MAIN_EXAMPLE_URI, { searchAllPanes: true });
    await conditionPromise(() => item.renderer != null, "the Three.js scene to initialize");
    const renderer = item.renderer;
    const viewport = item.element.querySelector(".graviss-viewport");
    viewport.style.width = "800px";
    viewport.style.height = "400px";
    renderer.resize();
    const canvas = renderer.canvasRenderer.domElement;
    // A dispatched pointer is not an active one, so the capture the controls
    // take on it would throw. Nothing here depends on it.
    canvas.setPointerCapture = () => {};
    canvas.releasePointerCapture = () => {};
    const bounds = canvas.getBoundingClientRect();
    const node = renderer.geometry.nodes[0];
    const seen = renderer.projectToScreen([node.x, node.y, node.z]);
    const wheel = (deltaY) =>
      canvas.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaY,
          clientX: bounds.left + Math.round(seen.x),
          clientY: bounds.top + Math.round(seen.y),
        }),
      );
    const distance = () => renderer.camera.position.distanceTo(renderer.controls.target);
    const floor = renderer.controls.minDistance;

    const aimedAt = () =>
      renderer.intersectionAt({
        clientX: bounds.left + Math.round(seen.x),
        clientY: bounds.top + Math.round(seen.y),
      });
    expect(aimedAt()).not.toBeNull();

    // Zoom scales the distance rather than subtracting from it, so a few dozen
    // clicks are enough to decay it by six orders of magnitude. Turned this
    // fast they compound onto one another rather than each starting again from
    // wherever the easing has got to.
    for (let step = 0; step < 300; step += 1) wheel(-120);
    await conditionPromise(() => renderer.zoomFlight == null, "the zoom to settle");
    expect(distance()).toBeGreaterThanOrEqual(floor - 1e-9);

    // And the camera is still on this side of what it was aimed at. Scaling the
    // step by the camera target instead walked it the target's whole distance
    // along the ray, straight through anything nearer than the target.
    const surface = aimedAt();
    expect(surface).not.toBeNull();
    expect(surface.distance).toBeGreaterThanOrEqual(floor - 1e-9);
    // The point of the floor: never inside the near plane. The depth range
    // follows the camera, so at the closest the wheel can rest the plane has
    // come back down below the surface being approached.
    expect(distance()).toBeGreaterThan(renderer.camera.near);

    // Everything still moves down there, in the world and not just on paper.
    const beforePan = renderer.camera.position.clone();
    renderer.controls.pan(80, 0);
    renderer.controls.update();
    expect(renderer.camera.position.distanceTo(beforePan)).toBeGreaterThan(floor * 0.1);
    const beforeOut = distance();
    wheel(240);
    await conditionPromise(() => renderer.zoomFlight == null, "the zoom to settle");
    expect(distance()).toBeGreaterThan(beforeOut);

    // A drag takes the camera over from a zoom still settling, rather than
    // orbiting against a view that has not come to rest.
    wheel(-120);
    expect(renderer.zoomFlight).not.toBeNull();
    canvas.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0, buttons: 1, pointerId: 1 }),
    );
    expect(renderer.zoomFlight).toBeNull();
    canvas.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 1 }));

    // A camera that collapsed before there was a floor is pulled back out by
    // the restore, so an already-saved document is not stuck for good.
    renderer.applyCameraState({
      projection: "perspective",
      position: [4.0000001, 5, 3.5],
      target: [4, 5, 3.5],
      up: [0, 0, 1],
      fieldOfView: 42,
    });
    expect(distance()).toBeGreaterThanOrEqual(renderer.controls.minDistance - 1e-9);
  });

  it("pins the pivot only where a gesture asks for one", async () => {
    const item = await lumine.workspace.open(MAIN_EXAMPLE_URI, { searchAllPanes: true });
    await conditionPromise(() => item.renderer != null, "the Three.js scene to initialize");
    const renderer = item.renderer;
    const viewport = item.element.querySelector(".graviss-viewport");
    const marker = item.element.querySelector(".graviss-orbit-pivot");
    viewport.style.width = "800px";
    viewport.style.height = "400px";
    renderer.resize();

    const canvas = renderer.canvasRenderer.domElement;
    canvas.setPointerCapture = () => {};
    canvas.releasePointerCapture = () => {};

    const bounds = canvas.getBoundingClientRect();
    const at = (point, held = {}) => ({
      bubbles: true,
      button: 0,
      buttons: 1,
      pointerId: 1,
      clientX: bounds.left + point.x,
      clientY: bounds.top + point.y,
      ...held,
    });
    const send = (type, point, held) =>
      canvas.dispatchEvent(new PointerEvent(type, at(point, held)));
    const node = renderer.geometry.nodes[0];
    const over = renderer.projectToScreen([node.x, node.y, node.z]);

    // A press that never moved is a click: it marks nothing and turns nothing.
    const restingPosition = renderer.camera.position.clone();
    send("pointerdown", over);
    send("pointerup", over);
    expect(marker.hidden).toBe(true);
    expect(renderer.camera.position.equals(restingPosition)).toBe(true);

    // Pressed where the model is not, there is nothing to pin to and the orbit
    // is the one it always was.
    const empty = [
      { x: 6, y: 6 },
      { x: 794, y: 6 },
      { x: 6, y: 394 },
      { x: 794, y: 394 },
    ].find((point) => !renderer.intersectionAt(at(point)));
    expect(empty).toBeDefined();
    send("pointerdown", empty);
    expect(renderer.orbitPivot).toBeNull();
    const emptyTarget = renderer.controls.target.clone();
    send("pointermove", { x: empty.x + 80, y: empty.y + 40 });
    expect(marker.hidden).toBe(true);
    send("pointerup", { x: empty.x + 80, y: empty.y + 40 });
    expect(renderer.controls.target.distanceTo(emptyTarget)).toBeLessThan(1e-8);

    // Held shift the controls pan, and a pan has no pivot: the offset survives.
    const panOffset = renderer.camera.position.clone().sub(renderer.controls.target);
    send("pointerdown", over, { shiftKey: true });
    expect(renderer.orbitPivot).toBeNull();
    send("pointermove", { x: over.x + 70, y: over.y }, { shiftKey: true });
    send("pointerup", { x: over.x + 70, y: over.y }, { shiftKey: true });
    expect(
      renderer.camera.position.clone().sub(renderer.controls.target).distanceTo(panOffset),
    ).toBeLessThan(1e-8);

    // Turned off, the drag is the classic orbit about the target.
    lumine.config.set("graviss.orbitAroundPointer", false);
    const classicTarget = renderer.controls.target.clone();
    const classicPosition = renderer.camera.position.clone();
    send("pointerdown", over);
    expect(renderer.orbitPivot).toBeNull();
    send("pointermove", { x: over.x + 90, y: over.y + 30 });
    send("pointerup", { x: over.x + 90, y: over.y + 30 });
    expect(renderer.controls.target.distanceTo(classicTarget)).toBeLessThan(1e-8);
    expect(renderer.camera.position.distanceTo(classicPosition)).toBeGreaterThan(0.1);

    // The mark can be dropped without dropping the pivot with it.
    lumine.config.set("graviss.orbitAroundPointer", true);
    lumine.config.set("graviss.showOrbitPivot", false);
    const marked = renderer.projectToScreen([node.x, node.y, node.z]);
    send("pointerdown", marked);
    send("pointermove", { x: marked.x + 40, y: marked.y + 20 });
    expect(renderer.orbitPivot.rotating).toBe(true);
    expect(marker.hidden).toBe(true);
    send("pointerup", { x: marked.x + 40, y: marked.y + 20 });
  });

  it("exports the region as the very pixels the viewport shows there", async () => {
    const item = await lumine.workspace.open(MAIN_EXAMPLE_URI, { searchAllPanes: true });
    await conditionPromise(() => item.renderer != null, "the Three.js scene to initialize");
    const renderer = item.renderer;
    renderer.host.style.width = "800px";
    renderer.host.style.height = "500px";
    renderer.resize();
    expect(renderer.camera.isPerspectiveCamera).toBe(true);

    // A frame far off in a corner is where a head-on render and the oblique one
    // the viewport shows disagree most under perspective. The export crops the
    // view it is already in, so the two agree exactly.
    const region = renderer.printRegionFromViewportFractions({
      x: 0.02,
      y: 0.02,
      width: 0.34,
      height: 0.34,
    });
    const image = renderer.renderPrintImage(region, { maxEdge: 272 });

    expect(image.width).toBe(272);
    expect(image.height).toBe(170);
    expect(image.region.width).toBeCloseTo(0.34 * 800, 6);
    expect(image.region.height).toBeCloseTo(0.34 * 500, 6);

    // The camera is not moved to take the crop; an off-axis frustum is what
    // makes it the same view rather than a new one aimed at the frame.
    expect(renderer.camera.view?.enabled).toBeFalsy();

    // The same stored metres print the same picture from any pane — which is
    // what a region is for: an unambiguous plot area, for any window and for
    // a batch render that never had one.
    renderer.host.style.width = "320px";
    renderer.host.style.height = "400px";
    renderer.resize();
    const again = renderer.renderPrintImage(region, { maxEdge: 272 });
    expect(again.width).toBe(image.width);
    expect(again.height).toBe(image.height);
    expect(again.dataUrl).toBe(image.dataUrl);
  });

  it("frames the structure itself, with and without a border", async () => {
    const item = await lumine.workspace.open(MAIN_EXAMPLE_URI, { searchAllPanes: true });
    await conditionPromise(() => item.renderer != null, "the Three.js scene to initialize");
    const renderer = item.renderer;
    renderer.host.style.width = "800px";
    renderer.host.style.height = "500px";
    renderer.resize();

    const tight = item.autoSelectPrintRegion();
    expect(item.getPrintRegion()).toEqual(tight);
    expect(tight.width).toBeGreaterThan(0);
    expect(tight.height).toBeGreaterThan(0);

    // The frame is measured from the structure, not from the reference grid,
    // which spreads well beyond it.
    expect(renderer.grid.userData.gravissGridSize).toBeGreaterThan(renderer.bounds.radius * 2);
    expect(item.printRegionFractions().width).toBeLessThan(1);

    // It is measured from what is drawn rather than from where the nodes are.
    // A rendered section stands off its own centre line, and a support symbol
    // hangs below its node, so a frame taken from the node envelope alone would
    // cut both off.
    const drawn = renderer.visibleModelBounds();
    const nodes = new renderer.THREE.Box3(
      new renderer.THREE.Vector3(...renderer.bounds.min),
      new renderer.THREE.Vector3(...renderer.bounds.max),
    );
    expect(drawn.containsBox(nodes)).toBe(true);
    expect(drawn.min.z).toBeLessThan(nodes.min.z);
    expect(drawn.max.x).toBeGreaterThan(nodes.max.x);

    // Hiding a kind of element frees the room it was taking.
    item.setVisibility("supports", false);
    expect(renderer.visibleModelBounds().min.z).toBeGreaterThan(drawn.min.z);
    item.setVisibility("supports", true);

    // A structure reaching past the viewport is framed whole anyway: the
    // frame reaches past the pane wherever the structure does, because the
    // plot area must not depend on the window it was asked from.
    renderer.zoomCamera("in");
    renderer.zoomCamera("in");
    renderer.zoomCamera("in");
    const raw = renderer.modelScreenRect();
    expect(raw.x < 0 || raw.y < 0 || raw.x + raw.width > 1 || raw.y + raw.height > 1).toBe(true);
    const framed = item.autoSelectPrintRegion(0.02);
    expect(item.getPrintRegion()).toEqual(framed);
    const framedFractions = item.printRegionFractions();
    expect(
      framedFractions.x < 0 ||
        framedFractions.y < 0 ||
        framedFractions.x + framedFractions.width > 1 ||
        framedFractions.y + framedFractions.height > 1,
    ).toBe(true);
    item.clearPrintRegion();
    item.dispatchCommand("graviss:fit-view");
    await conditionPromise(() => renderer.modelScreenRect().width < 1, "the fitted view");

    // With a border it grows by two per cent of its longer side on each side.
    // Measured afresh, because the fit above moved the camera; asserted in
    // fractions of the unmoving camera's view, where the margin rule lives.
    item.autoSelectPrintRegion();
    const refitted = item.printRegionFractions();
    const bordered = item.autoSelectPrintRegion(0.02);
    const borderedFractions = item.printRegionFractions();
    // The margin is one distance, so it is the same number of pixels on every
    // side rather than the same fraction of two axes of different length.
    const viewport = renderer.viewportPixels();
    const margin =
      Math.max(refitted.width * viewport.width, refitted.height * viewport.height) * 0.02;
    expect(borderedFractions.width).toBeCloseTo(refitted.width + (margin * 2) / viewport.width, 6);
    expect(borderedFractions.x).toBeCloseTo(refitted.x - margin / viewport.width, 6);
    expect(item.getPrintRegion()).toEqual(bordered);
  });

  it("repaints the canvas in the same task as a resize", async () => {
    const item = await lumine.workspace.open(MAIN_EXAMPLE_URI, { searchAllPanes: true });
    await conditionPromise(() => item.renderer != null, "the Three.js scene to initialize");
    const renderer = item.renderer;

    // Resizing the drawing buffer clears it on the spot, and the observer
    // fires before paint: a repaint deferred to the next animation frame
    // would let the compositor show the empty canvas first, flashing the
    // pane's bare background on every step of a resize drag.
    const rendered = spyOn(renderer.canvasRenderer, "render").and.callThrough();
    renderer.host.style.width = "612px";
    renderer.host.style.height = "364px";
    renderer.resize();
    expect(rendered).toHaveBeenCalled();
  });

  it("frames the whole model without moving the camera", async () => {
    const item = await lumine.workspace.open(MAIN_EXAMPLE_URI, { searchAllPanes: true });
    await conditionPromise(() => item.renderer != null, "the Three.js scene to initialize");
    const renderer = item.renderer;
    renderer.host.style.width = "700px";
    renderer.host.style.height = "440px";
    renderer.resize();
    renderer.moveCamera("left");
    renderer.zoomCamera("in");
    expect(renderer.camera.isPerspectiveCamera).toBe(true);

    // Moving the camera to aim at the model would change the perspective, so an
    // image with no region reaches past the edges of the view instead of being
    // taken from somewhere the viewport never was.
    const before = renderer.captureCameraState();
    expect(item.getPrintRegion()).toBeNull();
    const image = renderer.renderPrintImage(null, { maxEdge: 400 });

    expect(image.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(renderer.captureCameraState()).toEqual(before);
    expect(renderer.camera.view?.enabled).toBeFalsy();
  });

  it("renders a print at the region's shape and leaves the viewport as it was", async () => {
    const item = await lumine.workspace.open(MAIN_EXAMPLE_URI, { searchAllPanes: true });
    await conditionPromise(() => item.renderer != null, "the Three.js scene to initialize");
    const renderer = item.renderer;
    renderer.host.style.width = "640px";
    renderer.host.style.height = "480px";
    renderer.resize();
    const before = renderer.captureCameraState();
    const beforeSize = renderer.canvasRenderer.getSize(new renderer.THREE.Vector2());

    const image = renderer.renderPrintImage(
      renderer.printRegionFromViewportFractions({ x: 0, y: 0.25, width: 1, height: 0.5 }),
      {
        maxEdge: 800,
      },
    );

    expect(image.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    // The raster keeps the shape of what the region covers.
    expect(image.width / image.height).toBeCloseTo(image.region.width / image.region.height, 3);

    // Printing from the viewport must not disturb it.
    expect(renderer.captureCameraState()).toEqual(before);
    expect(renderer.canvasRenderer.getSize(new renderer.THREE.Vector2())).toEqual(beforeSize);
  });

  it("declares its workspace commands and tree-view context menu", () => {
    const manifest = require("../package.json");
    const menus = require("../menus/main.json");
    const contextItems = menus["context-menu"]['.tree-view .file[data-path$=".grv"]'];
    const commands = lumine.commands
      .findCommands({ target: lumine.workspace.getElement() })
      .map(({ name }) => name);

    expect(manifest.activationCommands).toBeUndefined();
    expect(manifest.consumedServices["tree-view.selection"]).toBeDefined();
    expect(commands).toContain("graviss:open-source");
    expect(commands).toContain("graviss:open-source-on-right");
    expect(menus.menu[0].submenu[0].submenu).toContain(
      jasmine.objectContaining({ label: "Open Source", command: "graviss:open-source" }),
    );
    expect(menus.menu[0].submenu[0].submenu).toContain(
      jasmine.objectContaining({
        label: "Open Source on Right",
        command: "graviss:open-source-on-right",
      }),
    );
    expect(contextItems).toContain(
      jasmine.objectContaining({
        label: "Open Source on Right",
        command: "graviss:open-source-on-right",
      }),
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
    // The graphic controls stay on screen even here, where there is no
    // document to page through or edit; they are disabled instead of gone.
    expect(viewer.element.querySelector(".graviss-graphic-actions").hidden).toBe(false);
    for (const action of ["previous-graphic", "next-graphic", "add-graphic", "delete-graphic"]) {
      expect(viewer.element.querySelector(`[data-action="${action}"]`).disabled).toBe(true);
    }
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
    expect(updates[0].headers.find(({ currentCount }) => currentCount === 1).graphicIndex).toBe(0);

    spyOn(viewer, "focus");
    const dispatchCommand = spyOn(viewer, "dispatchCommand").and.callThrough();
    expect(adapter.navigateTo(viewer, updates[0].headers[1], { focus: false })).toBe(true);
    expect(dispatchCommand).toHaveBeenCalled();
    const [commandName, detail] = dispatchCommand.calls.mostRecent().args;
    expect(commandName).toBe("graviss:activate-graphic");
    expect(detail.graphicIndex).toBe(1);
    expect(detail.activated).toBe(true);
    expect(viewer.activeGraphic.title).toBe("Roof plan");
    expect(viewer.focus).not.toHaveBeenCalled();
    expect(updates.at(-1).headers.find(({ currentCount }) => currentCount === 1).graphicIndex).toBe(
      1,
    );

    expect(adapter.navigateTo(viewer, updates[0].headers[2])).toBe(true);
    expect(viewer.activeGraphic.title).toBe("Frame elevation");
    expect(viewer.focus).toHaveBeenCalled();
    expect(adapter.navigateTo(viewer, { graphicIndex: 99 })).toBe(false);

    const updateCount = updates.length;
    disposable.dispose();
    viewer.activateGraphic(0);
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

  it("names a tab after the file when the document names nothing", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "graviss-tab-title-"));
    const untitled = { ...MAIN_EXAMPLE.viewDocument };
    delete untitled.title;
    const mainPath = path.join(directory, "main.grv");
    fs.writeFileSync(mainPath, `${JSON.stringify(untitled, null, 2)}\n`);
    const providerDisposable = mainModule.consumeGravissSource({
      id: "titled-models",
      createSession: ({ filePath }) =>
        path.extname(filePath) === ".grv" ? new TestSession(MAIN_EXAMPLE) : null,
    });

    // Extension included, exactly as the editor writes it for the source of
    // the same file, so the icon is what tells the two tabs apart.
    const viewer = mainModule.createFileViewer(mainPath);
    expect(viewer.getTitle()).toBe("main.grv");
    expect(viewer.getIconName()).toBe("graph");
    await conditionPromise(() => viewer.renderer != null, "the Three.js scene to initialize");
    // Loading resolves the title again and must not talk itself into the
    // model's own name.
    expect(viewer.getTitle()).toBe("main.grv");

    // Nothing to be told apart from, so the tab stays as it is even when the
    // bar asks — which it does whenever the source of this very file is open.
    expect(viewer.getLongTitle()).toBe("main.grv");

    // A second render of a same-named file in another folder is the case that
    // does need it.
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "graviss-tab-title-"));
    const otherPath = path.join(other, "main.grv");
    fs.writeFileSync(otherPath, `${JSON.stringify(untitled, null, 2)}\n`);
    const opened = await lumine.workspace.open(mainPath, { searchAllPanes: true });
    const sibling = await lumine.workspace.open(otherPath, { searchAllPanes: true });
    expect(opened.getLongTitle()).toBe(`main.grv — ${path.basename(directory)}`);
    expect(sibling.getLongTitle()).toBe(`main.grv — ${path.basename(other)}`);

    // A document that names itself keeps its name.
    const named = path.join(directory, "named.grv");
    fs.writeFileSync(named, `${JSON.stringify(MAIN_EXAMPLE.viewDocument, null, 2)}\n`);
    const titled = mainModule.createFileViewer(named);
    expect(titled.getTitle()).toBe(MAIN_EXAMPLE.viewDocument.title);

    titled.destroy();
    viewer.destroy();
    providerDisposable.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  });

  it("draws springs and couplings as marks between the nodes they join", async () => {
    const model = {
      id: "connectors",
      title: "Connectors",
      format: "Spec fixture",
      createGeometry: () => ({
        nodes: [
          { id: 1, x: 0, y: 0, z: 0 },
          { id: 2, x: 0, y: 0, z: 2 },
          { id: 3, x: 4, y: 0, z: 0 },
          { id: 4, x: 4, y: 0, z: 2 },
          { id: 5, x: 8, y: 0, z: 0 },
        ],
        elements: [
          { id: "S1", kind: "spring", nodeIds: [1, 2] },
          { id: "C1", kind: "coupling", nodeIds: [3, 4] },
          // A spring between a node and the ground names one node and says
          // which way it acts.
          { id: "S2", kind: "spring", nodeIds: [5], direction: [0, 0, 1] },
        ],
        sections: [],
        supports: [],
      }),
    };
    const viewer = mainModule.createViewer(new TestSession(model), { title: model.title });
    jasmine.attachToDOM(viewer.element);
    try {
      const failure = viewer.element.querySelector(".graviss-error");
      await conditionPromise(
        () => viewer.renderer != null || !failure.hidden,
        "the Three.js scene to initialize",
      );
      if (!viewer.renderer) {
        fail(viewer.element.querySelector(".graviss-error-message").textContent);
        return;
      }
      const renderer = viewer.renderer;
      expect(renderer.meshes.springs).not.toBeUndefined();
      expect(renderer.meshes.couplings).not.toBeUndefined();

      const spread = (mesh) => {
        const box = new renderer.THREE.Box3().setFromObject(mesh);
        return box.getSize(new renderer.THREE.Vector3());
      };

      // A coupling is a rigid link, and a line between the nodes is the whole
      // of what it is: nothing of it stands off that line.
      const coupling = spread(renderer.meshes.couplings);
      expect(coupling.z).toBeCloseTo(2, 5);
      expect(coupling.x).toBeCloseTo(0, 6);
      expect(coupling.y).toBeCloseTo(0, 6);

      // A spring acting along its axis is a helix, so it turns about that axis
      // rather than running straight down it — in both directions square to it,
      // which is what makes it a helix and not a zigzag.
      const springs = new renderer.THREE.Box3().setFromObject(renderer.meshes.springs);
      const size = renderer.getSymbolSize();
      expect(springs.min.z).toBeCloseTo(0, 5);
      const reach = springs.getSize(new renderer.THREE.Vector3());
      expect(reach.y).toBeCloseTo(size * 2, 5);
      // The grounded one starts at the node it holds and reaches out the way it
      // was told to, rather than joining anything.
      expect(springs.max.x).toBeCloseTo(8 + size, 5);

      // A spring acting about its axis is drawn as a turn about it instead: a
      // ring across the axis, at the middle of the length it spans.
      renderer.geometry.elements[0].rotational = true;
      renderer.placeConnectorSymbols("spring");
      const turning = new renderer.THREE.Box3().setFromObject(renderer.meshes.springs);
      expect(turning.getSize(new renderer.THREE.Vector3()).y).toBeCloseTo(size * 2, 5);
      // A ring lies across the axis, so it reaches no further along it than the
      // nodes do — a helix would, having to climb between them.
      expect(turning.max.z).toBeCloseTo(2, 5);
      renderer.geometry.elements[0].rotational = false;
      renderer.placeConnectorSymbols("spring");

      // Both are marks, so the one size covers them with the nodes.
      const before = spread(renderer.meshes.springs).y;
      renderer.setSymbolSize(renderer.getSymbolSize() * 2);
      expect(spread(renderer.meshes.springs).y).toBeCloseTo(before * 2, 5);

      // Clicking anywhere on a spring selects that spring. A helix owns a whole
      // run of vertices rather than the two a straight member does, so which
      // entity a vertex belongs to is a question for the range table and not
      // for arithmetic on the index.
      const lines = renderer.pickables.find((mesh) => mesh.userData.gravissType === "spring");
      const ranges = lines.userData.gravissEntityRanges;
      expect(ranges.length).toBe(2);
      expect(ranges[0].count).toBeGreaterThan(2);
      for (const [index, range] of ranges.entries()) {
        for (const vertex of [range.start, range.start + range.count - 1]) {
          expect(entityIndexAtVertex(ranges, vertex)).toBe(index);
        }
      }
      // Past the last vertex nothing owns it, and nothing is selected.
      const last = ranges.at(-1);
      expect(entityIndexAtVertex(ranges, last.start + last.count)).toBeUndefined();
      expect(entityIndexAtVertex(ranges, -1)).toBeUndefined();

      // And both can be put away on their own.
      renderer.setVisibility("springs", false);
      expect(renderer.meshes.springs.visible).toBe(false);
      expect(renderer.meshes.couplings.visible).toBe(true);
    } finally {
      viewer.destroy();
    }
  });

  it("draws trusses and cables as members, section and all", async () => {
    const model = {
      id: "members",
      title: "Members",
      format: "Spec fixture",
      createGeometry: () => ({
        nodes: [
          { id: 1, x: 0, y: 0, z: 0 },
          { id: 2, x: 4, y: 0, z: 0 },
          { id: 3, x: 8, y: 0, z: 0 },
          { id: 4, x: 12, y: 0, z: 0 },
        ],
        // A truss and a cable are structure, so they are drawn as members
        // beside the beams rather than as marks. Neither states local axes —
        // an axial member has no bending for a section orientation to matter
        // to, and a source that has none says none.
        elements: [
          {
            id: "B1",
            kind: "beam",
            nodeIds: [1, 2],
            sectionId: "S1",
            localAxes: { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
          },
          { id: "T1", kind: "truss", nodeIds: [2, 3], sectionId: "S1" },
          { id: "K1", kind: "cable", nodeIds: [3, 4], sectionId: "S1" },
        ],
        sections: [{ id: "S1", shape: { kind: "rectangle", width: 0.2, height: 0.3 } }],
        supports: [],
      }),
    };
    const viewer = mainModule.createViewer(new TestSession(model), { title: model.title });
    jasmine.attachToDOM(viewer.element);
    try {
      const failure = viewer.element.querySelector(".graviss-error");
      await conditionPromise(
        () => viewer.renderer != null || !failure.hidden,
        "the Three.js scene to initialize",
      );
      if (!viewer.renderer) {
        fail(viewer.element.querySelector(".graviss-error-message").textContent);
        return;
      }
      const renderer = viewer.renderer;
      expect(renderer.getSceneSummary().members).toBe(3);
      expect(viewer.getGeometrySummary().members).toBe(3);

      // All three share one section, so they are baked into one fill: three
      // boxes of thirty-six vertices, one entity range each.
      const memberMesh = renderer.pickables.find(
        (mesh) => mesh.userData.gravissColorKey === "element",
      );
      expect(memberMesh.userData.gravissEntityRanges.length).toBe(3);
      // Three members sharing one section is one upload of that section and
      // three placements, not three copies of its triangles.
      expect(memberMesh.count).toBe(3);
      expect(memberMesh.geometry.getAttribute("position").count).toBe(24);
      const box = new renderer.THREE.Box3().setFromObject(renderer.meshes.members);
      expect(box.min.x).toBeCloseTo(0, 5);
      expect(box.max.x).toBeCloseTo(12, 5);

      // Section rendering off puts every member back on its centreline, and
      // the axial ones go with the beam rather than disappearing.
      renderer.setSectionRendering(false);
      expect(renderer.getSceneSummary().members).toBe(3);
      const lines = renderer.pickables.find((mesh) => mesh.userData.gravissLineSegments);
      expect(lines.userData.gravissEntityRanges.length).toBe(3);

      // One switch covers the members, whatever they carry.
      renderer.setVisibility("members", false);
      expect(renderer.meshes.members.visible).toBe(false);
      renderer.setVisibility("members", true);

      // Rebuilding the members paints what it built. The fill is drawn by
      // vertex colour and a fresh bake carries an attribute of zeros, so a
      // rebuild that left it alone would render every member black.
      renderer.setSectionRendering(true);
      const painted = () => {
        const mesh = renderer.pickables.find((m) => m.userData.gravissColorKey === "element");
        const colors = mesh.instanceColor?.array;
        return Boolean(colors) && [...colors].some((value) => value > 0);
      };
      expect(painted()).toBe(true);
      renderer.rebuildMemberMeshes();
      expect(painted()).toBe(true);

      // And a selection does not outlive the geometry it was picked from.
      const mesh = renderer.pickables.find((m) => m.userData.gravissColorKey === "element");
      renderer.setSelected({
        type: "element",
        entity: mesh.userData.gravissEntities[0],
        entityIndex: 0,
        instanceId: 0,
        object: mesh,
      });
      expect(renderer.selected).not.toBeNull();
      renderer.rebuildMemberMeshes();
      expect(renderer.selected).toBeNull();
    } finally {
      viewer.destroy();
    }
  });

  it("turns a slab rather than shearing it when the model moves", async () => {
    // Two quads meeting along an edge, thick enough to have two faces. Rotating
    // them about that edge is the case that decides whether the corner normals
    // are computed again or frozen: frozen, the mid-surface bends while the
    // faces stay parallel to the shape at rest, and a slab swinging about its
    // root renders edge on with no thickness at all.
    const model = {
      id: "turning-slab",
      title: "Turning slab",
      format: "Spec fixture",
      createGeometry: () => ({
        nodes: [
          { id: 1, x: 0, y: 0, z: 0 },
          { id: 2, x: 1, y: 0, z: 0 },
          { id: 3, x: 1, y: 1, z: 0 },
          { id: 4, x: 0, y: 1, z: 0 },
        ],
        elements: [{ id: 1, kind: "shell", nodeIds: [1, 2, 3, 4], thickness: 0.2 }],
        sections: [],
        supports: [],
      }),
    };
    const viewer = mainModule.createViewer(new TestSession(model), { title: model.title });
    jasmine.attachToDOM(viewer.element);
    try {
      const failure = viewer.element.querySelector(".graviss-error");
      await conditionPromise(
        () => viewer.renderer != null || !failure.hidden,
        "the Three.js scene to initialize",
      );
      if (!viewer.renderer) {
        fail(viewer.element.querySelector(".graviss-error-message").textContent);
        return;
      }
      const renderer = viewer.renderer;
      // Measured from the positions themselves rather than through Box3: a
      // mesh's bounding box is cached on its geometry, and nothing invalidates
      // it when the surface is written again.
      const thickness = () => {
        const positions = renderer.meshes.shells.geometry.getAttribute("position");
        const span = { x: [Infinity, -Infinity], z: [Infinity, -Infinity] };
        for (let vertex = 0; vertex < positions.count; vertex += 1) {
          span.x[0] = Math.min(span.x[0], positions.getX(vertex));
          span.x[1] = Math.max(span.x[1], positions.getX(vertex));
          span.z[0] = Math.min(span.z[0], positions.getZ(vertex));
          span.z[1] = Math.max(span.z[1], positions.getZ(vertex));
        }
        return { x: span.x[1] - span.x[0], z: span.z[1] - span.z[0] };
      };
      // At rest: a fifth of a metre thick, lying flat.
      expect(thickness().z).toBeCloseTo(0.2, 6);

      // Stand it on the edge through nodes 1 and 4, which is a rigid rotation
      // and not a bend, so it keeps every bit of its thickness - now measured
      // across x rather than up z.
      renderer.setResult({
        kind: "displacement",
        loadCaseId: 1,
        components: 3,
        nodes: { ids: [2, 3], values: [-1, 0, 1, -1, 0, 1] },
        extent: 1,
      });
      renderer.setDeformationScale(1);
      const turned = thickness();
      expect(turned.x).toBeCloseTo(0.2, 5);
      expect(turned.z).toBeGreaterThan(0.9);

      // What the model measures is what it measures now. A bounding box is
      // cached on a geometry, and nothing invalidates it when the positions
      // underneath are written again - so a model that has moved would
      // otherwise be framed, printed and picked against where it was at rest.
      const measured = renderer.visibleModelBounds();
      expect(measured.max.z).toBeGreaterThan(0.9);

      // And back exactly, which is what a scale of zero is for.
      renderer.setDeformationScale(0);
      expect(thickness().z).toBeCloseTo(0.2, 6);
      expect(renderer.visibleModelBounds().max.z).toBeLessThan(0.2);
    } finally {
      viewer.destroy();
    }
  });

  it("narrows the area elements as well as the line ones", async () => {
    const viewer = createFixtureViewer(SHELL_EXAMPLE);
    jasmine.attachToDOM(viewer.element);
    try {
      await conditionPromise(() => viewer.renderer != null, "the Three.js scene to initialize");
      const renderer = viewer.renderer;
      const shells = renderer.pickables.find((mesh) => mesh.userData.gravissColorKey === "shell");
      const positions = shells.geometry.getAttribute("position");
      const first = renderer.geometry.elements.find((element) => element.kind === "shell");
      const area = () => {
        const range = shells.userData.gravissEntityRanges[0];
        const box = new Set();
        for (let vertex = range.start; vertex < range.start + range.count; vertex += 1) {
          box.add(`${positions.getX(vertex)}:${positions.getY(vertex)}:${positions.getZ(vertex)}`);
        }
        return box.size;
      };
      expect(area()).toBeGreaterThan(1);

      // Folded onto one of its own corners: every offset it had is still where
      // it was, and a triangle with no area rasterises to nothing.
      renderer.setElementFilter(() => false);
      expect(area()).toBe(1);
      expect(shells.userData.gravissEntityRanges[0].count).toBeGreaterThan(1);
      expect(renderer.elementCounts().get("shell").shown).toBe(0);

      // And it comes back where it was, not somewhere near it.
      renderer.setElementFilter((element) => element.id === first.id);
      expect(area()).toBeGreaterThan(1);
      expect(renderer.elementCounts().get("shell")).toEqual({
        total: renderer.elementCounts().get("shell").total,
        shown: 1,
      });
    } finally {
      viewer.destroy();
    }
  });

  it("gives each member kind its own colour and its own switch", async () => {
    const model = {
      id: "kinds",
      title: "Kinds",
      format: "Spec fixture",
      createGeometry: () => ({
        nodes: [
          { id: 1, x: 0, y: 0, z: 0 },
          { id: 2, x: 6, y: 0, z: 0 },
          { id: 3, x: 12, y: 0, z: 0 },
          { id: 4, x: 18, y: 0, z: 0 },
        ],
        elements: [
          { id: "B1", kind: "beam", number: 1, sectionId: "R", nodeIds: [1, 2] },
          { id: "T1", kind: "truss", number: 2, sectionId: "R", nodeIds: [2, 3] },
          { id: "C1", kind: "cable", number: 3, sectionId: "R", nodeIds: [3, 4] },
        ],
        sections: [{ id: "R", shape: { kind: "rectangle", width: 0.2, height: 0.4 } }],
        supports: [],
      }),
    };
    const viewer = mainModule.createViewer(new TestSession(model), { title: model.title });
    jasmine.attachToDOM(viewer.element);
    try {
      const failure = viewer.element.querySelector(".graviss-error");
      await conditionPromise(
        () => viewer.renderer != null || !failure.hidden,
        "the Three.js scene to initialize",
      );
      if (!viewer.renderer) {
        fail(viewer.element.querySelector(".graviss-error-message").textContent);
        return;
      }
      const renderer = viewer.renderer;
      const fill = renderer.pickables.find((m) => m.userData.gravissColorKey === "element");
      const colorAt = (instance) => {
        const at = instance * 3;
        return [
          fill.instanceColor.array[at],
          fill.instanceColor.array[at + 1],
          fill.instanceColor.array[at + 2],
        ].map((channel) => Math.round(channel * 1000));
      };
      const of = (id) => {
        const index = fill.userData.gravissEntities.findIndex((entity) => entity.id === id);
        return colorAt(fill.userData.gravissEntityRanges[index].start);
      };
      // A beam is the member colour the scheme names; the other two step off it,
      // so all three differ and none of them is black.
      const beam = of("B1");
      expect(beam).toEqual([...renderer.colors.element.toArray()].map((c) => Math.round(c * 1000)));
      expect(of("T1")).not.toEqual(beam);
      expect(of("C1")).not.toEqual(beam);
      expect(of("C1")).not.toEqual(of("T1"));

      // A kind is narrowed away as a rule like any other question, and the
      // members umbrella is still the layer switch above all of them.
      const subjects = subjectsByKey(buildSubjects(renderer.geometry));
      renderer.setElementFilter(
        compileRules([{ sign: "-", type: "@kind", text: "truss" }], subjects),
      );
      expect(fill.count).toBe(2);
      expect(renderer.elementCounts().get("truss")).toEqual({ total: 1, shown: 0 });
      expect(renderer.elementCounts().get("beam")).toEqual({ total: 1, shown: 1 });
      expect(renderer.meshes.members.visible).toBe(true);
      renderer.setVisibility("members", false);
      expect(renderer.meshes.members.visible).toBe(false);
      renderer.setVisibility("members", true);
      renderer.setElementFilter(null);
      expect(fill.count).toBe(3);

      // Two rules narrow the same model together, for all six kinds rather
      // than the three that used to have switches.
      renderer.setElementFilter(
        compileRules(
          [
            { sign: "+", type: "@number", text: "2,3" },
            { sign: "-", type: "@kind", text: "cable" },
          ],
          subjects,
        ),
      );
      expect(fill.count).toBe(1);
      expect(fill.userData.gravissEntities[fill.userData.gravissSegmentToEntityIndex[0]].id).toBe(
        "T1",
      );

      // Selecting something and then narrowing it away does not leave a
      // selection pointing at an instance another element now occupies.
      renderer.setElementFilter(null);
      renderer.setSelected({
        type: "element",
        entity: fill.userData.gravissEntities.find((entity) => entity.id === "C1"),
        entityIndex: fill.userData.gravissEntities.findIndex((entity) => entity.id === "C1"),
        object: fill,
        instanceId: 2,
      });
      expect(renderer.selected).not.toBeNull();
      renderer.setElementFilter(
        compileRules([{ sign: "-", type: "@kind", text: "cable" }], subjects),
      );
      expect(renderer.selected).toBeNull();
    } finally {
      viewer.destroy();
    }
  });

  it("draws only the elements a filter keeps, and all of them again when it is dropped", async () => {
    const model = {
      id: "filtered",
      title: "Filtered",
      format: "Spec fixture",
      createGeometry: () => ({
        nodes: [
          { id: 1, x: 0, y: 0, z: 0 },
          { id: 2, x: 6, y: 0, z: 0 },
          { id: 3, x: 12, y: 0, z: 0 },
          { id: 4, x: 18, y: 0, z: 0 },
        ],
        filterTypes: [
          {
            id: "group",
            title: "Group",
            numeric: true,
            values: [{ id: 11, title: "Deck" }, { id: 12 }],
          },
        ],
        elements: [
          {
            id: "B1",
            kind: "beam",
            number: 101,
            sectionId: "R",
            nodeIds: [1, 2],
            filterValues: { group: 11 },
          },
          {
            id: "B2",
            kind: "beam",
            number: 102,
            sectionId: "R",
            nodeIds: [2, 3],
            filterValues: { group: 11 },
          },
          {
            id: "B3",
            kind: "beam",
            number: 201,
            sectionId: "R",
            nodeIds: [3, 4],
            filterValues: { group: 12 },
          },
        ],
        sections: [{ id: "R", shape: { kind: "rectangle", width: 0.2, height: 0.4 } }],
        supports: [],
      }),
    };
    const viewer = mainModule.createViewer(new TestSession(model), { title: model.title });
    jasmine.attachToDOM(viewer.element);
    try {
      const failure = viewer.element.querySelector(".graviss-error");
      await conditionPromise(
        () => viewer.renderer != null || !failure.hidden,
        "the Three.js scene to initialize",
      );
      if (!viewer.renderer) {
        fail(viewer.element.querySelector(".graviss-error-message").textContent);
        return;
      }
      const renderer = viewer.renderer;
      const fill = renderer.pickables.find((m) => m.userData.gravissColorKey === "element");
      const contours = renderer.memberContours[0];
      expect(fill.count).toBe(3);

      // Hiding is drawing fewer instances rather than drawing them invisibly:
      // the ones that survive are moved to the front and the count is cut.
      const subjects = subjectsByKey(buildSubjects(renderer.geometry));
      renderer.setElementFilter(
        compileRules([{ sign: "+", type: "@number", text: "1*" }], subjects),
      );
      expect(fill.count).toBe(2);
      expect(contours.geometry.instanceCount).toBe(2);
      // Both survivors are still findable by what they are, wherever they now
      // sit in the buffer.
      const drawn = new Set();
      for (let instance = 0; instance < fill.count; instance += 1) {
        drawn.add(
          fill.userData.gravissEntities[fill.userData.gravissSegmentToEntityIndex[instance]].id,
        );
      }
      expect([...drawn].sort()).toEqual(["B1", "B2"]);

      // A facet narrows it the same way, and the counts a panel shows follow.
      renderer.setElementFilter(compileRules([{ sign: "+", type: "group", text: "12" }], subjects));
      expect(fill.count).toBe(1);
      expect(renderer.elementCounts().get("beam")).toEqual({ total: 3, shown: 1 });

      // Dropping the filter draws everything again, and every element answers
      // for itself once more — a stale mapping here would name the wrong one.
      renderer.setElementFilter(null);
      expect(fill.count).toBe(3);
      for (let instance = 0; instance < fill.count; instance += 1) {
        expect(fill.userData.gravissSegmentToEntityIndex[instance]).toBe(instance);
      }
      expect(renderer.elementCounts().get("beam")).toEqual({ total: 3, shown: 3 });
    } finally {
      viewer.destroy();
    }
  });

  describe("showing an analysis", () => {
    // A little bridge with three cases, one of which is a mode shape. Node 3
    // moves in every case, so a scale and a colour both have something to say.
    function analysedModel() {
      return {
        id: "analysed",
        title: "Analysed",
        format: "Spec fixture",
        loadCases: [
          { id: 101, title: "self-weight", kind: "linear", hasResults: true },
          { id: 192, title: "dead-load", kind: "linear", hasResults: true },
          { id: 901, title: "1st mode", kind: "eigenmode", hasResults: true },
        ],
        createResult: (loadCaseId) => ({
          kind: "displacement",
          loadCaseId,
          components: 3,
          nodes: { ids: [3], values: [0, 0, loadCaseId === 901 ? -0.05 : -0.01] },
          extent: loadCaseId === 901 ? 0.05 : 0.01,
        }),
        createGeometry: () => ({
          nodes: [
            { id: 1, x: 0, y: 0, z: 0 },
            { id: 2, x: 6, y: 0, z: 0 },
            { id: 3, x: 12, y: 0, z: 0 },
          ],
          filterTypes: [{ id: "group", title: "Group", numeric: true }],
          elements: [
            {
              id: "B1",
              kind: "beam",
              number: 1,
              nodeIds: [1, 2],
              sectionId: "R",
              filterValues: { group: 1 },
            },
            {
              id: "B2",
              kind: "beam",
              number: 2,
              nodeIds: [2, 3],
              sectionId: "R",
              filterValues: { group: 2 },
            },
          ],
          sections: [{ id: "R", shape: { kind: "rectangle", width: 0.2, height: 0.4 } }],
          supports: [],
        }),
      };
    }

    async function analysedViewer() {
      const model = analysedModel();
      // With a document, because what is being shown of an analysis is something
      // a graphic holds rather than something a viewer merely remembers.
      const viewDocument = mainModule.createViewDocument({ fallbackData: { graphics: [{}] } });
      const viewer = mainModule.createViewer(new TestSession(model), {
        title: model.title,
        viewDocument,
      });
      jasmine.attachToDOM(viewer.element);
      const failure = viewer.element.querySelector(".graviss-error");
      await conditionPromise(
        () => viewer.renderer != null || !failure.hidden,
        "the Three.js scene to initialize",
      );
      return viewer;
    }

    it("lists what the analysis holds, and shows one case of it", async () => {
      const viewer = await analysedViewer();
      try {
        expect(viewer.hasResults()).toBe(true);
        expect(viewer.getLoadCases().map(({ title }) => title)).toEqual([
          "self-weight",
          "dead-load",
          "1st mode",
        ]);
        // Nothing is being shown until something is asked for: opening a model
        // with results is not the same as reading six thousand records.
        expect(viewer.result).toBeNull();
        expect(viewer.renderer.getDeformation()).toBeNull();

        await viewer.selectLoadCase(101);
        expect(viewer.result.loadCaseId).toBe(101);
        expect(viewer.renderer.getDeformation().extent).toBeCloseTo(0.01, 9);
        // A load case is a real state of the structure, so it runs up from zero;
        // a mode shape has no sign, so it swings about it.
        expect(viewer.getResultsState().cycle).toBe("thereAndBack");

        await viewer.selectLoadCase(901);
        expect(viewer.renderer.getDeformation().extent).toBeCloseTo(0.05, 9);
        // The cycle a user chose is theirs to keep; only a case arriving where
        // nobody chose one picks its own.
        expect(viewer.getResultsState().cycle).toBe("thereAndBack");
        viewer.setAnimationCycle(null);
        await viewer.selectLoadCase(901);
        expect(viewer.getResultsState().cycle).toBe("pingPong");

        // And a case nobody has is no case at all rather than an error.
        await viewer.selectLoadCase(404);
        expect(viewer.getResultsState().loadCaseId).toBeNull();
      } finally {
        viewer.destroy();
      }
    });

    it("holds an amplification and an animation the graphic remembers", async () => {
      const viewer = await analysedViewer();
      try {
        await viewer.selectLoadCase(101);
        // Chosen by the viewer until a user chooses one, and kept after.
        expect(viewer.getResultsState().scale).toBe("auto");
        expect(viewer.renderer.getDeformation().automatic).toBe(true);
        viewer.setDeformationScale(100);
        expect(viewer.renderer.getDeformation().automatic).toBe(false);
        expect(viewer.renderer.getDeformation().scale).toBe(100);

        viewer.toggleAnimation();
        expect(viewer.getResultsState().playing).toBe(true);
        expect(viewer.renderer.getAnimation().running).toBe(true);
        viewer.toggleAnimation();
        expect(viewer.renderer.getAnimation().running).toBe(false);
        // Stopping leaves the model at the shape rather than part way through it.
        expect(viewer.renderer.getDeformation().phase).toBe(1);

        viewer.toggleColorByDisplacement();
        expect(viewer.renderer.colorByDisplacement).toBe(true);

        // Only what differs from the default is written down.
        expect(viewer.activeGraphic.results).toEqual({
          loadCaseId: 101,
          scale: 100,
          cycle: "thereAndBack",
          colorByDisplacement: true,
        });
      } finally {
        viewer.destroy();
      }
    });

    it("narrows the model and says so in the graphic", async () => {
      const viewer = await analysedViewer();
      try {
        const fill = viewer.renderer.pickables.find(
          (mesh) => mesh.userData.gravissColorKey === "element",
        );
        const id = viewer.addRule({ sign: "+", type: "@number", text: "1" });
        expect(fill.count).toBe(1);
        expect(viewer.activeGraphic.filter).toEqual({
          rules: [{ sign: "+", type: "@number", text: "1" }],
        });

        // Half an expression is not an expression yet, so the model stays where
        // it was rather than emptying while a user is still typing.
        viewer.updateRule(id, { text: "1-" });
        expect(fill.count).toBe(1);
        expect(viewer.getFilterState().rules[0].text).toBe("1");

        viewer.updateRule(id, { type: "group", text: "2" });
        expect(fill.count).toBe(1);
        expect(viewer.activeGraphic.filter).toEqual({
          rules: [{ sign: "+", type: "group", text: "2" }],
        });
        expect(viewer.elementCounts().get("beam")).toEqual({ total: 2, shown: 1 });

        viewer.clearFilter();
        expect(fill.count).toBe(2);
        expect("filter" in viewer.activeGraphic).toBe(false);
      } finally {
        viewer.destroy();
      }
    });

    it("gives each graphic its own case, its own scale and its own filter", async () => {
      const viewer = await analysedViewer();
      try {
        await viewer.selectLoadCase(101);
        viewer.setDeformationScale(50);
        viewer.addRule({ sign: "+", type: "@number", text: "1" });

        viewer.addGraphic();
        expect(viewer.getResultsState().loadCaseId).toBeNull();
        expect(viewer.getFilterState().rules).toEqual([]);
        expect(viewer.renderer.getDeformation().result).toBeNull();
        await viewer.selectLoadCase(192);
        viewer.addRule({ sign: "+", type: "@number", text: "2" });

        viewer.activateGraphic(0);
        await conditionPromise(
          () => viewer.result?.loadCaseId === 101,
          "the first graphic's own case to come back",
        );
        expect(viewer.getResultsState().scale).toBe(50);
        expect(viewer.getFilterState().rules.map(({ text }) => text)).toEqual(["1"]);
        // Coming back to a graphic is looking at it, not changing it.
        expect(viewer.activeGraphic.results.loadCaseId).toBe(101);
      } finally {
        viewer.destroy();
      }
    });
  });

  it("bends a member between its ends when a result says how, and not before", async () => {
    const model = {
      id: "cantilever",
      title: "Cantilever",
      format: "Spec fixture",
      createGeometry: () => ({
        nodes: [
          { id: 1, x: 0, y: 0, z: 0 },
          { id: 2, x: 10, y: 0, z: 0 },
          { id: 3, x: 20, y: 0, z: 0 },
        ],
        elements: [
          { id: "B1", kind: "beam", number: 1, nodeIds: [1, 2], sectionId: "R" },
          { id: "B2", kind: "beam", number: 2, nodeIds: [2, 3], sectionId: "R" },
        ],
        sections: [{ id: "R", shape: { kind: "rectangle", width: 0.4, height: 0.8 } }],
        supports: [],
      }),
    };
    const viewer = mainModule.createViewer(new TestSession(model), { title: model.title });
    jasmine.attachToDOM(viewer.element);
    try {
      const failure = viewer.element.querySelector(".graviss-error");
      await conditionPromise(
        () => viewer.renderer != null || !failure.hidden,
        "the Three.js scene to initialize",
      );
      if (!viewer.renderer) {
        fail(viewer.element.querySelector(".graviss-error-message").textContent);
        return;
      }
      const renderer = viewer.renderer;
      const unitVertices = () =>
        renderer.pickables
          .find((mesh) => mesh.userData.gravissColorKey === "element")
          .geometry.getAttribute("position").count;
      // A straight member has nothing to say between its ends, so it is drawn
      // as the eight corners of a box and no rings in between.
      expect(renderer.memberBendSteps).toBe(1);
      const straight = unitVertices();

      // A result with no stations is still a result: the members move with
      // their nodes and stay straight, which is the best anyone can say.
      renderer.setResult({
        kind: "displacement",
        loadCaseId: 1,
        components: 3,
        nodes: { ids: [2], values: [0, 0, -0.5] },
        extent: 0.5,
      });
      expect(renderer.memberBendSteps).toBe(1);
      expect(unitVertices()).toBe(straight);

      // With stations the section gains rings along its length - there has to
      // be something between the ends for the bow to move.
      const tip = -0.5;
      const slope = (1.5 * 0.5) / 10;
      renderer.setResult({
        kind: "displacement",
        loadCaseId: 2,
        components: 3,
        nodes: { ids: [2], values: [0, 0, tip] },
        extent: 0.5,
        elements: [
          {
            id: "B1",
            stations: [
              { x: 0, u: [0, 0, 0], phi: [0, 0, 0] },
              // Twist about the member's own axis first, then the rotation
              // that bends it: the tip of a cantilever turns by one and a half
              // times its deflection over its length.
              { x: 10, u: [0, 0, tip], phi: [0.02, slope, 0] },
            ],
          },
        ],
      });
      expect(renderer.memberBendSteps).toBeGreaterThan(1);
      expect(unitVertices()).toBeGreaterThan(straight);

      // Both ends of the member that has stations, and nothing for the one that
      // does not - which draws it straight between its moved ends.
      const placement = renderer.memberInstances[0];
      const first = placement.elements.findIndex((element) => element.id === "B1");
      const second = placement.elements.findIndex((element) => element.id === "B2");
      // Held in a Float32Array, so read back to the precision one keeps.
      const farEnd = Array.from(placement.bendB.array.slice(first * 4, first * 4 + 4));
      expect(farEnd.slice(0, 3)).toEqual([0, 0, tip]);
      expect(farEnd[3]).toBeCloseTo(0.02, 6);
      expect(placement.bendR.array[first * 4 + 2]).toBeCloseTo(slope, 6);
      expect(Array.from(placement.bendB.array.slice(second * 4, second * 4 + 4))).toEqual([
        0, 0, 0, 0,
      ]);

      // The arrises read the very same three buffers as the fill they lie on,
      // for the same reason they read the same instance matrix.
      const contours = renderer.memberContours[0];
      expect(contours.geometry.getAttribute("instanceBendA")).toBe(placement.bendA);
      expect(contours.material.defines.GRAVISS_BEND).toBe("");

      // How far the bow is drawn is one number the materials share, so a frame
      // of animation costs a uniform rather than a walk over every vertex.
      renderer.setDeformationScale(3);
      expect(renderer.bendFactor.value).toBe(3);
      renderer.setDeformationPhase(0.5);
      expect(renderer.bendFactor.value).toBe(1.5);
      renderer.setDeformationScale(0);
      expect(renderer.bendFactor.value).toBe(0);

      // A member drawn as its centreline bends by the same cubic, because it is
      // the same member - it just has no card doing it, having no vertices
      // between its ends to bend. The run becomes the chain of short segments
      // it takes to look like a curve.
      renderer.setDeformationScale(1);
      renderer.setDeformationPhase(1);
      renderer.setSectionRendering(false);
      const line = renderer.memberLines.geometry.getAttribute("position");
      const range = renderer.memberLines.userData.gravissEntityRanges[first];
      expect(range.count).toBe(renderer.memberBendSteps * 2);
      // Mid-span of the bent member, against the straight line between its own
      // two ends. A cantilever's curve stands above its chord.
      const middle = range.start + renderer.memberBendSteps;
      const chordZ = (line.getZ(range.start) + line.getZ(range.start + range.count - 1)) / 2;
      expect(line.getZ(middle) - chordZ).toBeCloseTo(0.09375, 5);
      // And the member the result said nothing about is straight, as it should
      // be: every point of it on the line between its ends.
      const plain = renderer.memberLines.userData.gravissEntityRanges[second];
      const plainMiddle = plain.start + renderer.memberBendSteps;
      const plainChord = (line.getZ(plain.start) + line.getZ(plain.start + plain.count - 1)) / 2;
      expect(line.getZ(plainMiddle) - plainChord).toBeCloseTo(0, 9);
      // A filter reaches the centrelines too. With sections off these are the
      // only members there are, so one that did not would be a filter that
      // worked in one display mode and not the other.
      renderer.setElementFilter(
        compileRules(
          [{ sign: "+", type: "@number", text: "2" }],
          subjectsByKey(buildSubjects(renderer.geometry)),
        ),
      );
      const collapsed = renderer.memberLines.userData.gravissEntityRanges[first];
      const only = new Set();
      for (let vertex = collapsed.start; vertex < collapsed.start + collapsed.count; vertex += 1) {
        only.add(`${line.getX(vertex)}:${line.getY(vertex)}:${line.getZ(vertex)}`);
      }
      expect(only.size).toBe(1);
      renderer.setElementFilter(null);
      renderer.setSectionRendering(true);

      // And a result that goes away takes the tessellation with it.
      renderer.setResult(null);
      expect(renderer.memberBendSteps).toBe(1);
      expect(unitVertices()).toBe(straight);
    } finally {
      viewer.destroy();
    }
  });

  it("reads the model as a field when asked, and as a structure otherwise", async () => {
    const model = {
      id: "coloured",
      title: "Coloured",
      format: "Spec fixture",
      createGeometry: () => ({
        nodes: [
          { id: 1, x: 0, y: 0, z: 0 },
          { id: 2, x: 6, y: 0, z: 0 },
          { id: 3, x: 12, y: 0, z: 0 },
        ],
        elements: [
          { id: "B1", kind: "beam", nodeIds: [1, 2], sectionId: "R" },
          { id: "B2", kind: "beam", nodeIds: [2, 3], sectionId: "R" },
        ],
        sections: [{ id: "R", shape: { kind: "rectangle", width: 0.2, height: 0.4 } }],
        supports: [],
      }),
    };
    const viewer = mainModule.createViewer(new TestSession(model), { title: model.title });
    jasmine.attachToDOM(viewer.element);
    try {
      const failure = viewer.element.querySelector(".graviss-error");
      await conditionPromise(
        () => viewer.renderer != null || !failure.hidden,
        "the Three.js scene to initialize",
      );
      if (!viewer.renderer) {
        fail(viewer.element.querySelector(".graviss-error-message").textContent);
        return;
      }
      const renderer = viewer.renderer;
      const fill = renderer.pickables.find((m) => m.userData.gravissColorKey === "element");
      const of = (id) => {
        const index = fill.userData.gravissEntities.findIndex((entity) => entity.id === id);
        const at = fill.userData.gravissEntityRanges[index].start * 3;
        return Array.from(fill.instanceColor.array.slice(at, at + 3));
      };
      const structure = of("B1");

      // A model with nothing to read is still read as a structure, whatever the
      // switch says.
      expect(renderer.setColorByDisplacement(true)).toBe(true);
      expect(renderer.colorScaleRange()).toBeNull();
      expect(of("B1")).toEqual(structure);

      // Only the far end moves, so the two elements cannot be the same colour.
      renderer.setResult({
        kind: "displacement",
        loadCaseId: 1,
        components: 3,
        nodes: { ids: [2, 3], values: [0, 0, -0.005, 0, 0, -0.02] },
        extent: 0.02,
      });
      expect(renderer.colorScaleRange()).toEqual({ min: 0, max: 0.02 });
      expect(of("B1")).not.toEqual(structure);
      expect(of("B2")).not.toEqual(of("B1"));
      // The scale starts at not having moved, so the element nearer the support
      // sits lower on it - blue over red, and the ramp is blue at the bottom.
      expect(of("B1")[2]).toBeGreaterThan(of("B1")[0]);
      expect(of("B2")[0]).toBeGreaterThan(of("B2")[2]);

      // The phase moves the whole field at once, so it changes no colour.
      const painted = of("B2");
      renderer.setDeformationPhase(0.25);
      renderer.refreshInstanceColors();
      expect(of("B2")).toEqual(painted);

      // And a selection still says what is selected.
      renderer.setColorByDisplacement(false);
      expect(of("B1")).toEqual(structure);
    } finally {
      viewer.destroy();
    }
  });

  it("moves the model by a displacement field, and puts it back exactly", async () => {
    const model = {
      id: "deformed",
      title: "Deformed",
      format: "Spec fixture",
      createGeometry: () => ({
        nodes: [
          { id: 1, x: 0, y: 0, z: 0 },
          { id: 2, x: 6, y: 0, z: 0 },
          { id: 3, x: 12, y: 0, z: 0 },
        ],
        elements: [
          { id: "B1", kind: "beam", nodeIds: [1, 2], sectionId: "R" },
          { id: "B2", kind: "beam", nodeIds: [2, 3], sectionId: "R" },
        ],
        sections: [{ id: "R", shape: { kind: "rectangle", width: 0.2, height: 0.4 } }],
        supports: [],
      }),
    };
    const viewer = mainModule.createViewer(new TestSession(model), { title: model.title });
    jasmine.attachToDOM(viewer.element);
    try {
      const failure = viewer.element.querySelector(".graviss-error");
      await conditionPromise(
        () => viewer.renderer != null || !failure.hidden,
        "the Three.js scene to initialize",
      );
      if (!viewer.renderer) {
        fail(viewer.element.querySelector(".graviss-error-message").textContent);
        return;
      }
      const renderer = viewer.renderer;
      const fill = renderer.pickables.find((m) => m.userData.gravissColorKey === "element");
      const rest = Float32Array.from(fill.instanceMatrix.array);
      const restNodes = Float32Array.from(renderer.nodePositions);

      // The middle node sags a hundredth of a metre.
      const deformation = renderer.setResult({
        kind: "displacement",
        loadCaseId: 1,
        components: 3,
        nodes: { ids: [2], values: [0, 0, -0.01] },
        extent: 0.01,
      });

      // It picks its own scale, aiming the largest displacement at a fraction
      // of the model rather than at its true size.
      expect(deformation.automatic).toBe(true);
      expect(deformation.scale).toBeGreaterThan(1);

      // Both members moved, because both meet that node.
      expect(Array.from(fill.instanceMatrix.array)).not.toEqual(Array.from(rest));
      const sagged = renderer.nodePositions[1 * 3 + 2];
      expect(sagged).toBeLessThan(0);
      expect(sagged).toBeCloseTo(-0.01 * deformation.scale, 6);
      // The records the shells and the symbols read say the same thing as the
      // flat array the members read; two shapes of one answer.
      expect(renderer.drawnNodes[1].z).toBeCloseTo(sagged, 6);
      // And the ends did not move at all.
      expect(renderer.nodePositions[0]).toBe(restNodes[0]);

      // A scale of zero is the undeformed model, bit for bit — which is how a
      // user checks what moved against what did not.
      renderer.setDeformationScale(0);
      expect(Array.from(renderer.nodePositions)).toEqual(Array.from(restNodes));
      expect(Array.from(fill.instanceMatrix.array)).toEqual(Array.from(rest));

      // A phase runs the same field part of the way, and a negative one runs it
      // the other way — which is what a mode shape needs.
      renderer.setDeformationScale(100);
      renderer.setDeformationPhase(1);
      const up = renderer.nodePositions[1 * 3 + 2];
      renderer.setDeformationPhase(-1);
      expect(renderer.nodePositions[1 * 3 + 2]).toBeCloseTo(-up, 6);

      // Dropping the result puts it back for good.
      renderer.setResult(null);
      expect(Array.from(renderer.nodePositions)).toEqual(Array.from(restNodes));
    } finally {
      viewer.destroy();
    }
  });

  it("greys the part of a section that does not carry", async () => {
    // A welded girder whose lower flange is left out: the section is the whole
    // of it and one area of it is drawn without being counted.
    const flange = [
      [-0.13, 0.498],
      [0.13, 0.498],
      [0.13, 0.515],
      [-0.13, 0.515],
    ];
    const geometry = {
      nodes: [
        { id: 1, x: 0, y: 0, z: 0 },
        { id: 2, x: 6, y: 0, z: 0 },
      ],
      sections: [
        {
          id: "G",
          shape: {
            kind: "plates",
            plates: [
              { from: [0, -0.498], to: [0, 0.498], thickness: 0.01 },
              { from: [-0.13, -0.5065], to: [0.13, -0.5065], thickness: 0.017 },
              { from: [-0.13, 0.5065], to: [0.13, 0.5065], thickness: 0.017 },
            ],
          },
          ineffective: [{ points: flange }],
        },
      ],
      elements: [
        {
          id: 1,
          kind: "beam",
          nodeIds: [1, 2],
          sectionId: "G",
          localAxes: { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
        },
      ],
      supports: [],
    };
    const session = {
      async describe() {
        return {
          model: {
            id: "ineffective",
            title: "Ineffective",
            source: "Spec",
            coordinateSystem: { upAxis: "z", handedness: "right" },
          },
          capabilities: { geometry: { elementKinds: ["beam"], sections: true, localAxes: true } },
        };
      },
      async getGeometry() {
        return geometry;
      },
      dispose() {},
    };
    const item = mainModule.createViewer(session, { title: "Ineffective" });
    jasmine.attachToDOM(item.element);
    try {
      await conditionPromise(() => item.renderer != null, "the section scene to initialize");
      const renderer = item.renderer;

      // Two fills for one member: the section, and the area of it that does
      // not carry, stamped through the same matrices so the two are exactly
      // coincident where they meet.
      const fills = renderer.pickables.filter(
        (mesh) => mesh.userData.visibilityKey === "members" && mesh.isMesh,
      );
      expect(fills.length).toBe(2);
      const greyed = fills.find((mesh) => mesh.userData.gravissColorKey === "ineffective");
      expect(greyed).not.toBeUndefined();
      // One rectangle extruded, uploaded once and placed per member.
      expect(greyed.isInstancedMesh).toBe(true);
      expect(greyed.count).toBe(1);
      // It draws after the member so it wins every depth tie it makes.
      expect(greyed.renderOrder).toBeGreaterThan(fills.find((mesh) => mesh !== greyed).renderOrder);

      // Grey, and nothing like the member colour beside it.
      const member = renderer.colors.element;
      const ineffective = renderer.colors.ineffective;
      expect(ineffective).not.toBeUndefined();
      const saturation = (color) => {
        const hsl = { h: 0, s: 0, l: 0 };
        color.getHSL(hsl);
        return hsl.s;
      };
      expect(saturation(ineffective)).toBeLessThan(saturation(member));
      // Every scheme carries one, so switching never leaves it undefined.
      for (const scheme of ["cloud", "midnight", "paper", "white"]) {
        renderer.setAppearance(scheme);
        expect(renderer.colors.ineffective).not.toBeUndefined();
        expect(saturation(renderer.colors.ineffective)).toBeLessThan(0.35);
      }

      // It hides and shows with the member it belongs to, being part of it.
      renderer.setVisibility("members", false);
      expect(renderer.meshes.members.visible).toBe(false);
    } finally {
      item.destroy();
    }
  });

  it("opens a planar model on its own plane, with its grid behind it", async () => {
    // The shell fixture is a slab in the model's x-y plane, and a model that
    // lies in a plane has nothing to see from anywhere but face on.
    const item = mainModule.createViewer(new TestSession(SHELL_MODEL), {
      title: SHELL_MODEL.title,
    });
    jasmine.attachToDOM(item.element);
    try {
      await conditionPromise(() => item.renderer != null, "the Three.js scene to initialize");
      const renderer = item.renderer;
      expect(renderer.bounds.planeNormal).toEqual([0, 0, 1]);
      expect(renderer.planeView().viewId).toBe("top");

      // Looked at along the plane's normal rather than from the isometric
      // corner a model with three dimensions opens at.
      const offset = renderer.camera.position.clone().sub(renderer.controls.target).normalize();
      expect(Math.abs(offset.z)).toBeCloseTo(1, 6);

      // The grid lies in the model's plane instead of the horizontal one — for
      // a slab those are the same plane — and stands off it far enough not to
      // rule lines across what is meshed there.
      const gridNormal = new renderer.THREE.Vector3(0, 1, 0).applyQuaternion(
        renderer.grid.quaternion,
      );
      expect(Math.abs(gridNormal.z)).toBeCloseTo(1, 6);
      expect(renderer.grid.position.z).toBeCloseTo(
        -Math.sign(gridNormal.z) * renderer.bounds.radius * 0.02,
        6,
      );
    } finally {
      item.destroy();
    }
  });

  it("opens a model with three dimensions at the isometric corner", async () => {
    const item = mainModule.createViewer(new TestSession(FRAME_MODEL), {
      title: FRAME_MODEL.title,
    });
    jasmine.attachToDOM(item.element);
    try {
      await conditionPromise(() => item.renderer != null, "the Three.js scene to initialize");
      const renderer = item.renderer;
      expect(renderer.bounds.planeNormal).toBeNull();
      expect(renderer.planeView()).toBeNull();
      // Every component of the offset is doing something, which is what makes
      // it a corner rather than a face.
      const offset = renderer.camera.position.clone().sub(renderer.controls.target).normalize();
      for (const component of offset.toArray()) expect(Math.abs(component)).toBeGreaterThan(0.2);
      // And its grid is the ground at the world origin, as it always was.
      expect(renderer.grid.position.z).toBeCloseTo(0, 6);
    } finally {
      item.destroy();
    }
  });

  it("grades the background lighter towards the top when asked", async () => {
    const item = await lumine.workspace.open(MAIN_EXAMPLE_URI, { searchAllPanes: true });
    await conditionPromise(() => item.renderer != null, "the Three.js scene to initialize");
    const renderer = item.renderer;
    const button = item.element.querySelector('[data-action="toggle-gradient"]');

    // Flat until somebody asks otherwise: one colour, and nothing to dispose.
    expect(renderer.isBackgroundGradient()).toBe(false);
    expect(renderer.scene.background.isColor).toBe(true);
    expect(button.getAttribute("aria-pressed")).toBe("false");

    button.click();
    expect(renderer.isBackgroundGradient()).toBe(true);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.classList.contains("selected")).toBe(true);
    const sky = renderer.sky;
    expect(sky).not.toBeNull();

    // The grade belongs to the world, not to the screen: it is measured along
    // the model's own up axis, so the bright side stays where the ceiling is
    // however the camera is turned.
    const position = sky.geometry.getAttribute("position");
    const colors = sky.geometry.getAttribute("color");
    const direction = new renderer.THREE.Vector3();
    let zenith = null;
    let nadir = null;
    let horizon = null;
    for (let index = 0; index < position.count; index += 1) {
      direction.fromBufferAttribute(position, index).normalize();
      const height = direction.dot(renderer.worldUp);
      const warmth = colors.getX(index) - colors.getZ(index);
      const value = { r: colors.getX(index), b: colors.getZ(index), warmth };
      if (zenith === null || height > zenith.height) zenith = { height, ...value };
      if (nadir === null || height < nadir.height) nadir = { height, ...value };
      if (horizon === null || Math.abs(height) < Math.abs(horizon.height)) {
        horizon = { height, ...value };
      }
    }

    // Cool above the horizon and warm below it, meeting at the colour the
    // appearance chose — one grade each way rather than one across the whole,
    // so the horizon is the scheme and neither half is a second one. Hue is
    // what carries it: a viewport that can be turned under its model needs a
    // stronger signal than which end is brighter.
    const flat = new renderer.THREE.Color(
      appearanceDefinition(renderer.activeAppearance).background,
    );
    expect(horizon.height).toBeCloseTo(0, 6);
    expect(horizon.r).toBeCloseTo(flat.r, 5);
    expect(horizon.b).toBeCloseTo(flat.b, 5);
    expect(zenith.warmth).toBeLessThan(flat.r - flat.b);
    expect(nadir.warmth).toBeGreaterThan(flat.r - flat.b);

    // It follows the camera, so it is a sky and not something the camera can
    // leave behind or fly through.
    renderer.moveCamera("left");
    renderer.placeSky();
    expect(sky.position.distanceTo(renderer.camera.position)).toBeCloseTo(0, 9);
    expect(sky.scale.x).toBeGreaterThan(renderer.camera.near);

    // It belongs to the graphic, and it is taken out of the scene when the
    // background goes back to flat rather than left in it unseen.
    expect(item.viewDocument.getData().graphics[0].backgroundGradient).toBe(true);
    button.click();
    expect(renderer.isBackgroundGradient()).toBe(false);
    expect(renderer.sky).toBeNull();
    expect(renderer.scene.children.includes(sky)).toBe(false);
    expect(renderer.scene.background.isColor).toBe(true);

    // Switching graphics restores what each of them holds.
    item.setBackgroundGradient(true);
    item.activateGraphic(1);
    expect(renderer.isBackgroundGradient()).toBe(false);
    item.activateGraphic(0);
    expect(renderer.isBackgroundGradient()).toBe(true);
  });

  it("sizes every mark from one field, as the length it is", async () => {
    const item = await lumine.workspace.open(MAIN_EXAMPLE_URI, { searchAllPanes: true });
    await conditionPromise(() => item.renderer != null, "the Three.js scene to initialize");
    const renderer = item.renderer;
    const field = item.element.querySelector(".graviss-symbol-input");

    // Marks used to be fixed world sizes chosen for no model in particular, so
    // a small structure was buried under its own nodes. A graphic that has said
    // nothing takes a size from the model, and it is a real length either way.
    expect(renderer.getSymbolSize()).toBeCloseTo(renderer.bounds.radius / 500, 9);
    // The field is millimetres; everything behind it is metres — and whatever
    // length the model suggests is a valid value of its own field.
    expect(Number(field.value)).toBeCloseTo((renderer.bounds.radius / 500) * 1000, 1);
    expect(field.validity.valid).toBe(true);

    const scaleMatrix = new renderer.THREE.Matrix4();
    const scaleVector = new renderer.THREE.Vector3();
    const radiusOf = (mesh) => {
      mesh.getMatrixAt(0, scaleMatrix);
      return scaleVector.setFromMatrixScale(scaleMatrix).x;
    };
    expect(radiusOf(renderer.meshes.nodes)).toBeCloseTo(renderer.getSymbolSize(), 6);

    // One field, and everything drawn as a mark takes its length from it.
    const supportBefore = radiusOf(renderer.meshes.supports);
    field.value = "500";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    expect(renderer.getSymbolSize()).toBe(0.5);
    expect(radiusOf(renderer.meshes.nodes)).toBeCloseTo(0.5, 6);
    expect(radiusOf(renderer.meshes.supports)).toBeGreaterThan(supportBefore);

    // Nothing at all up to a metre: past a metre a mark is a shape in front of
    // the structure rather than a mark on it.
    expect(renderer.setSymbolSize(9)).toBe(1);
    expect(renderer.setSymbolSize(-3)).toBe(0);

    // And a size of nothing puts every mark away, whatever its own switch says.
    expect(renderer.setSymbolSize(0)).toBe(0);
    expect(renderer.meshes.nodes.visible).toBe(false);
    expect(renderer.meshes.supports.visible).toBe(false);
    // The structure is untouched by it.
    expect(renderer.meshes.members.visible).toBe(true);
    renderer.setSymbolSize(0.02);
    expect(renderer.meshes.nodes.visible).toBe(true);

    // The wheel over the field turns the length, which is how anyone reaches
    // for a size: five millimetres a notch, decoupled from the step attribute
    // the field no longer constrains values by.
    const step = 0.005;
    const before = renderer.getSymbolSize();
    field.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100 }));
    expect(renderer.getSymbolSize()).toBeCloseTo(before + step, 9);
    field.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100 }));
    expect(renderer.getSymbolSize()).toBeCloseTo(before, 9);
    // Held, it steps ten times as far, for a size worth being fussy about.
    field.dispatchEvent(
      new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100, shiftKey: true }),
    );
    expect(renderer.getSymbolSize()).toBeCloseTo(before + step * 10, 9);

    // It belongs to the graphic, like every other thing the toolbar sets.
    expect(item.viewDocument.getData().graphics[0].symbolSize).toBeCloseTo(before + step * 10, 9);
  });

  it("tapers an area element that is thicker at one corner than another", async () => {
    // SOFiSTiK stores a thickness per corner, so a slab that tapers across
    // itself is one element rather than a stack of them. Drawn from a single
    // number the whole plate would be parallel plates of the first corner's
    // thickness, which is neither what it is nor where it is.
    const model = {
      id: "tapered",
      title: "Tapered slab",
      format: "Spec fixture",
      createGeometry: () => ({
        nodes: [
          { id: 1, x: 0, y: 0, z: 0 },
          { id: 2, x: 1, y: 0, z: 0 },
          { id: 3, x: 1, y: 1, z: 0 },
          { id: 4, x: 0, y: 1, z: 0 },
        ],
        elements: [
          { id: 1, kind: "shell", nodeIds: [1, 2, 3, 4], thickness: [0.2, 0.2, 0.6, 0.6] },
        ],
        sections: [],
        supports: [],
      }),
    };
    const viewer = mainModule.createViewer(new TestSession(model), { title: model.title });
    jasmine.attachToDOM(viewer.element);
    try {
      const failure = viewer.element.querySelector(".graviss-error");
      await conditionPromise(
        () => viewer.renderer != null || !failure.hidden,
        "the Three.js scene to initialize",
      );
      if (!viewer.renderer) {
        fail(viewer.element.querySelector(".graviss-error-message").textContent);
        return;
      }
      const renderer = viewer.renderer;
      const bounds = new renderer.THREE.Box3().setFromObject(renderer.meshes.shells);
      // Half of the thickest corner either side of the plane the nodes are on.
      expect(bounds.min.z).toBeCloseTo(-0.3, 5);
      expect(bounds.max.z).toBeCloseTo(0.3, 5);

      // The thin end is thin: no vertex out there reaches the thick end's face.
      const position = renderer.meshes.shells.geometry.getAttribute("position");
      let thinnest = 0;
      for (let index = 0; index < position.count; index += 1) {
        if (position.getY(index) < 0.5)
          thinnest = Math.max(thinnest, Math.abs(position.getZ(index)));
      }
      expect(thinnest).toBeCloseTo(0.1, 5);
    } finally {
      viewer.destroy();
    }
  });

  it("extrudes every part of a composed section", async () => {
    const item = await lumine.workspace.open(MAIN_EXAMPLE_URI, { searchAllPanes: true });
    await conditionPromise(() => item.renderer != null, "the Three.js scene to initialize");
    const renderer = item.renderer;
    const plate = [
      [-1, -0.12],
      [1, -0.12],
      [1, 0],
      [-1, 0],
    ];
    const web = [
      [-0.13, 0],
      [0.13, 0],
      [0.16, 0.72],
      [-0.16, 0.72],
    ];
    const single = renderer.createSectionGeometry({ kind: "polygon", points: plate });
    const composed = renderer.createSectionGeometry({
      kind: "polygon",
      parts: [{ points: plate }, { points: web }],
    });
    // Both areas are in the one extrusion, so the composed section carries
    // more geometry than either area alone — a section that kept only its
    // last area was the bug this pins.
    expect(single.getAttribute("position").count).toBeGreaterThan(0);
    expect(composed.getAttribute("position").count).toBeGreaterThan(
      single.getAttribute("position").count,
    );
    single.dispose();
    composed.dispose();
  });

  it("meets neighbouring thicknesses and offsets at their mean, not at a step", async () => {
    // A plate whose thickness varies continuously is meshed as a run of
    // elements each carrying one number, and its eccentricity with them. Taken
    // at face value the run is a stair; the surface those elements describe
    // between them meets at the mean at every shared node, which is what the
    // source's own viewer draws.
    const model = {
      id: "stepped",
      title: "Stepped plates",
      format: "Spec fixture",
      createGeometry: () => ({
        nodes: [
          { id: 1, x: 0, y: 0, z: 0 },
          { id: 2, x: 1, y: 0, z: 0 },
          { id: 3, x: 2, y: 0, z: 0 },
          { id: 4, x: 0, y: 1, z: 0 },
          { id: 5, x: 1, y: 1, z: 0 },
          { id: 6, x: 2, y: 1, z: 0 },
        ],
        elements: [
          { id: "A", kind: "shell", nodeIds: [1, 2, 5, 4], thickness: 0.2, offset: 0.1 },
          { id: "B", kind: "shell", nodeIds: [2, 3, 6, 5], thickness: 0.4, offset: 0.2 },
        ],
        sections: [],
        supports: [],
      }),
    };
    const viewer = mainModule.createViewer(new TestSession(model), { title: model.title });
    jasmine.attachToDOM(viewer.element);
    try {
      const failure = viewer.element.querySelector(".graviss-error");
      await conditionPromise(
        () => viewer.renderer != null || !failure.hidden,
        "the Three.js scene to initialize",
      );
      if (!viewer.renderer) {
        fail(viewer.element.querySelector(".graviss-error-message").textContent);
        return;
      }
      const renderer = viewer.renderer;
      const position = renderer.meshes.shells.geometry.getAttribute("position");
      const seam = [];
      for (let index = 0; index < position.count; index += 1) {
        if (Math.abs(position.getX(index) - 1) < 1e-6) seam.push(position.getZ(index));
      }
      // Both elements sit on their nodes, so the node face stays put — and the
      // far faces meet at the mean of the two thicknesses, not at either one.
      expect(seam.length).toBeGreaterThan(0);
      expect(Math.min(...seam)).toBeCloseTo(0, 5);
      expect(Math.max(...seam)).toBeCloseTo(0.3, 5);
      expect(seam.some((z) => Math.abs(z - 0.2) < 1e-3 || Math.abs(z - 0.4) < 1e-3)).toBe(false);

      // The corners nothing is shared with keep their own element's numbers.
      const box = new renderer.THREE.Box3().setFromObject(renderer.meshes.shells);
      expect(box.max.z).toBeCloseTo(0.4, 5);
      expect(box.min.z).toBeCloseTo(0, 5);
    } finally {
      viewer.destroy();
    }
  });

  it("extrudes a warped quad along each corner's own normal", async () => {
    // A quad's four base nodes need not lie on one plane. Displacing every
    // corner along one element normal flattens the extrusion onto the plane of
    // the first three corners, which is a different element than the one the
    // mesh describes.
    const model = {
      id: "warped",
      title: "Warped quad",
      format: "Spec fixture",
      createGeometry: () => ({
        nodes: [
          { id: 1, x: 0, y: 0, z: 0 },
          { id: 2, x: 1, y: 0, z: 0 },
          { id: 3, x: 1, y: 1, z: 1 },
          { id: 4, x: 0, y: 1, z: 0 },
        ],
        elements: [{ id: 1, kind: "shell", nodeIds: [1, 2, 3, 4], thickness: 0.2 }],
        sections: [],
        supports: [],
      }),
    };
    const viewer = mainModule.createViewer(new TestSession(model), { title: model.title });
    jasmine.attachToDOM(viewer.element);
    try {
      const failure = viewer.element.querySelector(".graviss-error");
      await conditionPromise(
        () => viewer.renderer != null || !failure.hidden,
        "the Three.js scene to initialize",
      );
      if (!viewer.renderer) {
        fail(viewer.element.querySelector(".graviss-error-message").textContent);
        return;
      }
      const renderer = viewer.renderer;
      // The normal at the lifted corner, from the two edges meeting there.
      const lifted = { x: 1, y: 1, z: 1 };
      const next = { x: 0, y: 1, z: 0 };
      const previous = { x: 1, y: 0, z: 0 };
      const a = [next.x - lifted.x, next.y - lifted.y, next.z - lifted.z];
      const b = [previous.x - lifted.x, previous.y - lifted.y, previous.z - lifted.z];
      const cross = [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
      ];
      const length = Math.hypot(...cross);
      const expected = {
        x: lifted.x + (cross[0] / length) * 0.1,
        y: lifted.y + (cross[1] / length) * 0.1,
        z: lifted.z + (cross[2] / length) * 0.1,
      };
      const position = renderer.meshes.shells.geometry.getAttribute("position");
      let found = false;
      for (let index = 0; index < position.count; index += 1) {
        if (
          Math.abs(position.getX(index) - expected.x) < 1e-4 &&
          Math.abs(position.getY(index) - expected.y) < 1e-4 &&
          Math.abs(position.getZ(index) - expected.z) < 1e-4
        ) {
          found = true;
          break;
        }
      }
      expect(found).toBe(true);
    } finally {
      viewer.destroy();
    }
  });

  it("draws an area element where it sits, not where its nodes are", async () => {
    // A SOFiSTiK quad can be eccentric: a slab meshed at its top face, a deck
    // sitting on beams. The nodes stay where the analysis put them, so the
    // element has to carry the offset itself — nodes are shared between
    // elements that offset differently and cannot be moved for one of them.
    const square = [
      { id: 1, x: 0, y: 0, z: 0 },
      { id: 2, x: 1, y: 0, z: 0 },
      { id: 3, x: 1, y: 1, z: 0 },
      { id: 4, x: 0, y: 1, z: 0 },
    ];
    const model = {
      id: "offset-quad",
      title: "Offset quad",
      format: "Spec fixture",
      createGeometry: () => ({
        nodes: square,
        // Wound counter-clockwise in the XY plane, so the element normal is +Z
        // and a positive offset lifts it.
        elements: [
          {
            id: 1,
            kind: "shell",
            nodeIds: [1, 2, 3, 4],
            thickness: 0.2,
            offset: 0.5,
            localAxes: { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
          },
        ],
        sections: [],
        supports: [],
      }),
    };
    const viewer = mainModule.createViewer(new TestSession(model), { title: model.title });
    jasmine.attachToDOM(viewer.element);
    try {
      const failure = viewer.element.querySelector(".graviss-error");
      await conditionPromise(
        () => viewer.renderer != null || !failure.hidden,
        "the Three.js scene to initialize",
      );
      if (!viewer.renderer) {
        fail(viewer.element.querySelector(".graviss-error-message").textContent);
        return;
      }
      const renderer = viewer.renderer;
      // The triads are asked for up front, because they are rebuilt lazily: a
      // model that moves every frame must not dispose and rebuild a geometry
      // nobody is looking at, so the rebuild is owed until they are shown.
      renderer.setVisibility("localAxes", true);
      const bounds = new renderer.THREE.Box3().setFromObject(renderer.meshes.shells);
      // Half the thickness either side of a mid-surface half a metre up. Six
      // places, because positions are held in a Float32Array.
      expect(bounds.min.z).toBeCloseTo(0.4, 6);
      expect(bounds.max.z).toBeCloseTo(0.6, 6);
      // Only along the normal: the element keeps the footprint its nodes gave it.
      expect(bounds.min.x).toBeCloseTo(0, 6);
      expect(bounds.max.x).toBeCloseTo(1, 6);

      // Without sections the element is not a body but the analysis surface
      // itself, and that surface is where the nodes are: drawn eccentric it
      // would hang half a thickness clear of the supports, springs and
      // couplings that meet it at those nodes — which is how main-2's deck
      // floated over its own bearings.
      renderer.setSectionRendering(false);
      const flat = new renderer.THREE.Box3().setFromObject(renderer.meshes.shells);
      expect(flat.min.z).toBeCloseTo(0, 6);
      expect(flat.max.z).toBeCloseTo(0, 6);

      // The mesh lines follow whichever surface is drawn.
      expect(renderer.meshes.shells.visible).toBe(true);

      // So does the local-axis triad: the node plane here, the body when the
      // sections come back — left behind either way, it marks a plane rather
      // than the element.
      expect(renderer.elementCenter(renderer.geometry.elements[0]).z).toBeCloseTo(0, 9);
      expect(renderer.localAxes.geometry.getAttribute("position").getZ(0)).toBeCloseTo(0, 6);
      renderer.setSectionRendering(true);
      const centre = renderer.elementCenter(renderer.geometry.elements[0]);
      expect(centre.z).toBeCloseTo(0.5, 9);
      expect(centre.x).toBeCloseTo(0.5, 9);
      expect(renderer.localAxes.geometry.getAttribute("position").getZ(0)).toBeCloseTo(0.5, 6);
      expect(renderer.elementNormal(renderer.geometry.elements[0]).z).toBeCloseTo(1, 9);
    } finally {
      viewer.destroy();
    }
  });

  it("opens a hand-written document that repeats a graphic name", async () => {
    // The reported failure: a file written by hand names two graphics the same
    // and the whole document was refused, with the error thrown out of the
    // opener where nothing caught it, so clicking the file did nothing at all.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "graviss-by-hand-"));
    const viewPath = path.join(directory, "model.grv");
    fs.writeFileSync(
      viewPath,
      JSON.stringify({
        graphics: [
          { id: "overview", title: "First" },
          { id: "overview", title: "Second" },
        ],
        activeGraphic: "overview",
      }),
    );
    const providerDisposable = mainModule.consumeGravissSource({
      id: "by-hand",
      createSession: ({ filePath }) =>
        filePath === viewPath ? new TestSession(MAIN_EXAMPLE) : null,
    });
    try {
      const item = await lumine.workspace.open(viewPath, { searchAllPanes: true });
      expect(item instanceof GravissView).toBe(true);
      await conditionPromise(() => item.renderer != null, "the hand-written view to load");
      // A graphic is where it is, so both survive; the repeated alias picks the
      // first one wearing it, which is an answer rather than a refusal.
      expect(item.graphics.map(({ title }) => title)).toEqual(["First", "Second"]);
      expect(item.activeGraphicIndex).toBe(0);
      // Nothing was posed, so the model is framed rather than restored, and the
      // file is left exactly as it was written.
      expect(item.usesFittedCamera()).toBe(true);
      expect(item.getFileState()).toBe(FileState.UNMODIFIED);
      await lumine.workspace.paneForItem(item)?.destroyItem(item, true);
    } finally {
      providerDisposable.dispose();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("loads a pane restored before its source package registered", async () => {
    // What restoring a window does: the panes are rebuilt first and the
    // packages' services are wired afterwards, so the viewer is built while
    // nothing can source it.
    sourceProviderDisposable.dispose();
    const restored = mainModule.deserialize({ uri: MAIN_EXAMPLE_URI });
    expect(restored).not.toBeNull();
    const error = restored.element.querySelector(".graviss-error");
    await conditionPromise(() => !error.hidden, "the missing source to be reported");
    expect(error.querySelector(".graviss-error-message").textContent).toMatch(/No source provider/);
    expect(restored.renderer).toBeNull();

    // The provider arrives moments later, and the pane that was waiting on it
    // loads without being closed and opened again.
    const unresolved = restored.session;
    sourceProviderDisposable = mainModule.consumeGravissSource({
      id: "spec-models",
      createSession({ filePath }) {
        const model = TEST_MODELS.find(({ viewDocumentPath }) => viewDocumentPath === filePath);
        return model ? new TestSession(model) : null;
      },
    });
    await conditionPromise(() => restored.renderer != null, "the restored pane to load");
    expect(error.hidden).toBe(true);
    expect(restored.session).not.toBe(unresolved);
    // The placeholder is closed behind it rather than left holding on.
    expect(unresolved.disposed).toBe(true);

    // The camera the document held is what it comes back at, which is the
    // reason for reloading the pane rather than replacing it.
    expect(restored.renderer.captureCameraState().projection).toBe("perspective");
    restored.destroy();
  });

  it("leaves a viewer alone when a late provider cannot source it", async () => {
    sourceProviderDisposable.dispose();
    const restored = mainModule.deserialize({ uri: MAIN_EXAMPLE_URI });
    const error = restored.element.querySelector(".graviss-error");
    await conditionPromise(() => !error.hidden, "the missing source to be reported");
    const unresolved = restored.session;

    // A provider that handles nothing here leaves the pane as it was.
    const idle = mainModule.consumeGravissSource({
      id: "spec-handles-nothing",
      createSession: () => null,
    });
    expect(restored.session).toBe(unresolved);
    expect(error.hidden).toBe(false);
    idle.dispose();

    // One that throws is reported on the pane it was asked about, and not out
    // of the registration that would carry it into another package's activate.
    const angry = mainModule.consumeGravissSource({
      id: "spec-throws",
      createSession() {
        throw new Error("The engineering database is unavailable.");
      },
    });
    expect(error.querySelector(".graviss-error-message").textContent).toMatch(
      /database is unavailable/,
    );
    expect(restored.session).toBe(unresolved);
    angry.dispose();
    restored.destroy();
  });
});
