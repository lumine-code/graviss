const { CompositeDisposable, Disposable, Emitter } = require("lumine");

// What both panels are: a dock item that follows whichever model is being
// looked at.
//
// Built by hand rather than through a template library, which is what every
// other surface in this package is. A second idiom inside one package is a cost
// paid on every edit afterwards, and these panels are the same kind of surface
// as the toolbar already beside them.
//
// Following the centre and not the workspace is the whole trick. Activating a
// panel changes the active pane item - it is a pane item - so a panel that
// followed the workspace would let go of the model the moment it was clicked on.
class GravissPanel {
  constructor({ uri, title, iconName, className, deserializerName }) {
    this.uri = uri;
    // Named rather than derived from the class, because a deserializer name is
    // global across every package in the window and `FilterPanel` belongs to
    // nobody in particular.
    this.deserializerName = deserializerName;
    this.title = title;
    this.iconName = iconName;
    this.emitter = new Emitter();
    this.viewer = null;
    this.viewerSubscriptions = null;
    this.destroyed = false;
    // A subclass builds its controls after this constructor returns, and the
    // observer below fires the moment it is added - so nothing renders until
    // the subclass says it is ready.
    this.built = false;

    this.element = document.createElement("div");
    this.element.className = `graviss-panel ${className}`;
    this.element.tabIndex = -1;

    this.context = document.createElement("header");
    this.context.className = "graviss-panel-context";
    this.context.innerHTML = `
      <div class="graviss-panel-context-labels">
        <span class="graviss-panel-model"></span>
        <span class="graviss-panel-graphic"></span>
      </div>
      <button type="button" class="btn btn-sm icon icon-link-external graviss-panel-focus-model" aria-label="Focus model" title="Focus model"></button>
    `;
    this.contextModel = this.context.querySelector(".graviss-panel-model");
    this.contextGraphic = this.context.querySelector(".graviss-panel-graphic");
    this.context.querySelector("button").addEventListener("click", () => void this.unfocus());
    this.element.append(this.context);

    this.body = document.createElement("div");
    this.body.className = "graviss-panel-body";
    this.element.append(this.body);

    this.empty = document.createElement("background-tips");
    this.empty.className = "graviss-panel-empty";
    const emptyList = document.createElement("ul");
    emptyList.className = "centered background-message";
    this.emptyMessage = document.createElement("li");
    emptyList.append(this.emptyMessage);
    this.empty.append(emptyList);
    this.element.append(this.empty);

    const center = lumine.workspace.getCenter();
    // Follow the centre's active PANE and subscribe directly to that pane's
    // active ITEM. The container-level shortcut was not sufficient across all
    // split/tab transitions; this is the ownership chain that actually changes
    // when the user activates another centre tab. A dock activation changes
    // neither and therefore correctly preserves the centre context.
    this.centerPaneSubscriptions = new CompositeDisposable();
    const followActivePane = (pane) => {
      this.centerPaneSubscriptions.dispose();
      this.centerPaneSubscriptions = new CompositeDisposable();
      if (!pane) {
        this.followPaneItem(null);
        return;
      }
      this.centerPaneSubscriptions.add(
        pane.observeActiveItem((item) => {
          if (center.getActivePane() === pane) this.followPaneItem(item);
        }),
      );
    };
    this.subscriptions = new CompositeDisposable(
      center.observeActivePane(followActivePane),
      new Disposable(() => this.centerPaneSubscriptions.dispose()),
      lumine.commands.add(this.element, {
        "graviss:focus-viewer": {
          description: "Return focus to the model, leaving this panel open.",
          didDispatch: () => this.unfocus(),
        },
      }),
      new Disposable(() => this.viewerSubscriptions?.dispose()),
    );
  }

  // A pane item that is not a viewer is a real answer - a text editor is being
  // looked at, and there is no model to say anything about - so the panel lets
  // go rather than showing a model nobody is looking at any more.
  followPaneItem(item) {
    this.setViewer(isViewer(item) ? item : null);
  }

  setViewer(viewer) {
    if (viewer === this.viewer) return;
    const previous = this.viewer;
    this.viewerSubscriptions?.dispose();
    this.viewerSubscriptions = null;
    this.viewer = viewer;
    if (viewer) {
      this.viewerSubscriptions = new CompositeDisposable(
        viewer.onDidLoadModel(() => this.update()),
        viewer.onDidChangeResults(() => this.update()),
        viewer.onDidChangeFilter(() => this.update()),
        // Destroying the active centre item activates its neighbour before all
        // of the destroyed item's listeners have finished running. The centre
        // observer may therefore have moved this panel to B by the time A's
        // callback arrives; only A is allowed to clear itself.
        viewer.onDidDestroy(() => {
          if (this.viewer === viewer) this.setViewer(null);
        }),
      );
      if (typeof viewer.observeNavigationHeaders === "function") {
        this.viewerSubscriptions.add(
          viewer.observeNavigationHeaders(() => {
            this.forceControlSync = true;
            if (this.built) this.didChangeGraphic();
            this.update();
          }),
        );
      }
      if (typeof viewer.onDidChangeTitle === "function") {
        this.viewerSubscriptions.add(viewer.onDidChangeTitle(() => this.updateContext()));
      }
      if (typeof viewer.onDidChangeAnimationPosition === "function") {
        this.viewerSubscriptions.add(
          viewer.onDidChangeAnimationPosition((position) =>
            this.didChangeAnimationPosition(position),
          ),
        );
      }
    }
    if (this.built) this.didChangeViewer(previous, viewer);
    this.update();
  }

  // Subclasses keep small pieces of interaction state between ordinary
  // updates. A different centre item is a different context, so they get one
  // place to discard anything that must not cross that boundary.
  didChangeViewer() {}

  didChangeGraphic() {}

  didChangeAnimationPosition() {}

  updateContext() {
    const title = this.viewer?.getTitle?.() ?? this.viewer?.title ?? "";
    const graphic = this.viewer?.activeGraphic?.title ?? "";
    this.context.hidden = !this.viewer;
    this.contextModel.textContent = title;
    this.contextModel.title = title;
    this.contextGraphic.textContent = graphic;
    this.contextGraphic.title = graphic;
  }

  // Every panel says the same thing when there is nothing to say, and says it in
  // its own words: a panel that merely went blank would look broken rather than
  // idle.
  // Called by a subclass once its controls exist, which is also the first
  // render: the observer that follows the centre has already fired by then, and
  // a panel that waited for the next change would open blank.
  initialize() {
    this.built = true;
    this.update();
  }

  update() {
    if (this.destroyed || !this.built) return;
    this.updateContext();
    const reason = this.emptyReason();
    this.emptyMessage.textContent = reason ?? "";
    this.empty.hidden = !reason;
    this.body.hidden = Boolean(reason);
    this.element.classList.toggle("is-empty", Boolean(reason));
    if (reason) this.renderEmpty();
    else this.render();
  }

  renderEmpty() {}

  emptyReason() {
    if (!this.viewer) return "The active item is not supported.";
    if (!this.viewer.renderer) return "The model is still loading.";
    return null;
  }

  render() {
    throw new Error("A Graviss panel has to render itself.");
  }

  // --- The pane item protocol ------------------------------------------------

  getTitle() {
    return this.title;
  }

  getURI() {
    return this.uri;
  }

  getIconName() {
    return this.iconName;
  }

  getDefaultLocation() {
    return "right";
  }

  getAllowedLocations() {
    return ["right", "left"];
  }

  isPermanentDockItem() {
    return false;
  }

  serialize() {
    return { deserializer: this.deserializerName };
  }

  destroy() {
    if (this.destroyed) return;
    // An item is owned by its pane. Destroying the view object directly leaves
    // the tab in that pane, showing its last DOM forever with every observer
    // below already disposed. Package reload used to do exactly that, which is
    // why a visibly open Results panel could keep the previous Graviss model no
    // matter what became active in the centre.
    if (!this.detachingFromPane) {
      const pane = lumine.workspace.paneForItem(this);
      if (pane) {
        this.detachingFromPane = true;
        void pane.destroyItem(this, true).finally(() => {
          this.detachingFromPane = false;
        });
        return;
      }
    }
    this.destroyed = true;
    this.subscriptions.dispose();
    this.viewerSubscriptions?.dispose();
    this.viewerSubscriptions = null;
    this.element.remove();
    this.emitter.emit("did-destroy");
    this.emitter.dispose();
  }

  onDidDestroy(callback) {
    return this.emitter.on("did-destroy", callback);
  }

  // --- Showing and focusing --------------------------------------------------

  toggle() {
    return lumine.workspace.toggle(this);
  }

  // Whether the panel is on screen right now.
  //
  // Not "is it open": both panels land in the same dock and only one of them is
  // its pane's active item, so an open panel behind the other's tab is a panel
  // nobody can see. This is the same test `Workspace#hide` applies before it
  // will hide anything, which is why toggling a backgrounded panel brings it
  // forward instead of hiding it.
  isShowing() {
    return panelIsShowing(this.getURI());
  }

  // Bring the panel up and put the cursor in it, or hand focus back to the
  // model if it is already there. `tree-view` and `outline-view` are the shape:
  // pressing the same thing twice should return you to your work rather than
  // hide a panel you are looking at.
  //
  // `show()` first in every case, because focusing an element that is behind
  // another tab does nothing at all.
  async toggleFocus(viewer = this.viewer) {
    if (this.isFocused()) {
      await this.unfocus(viewer);
      return false;
    }
    await this.show();
    this.focus();
    return true;
  }

  async show() {
    await lumine.workspace.open(this, {
      searchAllPanes: true,
      activatePane: false,
      activateItem: false,
    });
    const container = lumine.workspace.paneContainerForURI(this.getURI());
    if (!container || container === lumine.workspace.getCenter()) return;
    container.show();
    container.getActivePane().activateItemForURI(this.getURI());
    container.activate();
  }

  isFocused() {
    const active = document.activeElement;
    return this.element === active || this.element.contains(active);
  }

  focus() {
    this.element.focus();
  }

  // Back to the model, which is what the panel is about. Not to whatever had
  // focus before - a panel reached from the command palette has no such thing,
  // and the model is the right answer either way.
  async unfocus(viewer = this.viewer) {
    if (!viewer) {
      lumine.workspace.getCenter().activate();
      return false;
    }
    const opened = await lumine.workspace.open(viewer, { searchAllPanes: true });
    if (!opened) return false;
    opened.element.focus();
    return true;
  }
}

// The same question asked by URI, for a caller that has no panel to hand - the
// toolbar has two buttons to keep in step and no business holding either panel.
function panelIsShowing(uri) {
  const container = lumine.workspace.paneContainerForURI(uri);
  if (!container || container.isVisible?.() === false) return false;
  return container.getPanes().some((pane) => pane.getActiveItem()?.getURI?.() === uri);
}

function panelIsFocused(uri) {
  const panel = lumine.workspace.getPaneItems().find((item) => item.getURI?.() === uri);
  return panel?.isFocused?.() === true;
}

// Duck-typed rather than checked against the class, because a viewer reaches
// this through the workspace and an instance check would tie a panel to the
// module identity of whatever loaded it.
function isViewer(item) {
  return Boolean(item) && typeof item.getResultsState === "function";
}

module.exports = { GravissPanel, isViewer, panelIsFocused, panelIsShowing };
