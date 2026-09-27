const { FILTER_PANEL_URI } = require("../lib/filter-panel");
const {
  CYCLE_LABELS,
  RESULTS_PANEL_URI,
  formatDisplacement,
  scaleForSlider,
  sliderForScale,
} = require("../lib/results-panel");
const { TestSession } = require("./support/test-model");

// A little bridge with three cases and two groups, which is the least a panel
// needs to have something to say about every control it carries.
const ANALYSED_MODEL = {
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
    nodes: { ids: [3], values: [0, 0, -0.01] },
    extent: 0.01,
  }),
  createGeometry: () => ({
    nodes: [
      { id: 1, x: 0, y: 0, z: 0 },
      { id: 2, x: 6, y: 0, z: 0 },
      { id: 3, x: 12, y: 0, z: 0 },
    ],
    filterTypes: [
      {
        id: "group",
        title: "Group",
        numeric: true,
        values: [
          { id: 1, title: "Deck" },
          { id: 2, title: "Piers" },
        ],
      },
    ],
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
        id: "T1",
        kind: "truss",
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

const PLAIN_MODEL = {
  id: "plain",
  title: "Plain",
  format: "Spec fixture",
  createGeometry: () => ({
    nodes: [
      { id: 1, x: 0, y: 0, z: 0 },
      { id: 2, x: 6, y: 0, z: 0 },
    ],
    elements: [{ id: "B1", kind: "beam", number: 1, nodeIds: [1, 2], sectionId: "R" }],
    sections: [{ id: "R", shape: { kind: "rectangle", width: 0.2, height: 0.4 } }],
    supports: [],
  }),
};

const OTHER_ANALYSED_MODEL = {
  ...ANALYSED_MODEL,
  id: "other-analysed",
  title: "Other analysed",
  loadCases: [
    { id: 301, title: "wind", kind: "linear", hasResults: true },
    { id: 302, title: "temperature", kind: "linear", hasResults: true },
    { id: 903, title: "2nd mode", kind: "eigenmode", hasResults: true },
  ],
  createGeometry: () => {
    const geometry = ANALYSED_MODEL.createGeometry();
    geometry.filterTypes = [
      {
        id: "group",
        title: "Storey",
        numeric: true,
        values: [
          { id: 1, title: "Lower" },
          { id: 2, title: "Upper" },
        ],
      },
    ];
    return geometry;
  },
};

describe("the Graviss dock panels", () => {
  let mainModule;
  let viewer;

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    const pack = await lumine.packages.activatePackage("graviss");
    mainModule = pack.mainModule;
  });

  afterEach(async () => {
    viewer = null;
    await lumine.packages.deactivatePackage("graviss");
  });

  async function openViewer(model) {
    const viewDocument = mainModule.createViewDocument({ fallbackData: { graphics: [{}] } });
    // The centre's pane, explicitly: opening a panel first leaves the dock's
    // pane active, and a viewer added there is a viewer the centre never sees.
    const pane = lumine.workspace.getCenter().getActivePane();
    viewer = mainModule.createViewer(new TestSession(model), {
      title: model.title,
      viewDocument,
    });
    pane.addItem(viewer);
    pane.activateItem(viewer);
    await conditionPromise(() => viewer.renderer != null, "the Three.js scene to initialize");
    return viewer;
  }

  it("opens each panel by URI and gives it a place in the dock", async () => {
    const filter = await lumine.workspace.open(FILTER_PANEL_URI);
    const results = await lumine.workspace.open(RESULTS_PANEL_URI);
    expect(filter.getTitle()).toBe("Filter");
    expect(results.getTitle()).toBe("Results");
    expect(filter.getDefaultLocation()).toBe("right");
    expect(filter.getAllowedLocations()).toEqual(["right", "left"]);
    expect(results.getDefaultLocation()).toBe("right");
    expect(results.getAllowedLocations()).toEqual(["right", "left"]);
    // One of each for the whole window: both follow whichever model is active,
    // so a second copy would be a second view of the same thing.
    expect(await lumine.workspace.open(FILTER_PANEL_URI)).toBe(filter);
    const filterState = { deserializer: "GravissFilterPanel" };
    const resultsState = { deserializer: "GravissResultsPanel" };
    expect(filter.serialize()).toEqual(filterState);
    expect(results.serialize()).toEqual(resultsState);
    expect(lumine.deserializers.deserialize(filter.serialize())).toBe(filter);
    expect(lumine.deserializers.deserialize(results.serialize())).toBe(results);

    await lumine.workspace.paneForItem(filter).destroyItem(filter);
    expect(mainModule.filterPanel).toBeNull();
    const replacement = lumine.deserializers.deserialize(filterState);
    expect(replacement).not.toBe(filter);
    expect(mainModule.getFilterPanel()).toBe(replacement);
  });

  it("keeps panels deserialized before activation as the window singletons", async () => {
    await lumine.packages.deactivatePackage("graviss");
    const pack = lumine.packages.getLoadedPackage("graviss");
    mainModule = pack.mainModule;
    const activate = spyOn(mainModule, "activate").and.callThrough();

    const filter = lumine.deserializers.deserialize({ deserializer: "GravissFilterPanel" });
    const results = lumine.deserializers.deserialize({ deserializer: "GravissResultsPanel" });
    // Workspace deserialization happens before the initial package batch. The
    // deserializer may construct its singleton panels, but the package's live
    // activate hook must wait for the normal bootstrap to finish.
    expect(activate).not.toHaveBeenCalled();
    expect(lumine.deserializers.deserialize(filter.serialize())).toBe(filter);
    expect(lumine.deserializers.deserialize(results.serialize())).toBe(results);

    await lumine.packages.activatePackage("graviss");
    expect(activate.calls.count()).toBe(1);
    expect(mainModule.getFilterPanel()).toBe(filter);
    expect(mainModule.getResultsPanel()).toBe(results);
  });

  it("removes panels on deactivation and replaces an orphan left by an older generation", async () => {
    await lumine.workspace.open(FILTER_PANEL_URI);
    await lumine.workspace.open(RESULTS_PANEL_URI);
    await lumine.packages.deactivatePackage("graviss");
    expect(
      lumine.workspace
        .getPaneItems()
        .filter((item) => [FILTER_PANEL_URI, RESULTS_PANEL_URI].includes(item?.getURI?.())),
    ).toEqual([]);

    // This is the exact broken state produced by the old lifecycle: the pane
    // still owns a Results item whose view has already been destroyed, so it
    // can display stale DOM but has no live centre observer.
    const staleElement = document.createElement("div");
    staleElement.textContent = "stale model results";
    const stale = {
      element: staleElement,
      destroyed: false,
      getTitle: () => "Results",
      getURI: () => RESULTS_PANEL_URI,
      destroy() {
        this.destroyed = true;
        this.element.remove();
      },
    };
    const pane = lumine.workspace.getRightDock().getActivePane();
    pane.addItem(stale);
    pane.activateItem(stale);

    const pack = await lumine.packages.activatePackage("graviss");
    mainModule = pack.mainModule;
    const replacement = mainModule.getResultsPanel();
    expect(stale.destroyed).toBe(true);
    expect(pane.getItems()).not.toContain(stale);
    expect(pane.getItems()).toContain(replacement);
    expect(pane.getActiveItem()).toBe(replacement);
    expect(replacement.empty.textContent).toBe("The active item is not supported.");
  });

  it("says why it is empty rather than merely going blank", async () => {
    const results = await lumine.workspace.open(RESULTS_PANEL_URI);
    // Nothing open at all.
    expect(results.empty.hidden).toBe(false);
    expect(results.empty.textContent).toBe("The active item is not supported.");
    expect(results.empty.tagName).toBe("BACKGROUND-TIPS");
    expect(results.empty.querySelector("ul.centered.background-message")).not.toBeNull();
    expect(getComputedStyle(results.body).display).toBe("none");

    // A model, but one that carries no analysis - which is the ordinary case,
    // and not an error to report.
    await openViewer(PLAIN_MODEL);
    expect(results.viewer).toBe(viewer);
    expect(results.empty.textContent).toMatch(/no analysis results/);
    expect(results.body.hidden).toBe(true);
    expect(getComputedStyle(results.body).display).toBe("none");
  });

  it("follows the model in the centre, and does not let go of it when clicked", async () => {
    const filter = await lumine.workspace.open(FILTER_PANEL_URI);
    await openViewer(ANALYSED_MODEL);
    expect(filter.viewer).toBe(viewer);

    // Activating the panel changes the active pane item - it is one - so a
    // panel that followed the workspace rather than the centre would let go of
    // the model the moment it was clicked on.
    lumine.workspace.paneForItem(filter).activateItem(filter);
    expect(filter.viewer).toBe(viewer);
  });

  it("follows the active item across tabs in the workspace centre", async () => {
    const filter = await lumine.workspace.open(FILTER_PANEL_URI);
    const results = await lumine.workspace.open(RESULTS_PANEL_URI);
    const analysed = await openViewer(ANALYSED_MODEL);
    const pane = lumine.workspace.paneForItem(analysed);
    analysed.applyFilterState({
      rules: [{ id: "shared", sign: "+", type: "group", text: "1" }],
    });
    analysed.setAnimationPeriod(1000);

    const otherDocument = mainModule.createViewDocument({ fallbackData: { graphics: [{}] } });
    const other = mainModule.createViewer(new TestSession(OTHER_ANALYSED_MODEL), {
      title: OTHER_ANALYSED_MODEL.title,
      viewDocument: otherDocument,
    });
    pane.addItem(other);
    await conditionPromise(() => other.renderer != null, "the second Three.js scene to initialize");
    other.applyFilterState(
      { rules: [{ id: "shared", sign: "+", type: "group", text: "2" }] },
      { record: false },
    );
    other.setAnimationPeriod(3000);

    // Keep the dock active while the centre changes underneath it. This is the
    // distinction that a global workspace observer misses, and a focused field
    // must not keep A's value or cached options once B becomes current.
    lumine.workspace.paneForItem(filter).activateItem(filter);
    filter.rows.get("shared").field.focus();
    results.previewTo(1);
    pane.activateItem(other);

    expect(lumine.workspace.getActivePaneItem()).toBe(filter);
    expect(lumine.workspace.getCenter().getActivePaneItem()).toBe(other);
    expect(filter.viewer).toBe(other);
    expect(results.viewer).toBe(other);
    expect(results.previewIndex).toBeNull();
    expect(results.previewTimer).toBeNull();
    expect(results.caseList.children.length).toBe(OTHER_ANALYSED_MODEL.loadCases.length + 1);
    expect(results.caseList.children[1].textContent).toContain("wind");
    const otherRow = filter.rows.get("shared");
    expect(otherRow.field.value).toBe("2");
    expect(otherRow.select.element.querySelector(".select-box-label").textContent).toBe("Storey");

    pane.activateItem(analysed);
    expect(lumine.workspace.getCenter().getActivePaneItem()).toBe(analysed);
    expect(filter.viewer).toBe(analysed);
    expect(results.viewer).toBe(analysed);
    expect(results.caseList.children.length).toBe(ANALYSED_MODEL.loadCases.length + 1);
    expect(filter.rows.get("shared").field.value).toBe("1");
    expect(
      filter.rows.get("shared").select.element.querySelector(".select-box-label").textContent,
    ).toBe("Group");

    // Focused controls are normally protected from incidental rerenders. A
    // viewer switch is not incidental: the new model's value must win.
    lumine.workspace.paneForItem(results).activateItem(results);
    results.periodSlider.focus();
    expect(results.periodSlider.value).toBe("1000");
    pane.activateItem(other);
    expect(lumine.workspace.getActivePaneItem()).toBe(results);
    expect(results.periodSlider.value).toBe("3000");
    pane.activateItem(analysed);

    // Activating either dock tab changes the workspace's global active item,
    // but never which item is current in the centre.
    lumine.workspace.paneForItem(filter).activateItem(filter);
    expect(filter.viewer).toBe(analysed);
    lumine.workspace.paneForItem(results).activateItem(results);
    expect(results.viewer).toBe(analysed);
  });

  it("clears both panels as soon as a text editor becomes the active centre item", async () => {
    const filter = await lumine.workspace.open(FILTER_PANEL_URI);
    const results = await lumine.workspace.open(RESULTS_PANEL_URI);
    const analysed = await openViewer(ANALYSED_MODEL);
    const pane = lumine.workspace.paneForItem(analysed);
    expect(filter.viewer).toBe(analysed);
    expect(results.viewer).toBe(analysed);
    expect(results.body.hidden).toBe(false);

    const editor = lumine.workspace.buildTextEditor();
    pane.addItem(editor);
    pane.activateItem(editor);
    pane.activate();

    expect(lumine.workspace.getCenter().getActivePaneItem()).toBe(editor);
    expect(lumine.workspace.getActivePaneItem()).toBe(editor);
    for (const panel of [filter, results]) {
      expect(panel.viewer).toBeNull();
      expect(panel.body.hidden).toBe(true);
      expect(panel.empty.hidden).toBe(false);
      expect(panel.empty.textContent).toBe("The active item is not supported.");
    }
    expect(results.caseList.children.length).toBe(0);
    expect(filter.rows.size).toBe(0);

    // Returning to the model repopulates the same panel instances rather than
    // leaving them detached after the unsupported item.
    pane.activateItem(analysed);
    expect(filter.viewer).toBe(analysed);
    expect(results.viewer).toBe(analysed);
    expect(results.body.hidden).toBe(false);
    await pane.destroyItem(editor, true);
  });

  it("follows the next centre item when the active viewer is destroyed", async () => {
    const filter = await lumine.workspace.open(FILTER_PANEL_URI);
    const results = await lumine.workspace.open(RESULTS_PANEL_URI);
    const first = await openViewer(ANALYSED_MODEL);
    const pane = lumine.workspace.paneForItem(first);
    const secondDocument = mainModule.createViewDocument({ fallbackData: { graphics: [{}] } });
    const second = mainModule.createViewer(new TestSession(OTHER_ANALYSED_MODEL), {
      title: OTHER_ANALYSED_MODEL.title,
      viewDocument: secondDocument,
    });
    pane.addItem(second);
    await conditionPromise(
      () => second.renderer != null,
      "the second Three.js scene to initialize",
    );
    pane.activateItem(first);

    first.destroy();

    expect(lumine.workspace.getCenter().getActivePaneItem()).toBe(second);
    expect(filter.viewer).toBe(second);
    expect(results.viewer).toBe(second);
    expect(results.caseList.children[1].textContent).toContain("wind");
  });

  it("clears both panels when the last centre viewer closes", async () => {
    const filter = await lumine.workspace.open(FILTER_PANEL_URI);
    const results = await lumine.workspace.open(RESULTS_PANEL_URI);
    const only = await openViewer(ANALYSED_MODEL);
    const pane = lumine.workspace.paneForItem(only);

    await pane.destroyItem(only, true);

    expect(lumine.workspace.getCenter().getActivePaneItem()).toBeUndefined();
    for (const panel of [filter, results]) {
      expect(panel.viewer).toBeNull();
      expect(panel.body.hidden).toBe(true);
      expect(panel.empty.hidden).toBe(false);
      expect(panel.empty.textContent).toBe("The active item is not supported.");
    }
  });

  // A row's controls, found by what they are rather than by position.
  function ruleRow(filter, index) {
    const row = filter.list.querySelectorAll(".graviss-rule-row")[index];
    const rowView = filter.rows.get(row.dataset.ruleId);
    return {
      row,
      sign: row.querySelector(".graviss-rule-sign"),
      swatch: row.querySelector(".graviss-rule-swatch"),
      select: rowView.select,
      field: row.querySelector(".graviss-rule-text"),
      count: row.querySelector(".graviss-rule-count"),
      remove: row.querySelector(".graviss-rule-remove"),
    };
  }

  function chooseSubject(filter, controls, title) {
    const subjects = filter.viewer.getFilterSubjects();
    const index = subjects.findIndex((subject) => subject.title === title);
    expect(index).toBeGreaterThanOrEqual(0);
    controls.select.setValue(String(index), { emit: true });
  }

  function typeExpression(controls, text) {
    controls.field.value = text;
    controls.field.dispatchEvent(new Event("input"));
  }

  it("narrows the model with a list of signed rules, and says what each one names", async () => {
    const filter = await lumine.workspace.open(FILTER_PANEL_URI);
    await openViewer(ANALYSED_MODEL);

    // Nothing narrowed is the whole model, and the seed row says so.
    expect(filter.seed.textContent).toBe("Showing the whole model.");
    expect(filter.total.textContent).toBe("2 of 2 elements");

    // A fresh row names no dimension, so adding it moves nothing.
    filter.body.querySelector(".graviss-add-rule").click();
    expect(filter.list.querySelectorAll(".graviss-rule-row").length).toBe(1);
    expect(filter.total.textContent).toBe("2 of 2 elements");
    expect("filter" in viewer.activeGraphic).toBe(false);

    // Choosing a dimension and typing an expression narrows the model and
    // reaches the document in the shape a hand could have written.
    const first = ruleRow(filter, 0);
    chooseSubject(filter, first, "Number");
    typeExpression(first, "1");
    expect(filter.total.textContent).toBe("1 of 2 elements");
    expect(first.count.textContent).toBe("1");
    expect(viewer.activeGraphic.filter).toEqual({
      rules: [{ sign: "+", type: "@number", text: "1" }],
    });
    // Opening by adding starts from nothing, and the seed row says which.
    expect(filter.seed.textContent).toBe("Starting from nothing:");

    // An expression nobody can read says so on the row and changes nothing.
    typeExpression(first, "1-");
    expect(first.field.classList.contains("graviss-invalid")).toBe(true);
    expect(viewer.getFilterState().rules[0].text).toBe("1");
    typeExpression(first, "1");
    expect(first.field.classList.contains("graviss-invalid")).toBe(false);

    // The sign flips on its button, and a leading subtraction starts whole.
    first.sign.click();
    expect(viewer.getFilterState().rules[0].sign).toBe("-");
    expect(filter.seed.textContent).toBe("Starting from the whole model:");
    expect(filter.total.textContent).toBe("1 of 2 elements");

    // The x takes the rule out, and an empty list takes the key out of the file.
    first.remove.click();
    expect(filter.list.querySelectorAll(".graviss-rule-row").length).toBe(0);
    expect("filter" in viewer.activeGraphic).toBe(false);
    expect(filter.total.textContent).toBe("2 of 2 elements");
  });

  it("offers the source's own dimensions without knowing what they mean", async () => {
    const filter = await lumine.workspace.open(FILTER_PANEL_URI);
    await openViewer(ANALYSED_MODEL);

    filter.body.querySelector(".graviss-add-rule").click();
    const first = ruleRow(filter, 0);
    await first.select.open();
    const titles = [...document.querySelectorAll(".select-box-option")].map(
      (option) => option.textContent,
    );
    first.select.close();
    // The two dimensions Graviss owns, the source's own by its declared title,
    // and the kind-narrowed variants this model can actually distinguish.
    expect(titles).toContain("Kind");
    expect(titles).toContain("Number");
    expect(titles).toContain("Group");
    expect(titles).toContain("Group (trusses)");

    chooseSubject(filter, first, "Group");
    typeExpression(first, "2");
    expect(viewer.activeGraphic.filter).toEqual({
      rules: [{ sign: "+", type: "group", text: "2" }],
    });
    expect(viewer.elementCounts().get("beam")).toEqual({ total: 1, shown: 0 });
    expect(viewer.elementCounts().get("truss")).toEqual({ total: 1, shown: 1 });

    // The kind-narrowed variant writes the kind into the rule rather than the
    // expression, which is the whole trick: the type id itself is never parsed.
    chooseSubject(filter, first, "Group (trusses)");
    expect(viewer.getFilterState().rules[0]).toEqual(
      jasmine.objectContaining({ type: "group", kinds: ["truss"] }),
    );
    // And the swatch takes the renderer's own resolved colour for that kind, so
    // it cannot disagree with what is on screen.
    expect(first.swatch.hidden).toBe(false);
    expect(first.swatch.style.background).toContain(
      String(viewer.renderer.colors.truss.getHexString())
        .match(/../g)
        .map((pair) => parseInt(pair, 16))
        .join(", "),
    );
  });

  it("reorders rules, and the order is the meaning", async () => {
    const filter = await lumine.workspace.open(FILTER_PANEL_URI);
    await openViewer(ANALYSED_MODEL);

    // "Everything but group 2" then "and the trusses back".
    const dropId = viewer.addRule({ sign: "-", type: "group", text: "2" });
    viewer.addRule({ sign: "+", type: "@kind", text: "truss" });
    expect(filter.total.textContent).toBe("2 of 2 elements");

    // The other way round the truss arrives first and group 2 takes it away.
    viewer.moveRule(dropId, 1);
    expect(viewer.getFilterState().rules.map(({ sign }) => sign)).toEqual(["+", "-"]);
    expect(filter.seed.textContent).toBe("Starting from nothing:");
    expect(filter.total.textContent).toBe("0 of 2 elements");

    // Reordering from the keyboard finds the row that holds focus.
    const second = ruleRow(filter, 1);
    second.field.focus();
    lumine.commands.dispatch(second.field, "graviss:move-rule-up");
    expect(viewer.getFilterState().rules.map(({ sign }) => sign)).toEqual(["-", "+"]);
    expect(filter.total.textContent).toBe("2 of 2 elements");
    // The row that moved is the same element it was, still holding focus.
    expect(document.activeElement).toBe(second.field);
  });

  it("reorders rules by dragging the grip", async () => {
    const filter = await lumine.workspace.open(FILTER_PANEL_URI);
    await openViewer(ANALYSED_MODEL);
    viewer.applyFilterState({
      rules: [
        { sign: "+", type: "@kind", text: "beam" },
        { sign: "+", type: "@kind", text: "truss" },
      ],
    });

    const rows = () => [...filter.list.querySelectorAll(".graviss-rule-row")];
    const [first, second] = rows();

    // The drag starts on the grip and carries the rule's own id under the
    // panel's own type - which is also what gates dragover, read from `items`
    // because that is the half of a DataTransfer a synthetic event can carry.
    const dataTransfer = {
      data: {},
      setData(key, value) {
        this.data[key] = String(value);
      },
      getData(key) {
        return this.data[key];
      },
      get items() {
        return Object.keys(this.data).map((type) => ({ type }));
      },
    };
    const dragstart = new MouseEvent("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(dragstart, "dataTransfer", { value: dataTransfer });
    first.querySelector(".graviss-rule-grip").dispatchEvent(dragstart);
    expect(dataTransfer.getData("graviss-filter-rule-event")).toBe(first.dataset.ruleId);

    // Dropped below the midpoint of the second row, the first rule lands after
    // it - and the order is the meaning, so the state says so too.
    const rect = second.getBoundingClientRect();
    const drop = new MouseEvent("drop", {
      bubbles: true,
      cancelable: true,
      clientY: rect.bottom + 1,
    });
    Object.defineProperty(drop, "dataTransfer", { value: dataTransfer });
    second.dispatchEvent(drop);

    expect(viewer.getFilterState().rules.map(({ text }) => text)).toEqual(["truss", "beam"]);
    expect(rows()[0]).toBe(second);
    expect(rows()[1]).toBe(first);
  });

  it("keeps a rule whose dimension this model has not got, and says so", async () => {
    const filter = await lumine.workspace.open(FILTER_PANEL_URI);
    await openViewer(ANALYSED_MODEL);

    viewer.applyFilterState({
      rules: [
        { sign: "+", type: "storey", text: "3" },
        { sign: "+", type: "@kind", text: "truss" },
      ],
    });
    const first = ruleRow(filter, 0);
    // The rule names nothing here, still holds its place in the fold, and the
    // dropdown shows the stored id rather than quietly rewriting the rule.
    expect(first.row.classList.contains("graviss-rule-unresolved")).toBe(true);
    expect(first.select.element.querySelector(".select-box-label").textContent).toContain("storey");
    expect(first.count.textContent).toBe("0");
    expect(filter.total.textContent).toBe("1 of 2 elements");
    // And it survives a round trip through the document untouched.
    expect(viewer.activeGraphic.filter.rules[0]).toEqual({
      sign: "+",
      type: "storey",
      text: "3",
    });
  });

  it("keeps the caret in a rule while the rest of the workspace changes", async () => {
    const filter = await lumine.workspace.open(FILTER_PANEL_URI);
    await openViewer(ANALYSED_MODEL);

    filter.body.querySelector(".graviss-add-rule").click();
    const first = ruleRow(filter, 0);
    chooseSubject(filter, first, "Number");
    first.field.focus();
    typeExpression(first, "12");
    first.field.setSelectionRange(1, 1);

    // A toolbar toggle re-renders this panel through the same event a filter
    // change does, and must not rebuild the row out from under the typing.
    viewer.toggleVisibility("grid");
    expect(document.activeElement).toBe(first.field);
    expect(first.field.value).toBe("12");
    expect(first.field.selectionStart).toBe(1);
  });

  it("steps the cases without reading every one it passes", async () => {
    const results = await lumine.workspace.open(RESULTS_PANEL_URI);
    await openViewer(ANALYSED_MODEL);
    const session = viewer.session;

    expect(
      [...results.caseList.querySelectorAll(".graviss-case-title")].map((n) => n.textContent),
    ).toEqual(["System", "self-weight", "dead-load", "1st mode"]);
    expect(results.caseList.children[0].classList).toContain("graviss-case-selected");

    // A preview moves the cursor and reads nothing, because reading a case is
    // thousands of records and a list being stepped through would queue one a
    // row.
    results.previewBy(1);
    expect(results.previewIndex).toBe(1);
    expect(session.lastResultRequest).toBeUndefined();
    results.previewBy(1);
    expect(results.previewIndex).toBe(2);
    expect(session.lastResultRequest).toBeUndefined();
    results.previewBy(1);
    expect(results.previewIndex).toBe(3);
    expect(session.lastResultRequest).toBeUndefined();

    // What is under the cursor is shown once the stepping stops.
    results.commitPreview();
    await conditionPromise(() => viewer.result != null, "the case under the cursor to be read");
    expect(session.lastResultRequest).toEqual({ loadCaseId: 901, kind: "displacement" });
    expect(results.caseList.children[3].classList.contains("graviss-case-selected")).toBe(true);

    // And a cursor moved and then abandoned leaves the model where it was.
    results.previewBy(-1);
    results.cancelPreview();
    expect(results.previewIndex).toBeNull();
    expect(viewer.result.loadCaseId).toBe(901);
  });

  it("lets the wheel scroll the case list without changing the active case", async () => {
    const results = await lumine.workspace.open(RESULTS_PANEL_URI);
    await openViewer(ANALYSED_MODEL);
    results.caseList.children[1].click();
    await conditionPromise(() => viewer.result != null, "the first case to be read");

    const wheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 120,
    });
    results.caseList.dispatchEvent(wheel);

    expect(wheel.defaultPrevented).toBe(false);
    expect(results.previewIndex).toBeNull();
    expect(results.previewTimer).toBeNull();
    expect(viewer.getResultsState().loadCaseId).toBe(101);
    expect(results.caseList.children[1].classList).toContain("graviss-case-selected");
  });

  it("drives the amplification, the animation and the legend", async () => {
    const results = await lumine.workspace.open(RESULTS_PANEL_URI);
    await openViewer(ANALYSED_MODEL);
    results.caseList.children[1].click();
    await conditionPromise(() => viewer.result != null, "the first case to be read");

    // The scale reads back as a factor rather than as a slider position.
    expect(results.scaleValue.textContent).toMatch(/\(auto\)$/);
    results.scalePresets.querySelector('[data-scale="100"]').click();
    expect(results.scaleValue.textContent).toBe("×100");
    expect(viewer.renderer.getDeformation().scale).toBe(100);
    results.scalePresets.querySelector(".graviss-scale-auto").click();
    expect(viewer.renderer.getDeformation().automatic).toBe(true);

    results.playButton.click();
    expect(results.playButton.textContent).toBe("Pause");
    const animation = viewer.renderer.getAnimation();
    expect(animation.running).toBe(true);
    viewer.renderer.setDeformationPhase(0.25);
    results.scalePresets.querySelector('[data-scale="100"]').click();
    expect(viewer.renderer.getDeformation().phase).toBe(0.25);
    expect(animation.running).toBe(true);
    results.scalePresets.querySelector(".graviss-scale-auto").click();
    expect(viewer.renderer.getDeformation().phase).toBe(0.25);
    expect(animation.running).toBe(true);
    results.playButton.click();
    expect(animation.running).toBe(false);

    expect(results.cycleSelect.value).toBe("default");
    results.cycleSelect.setValue("pingPong", { emit: true });
    expect(viewer.getResultsState().cycle).toBe("pingPong");
    results.cycleSelect.setValue("default", { emit: true });
    expect(viewer.getResultsState().cycle).toBeNull();
    expect(viewer.renderer.getAnimation().cycle).toBe("thereAndBack");

    // The legend appears with the colouring and states the ends of the field in
    // the unit somebody would say them in.
    expect(results.legend.hidden).toBe(true);
    results.colorToggle.click();
    expect(viewer.renderer.colorByDisplacement).toBe(true);
    expect(results.legend.hidden).toBe(false);
    expect(results.legend.querySelector(".graviss-legend-max").textContent).toBe("10.0 mm");

    // System is the undeformed state, not another result to read.
    results.caseList.children[0].click();
    expect(viewer.getResultsState().loadCaseId).toBeNull();
    expect(viewer.result).toBeNull();
    expect(viewer.renderer.getDeformation().result).toBeNull();
    expect(viewer.renderer.getAnimation().running).toBe(false);
    expect(results.caseList.children[0].classList).toContain("graviss-case-selected");
  });

  it("knows whether it is on screen, not merely whether it is open", async () => {
    const filter = await lumine.workspace.open(FILTER_PANEL_URI);
    const results = await lumine.workspace.open(RESULTS_PANEL_URI);
    await openViewer(ANALYSED_MODEL);

    // Both land in the same dock, so only one of them is its pane's active item
    // and the other is behind a tab. An open panel nobody can see is not showing.
    expect(lumine.workspace.paneContainerForURI(FILTER_PANEL_URI)).toBe(
      lumine.workspace.paneContainerForURI(RESULTS_PANEL_URI),
    );
    expect([filter.isShowing(), results.isShowing()].filter(Boolean).length).toBe(1);

    const container = lumine.workspace.paneContainerForURI(FILTER_PANEL_URI);
    container.getActivePane().activateItem(filter);
    expect(filter.isShowing()).toBe(true);
    expect(results.isShowing()).toBe(false);

    // And a dock nobody has opened shows neither.
    container.hide();
    expect(filter.isShowing()).toBe(false);
    expect(results.isShowing()).toBe(false);
  });

  it("brings a panel up and focuses it, then hands focus back", async () => {
    const filter = await lumine.workspace.open(FILTER_PANEL_URI);
    await openViewer(ANALYSED_MODEL);
    lumine.workspace.paneContainerForURI(FILTER_PANEL_URI).hide();
    expect(filter.isShowing()).toBe(false);

    // Not showing: come up and take focus.
    expect(await filter.toggleFocus()).toBe(true);
    expect(filter.isShowing()).toBe(true);
    expect(filter.isFocused()).toBe(true);

    // Showing and focused: hand focus back to the model, and stay open - hiding
    // a panel you are looking at is not what anyone asks for.
    expect(await filter.toggleFocus()).toBe(false);
    expect(filter.isFocused()).toBe(false);
    expect(filter.isShowing()).toBe(true);
    expect(lumine.workspace.getCenter().getActivePaneItem()).toBe(viewer);

    // Showing but not focused: take focus without closing anything.
    expect(await filter.toggleFocus()).toBe(true);
    expect(filter.isFocused()).toBe(true);
  });

  it("brings a panel up from the toolbar without taking focus off it", async () => {
    await openViewer(ANALYSED_MODEL);
    const button = viewer.element.querySelector('[data-action="filter-panel"]');
    expect(button).not.toBeNull();
    expect(button.dataset.command).toBe("graviss:toggle-focus-filter-panel");
    expect(button.getAttribute("aria-pressed")).toBe("false");

    // With the panel elsewhere, ordinary button focus is allowed: in a split
    // centre that is what activates the model whose toolbar was clicked.
    const mousedown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    button.dispatchEvent(mousedown);
    expect(mousedown.defaultPrevented).toBe(false);
    button.focus();

    button.click();
    // Opening a dock item is asynchronous, so the panel is not there the instant
    // the click returns.
    await conditionPromise(
      () => lumine.workspace.getPaneItems().some((i) => i.getURI?.() === FILTER_PANEL_URI),
      "the filter panel to be opened",
    );
    const filter = lumine.workspace.getPaneItems().find((i) => i.getURI?.() === FILTER_PANEL_URI);
    await conditionPromise(() => filter.isFocused(), "the filter panel to take focus");
    expect(filter.isShowing()).toBe(true);
    // Pressed says the panel is on screen, not that it has the cursor.
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.classList.contains("selected")).toBe(true);

    // Once the panel has focus, the default is cancelled so the click can see
    // that state and hand focus back to the model. The panel stays open.
    const returnMouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    button.dispatchEvent(returnMouseDown);
    expect(returnMouseDown.defaultPrevented).toBe(true);
    button.click();
    await conditionPromise(() => !filter.isFocused(), "focus to return to the model");
    expect(filter.isShowing()).toBe(true);
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });

  it("addresses the model whose panel button is clicked in a split centre", async () => {
    const first = await openViewer(ANALYSED_MODEL);
    const left = lumine.workspace.paneForItem(first);
    const secondDocument = mainModule.createViewDocument({ fallbackData: { graphics: [{}] } });
    const second = mainModule.createViewer(new TestSession(OTHER_ANALYSED_MODEL), {
      title: OTHER_ANALYSED_MODEL.title,
      viewDocument: secondDocument,
    });
    const right = left.splitRight({ items: [second] });
    await conditionPromise(
      () => second.renderer != null,
      "the second Three.js scene to initialize",
    );
    left.activateItem(first);
    left.activate();

    const button = second.element.querySelector('[data-action="results-panel"]');
    const openMouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    button.dispatchEvent(openMouseDown);
    expect(openMouseDown.defaultPrevented).toBe(false);
    // The browser's mousedown default focuses the clicked button, which makes
    // its split the current one before the click command opens the panel.
    button.focus();
    right.activate();
    button.click();
    await conditionPromise(
      () => lumine.workspace.getPaneItems().some((item) => item.getURI?.() === RESULTS_PANEL_URI),
      "the results panel to open",
    );
    const results = mainModule.getResultsPanel();
    await conditionPromise(() => results.isFocused(), "the results panel to take focus");
    expect(results.viewer).toBe(second);

    // Leave A as the centre's last item, then focus the shared panel. Clicking
    // B while it is focused must return to B, not to the viewer the panel used
    // to describe.
    left.activate();
    results.focus();
    expect(lumine.workspace.getCenter().getActivePaneItem()).toBe(first);
    expect(results.isFocused()).toBe(true);
    const returnMouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    button.dispatchEvent(returnMouseDown);
    expect(returnMouseDown.defaultPrevented).toBe(true);
    button.click();
    await conditionPromise(() => !results.isFocused(), "focus to return to the clicked model");
    expect(lumine.workspace.getCenter().getActivePaneItem()).toBe(second);
    expect(results.viewer).toBe(second);
  });

  it("keeps the toolbar honest about which panel is on screen", async () => {
    await openViewer(ANALYSED_MODEL);
    const filterButton = viewer.element.querySelector('[data-action="filter-panel"]');
    const resultsButton = viewer.element.querySelector('[data-action="results-panel"]');

    const filter = await lumine.workspace.open(FILTER_PANEL_URI);
    await lumine.workspace.open(RESULTS_PANEL_URI);
    await conditionPromise(
      () => resultsButton.getAttribute("aria-pressed") === "true",
      "the results button to report the panel it can see",
    );
    // Both are open but they share a dock, so only one is on screen at a time
    // and only one button may claim it.
    expect(filterButton.getAttribute("aria-pressed")).toBe("false");

    const container = lumine.workspace.paneContainerForURI(FILTER_PANEL_URI);
    container.getActivePane().activateItem(filter);
    await conditionPromise(
      () => filterButton.getAttribute("aria-pressed") === "true",
      "the filter button to take over",
    );
    expect(resultsButton.getAttribute("aria-pressed")).toBe("false");

    // A dock nobody has open leaves both of them unpressed, without either
    // button having been touched.
    container.hide();
    await conditionPromise(
      () => filterButton.getAttribute("aria-pressed") === "false",
      "both buttons to let go when the dock closes",
    );
    expect(resultsButton.getAttribute("aria-pressed")).toBe("false");
  });

  it("gets back to the model from the panel", async () => {
    const filter = await lumine.workspace.open(FILTER_PANEL_URI);
    await openViewer(ANALYSED_MODEL);
    lumine.workspace.paneForItem(filter).activateItem(filter);
    filter.focus();
    expect(filter.isFocused()).toBe(true);

    const reopen = spyOn(lumine.workspace, "open").and.callThrough();
    lumine.commands.dispatch(filter.element, "graviss:focus-viewer");
    await conditionPromise(() => !filter.isFocused(), "focus to return to the viewer");
    expect(reopen.calls.mostRecent().args[0]).toBe(viewer);
    expect(reopen.calls.mostRecent().args[1]).toEqual({ searchAllPanes: true });
    expect(lumine.workspace.getCenter().getActivePaneItem()).toBe(viewer);
  });
});

describe("the results panel's own arithmetic", () => {
  it("names the one-sided animation Positive", () => {
    expect(CYCLE_LABELS).toEqual({
      default: "Default",
      pingPong: "Swing",
      thereAndBack: "Positive",
    });
  });

  it("moves the amplification slider in factors, not in numbers", () => {
    // A hundredfold is one step of interest and a hundred and one is not, so
    // the slider runs over decades. A thousand steps across six of them is one
    // part in seven hundred, so a value put on the slider comes back within a
    // percent of itself rather than exactly - which is why the presets exist
    // and why the readout shows the factor rather than the position.
    for (const scale of [0.05, 1, 2, 10, 100, 1000]) {
      expect(scaleForSlider(sliderForScale(scale)) / scale).toBeGreaterThan(0.99);
      expect(scaleForSlider(sliderForScale(scale)) / scale).toBeLessThan(1.01);
    }
    // Zero is not on the slider at all - it is a preset - so it clamps to the
    // bottom rather than pretending to be reachable.
    expect(sliderForScale(0)).toBe(0);
    expect(scaleForSlider(0)).toBeCloseTo(0.01, 9);
  });

  it("says a displacement in the unit somebody would say it in", () => {
    expect(formatDisplacement(0.0003)).toBe("0.300 mm");
    expect(formatDisplacement(0.01)).toBe("10.0 mm");
    expect(formatDisplacement(2.5)).toBe("2.50 m");
    expect(formatDisplacement(Number.NaN)).toBe("");
  });
});
