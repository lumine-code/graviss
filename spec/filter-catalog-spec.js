const { buildSubjects } = require("../lib/filter-types");
const { compileStep } = require("../lib/filter-rules");
const {
  FilterCatalog,
  buildValueCatalog,
  expressionForValues,
  searchCatalog,
} = require("../lib/filter-catalog");

describe("the model value catalogue", () => {
  let geometry;
  let subjects;

  beforeEach(() => {
    geometry = {
      filterTypes: [
        {
          id: "group:all|opaque",
          title: "Group",
          numeric: true,
          multiple: true,
          values: [
            { id: 11, title: "Deck" },
            { id: 12, title: "Piers" },
            { id: 99, title: "Unused" },
          ],
        },
        {
          id: "named",
          title: "Named",
          values: [
            { id: "A B", title: "Spaces" },
            { id: "A,B", title: "Comma" },
            { id: "A*", title: "Wildcard" },
            { id: 'A"B', title: "Quote" },
            { id: "UP", title: "Upper" },
            { id: "up", title: "Lower" },
          ],
        },
      ],
      elements: [
        {
          kind: "beam",
          number: 1,
          filterValues: { "group:all|opaque": [11, 11, 12], named: "A B" },
        },
        { kind: "truss", number: 2, filterValues: { "group:all|opaque": [12], named: "A*" } },
        { kind: "truss", number: 3, filterValues: { "group:all|opaque": [11], named: "UP" } },
        { kind: "shell", filterValues: {} },
      ],
    };
    subjects = buildSubjects(geometry);
  });

  function subject(title) {
    return subjects.find((entry) => entry.title === title);
  }

  it("counts distinct elements per real value and includes declared unused values", () => {
    expect(
      buildValueCatalog(geometry, subject("Group")).map(({ id, title, count }) => ({
        id,
        title,
        count,
      })),
    ).toEqual([
      { id: 11, title: "Deck", count: 2 },
      { id: 12, title: "Piers", count: 2 },
      { id: 99, title: "Unused", count: 0 },
    ]);
    expect(
      buildValueCatalog(geometry, subject("Group (trusses)")).map(({ id, count }) => ({
        id,
        count,
      })),
    ).toEqual([
      { id: 11, count: 1 },
      { id: 12, count: 1 },
      { id: 99, count: 0 },
    ]);
  });

  it("lists undeclared values held in the model without inventing element numbers", () => {
    const unlisted = { ...subject("Group"), values: [] };
    expect(buildValueCatalog(geometry, unlisted).map(({ id }) => id)).toEqual([11, 12]);
    expect(buildValueCatalog(geometry, subject("Number"))).toEqual([]);
    expect(buildValueCatalog(geometry, subject("Kind")).map(({ count }) => count)).toEqual([
      1, 1, 2,
    ]);
  });

  it("searches IDs and titles without changing source entries", () => {
    const entries = buildValueCatalog(geometry, subject("Group"));
    expect(searchCatalog(entries, "DECK").map(({ id }) => id)).toEqual([11]);
    expect(searchCatalog(entries, "12").map(({ id }) => id)).toEqual([12]);
    expect(searchCatalog(entries, "missing")).toEqual([]);
    expect(searchCatalog(entries, " ")).toBe(entries);
    expect(entries.length).toBe(3);
  });

  it("serializes named picks as exact IDs, including separators, quotes and patterns", () => {
    const named = subject("Named");
    const entries = buildValueCatalog(geometry, named);
    for (const entry of entries) {
      const step = compileStep({ sign: "+", text: expressionForValues([entry], named) }, named);
      for (const candidate of entries) {
        expect(step.select({ kind: "beam", filterValues: { named: candidate.id } })).toBe(
          candidate.id === entry.id,
        );
      }
    }
    expect(
      expressionForValues(
        entries.filter(({ id }) => ["A B", "A,B"].includes(id)),
        named,
      ),
    ).toBe('"A B", "A,B"');
  });

  it("caches by model and subject identity while allowing a new model vocabulary", () => {
    const catalog = new FilterCatalog();
    const first = catalog.get(geometry, subjects, subject("Group"));
    expect(catalog.get(geometry, subjects, subject("Group"))).toBe(first);
    expect(catalog.get({ ...geometry }, subjects, subject("Group"))).not.toBe(first);
    const before = catalog.get(geometry, subjects, subject("Group"));
    expect(catalog.get(geometry, [...subjects], subject("Group"))).not.toBe(before);
  });

  it("refuses catalogue values the existing numeric expression cannot represent", () => {
    const numeric = { ...subject("Group"), values: [{ id: 1.5, title: "Fraction" }] };
    const entry = buildValueCatalog({ elements: [] }, numeric)[0];
    expect(entry.selectable).toBe(false);
    expect(entry.error).toContain("not a number, a range");
  });
});
