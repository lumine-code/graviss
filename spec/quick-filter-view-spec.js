const { TestSession } = require("./support/test-model");

const MODEL = {
  id: "quick-filter",
  title: "Quick filter",
  format: "Spec fixture",
  createGeometry: () => ({
    nodes: [
      { id: 1, x: 0, y: 0, z: 0 },
      { id: 2, x: 4, y: 0, z: 0 },
      { id: 3, x: 4, y: 4, z: 0 },
      { id: 4, x: 0, y: 4, z: 0 },
    ],
    filterTypes: [
      {
        id: "groups:opaque",
        title: "Group",
        numeric: true,
        quickFilterCode: "G",
        values: [
          { id: 12, title: "Deck" },
          { id: 13, title: "Piers" },
          { id: 14, title: "Bracing" },
          { id: 15, title: "Side slab" },
        ],
      },
    ],
    elements: [
      {
        id: "B1",
        kind: "beam",
        number: 1201,
        nodeIds: [1, 2],
        filterValues: { "groups:opaque": 12 },
      },
      {
        id: "B2",
        kind: "beam",
        number: 1301,
        nodeIds: [2, 3],
        filterValues: { "groups:opaque": 13 },
      },
      {
        id: "B3",
        kind: "beam",
        number: 1401,
        nodeIds: [3, 4],
        filterValues: { "groups:opaque": 14 },
      },
      {
        id: "Q1",
        kind: "shell",
        number: 1111,
        nodeIds: [1, 2, 3, 4],
        filterValues: { "groups:opaque": 14 },
      },
      {
        id: "Q2",
        kind: "shell",
        number: 2111,
        nodeIds: [1, 2, 3, 4],
        filterValues: { "groups:opaque": 15 },
      },
    ],
    supports: [],
  }),
};

describe("the Graviss toolbar quick filter", () => {
  let main;
  let viewer;
  let editor;

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    main = (await lumine.packages.activatePackage("graviss")).mainModule;
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("graviss");
    viewer = null;
    editor = null;
  });

  async function openViewer(graphics = [{}]) {
    viewer = main.createViewer(new TestSession(MODEL), {
      title: MODEL.title,
      viewDocument: main.createViewDocument({ fallbackData: { graphics, activeGraphic: 0 } }),
    });
    const pane = lumine.workspace.getCenter().getActivePane();
    pane.addItem(viewer);
    pane.activateItem(viewer);
    await conditionPromise(
      () => viewer.renderer != null && !viewer.loading,
      "the quick-filter model to load",
    );
    editor = viewer.quickFilterEditor;
    return viewer;
  }

  function keptIds() {
    const predicate = viewer.renderer.getElementFilter();
    return viewer.geometry.elements
      .filter((element) => !predicate || predicate(element))
      .map((element) => element.id);
  }

  function draft(text) {
    editor.element.focus();
    editor.setText(text);
  }

  function press(key) {
    const event = lumine.keymaps.constructor.buildKeydownEvent(key, { target: editor.element });
    lumine.keymaps.handleKeyboardEvent(event);
    return event;
  }

  function modelHasFocus() {
    return (
      document.activeElement === viewer.element ||
      document.activeElement === viewer.renderer.canvasRenderer.domElement
    );
  }

  it("uses a registered native mini editor with standard typography and destroys it with the viewer", async () => {
    await openViewer();
    expect(editor.isMini()).toBe(true);
    expect(editor.element.getModel()).toBe(editor);
    expect(editor.element.classList.contains("graviss-quick-filter-editor")).toBe(true);
    expect(editor.element.classList.contains("native-key-bindings")).toBe(false);
    expect(lumine.textEditors.roleFor(editor)).toBe("input");
    const reference = lumine.workspace.buildTextEditor({ mini: true });
    viewer.element.append(reference.element);
    try {
      await conditionPromise(
        () => editor.element.querySelector(".lines") && reference.element.querySelector(".lines"),
        "the native mini editor typography to render",
      );
      expect(getComputedStyle(editor.element.querySelector(".lines")).fontFamily).toBe(
        getComputedStyle(reference.element.querySelector(".lines")).fontFamily,
      );
    } finally {
      reference.destroy();
      reference.element.remove();
    }
    const owned = editor;
    viewer.destroy();
    expect(owned.isDestroyed()).toBe(true);
    expect(lumine.textEditors.roleFor(owned)).toBeNull();
  });

  it("applies the compact expression only on Enter and strips whitespace from typed or pasted input", async () => {
    await openViewer();
    const original = viewer.viewDocument.serialize().data;
    draft("");
    editor.insertText(" G 12 - 15 ; \n - Q1??1* ");
    expect(editor.getText()).toBe("G12-15;-Q1??1*");
    expect(editor.getLineCount()).toBe(1);
    expect(keptIds()).toEqual(["B1", "B2", "B3", "Q1", "Q2"]);
    expect(viewer.viewDocument.serialize().data).toEqual(original);
    press("enter");
    expect(viewer.quickFilterText).toBe("G12-15;-Q1??1*");
    expect(viewer.getQuickFilterState().error).toBeNull();
    expect(keptIds()).toEqual(["B1", "B2", "B3", "Q2"]);
    expect(viewer.activeGraphic.quickFilter).toBe("G12-15;-Q1??1*");
    expect(modelHasFocus()).toBe(true);
  });

  it("retains the last valid filter on an invalid Enter and Escape restores it without changing the document", async () => {
    await openViewer();
    expect(viewer.applyQuickFilter("G12")).toBe(true);
    const saved = viewer.viewDocument.serialize().data;
    draft("G12-");
    press("enter");
    expect(viewer.quickFilterIssue).not.toBeNull();
    expect(viewer.quickFilterError.hidden).toBe(false);
    expect(viewer.quickFilterError.textContent.length).toBeGreaterThan(0);
    expect(editor.element.getAttribute("aria-invalid")).toBe("true");
    expect(editor.element.contains(document.activeElement)).toBe(true);
    expect(editor.getText()).toBe("G12-");
    expect(viewer.quickFilterText).toBe("G12");
    expect(keptIds()).toEqual(["B1"]);
    expect(viewer.viewDocument.serialize().data).toEqual(saved);
    editor.setCursorBufferPosition([0, 2]);
    viewer.toggleVisibility("grid");
    expect(editor.getText()).toBe("G12-");
    expect(editor.getCursorBufferPosition().column).toBe(2);
    const afterGridToggle = viewer.viewDocument.serialize().data;
    press("escape");
    expect(editor.getText()).toBe("G12");
    expect(viewer.quickFilterIssue).toBeNull();
    expect(viewer.quickFilterError.hidden).toBe(true);
    expect(viewer.viewDocument.serialize().data).toEqual(afterGridToggle);
    expect(modelHasFocus()).toBe(true);
  });

  it("combines quick and panel filters with AND and clears only the quick filter", async () => {
    await openViewer();
    viewer.applyFilterState({ rules: [{ sign: "+", type: "@number", text: "13*,21*" }] });
    const panelState = viewer.getFilterState();
    expect(keptIds()).toEqual(["B2", "Q2"]);
    expect(viewer.applyQuickFilter("G14-15")).toBe(true);
    expect(keptIds()).toEqual(["Q2"]);
    expect(viewer.getRuleCounts().named).toEqual([2]);
    expect(viewer.getRuleCounts().shown).toBe(1);
    draft("");
    press("enter");
    expect(viewer.quickFilterText).toBe("");
    expect(keptIds()).toEqual(["B2", "Q2"]);
    expect(viewer.getFilterState()).toEqual(panelState);
    expect("quickFilter" in viewer.activeGraphic).toBe(false);
    expect(viewer.applyQuickFilter("G14-15")).toBe(true);
    viewer.element.querySelector('[data-action="clear-quick-filter"]').click();
    expect(editor.getText()).toBe("");
    expect(keptIds()).toEqual(["B2", "Q2"]);
    expect(viewer.getFilterState()).toEqual(panelState);
    expect("quickFilter" in viewer.activeGraphic).toBe(false);
  });

  it("clears panel rules while retaining the independent quick filter and its final counts", async () => {
    await openViewer();
    viewer.applyQuickFilter("G14");
    viewer.applyFilterState({ rules: [{ sign: "+", type: "@number", text: "14*" }] });
    expect(keptIds()).toEqual(["B3"]);
    viewer.clearFilter();
    expect(viewer.quickFilterText).toBe("G14");
    expect(editor.getText()).toBe("G14");
    expect(viewer.activeGraphic.quickFilter).toBe("G14");
    expect(viewer.getFilterState().rules).toEqual([]);
    expect(keptIds()).toEqual(["B3", "Q1"]);
    expect(viewer.getRuleCounts().shown).toBe(2);
    expect(viewer.getRuleCounts().named).toEqual([]);
    expect("filter" in viewer.activeGraphic).toBe(false);
  });

  it("restores each graphic's committed filter while discarding drafts from the previous graphic", async () => {
    await openViewer([
      { title: "Deck", quickFilter: "G12" },
      {
        title: "Bracing",
        quickFilter: "GB14",
        filter: { rules: [{ sign: "+", type: "@number", text: "14*" }] },
      },
    ]);
    expect(editor.getText()).toBe("G12");
    expect(keptIds()).toEqual(["B1"]);
    draft("G12-");
    const publications = [];
    const subscription = viewer.onDidChangeFilter(() =>
      publications.push({ ids: keptIds(), named: viewer.getRuleCounts().named }),
    );
    viewer.activateGraphic(1);
    subscription.dispose();
    expect(publications.length).toBeGreaterThan(0);
    for (const publication of publications) {
      expect(publication.ids).toEqual(["B3"]);
      expect(publication.named).toEqual([1]);
    }
    expect(editor.getText()).toBe("GB14");
    expect(viewer.quickFilterText).toBe("GB14");
    expect(keptIds()).toEqual(["B3"]);
    expect(viewer.quickFilterIssue).toBeNull();
    viewer.activateGraphic(0);
    expect(editor.getText()).toBe("G12");
    expect(keptIds()).toEqual(["B1"]);
    expect(
      viewer.viewDocument.serialize().data.graphics.map((graphic) => graphic.quickFilter),
    ).toEqual(["G12", "GB14"]);
  });

  it("keeps native copy, cut, paste and undo inside the draft instead of changing the graphic history", async () => {
    await openViewer();
    viewer.applyQuickFilter("G12");
    const documentState = viewer.viewDocument.serialize().data;
    draft("G12");
    editor.setSelectedBufferRange([
      [0, 1],
      [0, 3],
    ]);
    lumine.commands.dispatch(editor.element, "core:copy");
    expect(lumine.clipboard.read()).toBe("12");
    lumine.commands.dispatch(editor.element, "core:cut");
    expect(editor.getText()).toBe("G");
    lumine.commands.dispatch(editor.element, "core:undo");
    expect(editor.getText()).toBe("G12");
    editor.setCursorBufferPosition([0, 3]);
    lumine.clipboard.write(" \n - 15");
    lumine.commands.dispatch(editor.element, "core:paste");
    expect(editor.getText()).toBe("G12-15");
    expect(viewer.quickFilterText).toBe("G12");
    expect(viewer.viewDocument.serialize().data).toEqual(documentState);
    expect(keptIds()).toEqual(["B1"]);
  });

  it("keeps the draft and caret while help opens, updates and closes, and removes the popup on destruction", async () => {
    await openViewer();
    viewer.applyQuickFilter("G12");
    const control = viewer.quickFilterControl;
    draft("G12-");
    editor.setCursorBufferPosition([0, 2]);
    const mousedown = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
    control.help.dispatchEvent(mousedown);
    expect(mousedown.defaultPrevented).toBe(true);
    expect(editor.element.contains(document.activeElement)).toBe(true);
    control.help.click();
    expect(control.help.getAttribute("aria-expanded")).toBe("true");
    expect(control.helpView.element.isConnected).toBe(true);
    expect(control.guide.hidden).toBe(false);
    const aliases = new Map(viewer.quickFilterAliases);
    aliases.set("G", { ...aliases.get("G"), title: "Updated group" });
    viewer.quickFilterAliases = aliases;
    expect(() => control.sync()).not.toThrow();
    const group = [...control.codes.querySelectorAll("dt")].find(
      (node) => node.textContent === "G",
    );
    expect(group.nextElementSibling.textContent).toBe("Updated group");
    press("escape");
    expect(control.helpView).toBeNull();
    expect(control.help.getAttribute("aria-expanded")).toBe("false");
    expect(editor.getText()).toBe("G12-");
    expect(editor.getCursorBufferPosition().column).toBe(2);
    expect(viewer.quickFilterText).toBe("G12");
    expect(keptIds()).toEqual(["B1"]);
    control.help.click();
    const popup = control.helpView.element;
    viewer.destroy();
    expect(popup.isConnected).toBe(false);
    expect(editor.isDestroyed()).toBe(true);
  });

  it("lets camera shortcut letters and punctuation be typed without moving the view or toggling layers", async () => {
    await openViewer();
    draft("");
    const camera = viewer.renderer.camera.position.clone();
    const target = viewer.renderer.controls.target.clone();
    const toggle = spyOn(viewer, "toggleVisibility").and.callThrough();
    const action = spyOn(viewer, "performViewerAction").and.callThrough();
    for (const key of ["g", "b", "m", "f", "+", "-", "[", "]"]) {
      const event = press(key);
      expect(event.defaultPrevented).toBe(false);
      // Keymap dispatch alone has no Chromium default text insertion, so make
      // the input event's effect explicit after checking the key was free.
      editor.insertText(key);
    }
    expect(editor.getText()).toBe("gbmf+-[]");
    expect(toggle).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
    expect(viewer.renderer.camera.position.equals(camera)).toBe(true);
    expect(viewer.renderer.controls.target.equals(target)).toBe(true);
    const cursor = editor.getCursorBufferPosition().column;
    press("left");
    expect(editor.getCursorBufferPosition().column).toBe(cursor - 1);
    expect(viewer.renderer.controls.target.equals(target)).toBe(true);
  });

  it("fails closed for an unreadable restored expression without modifying the saved graphic", async () => {
    await openViewer([{ quickFilter: "ZZ12" }]);
    expect(editor.getText()).toBe("ZZ12");
    expect(viewer.quickFilterIssue).not.toBeNull();
    expect(viewer.quickFilterError.hidden).toBe(false);
    expect(keptIds()).toEqual([]);
    expect(viewer.viewDocument.serialize().data).toEqual({
      graphics: [{ quickFilter: "ZZ12" }],
      activeGraphic: 0,
    });
    const savedIssue = viewer.quickFilterIssue;
    draft("G12-");
    press("enter");
    press("escape");
    expect(editor.getText()).toBe("ZZ12");
    expect(viewer.quickFilterIssue).toBe(savedIssue);
    expect(viewer.quickFilterError.hidden).toBe(false);
    expect(keptIds()).toEqual([]);
    draft("");
    press("enter");
    expect(keptIds()).toEqual(["B1", "B2", "B3", "Q1", "Q2"]);
    expect(viewer.quickFilterIssue).toBeNull();
  });
});
