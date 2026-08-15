const path = require("node:path");
const { CompositeDisposable, Emitter } = require("lumine");
const { APPEARANCES, APPEARANCE_IDS } = require("./appearance");
const { CAMERA_VIEW_IDS } = require("./camera-navigation");
const { loadRenderer } = require("./renderer-loader");
const { toolbarIcon } = require("./toolbar-icons");
const {
  validateChangeEvent,
  validateDescription,
  validateGeometry,
  validateSession,
} = require("./validation");
const { GravissViewDocument } = require("./view-document");

let nextSessionId = 1;
const IDLE_FRAME_RATE_LABEL = "\u2014 FPS";

const BACKGROUND_OPTIONS = Object.freeze([
  Object.freeze({
    id: "auto",
    label: "Automatic",
    description: "Follow the active Lumine theme",
  }),
  ...APPEARANCE_IDS.map((id) =>
    Object.freeze({
      id,
      label: APPEARANCES[id].label,
      description: `Use the ${APPEARANCES[id].label.toLowerCase()} engineering palette`,
    }),
  ),
]);

const VIEW_COMMANDS = Object.freeze({
  "graviss:view-isometric": "iso",
  ...Object.fromEntries(CAMERA_VIEW_IDS.map((viewId) => [`graviss:view-${viewId}`, viewId])),
});

const PROJECTION_COMMANDS = Object.freeze({
  "graviss:projection-perspective": "perspective",
  "graviss:projection-orthographic": "orthographic",
});

const VISIBILITY_COMMANDS = Object.freeze({
  "graviss:toggle-members": "members",
  "graviss:toggle-shells": "shells",
  "graviss:toggle-nodes": "nodes",
  "graviss:toggle-supports": "supports",
  "graviss:toggle-mesh": "mesh",
  "graviss:toggle-grid": "grid",
  "graviss:toggle-axes": "axes",
  "graviss:toggle-local-axes": "localAxes",
});

const BACKGROUND_COMMANDS = Object.freeze(
  Object.fromEntries(APPEARANCE_IDS.concat("auto").map((id) => [`graviss:background-${id}`, id])),
);

const CAMERA_STEP_COMMANDS = Object.freeze({
  "graviss:move-left": { displayName: "Move Left", method: "moveCamera", argument: "left" },
  "graviss:move-right": { displayName: "Move Right", method: "moveCamera", argument: "right" },
  "graviss:move-up": { displayName: "Move Up", method: "moveCamera", argument: "up" },
  "graviss:move-down": { displayName: "Move Down", method: "moveCamera", argument: "down" },
  "graviss:rotate-left": {
    displayName: "Rotate Left",
    method: "rotateCamera",
    argument: "left",
  },
  "graviss:rotate-right": {
    displayName: "Rotate Right",
    method: "rotateCamera",
    argument: "right",
  },
  "graviss:rotate-up": { displayName: "Rotate Up", method: "rotateCamera", argument: "up" },
  "graviss:rotate-down": {
    displayName: "Rotate Down",
    method: "rotateCamera",
    argument: "down",
  },
  "graviss:zoom-in": { displayName: "Zoom In", method: "zoomCamera", argument: "in" },
  "graviss:zoom-out": { displayName: "Zoom Out", method: "zoomCamera", argument: "out" },
});

class GravissView {
  constructor(session, options = {}) {
    validateSession(session);
    this.session = session;
    this.options = options;
    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable();
    this.viewDocument = createViewDocument(options);
    this.uri = options.uri || `graviss://session/${nextSessionId++}`;
    this.deserializer = options.deserializer || "GravissView";
    this.title = this.viewDocument?.getData().title || options.title || "FEM Model";
    this.restorable = Boolean(options.restorable);
    this.graphics = normalizeGraphics(this.viewDocument?.getData().graphics || options.graphics);
    const requestedGraphicId =
      options.activeGraphicId || this.viewDocument?.getData().activeGraphicId;
    const requestedGraphic = this.graphics.findIndex(
      (graphic) => graphic.id === requestedGraphicId,
    );
    this.activeGraphicIndex = requestedGraphic >= 0 ? requestedGraphic : 0;
    this.appearance = options.appearance || this.activeGraphic?.appearance || "auto";
    this.destroyed = false;
    this.hasTerminatedPendingState = false;
    this.renderer = null;
    this.description = null;
    this.geometry = null;
    this.sessionSubscription = null;
    this.backgroundList = null;
    this.element = this.createElement();
    this.bindInterface();
    this.load();
  }

  createElement() {
    const element = document.createElement("div");
    element.className = "graviss pane-item native-key-bindings";
    element.tabIndex = -1;
    element.innerHTML = `
      <header class="graviss-toolbar btn-toolbar">
        <div class="block graviss-toolbar-block graviss-graphic-actions" role="group" aria-label="Graphics">
          <div class="btn-group btn-group-sm">
            <button type="button" class="btn graviss-toolbar-button" data-action="previous-graphic" data-command="graviss:previous-graphic" aria-label="Previous graphic">${toolbarIcon("previous-graphic")}</button>
            <span class="btn graviss-graphic-counter" role="status" aria-live="polite" aria-atomic="true">0/0</span>
            <button type="button" class="btn graviss-toolbar-button" data-action="next-graphic" data-command="graviss:next-graphic" aria-label="Next graphic">${toolbarIcon("next-graphic")}</button>
          </div>
        </div>
        <div class="block graviss-toolbar-block">
          <div class="btn-group btn-group-sm graviss-view-actions" role="group" aria-label="Camera views">
            <button type="button" class="btn graviss-toolbar-button" data-action="fit" data-command="graviss:fit-view" aria-label="Fit model">${toolbarIcon("fit")}</button>
            <button type="button" class="btn graviss-toolbar-button" data-view="iso" data-command="graviss:view-isometric" aria-label="Isometric view">${toolbarIcon("isometric")}</button>
            <button type="button" class="btn graviss-toolbar-button" data-view="top" data-command="graviss:view-top" aria-label="Top view">${toolbarIcon("top")}</button>
            <button type="button" class="btn graviss-toolbar-button" data-view="front" data-command="graviss:view-front" aria-label="Front view">${toolbarIcon("front")}</button>
            <button type="button" class="btn graviss-toolbar-button" data-view="right" data-command="graviss:view-right" aria-label="Right view">${toolbarIcon("right")}</button>
          </div>
        </div>
        <div class="block graviss-toolbar-block">
          <div class="btn-group btn-group-sm graviss-projection-actions" role="group" aria-label="Camera projection">
            <button type="button" class="btn graviss-toolbar-button selected" data-projection="perspective" data-command="graviss:projection-perspective" aria-label="Perspective projection" aria-pressed="true">${toolbarIcon("perspective")}</button>
            <button type="button" class="btn graviss-toolbar-button" data-projection="orthographic" data-command="graviss:projection-orthographic" aria-label="Orthographic projection" aria-pressed="false">${toolbarIcon("orthographic")}</button>
          </div>
        </div>
        <div class="block graviss-toolbar-block graviss-section-rendering">
          <div class="btn-group btn-group-sm" role="group" aria-label="Section rendering">
            <button type="button" class="btn graviss-toolbar-button selected" data-action="toggle-sections" data-command="graviss:toggle-sections" aria-label="Draw elements without their sections" aria-pressed="true">${toolbarIcon("sections")}</button>
          </div>
        </div>
        <div class="block graviss-toolbar-block graviss-visibility">
          <div class="btn-group btn-group-sm" role="group" aria-label="Visible entities">
            <button type="button" class="btn graviss-toolbar-button selected" data-visible="members" data-command="graviss:toggle-members" aria-label="Hide members" aria-pressed="true">${toolbarIcon("members")}</button>
            <button type="button" class="btn graviss-toolbar-button selected" data-visible="shells" data-command="graviss:toggle-shells" aria-label="Hide shells" aria-pressed="true">${toolbarIcon("shells")}</button>
            <button type="button" class="btn graviss-toolbar-button selected" data-visible="nodes" data-command="graviss:toggle-nodes" aria-label="Hide nodes" aria-pressed="true">${toolbarIcon("nodes")}</button>
            <button type="button" class="btn graviss-toolbar-button selected" data-visible="supports" data-command="graviss:toggle-supports" aria-label="Hide supports" aria-pressed="true">${toolbarIcon("supports")}</button>
            <button type="button" class="btn graviss-toolbar-button selected" data-visible="mesh" data-command="graviss:toggle-mesh" aria-label="Hide mesh" aria-pressed="true">${toolbarIcon("mesh")}</button>
            <button type="button" class="btn graviss-toolbar-button selected" data-visible="grid" data-command="graviss:toggle-grid" aria-label="Hide grid" aria-pressed="true">${toolbarIcon("grid")}</button>
            <button type="button" class="btn graviss-toolbar-button selected" data-visible="axes" data-command="graviss:toggle-axes" aria-label="Hide axes" aria-pressed="true">${toolbarIcon("axes")}</button>
            <button type="button" class="btn graviss-toolbar-button" data-visible="localAxes" data-command="graviss:toggle-local-axes" aria-label="Show local axes" aria-pressed="false">${toolbarIcon("local-axes")}</button>
          </div>
        </div>
        <div class="block graviss-toolbar-block graviss-background-control">
          <div class="btn-group btn-group-sm">
            <button type="button" class="btn graviss-toolbar-button graviss-background-button" data-action="background" data-command="graviss:choose-background" aria-label="Choose model background" aria-haspopup="dialog" aria-expanded="false">${toolbarIcon("background")}</button>
          </div>
        </div>
        <div class="block graviss-toolbar-block graviss-performance">
          <span class="btn graviss-fps-counter" data-tooltip="Rendered frames per second while the viewport is active" aria-label="Render frame rate idle">${IDLE_FRAME_RATE_LABEL}</span>
        </div>
      </header>
      <main class="graviss-workspace">
        <section class="graviss-viewport" aria-label="FEM model viewport">
          <div class="graviss-canvas-host"></div>
          <div class="graviss-status graviss-loading">
            <span class="loading loading-spinner-tiny inline-block"></span>
            <span>Loading model geometry…</span>
          </div>
          <div class="graviss-status graviss-error" hidden>
            <strong>Could not open this FEM model</strong>
            <span class="graviss-error-message"></span>
            <button class="btn btn-primary" data-action="retry" data-command="graviss:retry">Retry</button>
          </div>
          <div class="graviss-camera-navigator" role="group" aria-label="Camera navigation">
            <canvas class="graviss-view-cube" tabindex="0" aria-label="Interactive 3D view cube. Click a face, edge, or corner to orient the model."></canvas>
          </div>
          <div class="graviss-axis-gizmo" aria-label="Global axes" hidden>
            <svg viewBox="0 0 84 84" aria-hidden="true">
              <g class="graviss-gizmo-axis is-x" data-gizmo-axis="x">
                <line x1="42" y1="42" x2="69" y2="42"></line>
                <circle cx="69" cy="42" r="2"></circle>
                <text x="75" y="42">X</text>
              </g>
              <g class="graviss-gizmo-axis is-y" data-gizmo-axis="y">
                <line x1="42" y1="42" x2="42" y2="15"></line>
                <circle cx="42" cy="15" r="2"></circle>
                <text x="42" y="9">Y</text>
              </g>
              <g class="graviss-gizmo-axis is-z" data-gizmo-axis="z">
                <line x1="42" y1="42" x2="42" y2="69"></line>
                <circle cx="42" cy="69" r="2"></circle>
                <text x="42" y="77">Z</text>
              </g>
              <circle class="graviss-gizmo-origin" cx="42" cy="42" r="3"></circle>
            </svg>
          </div>
        </section>
      </main>
    `;
    this.updateAppearanceControls(element);
    this.updateGraphicControls(element);
    return element;
  }

  get activeGraphic() {
    return this.graphics[this.activeGraphicIndex] || null;
  }

  bindInterface() {
    this.onClick = (event) => {
      const button = event.target.closest("button[data-command]");
      if (!button || !this.element.contains(button)) return;
      this.dispatchCommand(button.dataset.command);
    };
    this.onContextMenu = (event) => {
      if (!event.target.closest(".graviss-viewport")) return;
      event.preventDefault();
      event.stopPropagation();
    };
    this.element.addEventListener("click", this.onClick);
    this.element.addEventListener("contextmenu", this.onContextMenu);
    this.subscriptions.add(
      lumine.commands.add(this.element, this.createViewerCommands()),
      lumine.themes.onDidChangeActiveThemes(() => this.renderer?.applyTheme()),
    );
    this.bindTooltips();
    this.bindViewDocument();
  }

  bindTooltips() {
    for (const button of this.element.querySelectorAll(".graviss-toolbar button[data-command]")) {
      this.subscriptions.add(
        lumine.tooltips.add(button, {
          title: tooltipLabel,
          keyBindingCommand: button.dataset.command,
          keyBindingTarget: button,
        }),
      );
    }
    for (const element of this.element.querySelectorAll(
      ".graviss-graphic-counter, .graviss-fps-counter, .graviss-view-cube",
    )) {
      this.subscriptions.add(lumine.tooltips.add(element, { title: tooltipLabel }));
    }
  }

  createViewerCommands() {
    const commands = {
      "core:undo": exclusiveCommand(() => this.undo()),
      "core:redo": exclusiveCommand(() => this.redo()),
      "graviss:fit-view": viewerCommand("Fit View", () =>
        this.performViewerAction(() => this.renderer?.fitView()),
      ),
      "graviss:previous-graphic": viewerCommand("Previous Graphic", () =>
        this.performViewerAction(() => this.switchGraphic(-1)),
      ),
      "graviss:next-graphic": viewerCommand("Next Graphic", () =>
        this.performViewerAction(() => this.switchGraphic(1)),
      ),
      "graviss:activate-graphic": viewerCommand(
        "Activate Graphic",
        (event) => {
          const activated = this.performViewerAction(() =>
            this.activateGraphic(event.detail?.graphicId),
          );
          if (event.detail && typeof event.detail === "object") {
            event.detail.activated = activated;
          }
          return activated;
        },
        { hiddenInCommandPalette: true },
      ),
      "graviss:choose-background": viewerCommand(
        "Choose Background",
        () => this.performViewerAction(() => this.showBackgroundList()),
        { modal: "Model background" },
      ),
      "graviss:toggle-projection": viewerCommand("Toggle Projection", () =>
        this.performViewerAction(() => this.renderer?.toggleProjection()),
      ),
      "graviss:retry": viewerCommand("Retry Loading Model", () =>
        this.performViewerAction(() => this.load()),
      ),
    };
    for (const [commandName, viewId] of Object.entries(VIEW_COMMANDS)) {
      commands[commandName] = viewerCommand(`View ${titleForId(viewId)}`, (event) =>
        this.performViewerAction(() =>
          this.renderer?.setStandardView(viewId, {
            animate: event.detail?.animate === true,
          }),
        ),
      );
    }
    for (const [commandName, projection] of Object.entries(PROJECTION_COMMANDS)) {
      commands[commandName] = viewerCommand(`${titleForId(projection)} Projection`, () =>
        this.performViewerAction(() => this.renderer?.setProjection(projection)),
      );
    }
    for (const [commandName, name] of Object.entries(VISIBILITY_COMMANDS)) {
      commands[commandName] = viewerCommand(`Toggle ${titleForId(name)}`, () =>
        this.performViewerAction(() => this.toggleVisibility(name)),
      );
    }
    commands["graviss:toggle-sections"] = viewerCommand("Toggle Section Rendering", () =>
      this.performViewerAction(() => this.toggleSectionRendering()),
    );
    for (const [commandName, appearance] of Object.entries(BACKGROUND_COMMANDS)) {
      commands[commandName] = viewerCommand(`Background ${titleForId(appearance)}`, () =>
        this.performViewerAction(() => this.setAppearance(appearance)),
      );
    }
    for (const [commandName, { displayName, method, argument }] of Object.entries(
      CAMERA_STEP_COMMANDS,
    )) {
      commands[commandName] = viewerCommand(displayName, () =>
        this.performViewerAction(() => this.renderer?.[method](argument)),
      );
    }
    return commands;
  }

  dispatchCommand(commandName, detail) {
    return lumine.commands.dispatch(this.element, commandName, detail);
  }

  performViewerAction(action) {
    this.flushPendingCameraHistory();
    return action();
  }

  toggleVisibility(name) {
    const button = this.element.querySelector(`button[data-visible="${name}"]`);
    if (!button) return false;
    const visible = button.getAttribute("aria-pressed") !== "true";
    this.updateVisibilityControl(button, visible);
    this.renderer?.setVisibility(name, visible);
    this.updateActiveGraphic((graphic) => {
      graphic.visibility ||= {};
      graphic.visibility[name] = visible;
    }, "visibility");
    return visible;
  }

  isVisible(name) {
    return (
      this.element.querySelector(`button[data-visible="${name}"]`)?.getAttribute("aria-pressed") ===
      "true"
    );
  }

  setVisibility(name, visible) {
    const next = Boolean(visible);
    if (this.isVisible(name) === next) return next;
    return this.toggleVisibility(name);
  }

  bindViewDocument() {
    if (!this.viewDocument) return;
    this.subscriptions.add(
      this.viewDocument.onDidChange(({ data }) => this.syncGraphicsFromDocument(data)),
      this.viewDocument.onDidReload((data) => this.reloadViewDocument(data)),
      this.viewDocument.onDidRestoreHistory(({ data }) => this.reloadViewDocument(data)),
      this.viewDocument.onDidChangeModified((modified) => {
        if (modified) this.terminatePendingState();
        this.emitter.emit("did-change-modified", modified);
      }),
      this.viewDocument.onDidConflict(() => this.emitter.emit("did-conflict")),
      this.viewDocument.onDidDelete(() => this.emitter.emit("did-delete")),
      this.viewDocument.onDidChangePath((filePath) => this.didChangePath(filePath)),
      this.viewDocument.onDidSave((event) => this.emitter.emit("did-save", event)),
    );
  }

  didChangePath(filePath) {
    if (this.options.uriTracksPath) this.uri = filePath;
    this.emitter.emit("did-change-path", filePath);
  }

  async load() {
    if (this.destroyed || this.loading) return;
    this.loading = true;
    this.showLoading();
    this.updateFrameRate(null);
    this.renderer?.destroy();
    this.renderer = null;
    try {
      const description = validateDescription(await this.session.describe());
      this.description = description;
      this.observeSessionChanges();
      if (this.destroyed) return;
      const geometry = validateGeometry(await this.session.getGeometry());
      this.geometry = geometry;
      if (this.destroyed) return;
      const { GravissRenderer } = await loadRenderer();
      if (this.destroyed) return;
      const renderer = await GravissRenderer.create(
        this.element.querySelector(".graviss-canvas-host"),
        geometry,
        {
          onProjectionChange: (projection) => this.updateProjection(projection),
          onCameraChange: (camera) => this.updateCamera(camera),
          onFrameRate: (fps) => this.updateFrameRate(fps),
          onViewSelect: (viewId) =>
            this.dispatchCommand(`graviss:view-${viewId}`, { animate: true }),
          onSelectionChange: (selection) => this.emitter.emit("did-change-selection", selection),
          coordinateSystem: description.model.coordinateSystem,
        },
      );
      if (this.destroyed) {
        renderer.destroy();
        return;
      }
      this.renderer = renderer;
      this.applyActiveGraphic();
      this.title =
        this.viewDocument?.getData().title || this.options.title || description.model.title;
      this.hideStatus();
      this.emitter.emit("did-change-title");
      this.emitter.emit("did-load-model", {
        description: this.description,
        geometry: this.geometry,
      });
    } catch (error) {
      if (!this.destroyed) this.showError(error);
    } finally {
      this.loading = false;
    }
  }

  // A source that can tell Graviss it changed gets one subscription per load.
  // Reloading re-subscribes, so a session swapped in by a retry is watched too.
  observeSessionChanges() {
    this.sessionSubscription?.dispose();
    this.sessionSubscription = null;
    if (typeof this.session.onDidChange !== "function") return;
    this.sessionSubscription = this.session.onDidChange((event) =>
      this.didChangeSource(validateChangeEvent(event)),
    );
  }

  // Every scope Graviss understands today is a geometry change, so a report
  // rebuilds the scene. The camera survives it; it belongs to the view document.
  didChangeSource({ scope }) {
    if (this.destroyed) return scope;
    void this.load();
    return scope;
  }

  showLoading() {
    this.element.querySelector(".graviss-loading").hidden = false;
    this.element.querySelector(".graviss-error").hidden = true;
  }

  updateFrameRate(fps) {
    const counter = this.element.querySelector(".graviss-fps-counter");
    if (!counter) return;
    const active = Number.isFinite(fps) && fps > 0;
    const value = active ? Math.round(fps) : null;
    counter.textContent = active ? `${value} FPS` : IDLE_FRAME_RATE_LABEL;
    counter.dataset.active = String(active);
    counter.setAttribute(
      "aria-label",
      active ? `Render frame rate ${value} frames per second` : "Render frame rate idle",
    );
  }

  hideStatus() {
    this.element.querySelector(".graviss-loading").hidden = true;
    this.element.querySelector(".graviss-error").hidden = true;
  }

  showError(error) {
    this.element.querySelector(".graviss-loading").hidden = true;
    const errorElement = this.element.querySelector(".graviss-error");
    errorElement.hidden = false;
    errorElement.querySelector(".graviss-error-message").textContent =
      error?.message || String(error);
  }

  updateProjection(projection) {
    for (const button of this.element.querySelectorAll("[data-projection]")) {
      const selected = button.dataset.projection === projection;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    }
  }

  setAppearance(appearance) {
    if (appearance !== "auto" && !APPEARANCE_IDS.includes(appearance)) return false;
    this.appearance = appearance;
    this.updateAppearanceControls();
    this.renderer?.setAppearance(appearance);
    this.updateActiveGraphic((graphic) => {
      graphic.appearance = appearance;
    }, "appearance");
    return true;
  }

  updateAppearanceControls(root = this.element) {
    const button = root.querySelector('[data-action="background"]');
    if (!button) return;
    const label =
      this.appearance === "auto" ? "Automatic" : APPEARANCES[this.appearance]?.label || "Unknown";
    button.dataset.appearance = this.appearance;
    button.setAttribute("aria-label", `Model background: ${label}. Choose background`);
  }

  showBackgroundList() {
    if (this.destroyed || this.backgroundList) return;
    const initialSelectionIndex = Math.max(
      0,
      BACKGROUND_OPTIONS.findIndex(({ id }) => id === this.appearance),
    );
    this.backgroundList = lumine.workspace.buildSelectList({
      className: "graviss-background-list",
      crumb: "Model background",
      emptyMessage: "No model backgrounds found",
      items: BACKGROUND_OPTIONS,
      initialSelectionIndex,
      filterKeyForItem: ({ label, description }) => `${label} ${description}`,
      elementForItem: (option, { highlight }) => ({
        primary: highlight(option.label),
        secondary: option.description,
        icon: [option.id === this.appearance ? "icon-check" : "icon-color-mode"],
      }),
      didConfirmSelection: (option) => {
        this.dispatchCommand(`graviss:background-${option.id}`);
        this.closeBackgroundList();
      },
      didCancelSelection: () => this.closeBackgroundList(),
    });
    this.element.querySelector('[data-action="background"]')?.setAttribute("aria-expanded", "true");
    this.backgroundList.show();
  }

  closeBackgroundList() {
    const list = this.backgroundList;
    if (!list) return;
    this.backgroundList = null;
    this.element
      .querySelector('[data-action="background"]')
      ?.setAttribute("aria-expanded", "false");
    list.hide();
    list.destroy();
  }

  updateVisibilityControl(button, visible) {
    button.classList.toggle("selected", visible);
    button.setAttribute("aria-pressed", String(visible));
    const action = visible ? "Hide" : "Show";
    const label = `${action} ${button.dataset.visible}`;
    button.setAttribute("aria-label", label);
  }

  switchGraphic(direction) {
    if (this.graphics.length < 2 || !Number.isInteger(direction) || direction === 0) return null;
    const nextIndex =
      (this.activeGraphicIndex + Math.sign(direction) + this.graphics.length) %
      this.graphics.length;
    this.activateGraphic(this.graphics[nextIndex].id);
    return this.activeGraphic;
  }

  activateGraphic(graphicId) {
    const nextIndex = this.graphics.findIndex(({ id }) => id === graphicId);
    if (nextIndex < 0) return false;
    this.flushPendingCameraHistory();
    const changed = nextIndex !== this.activeGraphicIndex;
    this.activeGraphicIndex = nextIndex;
    this.viewDocument?.update((document) => {
      document.activeGraphicId = this.activeGraphic.id;
    }, "active-graphic");
    this.applyActiveGraphic();
    if (changed) this.emitter.emit("did-change-navigation");
    return true;
  }

  updateActiveGraphic(mutator, reason) {
    const graphicId = this.activeGraphic?.id;
    if (!this.viewDocument || !graphicId) return false;
    const fittedCamera = this.viewDocument.isImplicit()
      ? this.renderer?.captureCameraState()
      : null;
    return this.viewDocument.update((document) => {
      const graphic = document.graphics.find(({ id }) => id === graphicId);
      if (graphic) {
        if (fittedCamera) graphic.camera = fittedCamera;
        mutator(graphic);
      }
    }, reason);
  }

  updateCamera(camera) {
    this.updateActiveGraphic((graphic) => {
      graphic.camera = camera;
    }, "camera");
  }

  // The document is the authority on the graphics. Every committed change — a
  // camera write, a toolbar toggle, an edit of the JSON source — refreshes the
  // snapshot that graphic switching reads, so returning to a graphic restores
  // the camera it holds now rather than the one it held when the file opened.
  syncGraphicsFromDocument(data) {
    const activeId = this.activeGraphic?.id;
    const before = this.navigationSignature();
    this.graphics = normalizeGraphics(data.graphics);
    const activeIndex = this.graphics.findIndex(({ id }) => id === activeId);
    this.activeGraphicIndex =
      activeIndex >= 0 ? activeIndex : Math.min(this.activeGraphicIndex, this.graphics.length - 1);
    if (this.navigationSignature() !== before) this.emitter.emit("did-change-navigation");
  }

  navigationSignature() {
    return JSON.stringify([
      this.activeGraphicIndex,
      this.graphics.map(({ id, title }) => [id, title]),
    ]);
  }

  reloadViewDocument(data) {
    this.graphics = normalizeGraphics(data.graphics);
    const activeIndex = this.graphics.findIndex(({ id }) => id === data.activeGraphicId);
    this.activeGraphicIndex = activeIndex >= 0 ? activeIndex : 0;
    this.title = data.title || this.options.title || this.title;
    this.applyActiveGraphic();
    this.emitter.emit("did-change-title");
    this.emitter.emit("did-change-navigation");
  }

  getNavigationHeaders() {
    return this.graphics.map((graphic, index) => {
      const current = index === this.activeGraphicIndex ? 1 : 0;
      const point = { row: index, column: 0 };
      return {
        text: graphic.title,
        level: 1,
        classList: [],
        children: [],
        graphicId: graphic.id,
        currentCount: current,
        stackCount: current,
        startPoint: point,
        endPoint: point,
      };
    });
  }

  observeNavigationHeaders(callback) {
    if (typeof callback !== "function") {
      throw new TypeError("A navigation-header observer must be a function");
    }
    const refresh = () => callback(this.getNavigationHeaders(), { instant: true });
    refresh();
    return this.emitter.on("did-change-navigation", refresh);
  }

  applyActiveGraphic() {
    const graphic = this.activeGraphic;
    this.updateGraphicControls();
    if (!this.renderer) return;
    if (!graphic) {
      this.renderer.setAppearance(this.appearance);
      return;
    }

    this.appearance = graphic.appearance || "auto";
    this.updateAppearanceControls();
    this.renderer.setAppearance(this.appearance);
    const visibility = {
      members: true,
      shells: true,
      nodes: true,
      supports: true,
      mesh: true,
      grid: true,
      axes: true,
      localAxes: false,
      ...graphic.visibility,
    };
    for (const [name, visible] of Object.entries(visibility)) {
      const button = this.element.querySelector(`button[data-visible="${name}"]`);
      if (!button || typeof visible !== "boolean") continue;
      this.updateVisibilityControl(button, visible);
      this.renderer.setVisibility(name, visible);
    }
    // Restored through the renderer directly: going through setSectionRendering
    // here would write the value straight back into the document it just came
    // from and stamp a modification on merely activating a graphic.
    const sectionRendering = graphic.sectionRendering !== false;
    this.renderer.setSectionRendering(sectionRendering);
    this.updateSectionRenderingControl(sectionRendering);
    if (!this.viewDocument?.isImplicit()) this.renderer.applyCameraState(graphic.camera);
  }

  updateGraphicControls(root = this.element) {
    const actions = root.querySelector(".graviss-graphic-actions");
    if (!actions) return;
    actions.hidden = this.graphics.length < 2;
    const graphic = this.activeGraphic;
    const summary = graphic
      ? `${graphic.title}, graphic ${this.activeGraphicIndex + 1} of ${this.graphics.length}`
      : "Graphics";
    actions.setAttribute("aria-label", summary);
    const counter = actions.querySelector(".graviss-graphic-counter");
    counter.textContent = graphic
      ? `${this.activeGraphicIndex + 1}/${this.graphics.length}`
      : "0/0";
    counter.dataset.tooltip = graphic?.title || "No active graphic";
    counter.setAttribute("aria-label", summary);
    const previous = actions.querySelector('[data-action="previous-graphic"]');
    const next = actions.querySelector('[data-action="next-graphic"]');
    const previousTitle = `Previous graphic from ${summary}`;
    const nextTitle = `Next graphic from ${summary}`;
    previous.setAttribute("aria-label", previousTitle);
    next.setAttribute("aria-label", nextTitle);
  }

  getElement() {
    return this.element;
  }

  getModelDescription() {
    return this.description;
  }

  getGeometrySummary() {
    if (!this.geometry) return null;
    return {
      nodes: this.geometry.nodes.length,
      members: this.geometry.elements.filter(({ kind }) => kind === "beam").length,
      shells: this.geometry.elements.filter(({ kind }) => kind === "shell").length,
      supports: (this.geometry.supports || []).length,
      sections: (this.geometry.sections || []).length,
    };
  }

  // The model has two display modes: with section rendering a line element
  // carries its extruded cross-section and a thick area element is a closed
  // solid; without it a line element is a line and an area element its
  // reference surface.
  setSectionRendering(enabled) {
    const applied = this.renderer?.setSectionRendering(enabled) ?? Boolean(enabled);
    this.updateSectionRenderingControl(applied);
    this.updateActiveGraphic((graphic) => {
      graphic.sectionRendering = applied;
    }, "section-rendering");
    return applied;
  }

  isSectionRenderingEnabled() {
    return this.renderer?.isSectionRendering() ?? true;
  }

  toggleSectionRendering() {
    return this.setSectionRendering(!this.isSectionRenderingEnabled());
  }

  updateSectionRenderingControl(enabled = this.isSectionRenderingEnabled(), root = this.element) {
    const button = root.querySelector('[data-action="toggle-sections"]');
    if (!button) return;
    button.classList.toggle("selected", enabled);
    button.setAttribute("aria-pressed", String(enabled));
    button.setAttribute(
      "aria-label",
      enabled ? "Draw elements without their sections" : "Draw elements with their sections",
    );
  }

  getTitle() {
    return this.title;
  }

  getURI() {
    return this.uri;
  }

  getPath() {
    return this.viewDocument?.getPath() || null;
  }

  isModified() {
    return this.viewDocument?.isModified() || false;
  }

  isInConflict() {
    return this.viewDocument?.isInConflict() || false;
  }

  isDeleted() {
    return this.viewDocument?.isDeleted() || false;
  }

  shouldPromptToSave({ windowCloseRequested, projectHasPaths } = {}) {
    this.flushPendingCameraHistory();
    if (windowCloseRequested && projectHasPaths && lumine.stateStore.isConnected()) {
      return this.isInConflict();
    }
    const promptForDeleted = this.isDeleted() && lumine.config.get("core.promptOnCloseDeletedFile");
    return this.isModified() || promptForDeleted;
  }

  canUndo() {
    return this.viewDocument?.canUndo() || false;
  }

  canRedo() {
    return this.viewDocument?.canRedo() || false;
  }

  undo() {
    this.flushPendingCameraHistory();
    return this.viewDocument?.undo() || false;
  }

  redo() {
    this.flushPendingCameraHistory();
    return this.viewDocument?.redo() || false;
  }

  flushPendingCameraHistory() {
    this.renderer?.flushScheduledCameraChange();
  }

  async save() {
    this.flushPendingCameraHistory();
    if (!this.viewDocument) return false;
    if (!this.getPath()) {
      const pane = lumine.workspace.paneForItem(this);
      return pane ? pane.saveItemAs(this) : false;
    }
    return this.viewDocument.save();
  }

  saveAs(filePath) {
    this.flushPendingCameraHistory();
    return this.viewDocument?.saveAs(filePath) || false;
  }

  getSaveDialogOptions() {
    let defaultPath = this.getPath();
    if (!defaultPath) {
      const projectPath = lumine.project.getPaths()[0];
      defaultPath = projectPath
        ? path.join(projectPath, `${safeFileName(this.title)}.grv`)
        : `${safeFileName(this.title)}.grv`;
    }
    return {
      defaultPath,
      filters: [{ name: "Graviss view", extensions: ["grv"] }],
    };
  }

  getIconName() {
    return "graph";
  }

  getDefaultLocation() {
    return "center";
  }

  getAllowedLocations() {
    return ["center"];
  }

  focus() {
    (this.renderer?.canvasRenderer?.domElement || this.element).focus();
  }

  onDidChangeTitle(callback) {
    return this.emitter.on("did-change-title", callback);
  }

  onDidLoadModel(callback) {
    return this.emitter.on("did-load-model", callback);
  }

  onDidChangeSelection(callback) {
    return this.emitter.on("did-change-selection", callback);
  }

  onDidChangeModified(callback) {
    return this.emitter.on("did-change-modified", callback);
  }

  terminatePendingState() {
    if (this.hasTerminatedPendingState) return;
    this.hasTerminatedPendingState = true;
    this.emitter.emit("did-terminate-pending-state");
  }

  onDidTerminatePendingState(callback) {
    return this.emitter.on("did-terminate-pending-state", callback);
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

  onDidDestroy(callback) {
    return this.emitter.on("did-destroy", callback);
  }

  serialize() {
    if (!this.restorable) return null;
    this.flushPendingCameraHistory();
    const state = { deserializer: this.deserializer, uri: this.uri };
    if (this.activeGraphic) state.activeGraphicId = this.activeGraphic.id;
    if (this.viewDocument) state.viewDocument = this.viewDocument.serialize();
    return state;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.renderer?.destroy();
    this.renderer = null;
    this.closeBackgroundList();
    this.sessionSubscription?.dispose();
    this.sessionSubscription = null;
    this.subscriptions.dispose();
    this.element.removeEventListener("click", this.onClick);
    this.element.removeEventListener("contextmenu", this.onContextMenu);
    try {
      this.session.dispose();
    } finally {
      this.viewDocument?.destroy();
      this.viewDocument = null;
      this.emitter.emit("did-destroy");
      this.emitter.dispose();
      this.element.remove();
    }
  }
}

function exclusiveCommand(action) {
  return (event) => {
    event.stopPropagation();
    return action(event);
  };
}

function tooltipLabel() {
  const label = this.dataset.tooltip || this.getAttribute("aria-label") || "";
  return String(label).replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
}

function viewerCommand(displayName, action, metadata = {}) {
  return {
    displayName: `Graviss: ${displayName}`,
    ...metadata,
    didDispatch: exclusiveCommand(action),
  };
}

function titleForId(id) {
  if (id === "iso") return "Isometric";
  if (id === "auto") return "Automatic";
  return String(id)
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeGraphics(graphics) {
  if (graphics == null) return [];
  if (!Array.isArray(graphics)) throw new TypeError("Graviss graphics must be an array");
  const ids = new Set();
  return graphics.map((graphic, index) => {
    if (!graphic || typeof graphic !== "object") {
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
    return graphic;
  });
}

function createViewDocument(options) {
  if (options.viewDocument instanceof GravissViewDocument) return options.viewDocument;
  if (!options.viewDocument) return null;
  return new GravissViewDocument({ data: options.viewDocument, filePath: options.filePath });
}

function safeFileName(title) {
  const name = [...String(title || "Untitled")]
    .map((character) =>
      character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character) ? "-" : character,
    )
    .join("")
    .replace(/[. ]+$/g, "")
    .trim();
  return name || "Untitled";
}

module.exports = GravissView;
