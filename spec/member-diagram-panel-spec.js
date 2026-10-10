const { TestSession } = require("./support/test-model");

const MODEL = {
  id: "beam-panel",
  title: "Beam results",
  format: "Spec fixture",
  loadCases: [{ id: 1, title: "Member loads", kind: "linear", hasResults: true }],
  createGeometry: () => ({
    nodes: [
      { id: 1, x: 0, y: 0, z: 0 },
      { id: 2, x: 8, y: 0, z: 0 },
    ],
    elements: [
      {
        id: 10,
        kind: "beam",
        nodeIds: [1, 2],
        localAxes: { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
      },
    ],
    supports: [],
  }),
  createResult: (loadCaseId) => ({
    kind: "displacement",
    loadCaseId,
    components: 3,
    nodes: { ids: [2], values: [0, 0, -0.01] },
  }),
};

function memberResult() {
  return {
    kind: "memberDiagram",
    loadCaseId: 1,
    components: [
      {
        id: "N",
        title: "Axial force",
        group: "Forces",
        unit: "N",
        displayUnit: "kN",
        displayFactor: 0.001,
        plane: "y",
        directionSign: 1,
      },
      {
        id: "Mz",
        title: "Bending moment",
        group: "Forces",
        unit: "N·m",
        displayUnit: "kN·m",
        displayFactor: 0.001,
        plane: "y",
        directionSign: -1,
      },
      {
        id: "ux",
        title: "Axial displacement",
        group: "Displacements",
        unit: "m",
        displayUnit: "mm",
        displayFactor: 1000,
        plane: "y",
        directionSign: 1,
      },
      {
        id: "py",
        title: "Bedding force",
        group: "Bedding",
        unit: "N/m",
        displayUnit: "kN/m",
        displayFactor: 0.001,
        plane: "y",
        directionSign: 1,
      },
      {
        id: "stressTop",
        title: "Top fibre stress",
        group: "Stresses",
        unit: "Pa",
        displayUnit: "MPa",
        displayFactor: 0.000001,
        plane: "z",
        directionSign: 1,
      },
    ],
    elements: [
      {
        id: 10,
        stations: [
          { x: 0, values: [-12000, 0, 0, null, 2e6] },
          { x: 4, values: [-12000, 24000, 0.002, 3000, null] },
          { x: 4, values: [6000, 24000, 0.002, null, -1e6] },
          { x: 8, values: [6000, 0, 0.004, 7000, 4e6] },
        ],
      },
    ],
  };
}

describe("the Results panel's source-defined member diagrams", () => {
  let mainModule;
  let viewer;
  let panel;
  let session;

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    mainModule = (await lumine.packages.activatePackage("graviss")).mainModule;
    panel = await lumine.workspace.open("graviss://results");
    session = new TestSession(MODEL);
    const describe = session.describe.bind(session);
    session.describe = async () => {
      const description = await describe();
      description.capabilities.results.memberDiagram = true;
      return description;
    };
    session.getResult = async ({ kind, loadCaseId }) =>
      kind === "memberDiagram" ? memberResult() : MODEL.createResult(loadCaseId);
    const viewDocument = mainModule.createViewDocument({ fallbackData: { graphics: [{}] } });
    viewer = mainModule.createViewer(session, { title: MODEL.title, viewDocument });
    const pane = lumine.workspace.getCenter().getActivePane();
    pane.addItem(viewer);
    pane.activateItem(viewer);
    await conditionPromise(() => viewer.renderer != null, "the model to initialize");
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("graviss");
  });

  function input(field, value) {
    field.value = String(value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }

  async function showForces() {
    await viewer.selectLoadCase(1);
    panel.resultKindSelect.setValue("memberDiagram", { emit: true });
    await conditionPromise(() => viewer.result?.kind === "memberDiagram", "member results to load");
  }

  function selectMember() {
    const object = viewer.renderer.pickables.find((candidate) =>
      candidate.userData.gravissEntities?.some((entity) => entity.id === 10),
    );
    viewer.renderer.setSelected({
      type: "element",
      entity: viewer.geometry.elements[0],
      entityIndex: 0,
      instanceId: 0,
      object,
    });
  }

  it("offers source-supported quantities and actual components, with signed engineering units", async () => {
    expect(panel.resultKindSelect.items.map(({ value }) => value)).toEqual([
      "displacement",
      "memberDiagram",
    ]);
    await showForces();
    expect(panel.beamSection.hidden).toBe(false);
    expect(
      panel.forceComponentSelect.items
        .filter(({ disabled }) => !disabled)
        .map(({ value }) => value),
    ).toEqual(["N", "Mz"]);
    expect(panel.forceMin.textContent).toBe("-12 kN");
    expect(panel.forceMax.textContent).toBe("+6 kN");
    expect(panel.forceMinLocation.textContent).toBe("Member 10 · x = 0 m");
    expect(panel.forceCount.textContent).toBe("1 of 1 members · 4 stations");
    panel.forceComponentSelect.setValue("Mz", { emit: true });
    expect(viewer.getResultsState().component).toBe("Mz");
    expect(panel.forceMin.textContent).toBe("0 kN·m");
    expect(panel.forceMax.textContent).toBe("+24 kN·m");
    expect(panel.forceScaleUnit.textContent).toBe("m/(kN·m)");
    expect(panel.forcePlaneSelect.element.title).toBe("Positive ordinate: −local y");
    expect(panel.playButton.disabled).toBe(true);
    expect(panel.periodInput.disabled).toBe(true);
    expect(panel.positionSlider.disabled).toBe(true);
    expect(panel.scaleInput.disabled).toBe(true);
    expect(panel.colorToggle.disabled).toBe(true);
    expect(panel.resultStatus.textContent).toBe("LC 1 · Member loads · Member results");
  });

  it("derives categories, arbitrary quantity names, display units and scale conversion from the source catalog", async () => {
    await showForces();
    expect(panel.memberGroupSelect.items.map(({ label }) => label)).toEqual([
      "Forces",
      "Displacements",
      "Bedding",
      "Stresses",
    ]);
    panel.memberGroupSelect.setValue("Displacements", { emit: true });
    expect(viewer.getResultsState().component).toBe("ux");
    expect(panel.forceComponentSelect.items.map(({ label }) => label)).toEqual([
      "ux · Axial displacement [mm]",
    ]);
    expect(panel.forceMin.textContent).toBe("0 mm");
    expect(panel.forceMax.textContent).toBe("+4 mm");
    expect(panel.forceScaleUnit.textContent).toBe("m/mm");
    input(panel.forceScaleInput, "0.25");
    expect(viewer.getResultsState().diagramScale).toBe(250);
    expect(Number(panel.forceScaleInput.value)).toBe(0.25);
    panel.forceScaleAuto.click();
    panel.memberGroupSelect.setValue("Stresses", { emit: true });
    expect(viewer.getResultsState().component).toBe("stressTop");
    expect(panel.forceMin.textContent).toBe("-1 MPa");
    expect(panel.forceMax.textContent).toBe("+4 MPa");
    expect(panel.forceScaleUnit.textContent).toBe("m/MPa");
    expect(panel.forcePlaneSelect.element.title).toBe("Positive ordinate: +local z");
  });

  it("keeps unavailable station values distinct from zero for partial and entirely missing quantities", async () => {
    await showForces();
    panel.memberGroupSelect.setValue("Bedding", { emit: true });
    expect(panel.forceMin.textContent).toBe("+3 kN/m");
    expect(panel.forceMax.textContent).toBe("+7 kN/m");
    expect(panel.forceScaleUnit.textContent).toBe("m/(kN/m)");
    selectMember();
    expect(
      [...panel.forceStations.children].map((row) => row.lastElementChild.textContent),
    ).toEqual(["Unavailable", "+3", "Unavailable", "+7"]);
    session.getResult = async () => {
      const result = memberResult();
      result.elements[0].stations.forEach(({ values }) => {
        values[3] = null;
      });
      return result;
    };
    await viewer.selectLoadCase(1);
    expect(panel.forceExtrema.hidden).toBe(true);
    expect(panel.forceMin.textContent).toBe("—");
    expect(panel.forceMax.textContent).toBe("—");
    expect(panel.forceEmpty.textContent).toBe("No values for Bedding force in the visible model.");
  });

  it("converts diagram scale to SI independently of deformation amplification and changes drawing options", async () => {
    await showForces();
    const amplification = viewer.getResultsState().scale;
    panel.forceScaleInput.focus();
    input(panel.forceScaleInput, "0.25");
    expect(viewer.getResultsState().diagramScale).toBeCloseTo(0.00025, 10);
    expect(viewer.renderer.getMemberDiagramSummary().scale).toBeCloseTo(0.00025, 10);
    expect(viewer.getResultsState().scale).toBe(amplification);
    input(panel.forceScaleInput, "0");
    expect(panel.forceScaleInput.getAttribute("aria-invalid")).toBe("true");
    expect(panel.forceScaleError.hidden).toBe(false);
    expect(viewer.getResultsState().diagramScale).toBeCloseTo(0.00025, 10);
    input(panel.forceScaleInput, "-2");
    expect(viewer.getResultsState().diagramScale).toBeCloseTo(0.00025, 10);
    input(panel.forceScaleInput, "1e308");
    expect(panel.forceScaleInput.getAttribute("aria-invalid")).toBe("true");
    expect(panel.forceScaleError.hidden).toBe(false);
    expect(panel.forceScaleError.textContent).toMatch(/coordinate|range|finite/i);
    expect(viewer.getResultsState().diagramScale).toBeCloseTo(0.00025, 10);
    expect(viewer.activeGraphic.results.diagramScale).toBeCloseTo(0.00025, 10);
    expect(viewer.renderer.getMemberDiagramSummary().scale).toBeCloseTo(0.00025, 10);
    panel.forceScaleAuto.click();
    expect(viewer.getResultsState().diagramScale).toBe("auto");
    const automatic = viewer.renderer.getMemberDiagramSummary().scale;
    panel.forceScaleAuto.click();
    expect(viewer.getResultsState().diagramScale).toBe(automatic);
    panel.forcePlaneSelect.setValue("z", { emit: true });
    panel.forceFlip.click();
    panel.forceFilled.click();
    panel.forceLabels.click();
    const state = viewer.getResultsState();
    expect(state.diagramPlane).toBe("z");
    expect(state.diagramFlip).toBe(true);
    expect(state.diagramFilled).toBe(false);
    expect(state.diagramLabels).toBe(false);
    expect(panel.forceMin.textContent).toBe("-12 kN");
    expect(panel.forceMax.textContent).toBe("+6 kN");
    expect(viewer.activeGraphic.results.diagramScale).toBe(automatic);
  });

  it("distinguishes a quantity being loaded or failing from the displacement still displayed", async () => {
    await viewer.selectLoadCase(1);
    let reject;
    spyOn(session, "getResult").and.callFake(
      () =>
        new Promise((_resolve, rejectPromise) => {
          reject = rejectPromise;
        }),
    );
    const loading = viewer.setResultKind("memberDiagram");
    expect(panel.resultKindSelect.value).toBe("memberDiagram");
    expect(panel.forceEmpty.textContent).toBe("Loading member results…");
    expect(panel.resultStatus.textContent).toBe(
      "Loading LC 1 · Member loads · Member results · still displaying LC 1 · Member loads · Displacement",
    );
    expect(panel.forceComponentSelect.element.disabled).toBe(true);
    reject(new Error("Member results unavailable"));
    await loading;
    expect(viewer.result.kind).toBe("displacement");
    expect(panel.resultError.textContent).toContain("Member results: Member results unavailable");
    expect(panel.resultStatus.textContent).toBe("LC 1 · Member loads · Displacement");
    expect(panel.resultKindSelect.value).toBe("memberDiagram");
    session.getResult.and.returnValue(Promise.resolve(memberResult()));
    panel.retryButton.click();
    await conditionPromise(
      () => viewer.result?.kind === "memberDiagram",
      "failed member results to retry",
    );
    expect(panel.resultError.hidden).toBe(true);
  });

  it("reports an empty field or hidden members without fabricating zero extrema", async () => {
    await showForces();
    viewer.toggleVisibility("members");
    expect(panel.forceExtrema.hidden).toBe(true);
    expect(panel.forceEmpty.textContent).toBe("No values for Axial force in the visible model.");
    expect(panel.forceMin.textContent).toBe("—");
    viewer.toggleVisibility("members");
    expect(panel.forceExtrema.hidden).toBe(false);
    session.getResult = async () => ({ ...memberResult(), elements: [] });
    await viewer.selectLoadCase(1);
    expect(panel.forceExtrema.hidden).toBe(true);
    expect(panel.forceEmpty.textContent).toBe("This load case contains no member results.");
    expect(panel.forceMax.textContent).toBe("—");
  });

  it("discloses when the viewport label budget leaves values available only in the station readout", async () => {
    await showForces();
    const summary = viewer.renderer.getMemberDiagramSummary();
    spyOn(viewer.renderer, "getMemberDiagramSummary").and.returnValue({
      ...summary,
      labelsTotal: 340,
      labelsShown: 300,
    });
    panel.update();
    expect(panel.forceLabelNotice.hidden).toBe(false);
    expect(panel.forceLabelNotice.textContent).toBe(
      "Showing 300 of 340 labels. Select a member to inspect its stations.",
    );
    panel.forceLabels.click();
    expect(panel.forceLabelNotice.hidden).toBe(true);
  });

  it("shows selected member stations with distinct left and right limits at force jumps", async () => {
    await showForces();
    selectMember();
    expect(panel.forceSelected.hidden).toBe(false);
    expect(panel.forceSelectedTitle.textContent).toBe("Member 10");
    expect(
      [...panel.forceStations.children].map((row) =>
        [...row.children].map((cell) => cell.textContent),
      ),
    ).toEqual([
      ["0", "-12"],
      ["4−", "-12"],
      ["4+", "+6"],
      ["8", "+6"],
    ]);
    panel.forceComponentSelect.setValue("Mz", { emit: true });
    expect(panel.forceStationQuantity.textContent).toBe("Mz [kN·m]");
    viewer.renderer.setSelected(null);
    expect(panel.forceSelected.hidden).toBe(true);
    expect(panel.forceStations.children.length).toBe(0);
  });
});
