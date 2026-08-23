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
    facets: [
      {
        id: "group",
        title: "Group",
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
        facetValues: { group: 1 },
      },
      {
        id: "T1",
        kind: "truss",
        number: 2,
        nodeIds: [2, 3],
        sectionId: "R",
        facetValues: { group: 2 },
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

  it("narrows the model from its own controls, and says what survived", async () => {
    const filter = await lumine.workspace.open(FILTER_PANEL_URI);
    await openViewer(ANALYSED_MODEL);

    const rows = [...filter.kindList.querySelectorAll(".graviss-kind-row")];
    expect(rows.map((row) => row.querySelector(".graviss-kind-label").textContent)).toEqual([
      "Beams",
      "Trusses",
    ]);
    // The swatch is painted from the renderer's own resolved colour, so it
    // cannot disagree with what is on screen.
    const swatch = rows[1].querySelector(".graviss-kind-swatch").style.background;
    expect(swatch).toContain(
      String(viewer.renderer.colors.truss.getHexString())
        .match(/../g)
        .map((pair) => parseInt(pair, 16))
        .join(", "),
    );

    // A kind switched off is a kind not drawn, and the count says so.
    rows[0].querySelector("input").click();
    expect(viewer.isVisible("beams")).toBe(false);
    expect(filter.kindList.querySelectorAll(".graviss-kind-count")[0].textContent).toBe("0 / 1");
    rows[0].querySelector("input").click();

    // A number expression nobody can read says so and changes nothing.
    filter.numberField.value = "1-";
    filter.numberField.dispatchEvent(new Event("input"));
    expect(filter.numberField.classList.contains("graviss-invalid")).toBe(true);
    expect(viewer.getFilterState().numbers).toBe("");

    filter.numberField.value = "2";
    filter.numberField.dispatchEvent(new Event("input"));
    expect(filter.numberField.classList.contains("graviss-invalid")).toBe(false);
    expect(viewer.getFilterState().numbers).toBe("2");
    expect(viewer.activeGraphic.filter).toEqual({ numbers: "2" });

    filter.body.querySelector(".graviss-clear-filter").click();
    expect(viewer.getFilterState().numbers).toBe("");
  });

  it("offers the source's own dimensions without knowing what they mean", async () => {
    const filter = await lumine.workspace.open(FILTER_PANEL_URI);
    await openViewer(ANALYSED_MODEL);

    const heading = filter.facetSection.querySelector(".graviss-facet-heading");
    expect(heading.textContent).toContain("Group");
    // Closed until asked for: a model with a dozen dimensions would otherwise
    // open as a wall of checkboxes.
    expect(filter.facetSection.querySelector(".graviss-facet-values")).toBeNull();

    heading.click();
    const values = [...filter.facetSection.querySelectorAll(".graviss-facet-values label span")];
    expect(values.map((value) => value.textContent)).toEqual(["Deck", "Piers"]);

    filter.facetSection.querySelectorAll(".graviss-facet-values input")[1].click();
    expect(viewer.getFilterState().facets.group).toEqual([2]);
    expect(viewer.elementCounts().get("beam")).toEqual({ total: 1, shown: 0 });
    expect(filter.facetSection.querySelector(".graviss-facet-badge").textContent).toBe("1");
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

    results.cycleSelect.value = "pingPong";
    results.cycleSelect.dispatchEvent(new Event("change"));
    expect(viewer.getResultsState().cycle).toBe("pingPong");

    // The legend appears with the colouring and states the ends of the field in
    // the unit somebody would say them in.
    expect(results.legend.hidden).toBe(true);
    results.colorToggle.click();
    expect(viewer.renderer.colorByDisplacement).toBe(true);
    expect(results.legend.hidden).toBe(false);
    expect(results.legend.querySelector(".graviss-legend-max").textContent).toBe("10.0 mm");
  });

  it("gets back to the model from the panel", async () => {
    const filter = await lumine.workspace.open(FILTER_PANEL_URI);
    await openViewer(ANALYSED_MODEL);
    lumine.workspace.paneForItem(filter).activateItem(filter);
    filter.focus();
    expect(filter.isFocused()).toBe(true);

    lumine.commands.dispatch(filter.element, "graviss:focus-viewer");
    expect(filter.isFocused()).toBe(false);
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
