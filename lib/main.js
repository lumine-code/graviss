const path = require("node:path");
const { CompositeDisposable, Disposable } = require("lumine");
const GravissView = require("./graviss-view");
const { UnresolvedSourceSession } = require("./unresolved-source-session");
const { validateSession, validateSourceProvider } = require("./validation");
const { GravissViewDocument } = require("./view-document");

module.exports = {
  activate() {
    if (this.subscriptions) return;
    this.viewers = new Set();
    this.sourceProviders ||= [];
    this.subscriptions = new CompositeDisposable(
      lumine.workspace.addOpener((uri) => {
        if (isGravissViewPath(uri)) return this.createFileViewer(uri);
      }),
      lumine.commands.add("lumine-workspace", {
        "graviss:open-source": {
          displayName: "Graviss: Open Source",
          didDispatch: (event) => this.openSourceCommand(event),
        },
      }),
    );
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
    this.treeView = null;
  },

  createViewer(session, options = {}) {
    validateSession(session);
    const viewer = new GravissView(session, options);
    this.viewers ||= new Set();
    this.viewers.add(viewer);
    viewer.onDidDestroy(() => this.viewers?.delete(viewer));
    return viewer;
  },

  createFileViewer(filePath, options = {}) {
    const absolutePath = path.resolve(filePath);
    const viewDocument = this.createViewDocument({
      filePath: absolutePath,
      state: options.viewDocumentState,
    });
    const currentPath = viewDocument.getPath() || absolutePath;
    const session =
      this.createSourceSession({ viewDocument, filePath: currentPath }) ||
      new UnresolvedSourceSession(viewDocument, currentPath);
    return this.createViewer(session, {
      uri: currentPath,
      uriTracksPath: true,
      title: viewDocument.getData().title,
      restorable: true,
      viewDocument,
      activeGraphicId: options.activeGraphicId || viewDocument.getData().activeGraphicId,
    });
  },

  createViewDocument({ filePath = null, state = null, fallbackData } = {}) {
    if (state && (state.modified || state.conflicted || state.deleted)) {
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
        { ...state, deleted: true },
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
      if (!viewDocument || !filePath) continue;
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
    for (const provider of this.sourceProviders || []) {
      const session = provider.createSession(context);
      if (session) return session;
    }
    return null;
  },

  async openSourceCommand(event) {
    const paths = this.sourcePathsForEvent(event);
    if (!paths.length) {
      lumine.notifications.addWarning("Open Source requires a .grv file", {
        detail: "Select a .grv file in tree-view or activate a Graviss canvas.",
        dismissable: true,
      });
      return undefined;
    }
    const editors = [];
    for (const filePath of paths) editors.push(await this.openSource(filePath));
    return editors.length === 1 ? editors[0] : editors;
  },

  sourcePathsForEvent(event) {
    if (event?.target?.closest?.(".tree-view")) {
      const clickedPath = event.target.closest(".file[data-path]")?.dataset.path;
      const selectedPaths = this.treeView?.selectedPaths?.() || [];
      return uniquePaths([...selectedPaths, clickedPath].filter(isGravissViewPath));
    }
    // A dispatch from inside a canvas means that canvas, whether or not its
    // pane is the active one; anything else means the active pane item.
    const item = this.viewerForEvent(event) || lumine.workspace.getActivePaneItem();
    const filePath = item instanceof GravissView ? item.getPath() : item?.getPath?.();
    return isGravissViewPath(filePath) ? [path.resolve(filePath)] : [];
  },

  viewerForEvent(event) {
    const target = event?.target;
    if (!target?.closest?.(".graviss")) return null;
    for (const viewer of this.viewers || []) {
      if (viewer.element?.contains(target)) return viewer;
    }
    return null;
  },

  async openSource(filePath) {
    if (!isGravissViewPath(filePath)) {
      throw new TypeError("Graviss source files must use the .grv extension");
    }
    const absolutePath = path.resolve(filePath);
    let editor = lumine.workspace
      .getTextEditors()
      .find((candidate) => samePath(candidate.getPath?.(), absolutePath));
    if (!editor) editor = await lumine.workspace.openTextFile(absolutePath);
    const jsonGrammar = lumine.grammars.grammarForScopeName("source.json");
    if (jsonGrammar && editor.getGrammar() !== jsonGrammar) editor.setGrammar(jsonGrammar);
    return lumine.workspace.open(editor, { searchAllPanes: true });
  },

  deserialize(state) {
    this.activate();
    const options = {
      activeGraphicId: state?.activeGraphicId,
      viewDocumentState: state?.viewDocument,
    };
    if (isGravissViewPath(state?.uri)) return this.createFileViewer(state.uri, options);
    return undefined;
  },

  consumeTreeViewSelection(treeView) {
    this.treeView = treeView;
    return new Disposable(() => {
      if (this.treeView === treeView) this.treeView = null;
    });
  },

  provideNavigationAdapter() {
    return {
      handlesItem: (item) => item instanceof GravissView,
      observeHeaders: (item, callback) => item.observeNavigationHeaders(callback),
      navigateTo: (item, header, options = {}) => {
        const detail = { graphicId: header.graphicId, activated: false };
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

function samePath(left, right) {
  if (!left || !right) return false;
  const leftPath = path.resolve(left);
  const rightPath = path.resolve(right);
  return process.platform === "win32"
    ? leftPath.toLowerCase() === rightPath.toLowerCase()
    : leftPath === rightPath;
}

function uniquePaths(paths) {
  const unique = [];
  for (const filePath of paths) {
    const absolutePath = path.resolve(filePath);
    if (!unique.some((candidate) => samePath(candidate, absolutePath))) unique.push(absolutePath);
  }
  return unique;
}
