const { FILTER_PANEL_URI } = require("../lib/filter-panel");
const {
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
    expect(filter.getTitle()).toBe("Model Filter");
    expect(results.getTitle()).toBe("Model Results");
    expect(filter.getDefaultLocation()).toBe("right");
    // One of each for the whole window: both follow whichever model is active,
    // so a second copy would be a second view of the same thing.
    expect(await lumine.workspace.open(FILTER_PANEL_URI)).toBe(filter);
    expect(filter.serialize()).toEqual({ deserializer: "GravissFilterPanel" });
    expect(mainModule.deserializeResultsPanel()).toBe(results);
  });

  it("says why it is empty rather than merely going blank", async () => {
    const results = await lumine.workspace.open(RESULTS_PANEL_URI);
    // Nothing open at all.
    expect(results.empty.hidden).toBe(false);
    expect(results.empty.textContent).toMatch(/Open a model/);

    // A model, but one that carries no analysis - which is the ordinary case,
    // and not an error to report.
    await openViewer(PLAIN_MODEL);
    expect(results.viewer).toBe(viewer);
    expect(results.empty.textContent).toMatch(/no analysis results/);
    expect(results.body.hidden).toBe(true);
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
    ).toEqual(["self-weight", "dead-load", "1st mode"]);

    // A preview moves the cursor and reads nothing, because reading a case is
    // thousands of records and a list being stepped through would queue one a
    // row.
    results.previewBy(1);
    expect(results.previewIndex).toBe(1);
    expect(session.lastResultRequest).toBeUndefined();
    results.previewBy(1);
    expect(results.previewIndex).toBe(2);
    expect(session.lastResultRequest).toBeUndefined();

    // What is under the cursor is shown once the stepping stops.
    results.commitPreview();
    await conditionPromise(() => viewer.result != null, "the case under the cursor to be read");
    expect(session.lastResultRequest).toEqual({ loadCaseId: 901, kind: "displacement" });
    expect(results.caseList.children[2].classList.contains("graviss-case-selected")).toBe(true);

    // And a cursor moved and then abandoned leaves the model where it was.
    results.previewBy(-1);
    results.cancelPreview();
    expect(results.previewIndex).toBeNull();
    expect(viewer.result.loadCaseId).toBe(901);
  });

  it("drives the amplification, the animation and the legend", async () => {
    const results = await lumine.workspace.open(RESULTS_PANEL_URI);
    await openViewer(ANALYSED_MODEL);
    results.caseList.children[0].click();
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
    expect(viewer.renderer.getAnimation().running).toBe(true);
    results.playButton.click();
    expect(viewer.renderer.getAnimation().running).toBe(false);

    results.cycleSelect.setValue("pingPong", { emit: true });
    expect(viewer.getResultsState().cycle).toBe("pingPong");

    // The legend appears with the colouring and states the ends of the field in
    // the unit somebody would say them in.
    expect(results.legend.hidden).toBe(true);
    results.colorToggle.click();
    expect(viewer.renderer.colorByDisplacement).toBe(true);
    expect(results.legend.hidden).toBe(false);
    expect(results.legend.querySelector(".graviss-legend-max").textContent).toBe("10.0 mm");
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

    // A button takes focus on mousedown, and these two are about focus - so the
    // default is cancelled and the click still lands. Without that the panel
    // would have lost focus before the command ran, and "hand focus back" could
    // never happen from the toolbar.
    const mousedown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    button.dispatchEvent(mousedown);
    expect(mousedown.defaultPrevented).toBe(true);

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

    // Again, and focus goes back to the model - the panel stays open.
    button.click();
    await conditionPromise(() => !filter.isFocused(), "focus to return to the model");
    expect(filter.isShowing()).toBe(true);
    expect(button.getAttribute("aria-pressed")).toBe("true");
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
