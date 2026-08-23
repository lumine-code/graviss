const {
  createElementFilter,
  isEmptyFilter,
  isValidNumberFilter,
  parseNumberFilter,
} = require("../lib/element-filter");

describe("parseNumberFilter", () => {
  it("reads the spelling every FEM tool writes a selection in", () => {
    const matches = parseNumberFilter("1-10,15,1*,11??");
    // A range, ends included.
    expect(matches(1)).toBe(true);
    expect(matches(10)).toBe(true);
    expect(matches(11)).toBe(true); // 11?? has four digits, but 1* takes it
    expect(matches(0)).toBe(false);
    // One number.
    expect(matches(15)).toBe(true);
    // `*` is any run of digits, including none.
    expect(matches(1)).toBe(true);
    expect(matches(1999)).toBe(true);
    expect(matches(2000)).toBe(false);
    // `?` is exactly one digit.
    const two = parseNumberFilter("11??");
    expect(two(1100)).toBe(true);
    expect(two(1199)).toBe(true);
    expect(two(110)).toBe(false);
    expect(two(11000)).toBe(false);
  });

  it("takes whitespace as a separator and a range written backwards", () => {
    const matches = parseNumberFilter("  5 - 7 , 20  30 ");
    expect([5, 6, 7, 20, 30].every((number) => matches(number))).toBe(true);
    expect(matches(21)).toBe(false);
    expect(parseNumberFilter("9-3")(5)).toBe(true);
  });

  it("is nothing at all when nothing was asked", () => {
    expect(parseNumberFilter("")).toBeNull();
    expect(parseNumberFilter("   ")).toBeNull();
    expect(parseNumberFilter(null)).toBeNull();
  });

  it("refuses a term it cannot read rather than quietly meaning something else", () => {
    expect(() => parseNumberFilter("1-10,beam")).toThrowError(/not a number, a range/);
    expect(() => parseNumberFilter("1.5")).toThrowError();
    expect(isValidNumberFilter("1-10,15,1*")).toBe(true);
    expect(isValidNumberFilter("beam")).toBe(false);
  });

  it("admits nothing for an element that has no number", () => {
    const matches = parseNumberFilter("1*");
    expect(matches(undefined)).toBe(false);
    expect(matches(Number.NaN)).toBe(false);
  });
});

describe("createElementFilter", () => {
  const elements = [
    { id: "beam-110001", kind: "beam", number: 110001, facetValues: { group: 11, set: ["a"] } },
    { id: "beam-120001", kind: "beam", number: 120001, facetValues: { group: 12 } },
    { id: "truss-110002", kind: "truss", number: 110002, facetValues: { group: 11 } },
    { id: "coupling-1-2", kind: "coupling" },
  ];
  const kept = (filter) =>
    elements.filter(createElementFilter(filter) ?? (() => true)).map((e) => e.id);

  it("narrows by nothing when nothing was stated", () => {
    expect(createElementFilter({})).toBeNull();
    expect(createElementFilter({ numbers: "", kinds: [], facets: { group: [] } })).toBeNull();
    expect(isEmptyFilter({})).toBe(true);
    // A fresh panel shows the whole model, which is why an unstated question
    // has to mean "everything" and not "nothing".
    expect(kept({})).toEqual(elements.map((e) => e.id));
  });

  it("takes every stated question together", () => {
    expect(kept({ numbers: "11*" })).toEqual(["beam-110001", "truss-110002"]);
    expect(kept({ kinds: ["beam"] })).toEqual(["beam-110001", "beam-120001"]);
    expect(kept({ facets: { group: [11] } })).toEqual(["beam-110001", "truss-110002"]);
    // All three at once, which is a conjunction and not a union.
    expect(kept({ numbers: "11*", kinds: ["beam"], facets: { group: [11] } })).toEqual([
      "beam-110001",
    ]);
  });

  it("keeps an element that holds any of the values a facet was narrowed to", () => {
    expect(kept({ facets: { group: [11, 12] } })).toEqual([
      "beam-110001",
      "beam-120001",
      "truss-110002",
    ]);
    // A many-valued facet matches on any of what the element holds.
    expect(kept({ facets: { set: ["a"] } })).toEqual(["beam-110001"]);
    // An element silent about a facet is not in it.
    expect(kept({ facets: { group: [11] } })).not.toContain("coupling-1-2");
  });

  it("drops an element with no number when numbers were asked for", () => {
    expect(kept({ numbers: "1-999999" })).not.toContain("coupling-1-2");
  });
});
