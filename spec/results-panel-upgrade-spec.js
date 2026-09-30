const { TestSession } = require("./support/test-model");

const CASES = [
  { id: 101, title: "Self weight", kind: "linear", hasResults: true },
  { id: 102, title: "Permanent load", kind: "linear", hasResults: true },
  { id: 901, title: "First mode", kind: "eigenmode", hasResults: true },
  ...Array.from({ length: 36 }, (_, index) => ({
    id: 2000 + index,
    title: `Wind ${index + 1}`,
    kind: "linear",
    hasResults: true,
  })),
];
const MODEL = {
  id: "results-upgrade",
  title: "Results upgrade",
  format: "Spec fixture",
  loadCases: CASES,
  createGeometry: () => ({
    nodes: [
      { id: 1, x: 0, y: 0, z: 0 },
      { id: 2, x: 8, y: 0, z: 0 },
    ],
    elements: [{ id: 1, kind: "beam", nodeIds: [1, 2] }],
    supports: [],
  }),
  createResult: (loadCaseId) => ({
    kind: "displacement",
    loadCaseId,
    components: 3,
    nodes: { ids: [2], values: [0, 0, -0.01] },
    extent: 0.01,
  }),
};

describe("the Results panel case browser and precise controls", () => {
  let mainModule;
  let viewer;
  let panel;

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    mainModule = (await lumine.packages.activatePackage("graviss")).mainModule;
    panel = await lumine.workspace.open("graviss://results");
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("graviss");
    viewer = null;
    panel = null;
  });

  async function openViewer(session = new TestSession(MODEL), graphics = [{}]) {
    const viewDocument = mainModule.createViewDocument({ fallbackData: { graphics } });
    const pane = lumine.workspace.getCenter().getActivePane();
    viewer = mainModule.createViewer(session, { title: MODEL.title, viewDocument });
    pane.addItem(viewer);
    pane.activateItem(viewer);
    await conditionPromise(() => viewer.renderer != null, "the model to initialize");
    return viewer;
  }

  function input(field, value) {
    field.value = String(value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function shownIds() {
    return [...panel.caseList.children].map((row) => row.dataset.caseId);
  }

  it("searches case numbers and names with types derived from the model, without reading results", async () => {
    await openViewer();
    const read = spyOn(viewer.session, "getResult").and.callThrough();
    expect(panel.kindSelect.items.map((item) => item.value)).toEqual([
      "all",
      "eigenmode",
      "linear",
    ]);
    input(panel.caseSearch, "PERMANENT");
    expect(shownIds()).toEqual(["102"]);
    expect(panel.caseCount.textContent).toBe("1 of 39");
    input(panel.caseSearch, "901");
    expect(shownIds()).toEqual(["901"]);
    panel.kindSelect.setValue("linear", { emit: true });
    expect(shownIds()).toEqual([]);
    expect(panel.body.querySelector(".graviss-case-no-matches").hidden).toBe(false);
    input(panel.caseSearch, "");
    expect(shownIds()).not.toContain("901");
    expect(read).not.toHaveBeenCalled();
  });

  it("steps only matching cases and debounces keyboard preview before reading", async () => {
    await openViewer();
    input(panel.caseSearch, "load");
    const read = spyOn(viewer.session, "getResult").and.callThrough();
    lumine.commands.dispatch(panel.caseList, "core:move-down");
    expect(panel.previewIndex).toBe(0);
    expect(read).not.toHaveBeenCalled();
    expect(panel.caseList.children[0].classList.contains("graviss-case-preview")).toBe(true);
    await conditionPromise(() => viewer.result?.loadCaseId === 102, "the stopped preview to load");
    expect(read.calls.count()).toBe(1);
    input(panel.caseSearch, "");
    panel.kindSelect.setValue("eigenmode", { emit: true });
    panel.caseNext.click();
    await conditionPromise(
      () => viewer.result?.loadCaseId === 901,
      "the matching next case to load",
    );
    expect(read.calls.count()).toBe(2);
    expect(panel.casePrevious.disabled).toBe(true);
    expect(panel.caseNext.disabled).toBe(true);
    expect(panel.casePosition.textContent).toBe("1 of 1");
  });

  it("retains keyed rows, list scroll and the search caret across control updates", async () => {
    await openViewer();
    await viewer.selectLoadCase(101);
    const rows = [...panel.caseList.children];
    const firstTitle = rows[0].querySelector(".graviss-case-title").firstChild;
    panel.caseList.style.height = "90px";
    panel.caseList.style.maxHeight = "90px";
    panel.caseList.style.overflow = "auto";
    panel.caseList.scrollTop = 80;
    const scroll = panel.caseList.scrollTop;
    panel.caseSearch.focus();
    input(panel.caseSearch, " ");
    panel.caseSearch.setSelectionRange(1, 1);
    viewer.setDeformationScale(12.375);
    viewer.setAnimationPeriod(2750);
    viewer.toggleVisibility("grid");
    expect([...panel.caseList.children]).toEqual(rows);
    expect(rows[0].querySelector(".graviss-case-title").firstChild).toBe(firstTitle);
    expect(panel.caseList.scrollTop).toBe(scroll);
    expect(document.activeElement).toBe(panel.caseSearch);
    expect(panel.caseSearch.selectionStart).toBe(1);
    expect(panel.caseSearch.value).toBe(" ");
  });

  it("cancels a pending case preview when another graphic of the same model becomes active", async () => {
    await openViewer(new TestSession(MODEL), [
      { title: "First" },
      { title: "Second", results: { loadCaseId: 901, scale: 10 } },
    ]);
    const read = spyOn(viewer.session, "getResult").and.callThrough();
    input(panel.caseSearch, "load");
    panel.previewBy(1);
    expect(panel.previewIndex).toBe(0);
    expect(read).not.toHaveBeenCalled();
    viewer.activateGraphic(1);
    expect(panel.previewIndex).toBeNull();
    expect(panel.previewTimer).toBeNull();
    expect(panel.caseSearch.value).toBe("load");
    await conditionPromise(() => viewer.result?.loadCaseId === 901, "the second graphic to load");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(viewer.getResultsState().loadCaseId).toBe(901);
    expect(viewer.activeGraphic.results.loadCaseId).toBe(901);
    expect(read.calls.allArgs().map(([request]) => request.loadCaseId)).toEqual([901]);
  });

  it("shows a pending and failed selection separately from the result still displayed, and retries in place", async () => {
    await openViewer();
    await viewer.selectLoadCase(101);
    let reject;
    let attempts = 0;
    spyOn(viewer.session, "getResult").and.callFake(({ loadCaseId }) => {
      if (loadCaseId === 102 && ++attempts === 1) {
        return new Promise((_resolve, rejectPromise) => {
          reject = rejectPromise;
        });
      }
      return Promise.resolve(MODEL.createResult(loadCaseId));
    });
    const oldRow = panel.caseRows.get("101");
    const nextRow = panel.caseRows.get("102");
    const selected = viewer.selectLoadCase(102);
    expect(panel.body.hidden).toBe(false);
    expect(nextRow.classList.contains("graviss-case-pending")).toBe(true);
    expect(nextRow.getAttribute("aria-selected")).toBe("true");
    expect(oldRow.classList.contains("graviss-case-displayed")).toBe(true);
    expect(panel.resultStatus.textContent).toContain("still displaying LC 101");
    reject(new Error("CDB unavailable"));
    await selected;
    expect(panel.body.hidden).toBe(false);
    expect(panel.resultError.hidden).toBe(false);
    expect(panel.resultError.textContent).toContain("CDB unavailable");
    expect(nextRow.classList.contains("graviss-case-failed")).toBe(true);
    expect(viewer.result.loadCaseId).toBe(101);
    panel.retryButton.click();
    await conditionPromise(() => viewer.result?.loadCaseId === 102, "the failed case to retry");
    expect(panel.resultError.hidden).toBe(true);
    expect(panel.caseRows.get("102")).toBe(nextRow);
    expect(panel.resultStatus.textContent).toContain("Displayed: LC 102");
  });

  it("keeps the controls available when the load case index fails and offers Retry", async () => {
    const session = new TestSession(MODEL);
    let reads = 0;
    spyOn(session, "getLoadCases").and.callFake(() =>
      ++reads === 1 ? Promise.reject(new Error("Index unavailable")) : Promise.resolve(CASES),
    );
    await openViewer(session);
    expect(viewer.hasResults()).toBe(false);
    expect(panel.body.hidden).toBe(false);
    expect(panel.resultError.hidden).toBe(false);
    expect(panel.resultError.textContent).toContain("load cases: Index unavailable");
    expect(panel.retryButton.disabled).toBe(false);
    panel.retryButton.click();
    await conditionPromise(() => viewer.hasResults(), "the load case index to retry");
    expect(shownIds().length).toBe(CASES.length);
    expect(panel.resultError.hidden).toBe(true);
  });

  it("accepts precise nonnegative factors, validates invalid edits and toggles Auto without changing the factor", async () => {
    await openViewer();
    await viewer.selectLoadCase(101);
    panel.scaleInput.focus();
    input(panel.scaleInput, "12.375");
    expect(viewer.getResultsState().scale).toBe(12.375);
    expect(panel.scaleInput.value).toBe("12.375");
    expect(panel.scaleMode.textContent).toBe("Manual");
    input(panel.scaleInput, "-1");
    expect(viewer.getResultsState().scale).toBe(12.375);
    expect(panel.scaleInput.getAttribute("aria-invalid")).toBe("true");
    expect(panel.scaleError.hidden).toBe(false);
    input(panel.scaleInput, "");
    expect(viewer.getResultsState().scale).toBe(12.375);
    input(panel.scaleInput, "0");
    expect(viewer.renderer.getDeformation().scale).toBe(0);
    expect(panel.scaleError.hidden).toBe(true);
    panel.scaleAuto.click();
    expect(viewer.getResultsState().scale).toBe("auto");
    const automaticFactor = viewer.renderer.getDeformation().scale;
    panel.scaleAuto.click();
    expect(viewer.getResultsState().scale).toBe(automaticFactor);
    expect(viewer.renderer.getDeformation().scale).toBe(automaticFactor);
    expect([...panel.scalePresets.children].map((button) => button.dataset.scale)).toEqual([
      "0",
      "1",
      "10",
      "100",
      "1000",
    ]);
  });

  it("scrubs deformation while preserving the return direction and updates only the thumb for clock events", async () => {
    await openViewer();
    await viewer.selectLoadCase(101);
    viewer.setAnimationPosition(0.73);
    panel.playButton.click();
    expect(viewer.getResultsState().playing).toBe(true);
    input(panel.positionSlider, "73");
    expect(viewer.getResultsState().playing).toBe(false);
    expect(panel.playButton.textContent).toBe("Play");
    const pausedPosition = viewer.getAnimationPosition();
    expect(pausedPosition).toBeGreaterThan(0.5);
    expect(viewer.renderer.getDeformation().phase).toBeCloseTo(0.73, 8);
    expect(panel.positionValue.textContent).toBe("Deformation +73%");
    const renderCases = spyOn(panel, "renderCases").and.callThrough();
    const row = panel.caseList.firstElementChild;
    panel.positionSlider.focus();
    viewer.emitter.emit("did-change-animation-position", 0.25);
    expect(panel.positionValue.textContent).toBe("Deformation +50%");
    expect(Number(panel.positionSlider.value)).toBeCloseTo(50, 8);
    viewer.emitter.emit("did-change-animation-position", 0.5);
    expect(panel.positionValue.textContent).toBe("Deformation +100%");
    expect(panel.positionSlider.value).toBe("100");
    expect(renderCases).not.toHaveBeenCalled();
    expect(panel.caseList.firstElementChild).toBe(row);
    input(panel.periodInput, "3.75");
    expect(viewer.getResultsState().period).toBe(3750);
    expect(viewer.getAnimationPosition()).toBeCloseTo(pausedPosition, 8);
    input(panel.periodInput, "0");
    expect(viewer.getResultsState().period).toBe(3750);
    expect(panel.periodInput.getAttribute("aria-invalid")).toBe("true");
  });

  it("follows the eased positive or signed swing deformation, including the default mode shape", async () => {
    await openViewer();
    await viewer.selectLoadCase(101);
    expect(panel.positionSlider.min).toBe("0");
    viewer.setAnimationPosition(0.125);
    expect(Number(panel.positionSlider.value)).toBeCloseTo(14.6, 1);
    viewer.setAnimationPosition(0.25);
    expect(Number(panel.positionSlider.value)).toBeCloseTo(50, 8);
    await viewer.selectLoadCase(901);
    expect(panel.positionSlider.min).toBe("-100");
    viewer.setAnimationPosition(0.75);
    expect(panel.positionSlider.value).toBe("-100");
    expect(panel.positionValue.textContent).toBe("Deformation -100%");
    expect(panel.positionSlider.getAttribute("aria-valuetext")).toBe("-100% deformation");
    viewer.setAnimationPosition(0.5);
    input(panel.positionSlider, "-50");
    expect(viewer.renderer.getDeformation().phase).toBeCloseTo(-0.5, 8);
    expect(viewer.getAnimationPosition()).toBeCloseTo(7 / 12, 8);
    viewer.setAnimationPosition(0.875);
    input(panel.positionSlider, "-50");
    expect(viewer.renderer.getDeformation().phase).toBeCloseTo(-0.5, 8);
    expect(viewer.getAnimationPosition()).toBeCloseTo(11 / 12, 8);
    panel.cycleSelect.setValue("thereAndBack", { emit: true });
    expect(panel.positionSlider.min).toBe("0");
    expect(Number(panel.positionSlider.value)).toBeCloseTo(6.7, 1);
    panel.cycleSelect.setValue("pingPong", { emit: true });
    expect(panel.positionSlider.min).toBe("-100");
    expect(Number(panel.positionSlider.value)).toBeCloseTo(-50, 8);
  });

  it("keeps System separate from the case filter and labels colours with true displacement units", async () => {
    await openViewer();
    await viewer.selectLoadCase(101);
    panel.colorToggle.click();
    expect(panel.legend.hidden).toBe(false);
    expect(panel.legend.querySelector(".graviss-legend-max").textContent).toBe("10.0 mm");
    input(panel.caseSearch, "no such case");
    expect(panel.caseList.children.length).toBe(0);
    panel.systemButton.click();
    expect(viewer.result).toBeNull();
    expect(viewer.getResultsState().loadCaseId).toBeNull();
    expect(panel.systemButton.getAttribute("aria-pressed")).toBe("true");
    expect(panel.resultStatus.textContent).toBe("System · No result field");
    expect(panel.playButton.disabled).toBe(true);
    expect(panel.scaleInput.disabled).toBe(true);
    expect(panel.colorToggle.disabled).toBe(true);
    expect(panel.legend.hidden).toBe(true);
  });
});
