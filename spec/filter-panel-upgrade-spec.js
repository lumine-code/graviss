const { TestSession } = require("./support/test-model");

const MODEL = {
  id: "catalogue",
  title: "Catalogue",
  format: "Spec fixture",
  createGeometry: () => ({
    nodes: [
      { id: 1, x: 0, y: 0, z: 0 },
      { id: 2, x: 2, y: 0, z: 0 },
      { id: 3, x: 4, y: 0, z: 0 },
      { id: 4, x: 6, y: 0, z: 0 },
    ],
    filterTypes: [
      {
        id: "group:all|opaque",
        title: "Group",
        numeric: true,
        values: [
          { id: 1, title: "Deck" },
          { id: 2, title: "Piers" },
          { id: 9, title: "Unused" },
        ],
      },
      {
        id: "name:opaque",
        title: "Named set",
        multiple: true,
        values: [
          { id: "A B", title: "Space" },
          { id: "A*", title: "Literal star" },
          { id: "AB", title: "Plain" },
        ],
      },
      {
        id: "beam-flag",
        title: "Beam flag",
        kinds: ["beam"],
        values: [{ id: "B", title: "Beam only" }],
      },
    ],
    elements: [
      {
        id: "B1",
        kind: "beam",
        number: 1,
        nodeIds: [1, 2],
        filterValues: { "group:all|opaque": 1, "name:opaque": ["A B", "A*"], "beam-flag": "B" },
      },
      {
        id: "T2",
        kind: "truss",
        number: 2,
        nodeIds: [2, 3],
        filterValues: { "group:all|opaque": 2, "name:opaque": ["AB"] },
      },
      {
        id: "B3",
        kind: "beam",
        number: 3,
        nodeIds: [3, 4],
        filterValues: { "group:all|opaque": 2, "name:opaque": ["AB"] },
      },
    ],
    supports: [],
  }),
};

describe("the Filter overview", () => {
  let panel;
  let viewer;

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    const pack = await lumine.packages.activatePackage("graviss");
    const main = pack.mainModule;
    viewer = main.createViewer(new TestSession(MODEL), {
      title: MODEL.title,
      viewDocument: main.createViewDocument({ fallbackData: { graphics: [{}] } }),
    });
    const pane = lumine.workspace.getCenter().getActivePane();
    pane.addItem(viewer);
    pane.activateItem(viewer);
    await conditionPromise(() => viewer.renderer != null, "the catalogue model to load");
    panel = await lumine.workspace.open("graviss://filter");
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("graviss");
  });

  function chooseDimension(title) {
    const index = viewer.getFilterSubjects().findIndex((subject) => subject.title === title);
    expect(index).toBeGreaterThanOrEqual(0);
    panel.dimensionSelect.setValue(String(index), { emit: true });
  }

  function type(field, text) {
    field.value = text;
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("shows real values, searches locally and retains a hidden selection", () => {
    expect(panel.catalogSubject.title).toBe("Group");
    expect(panel.catalogRows.size).toBe(3);
    expect(
      panel.catalogRows.get("9").querySelector(".graviss-catalog-value-count").textContent,
    ).toBe("0");
    panel.catalogRows.get("1").click();
    type(panel.catalogSearch, "Piers");
    expect([...panel.catalogRows.keys()]).toEqual(["2"]);
    expect(panel.selectedValues.has("1")).toBe(true);
    expect(viewer.getFilterState().rules).toEqual([]);
    panel.catalogRows.get("2").click();
    expect(panel.catalogStatus.textContent).toBe("2 selected");
    panel.catalogButtons[0].click();
    expect(viewer.activeGraphic.filter.rules).toEqual([
      { sign: "+", type: "group:all|opaque", text: "1, 2" },
    ]);
    expect(panel.selectedValues.size).toBe(0);
    expect(panel.catalogButtons[0].disabled).toBe(true);
  });

  it("appends one scoped subtraction and never applies an empty selection", () => {
    const add = spyOn(viewer, "addRule").and.callThrough();
    expect(panel.appendCatalogRule("+")).toBeNull();
    expect(add).not.toHaveBeenCalled();
    chooseDimension("Group (trusses)");
    panel.catalogRows.get("2").click();
    panel.catalogButtons[1].click();
    expect(add.calls.count()).toBe(1);
    expect(viewer.activeGraphic.filter.rules).toEqual([
      { sign: "-", type: "group:all|opaque", kinds: ["truss"], text: "2" },
    ]);
    expect(viewer.getRuleCounts().named).toEqual([1]);
    expect(viewer.getRuleCounts().shown).toBe(2);
  });

  it("selects named values exactly without changing wildcard or whitespace meaning", () => {
    chooseDimension("Named set");
    panel.catalogRows.get("A B").click();
    panel.catalogRows.get("A*").click();
    panel.catalogButtons[0].click();
    expect(viewer.activeGraphic.filter.rules[0].text).toBe('"A B", "A*"');
    expect(viewer.getRuleCounts().shown).toBe(1);
    expect(viewer.getRuleCounts().named).toEqual([1]);
  });

  it("uses a number expression without listing the model's element IDs", () => {
    chooseDimension("Number (trusses)");
    expect(panel.catalogList.hidden).toBe(true);
    expect(panel.catalogNumber.hidden).toBe(false);
    expect(panel.catalogRows.size).toBe(0);
    type(panel.catalogNumber, " , , ");
    expect(panel.catalogButtons[0].disabled).toBe(true);
    expect(panel.appendCatalogRule("+")).toBeNull();
    type(panel.catalogNumber, "2-");
    expect(panel.catalogButtons[0].disabled).toBe(true);
    expect(panel.catalogError.textContent).toContain("not a number, a range");
    expect(panel.appendCatalogRule("+")).toBeNull();
    type(panel.catalogNumber, "1-3");
    panel.catalogButtons[0].click();
    expect(viewer.activeGraphic.filter.rules).toEqual([
      { sign: "+", type: "@number", kinds: ["truss"], text: "1-3" },
    ]);
    expect(viewer.getRuleCounts().shown).toBe(1);
  });

  it("keeps the source domain for a dimension declared on one kind", () => {
    chooseDimension("Beam flag");
    panel.catalogRows.get("B").click();
    panel.catalogButtons[0].click();
    expect(viewer.activeGraphic.filter.rules).toEqual([
      { sign: "+", type: "beam-flag", text: '"B"' },
    ]);
    expect(viewer.getRuleCounts().shown).toBe(1);
    const row = [...panel.rows.values()][0];
    expect(row.select.element.querySelector(".select-box-label").textContent).toBe("Beam flag");
  });

  it("keeps an invalid draft visible and leaves the last valid filter active", () => {
    const id = viewer.addRule({ sign: "+", type: "@number", text: "1" });
    const row = panel.rows.get(id);
    row.field.focus();
    type(row.field, "1-");
    expect(row.field.getAttribute("aria-invalid")).toBe("true");
    expect(row.error.hidden).toBe(false);
    expect(row.error.textContent).toContain("not a number, a range");
    expect(viewer.getFilterState().rules[0].text).toBe("1");
    expect(viewer.getRuleCounts().shown).toBe(1);
    row.sign.click();
    viewer.toggleVisibility("grid");
    expect(row.field.value).toBe("1-");
    expect(row.error.hidden).toBe(false);
    type(row.field, "2");
    expect(row.error.hidden).toBe(true);
    expect(viewer.getFilterState().rules[0].text).toBe("2");
  });

  it("preserves rows and input focus while reordering, with labelled button alternatives", () => {
    const first = viewer.addRule({ sign: "+", type: "@number", text: "1" });
    const second = viewer.addRule({ sign: "-", type: "@number", text: "2" });
    const row = panel.rows.get(second);
    row.field.focus();
    row.field.setSelectionRange(1, 1);
    panel.moveFocusedRule(-1);
    expect(viewer.getFilterState().rules.map(({ id }) => id)).toEqual([second, first]);
    expect(panel.rows.get(second)).toBe(row);
    expect(document.activeElement).toBe(row.field);
    expect(row.field.selectionStart).toBe(1);
    expect(row.up.disabled).toBe(true);
    expect(row.down.getAttribute("aria-label")).toBe("Move this rule down");
    row.down.focus();
    row.down.click();
    expect(viewer.getFilterState().rules.map(({ id }) => id)).toEqual([first, second]);
    expect(document.activeElement).toBe(row.field);
    expect(row.sign.textContent).toBe("Subtract");
  });

  it("reports an unfinished exact named value while retaining the displayed set", () => {
    const id = viewer.addRule({ sign: "+", type: "name:opaque", text: '"A B"' });
    const row = panel.rows.get(id);
    row.field.focus();
    type(row.field, '"A B');
    expect(row.field.getAttribute("aria-invalid")).toBe("true");
    expect(row.error.textContent).toBe("Close the quoted value with a double quote.");
    expect(viewer.getFilterState().rules[0].text).toBe('"A B"');
    expect(viewer.getRuleCounts().shown).toBe(1);
    type(row.field, '"AB"');
    expect(row.error.hidden).toBe(true);
    expect(viewer.getRuleCounts().shown).toBe(2);
  });

  it("keeps catalogue rows and selection while unrelated model controls change", () => {
    const first = panel.catalogRows.get("1");
    first.click();
    first.focus();
    viewer.toggleVisibility("grid");
    expect(panel.catalogRows.get("1")).toBe(first);
    expect(document.activeElement).toBe(first);
    expect(first.getAttribute("aria-pressed")).toBe("true");
  });

  it("clears unfinished work when another graphic repeats a rule ID and stored text", () => {
    const filter = { rules: [{ id: "shared", sign: "+", type: "@number", text: "1" }] };
    viewer.viewDocument.update((document) => {
      document.graphics = [
        { title: "First", filter },
        { title: "Second", filter },
      ];
    }, "fixture");
    viewer.activateGraphic(0);
    const row = panel.rows.get("shared");
    row.field.focus();
    type(row.field, "1-");
    type(panel.catalogSearch, "Deck");
    panel.catalogRows.get("1").click();
    panel.dragging = "shared";
    viewer.activateGraphic(1);
    expect(panel.rows.get("shared")).toBe(row);
    expect(row.field.value).toBe("1");
    expect(row.error.hidden).toBe(true);
    expect(panel.selectedValues.size).toBe(0);
    expect(panel.catalogButtons[0].disabled).toBe(true);
    expect(panel.dragging).toBeNull();
    expect(panel.catalogSearch.value).toBe("Deck");
  });

  it("retains unfinished work when only the current graphic title changes", () => {
    const id = viewer.addRule({ sign: "+", type: "@number", text: "1" });
    const row = panel.rows.get(id);
    row.field.focus();
    type(row.field, "1-");
    row.field.setSelectionRange(1, 1);
    panel.catalogRows.get("1").click();
    viewer.viewDocument.update((document) => {
      document.graphics[0].title = "Renamed";
    }, "rename");
    expect(row.field.value).toBe("1-");
    expect(document.activeElement).toBe(row.field);
    expect(row.field.selectionStart).toBe(1);
    expect(panel.selectedValues.has("1")).toBe(true);
    expect(row.error.hidden).toBe(false);
  });
});
