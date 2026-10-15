const path = require("node:path");
const { CompositeDisposable, Disposable } = require("lumine");
let GravissView;
const getGravissView = () => (GravissView ||= require("./graviss-view"));
function isGravissView(item) {
  for (let prototype = item; prototype; prototype = Object.getPrototypeOf(prototype)) {
    if (prototype.constructor?.name === "GravissView") return item instanceof getGravissView();
  }
  return false;
}
const FILTER_PANEL_URI = "graviss://filter";
const RESULTS_PANEL_URI = "graviss://results";
const { UnresolvedSourceSession } = require("./unresolved-source-session");
const { validateSession, validateSourceProvider } = require("./source-validation");

module.exports = {
  provideBackgroundTips() {
    return {
      packageName: "graviss",
      tips: [
        "You can fit the active FEM model to its viewport with {{ 'graviss:fit-view' | keystroke }}",
        "You can narrow a FEM model to the elements you are interested in with {{ 'graviss:toggle-filter-panel' | keystroke }}",
        "You can animate a load case over the FEM model with {{ 'graviss:toggle-results-panel' | keystroke }}",
      ],
    };
  },

  initialize() {
    if (this.initialized) return;
    this.initialized = true;
    this.viewers = new Set();
    this.sourceProviders = [];
    this.updatingModelSources = new Set();
  },

  activate() {
    this.initialize();
    if (this.subscriptions) return;
    this.subscriptions = new CompositeDisposable(
      lumine.workspace.addOpener((uri) => {
        if (uri === FILTER_PANEL_URI) return this.getFilterPanel();
        if (uri === RESULTS_PANEL_URI) return this.getResultsPanel();
      }),
      lumine.workspace.addPathOpener({
        id: "graviss",
        label: "Graviss",
        canOpen: isGravissViewPath,
        open: (uri) => this.openFileViewer(uri),
        handlesItem: isGravissView,
      }),
      lumine.commands.add("lumine-workspace", {
        "graviss:toggle-filter-panel": {
          description: "Show or hide the panel that narrows which elements are drawn.",
          didDispatch: () => this.getFilterPanel().toggle(),
        },
        "graviss:toggle-results-panel": {
          description: "Show or hide the panel that shows the analysis results.",
          didDispatch: () => this.getResultsPanel().toggle(),
        },
        "graviss:toggle-focus-filter-panel": {
          description: "Focus the filter panel, or hand focus back to the model.",
          didDispatch: (event) =>
            void this.getFilterPanel().toggleFocus(this.viewerForEvent(event) || undefined),
        },
        "graviss:toggle-focus-results-panel": {
          description: "Focus the results panel, or hand focus back to the model.",
          didDispatch: (event) =>
            void this.getResultsPanel().toggleFocus(this.viewerForEvent(event) || undefined),
        },
      }),
    );
    this.replaceOrphanedPanelItems();
  },

  // A generation loaded before the panel lifecycle fix may already have left
  // a destroyed Results/Filter item in a dock. It belongs to another module
  // generation and cannot be revived: replace it in place with this
  // generation's singleton, preserving the visible tab. This makes the first
  // reload carrying the fix repair the existing window instead of requiring a
  // second reload or manual tab close.
  replaceOrphanedPanelItems() {
    const definitions = [
      { uri: FILTER_PANEL_URI, held: "filterPanel", get: () => this.getFilterPanel() },
      { uri: RESULTS_PANEL_URI, held: "resultsPanel", get: () => this.getResultsPanel() },
    ];
    for (const definition of definitions) {
      const candidates = lumine.workspace
        .getPaneItems()
        .filter((item) => item?.getURI?.() === definition.uri);
      for (const stale of candidates) {
        if (stale === this[definition.held]) continue;
        const pane = lumine.workspace.paneForItem(stale);
        if (!pane) continue;
        const index = pane.getItems().indexOf(stale);
        const wasActive = pane.getActiveItem() === stale;
        pane.removeItem(stale, false);
        stale.destroy?.();
        const replacement = definition.get();
        if (!lumine.workspace.paneForItem(replacement)) {
          pane.addItem(replacement, { index });
        }
        if (wasActive) pane.activateItem(replacement);
      }
    }
  },

  // One panel of each, for the whole window. Both follow whichever model is
  // being looked at, so a second copy would be a second view of the same thing
  // - and the dock has nowhere to put it that the first one is not already.
  getFilterPanel() {
    if (!this.filterPanel) {
      const { FilterPanel } = require("./filter-panel");
      this.filterPanel = this.createPanel(FilterPanel, "filterPanel");
    }
    return this.filterPanel;
  },

  getResultsPanel() {
    if (!this.resultsPanel) {
      const { ResultsPanel } = require("./results-panel");
      this.resultsPanel = this.createPanel(ResultsPanel, "resultsPanel");
    }
    return this.resultsPanel;
  },

  createPanel(Panel, held) {
    const panel = new Panel();
    panel.onDidDestroy(() => {
      if (this[held] === panel) this[held] = null;
    });
    return panel;
  },

  deserializeFilterPanel() {
    return this.getFilterPanel();
  },

  deserializeResultsPanel() {
    return this.getResultsPanel();
  },

  async deactivate() {
    this.subscriptions?.dispose();
    this.subscriptions = null;
    const closures = [];
    for (const viewer of [...(this.viewers || [])]) {
      const pane = lumine.workspace.paneForItem(viewer);
      if (pane) closures.push(pane.destroyItem(viewer, true));
      else viewer.destroy();
    }
    await Promise.all(closures);
    this.viewers?.clear();
    const filterPane = this.filterPanel && lumine.workspace.paneForItem(this.filterPanel);
    if (filterPane) await filterPane.destroyItem(this.filterPanel, true);
    else this.filterPanel?.destroy();
    this.filterPanel = null;
    const resultsPane = this.resultsPanel && lumine.workspace.paneForItem(this.resultsPanel);
    if (resultsPane) await resultsPane.destroyItem(this.resultsPanel, true);
    else this.resultsPanel?.destroy();
    this.resultsPanel = null;
    this.sourceProviders = [];
    this.updatingModelSources?.clear();
    this.initialized = false;
  },

  createViewer(session, options = {}) {
    validateSession(session);
    const View = getGravissView();
    const viewer = new View(session, {
      ...options,
      createCopy: (source, copyOptions) => {
        const copy = this.createViewer(source.session, copyOptions);
        if (copy.viewDocument) this.observeFileViewerSource(copy);
        return copy;
      },
    });
    this.viewers ||= new Set();
    this.viewers.add(viewer);
    viewer.onDidDestroy(() => this.viewers?.delete(viewer));
    return viewer;
  },

  // A malformed document can be repaired with Text Editor in Open.
  // Explain a refused canvas open instead of leaving an unhandled rejection.
  openFileViewer(filePath, options = {}) {
    try {
      return this.createFileViewer(filePath, options);
    } catch (error) {
      lumine.notifications.addError(`Graviss could not read ${path.basename(filePath)}`, {
        detail: error.message,
        dismissable: true,
      });
      return undefined;
    }
  },

  createFileViewer(filePath, options = {}) {
    const absolutePath = path.resolve(filePath);
    const viewDocument = this.createViewDocument({
      filePath: absolutePath,
      state: options.viewDocumentState,
    });
    return this.createDocumentViewer(viewDocument, options);
  },

  createNewViewer({ signal } = {}) {
    signal?.throwIfAborted();
    const viewDocument = this.createViewDocument({ fallbackData: {} });
    return this.createDocumentViewer(viewDocument, { title: "Untitled" });
  },

  createDocumentViewer(viewDocument, options = {}) {
    const currentPath = viewDocument.getPath();
    const session =
      this.createSourceSession({ viewDocument, filePath: currentPath }) ||
      new UnresolvedSourceSession(viewDocument, currentPath);
    const viewer = this.createViewer(session, {
      uri: currentPath || options.uri,
      uriTracksPath: true,
      title: options.title || viewDocument.getData().title || "Untitled",
      restorable: true,
      viewDocument,
      openModelSource: (viewer) => this.openModelSource(viewer),
      retryLoadingModel: (viewer) => this.resolveFileViewerSource(viewer),
      activeGraphic: options.activeGraphic ?? viewDocument.getData().activeGraphic,
      cameraStates: options.cameraStates,
      copyPresentation: options.copyPresentation,
    });
    this.observeFileViewerSource(viewer);
    return viewer;
  },

  createViewDocument({ filePath = null, state = null, fallbackData } = {}) {
    const { GravissViewDocument } = require("./view-document");
    if (state && (state.fileState !== "unmodified" || !filePath)) {
      return GravissViewDocument.restore(state, { fallbackData, fallbackPath: filePath });
    }
    if (!filePath) {
      if (!fallbackData) throw new TypeError("A view document path or fallback data is required");
      return GravissViewDocument.restore(state || { data: fallbackData }, {
        fallbackData,
        fallbackPath: filePath,
      });
    }
    try {
      return GravissViewDocument.load(filePath);
    } catch (error) {
      if (!state || error.code !== "ENOENT") throw error;
      return GravissViewDocument.restore(
        { ...state, fileState: "removed" },
        { fallbackData, fallbackPath: filePath },
      );
    }
  },

  createFileDocument(filePath, state) {
    return this.createViewDocument({ filePath, state });
  },

  consumeGravissSource(provider) {
    validateSourceProvider(provider);
    this.sourceProviders ||= [];
    this.sourceProviders.push(provider);
    this.resolveUnresolvedViewers();
    return new Disposable(() => {
      const index = this.sourceProviders?.indexOf(provider) ?? -1;
      if (index >= 0) this.sourceProviders.splice(index, 1);
    });
  },

  // Restoring a window rebuilds its panes before it wires up the packages'
  // services, so a .grv reopened from the last session is built while no
  // provider is registered and opens saying there is none. The provider
  // arrives moments later, and this is what goes back to the panes that were
  // left waiting on it. Without it the only way out is to close the pane and
  // open it again, which loses nothing but is not something anyone should have
  // to work out.
  //
  // A provider that throws while being asked is left to fail on its own pane
  // rather than out of here, where it would be thrown into whichever package
  // was registering and take its activation down with it.
  resolveUnresolvedViewers() {
    let resolved = 0;
    for (const viewer of this.viewers || []) {
      if (!(viewer.session instanceof UnresolvedSourceSession)) continue;
      const viewDocument = viewer.viewDocument;
      const filePath = viewer.getPath();
      if (!viewDocument) continue;
      try {
        const session = this.createSourceSession({ viewDocument, filePath });
        if (session && viewer.adoptSession(session)) resolved += 1;
      } catch (error) {
        viewer.showError(error);
      }
    }
    return resolved;
  },

  createSourceSession(context) {
    // An unsaved view has no basename from which a provider could infer its
    // model. An explicitly chosen source is absolute until the view is saved.
    if (!context.filePath) {
      const source = context.viewDocument.getData().source;
      if (typeof source !== "string" || !path.isAbsolute(source.trim())) return null;
    }
    for (const provider of this.sourceProviders || []) {
      const session = provider.createSession(context);
      if (session) return session;
    }
    return null;
  },

  observeFileViewerSource(viewer) {
    const viewDocument = viewer.viewDocument;
    let observedSource = sourceIdentity(viewDocument.getData(), viewer.getPath());
    const resolveChangedSource = () => {
      if (!this.viewers?.has(viewer) || viewer.viewDocument !== viewDocument) return;
      const nextSource = sourceIdentity(viewDocument.getData(), viewer.getPath());
      if (nextSource === observedSource) return;
      observedSource = nextSource;
      if (this.updatingModelSources?.has(viewer)) return;
      this.resolveFileViewerSource(viewer);
    };
    const subscriptions = new CompositeDisposable(
      viewDocument.onDidChange(resolveChangedSource),
      viewDocument.onDidChangePath(resolveChangedSource),
    );
    subscriptions.add(viewer.onDidDestroy(() => subscriptions.dispose()));
    return subscriptions;
  },

  resolveFileViewerSource(viewer) {
    if (!this.viewers?.has(viewer)) return false;
    const viewDocument = viewer.viewDocument;
    const filePath = viewer.getPath();
    if (!viewDocument) return false;
    try {
      const session =
        this.createSourceSession({ viewDocument, filePath }) ||
        new UnresolvedSourceSession(viewDocument, filePath);
      if (session === viewer.session) return viewer.load();
      return viewer.adoptSession(session);
    } catch (error) {
      return viewer.adoptSession(new UnresolvedSourceSession(viewDocument, filePath, error));
    }
  },

  async openModelSource(viewer) {
    if (!this.viewers?.has(viewer)) return false;
    const viewDocument = viewer.viewDocument;
    const viewPath = viewer.getPath();
    if (!viewDocument) return false;

    try {
      const result = await lumine.window.showOpenDialog({
        title: "Open FEM Model Source",
        ...(viewPath ? { defaultPath: path.dirname(viewPath) } : {}),
        properties: ["openFile"],
      });
      const sourcePath = result?.canceled ? null : result?.filePaths?.[0];
      if (typeof sourcePath !== "string" || !sourcePath.trim()) return false;
      if (!this.viewers?.has(viewer) || viewer.viewDocument !== viewDocument) return false;

      const currentPath = viewer.getPath();
      this.updatingModelSources ||= new Set();
      this.updatingModelSources.add(viewer);
      try {
        viewDocument.update((document) => {
          document.source = sourceReferenceForPath(currentPath, sourcePath);
        }, "model-source");
      } finally {
        this.updatingModelSources.delete(viewer);
      }
      return this.resolveFileViewerSource(viewer);
    } catch (error) {
      if (this.viewers?.has(viewer)) viewer.showError(error);
      return false;
    }
  },

  viewerForEvent(event) {
    const target = event?.target;
    if (!target?.closest?.(".graviss")) return null;
    for (const viewer of this.viewers || []) {
      if (viewer.element?.contains(target)) return viewer;
    }
    return null;
  },

  deserialize(state) {
    this.initialize();
    const options = {
      activeGraphic: state?.activeGraphic,
      viewDocumentState: state?.viewDocument,
      cameraStates: state?.viewState?.cameraStates,
      copyPresentation: state?.viewState?.presentation,
    };
    if (isGravissViewPath(state?.uri)) return this.openFileViewer(state.uri, options);
    if (state?.viewDocument && !state.viewDocument.filePath) {
      const viewDocument = this.createViewDocument({ state: state.viewDocument });
      return this.createDocumentViewer(viewDocument, { ...options, uri: state.uri });
    }
    return undefined;
  },

  provideLauncher() {
    const generation = this.subscriptions;
    return {
      id: "graviss",
      label: "Graviss",
      create: (context = {}) => {
        if (!generation || this.subscriptions !== generation) {
          throw new Error("The Graviss launcher provider is no longer active.");
        }
        return this.createNewViewer(context);
      },
    };
  },

  provideNavigationAdapter() {
    return {
      handlesItem: isGravissView,
      observeHeaders: (item, callback) => item.observeNavigationHeaders(callback),
      navigateTo: (item, header, options = {}) => {
        const detail = { graphicIndex: header.graphicIndex, activated: false };
        item.dispatchCommand("graviss:activate-graphic", detail);
        if (!detail.activated) return false;
        if (options.focus !== false) item.focus();
        return true;
      },
    };
  },
};

function isGravissViewPath(filePath) {
  return typeof filePath === "string" && path.extname(filePath).toLowerCase() === ".grv";
}

function sourceReferenceForPath(viewPath, sourcePath) {
  const absolutePath = path.resolve(sourcePath);
  if (!viewPath) return absolutePath;
  const relativePath = path.relative(path.dirname(viewPath), absolutePath);
  if (!relativePath || path.isAbsolute(relativePath)) return absolutePath;
  return relativePath.split(path.sep).join("/");
}

function sourceIdentity(document, viewPath) {
  const source =
    typeof document.source === "string" && document.source.trim()
      ? path.resolve(viewPath ? path.dirname(viewPath) : "", document.source.trim())
      : "";
  return `${viewPath ? path.resolve(viewPath) : ""}\0${source}`;
}
