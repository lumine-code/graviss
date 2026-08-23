const {
  compileRules,
  countRules,
  countingRules,
  isReadableExpression,
  isValidNumberFilter,
  parseNameFilter,
  parseNumberFilter,
  startsWhole,
} = require("../lib/filter-rules");
const { buildSubjects, subjectsByKey } = require("../lib/filter-types");

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

describe("parseNameFilter", () => {
  const subject = { titles: new Map([["PP", "Pier piles"]]) };

  it("names a value by its id or by the title it was shown under", () => {
    expect(parseNameFilter("PP", subject)("PP")).toBe(true);
    expect(parseNameFilter("pier*", subject)("PP")).toBe(true);
    expect(parseNameFilter("PP", subject)("QQ")).toBe(false);
  });

  it("takes the same wildcards the number expression does, and ignores case", () => {
    expect(parseNameFilter("p?", subject)("PP")).toBe(true);
    expect(parseNameFilter("p*", subject)("PXYZ")).toBe(true);
    expect(parseNameFilter("p?", subject)("PXYZ")).toBe(false);
  });

  it("never refuses an expression, because every string is a legal name", () => {
    // Only a numeric dimension can produce a rule nobody can read, which is why
    // a row over a named dimension never shows the invalid state.
    expect(() => parseNameFilter("1-10,beam,,,***", subject)).not.toThrow();
    expect(parseNameFilter("", subject)).toBeNull();
    expect(isReadableExpression("1-10,beam", { numeric: true })).toBe(false);
    expect(isReadableExpression("1-10,beam", { numeric: false })).toBe(true);
  });
});

describe("compileRules", () => {
  // A beam and a truss that carry a group, and a coupling that carries neither
  // a group nor a number - which is the case every absence rule turns on.
  const GEOMETRY = {
    elements: [
      { id: "beam-1", kind: "beam", number: 11, filterValues: { group: 1, set: ["a"] } },
      { id: "beam-2", kind: "beam", number: 12, filterValues: { group: 2 } },
      { id: "truss-1", kind: "truss", number: 21, filterValues: { group: 1 } },
      { id: "coupling-1", kind: "coupling" },
    ],
    filterTypes: [
      { id: "group", title: "Group", numeric: true },
      { id: "set", title: "Set", multiple: true },
    ],
  };
  const subjects = subjectsByKey(buildSubjects(GEOMETRY));
  const kept = (rules) => {
    const filter = compileRules(rules, subjects);
    return GEOMETRY.elements.filter(filter ?? (() => true)).map((element) => element.id);
  };

  it("shows the whole model when nobody has asked for anything", () => {
    expect(compileRules([], subjects)).toBeNull();
    expect(compileRules(undefined, subjects)).toBeNull();
    // A row with no dimension chosen is not a question yet, so putting one on
    // the screen must not move the model underneath it.
    expect(compileRules([{ sign: "+", type: "", text: "1" }], subjects)).toBeNull();
    expect(
      countingRules([
        { sign: "+", type: "" },
        { sign: "+", type: "group" },
      ]).length,
    ).toBe(1);
  });

  it("starts from nothing when the list opens by adding", () => {
    expect(startsWhole([{ sign: "+", type: "group", text: "1" }])).toBe(false);
    expect(kept([{ sign: "+", type: "group", text: "1" }])).toEqual(["beam-1", "truss-1"]);
  });

  it("starts from the whole model when the list opens by taking away", () => {
    expect(startsWhole([{ sign: "-", type: "@number", text: "11" }])).toBe(true);
    // Everything except the one element named - which is the reading that makes
    // "hide this" a one-rule list rather than needing a leading "add all".
    expect(kept([{ sign: "-", type: "@number", text: "11" }])).toEqual([
      "beam-2",
      "truss-1",
      "coupling-1",
    ]);
  });

  it("lets the last rule that names an element decide it", () => {
    expect(kept([{ sign: "+", type: "group", text: "1,2" }])).toEqual([
      "beam-1",
      "beam-2",
      "truss-1",
    ]);
    expect(
      kept([
        { sign: "+", type: "group", text: "1,2" },
        { sign: "-", type: "@kind", text: "truss" },
      ]),
    ).toEqual(["beam-1", "beam-2"]);
    // And put back again by a later rule, which is what an ordered fold is for.
    expect(
      kept([
        { sign: "+", type: "group", text: "1,2" },
        { sign: "-", type: "@kind", text: "truss" },
        { sign: "+", type: "@number", text: "21" },
      ]),
    ).toEqual(["beam-1", "beam-2", "truss-1"]);
  });

  it("means something different when the same two rules are the other way round", () => {
    const add = { sign: "+", type: "@kind", text: "truss" };
    const drop = { sign: "-", type: "group", text: "1" };
    // Adding first starts from nothing: the truss arrives, then group one takes
    // it straight back out and nothing is left.
    expect(kept([add, drop])).toEqual([]);
    // Subtracting first starts from the whole model: group one goes, then the
    // truss comes back. Same two rules, and not remotely the same picture.
    expect(kept([drop, add])).toEqual(["beam-2", "truss-1", "coupling-1"]);
  });

  it("does not narrow an element by a dimension it was never placed on", () => {
    // Both directions. The coupling carries no group, so a group question
    // neither adds it nor takes it away - it leaves it where the rules before
    // had put it.
    expect(kept([{ sign: "-", type: "group", text: "1" }])).toContain("coupling-1");
    expect(kept([{ sign: "+", type: "group", text: "1" }])).not.toContain("coupling-1");
    // A number is an identity every numbered element shares, so an element the
    // source numbered nothing is not any of the numbers asked for.
    expect(kept([{ sign: "+", type: "@number", text: "1*" }])).not.toContain("coupling-1");
    expect(kept([{ sign: "-", type: "@number", text: "1*" }])).toContain("coupling-1");
  });

  it("takes a blank expression as every value of that dimension, not every element", () => {
    // The union of every value that could have been listed - so the grouped
    // elements, and not the ungrouped coupling beside them.
    expect(kept([{ sign: "+", type: "group", text: "" }])).toEqual(["beam-1", "beam-2", "truss-1"]);
    expect(kept([{ sign: "+", type: "group" }])).toEqual(["beam-1", "beam-2", "truss-1"]);
    // And it is the kind restriction, not the expression, that says "trusses".
    expect(kept([{ sign: "+", type: "group", kinds: ["truss"] }])).toEqual(["truss-1"]);
  });

  it("matches any of the values a many-valued dimension holds", () => {
    expect(kept([{ sign: "+", type: "set", text: "a" }])).toEqual(["beam-1"]);
    expect(kept([{ sign: "+", type: "set", text: "b" }])).toEqual([]);
  });

  it("names nothing for a dimension this model has not got, and still votes on the start", () => {
    // A document opened against the wrong database. The rule names nothing, so
    // nothing is added - but it is still the first rule, so the list still
    // starts from nothing and the model is empty rather than whole.
    expect(kept([{ sign: "+", type: "storey", text: "3" }])).toEqual([]);
    // The reverse: a leading unresolvable subtraction leaves the model whole
    // rather than blanking it.
    expect(kept([{ sign: "-", type: "storey", text: "3" }]).length).toBe(4);
    // Seeding from the first rule that happened to compile would show the
    // complement of what was asked for.
    expect(
      kept([
        { sign: "+", type: "storey", text: "3" },
        { sign: "+", type: "@kind", text: "truss" },
      ]),
    ).toEqual(["truss-1"]);
  });

  it("names nothing for an expression nobody can read, and still votes on the start", () => {
    expect(kept([{ sign: "+", type: "group", text: "1-10,beam" }])).toEqual([]);
    expect(kept([{ sign: "-", type: "group", text: "1-10,beam" }]).length).toBe(4);
  });
});

describe("countRules", () => {
  const GEOMETRY = {
    elements: [
      { id: "beam-1", kind: "beam", number: 11, filterValues: { group: 1 } },
      { id: "beam-2", kind: "beam", number: 12, filterValues: { group: 2 } },
      { id: "truss-1", kind: "truss", number: 21, filterValues: { group: 1 } },
    ],
    filterTypes: [{ id: "group", title: "Group", numeric: true }],
  };
  const subjects = subjectsByKey(buildSubjects(GEOMETRY));

  it("says how many elements each rule names, and how many survive them all", () => {
    const counts = countRules(
      GEOMETRY.elements,
      [
        { sign: "+", type: "group", text: "1" },
        { sign: "-", type: "@kind", text: "truss" },
      ],
      subjects,
    );
    // What each rule is about, not what it contributed on the day: a net figure
    // is meaningless once a later rule overrules it, and it would flicker as
    // rows are dragged.
    expect(counts.named).toEqual([2, 1]);
    expect(counts.shown).toBe(1);
    expect(counts.total).toBe(3);
  });

  it("reports nothing for a rule nobody can read, which is the diagnosis", () => {
    const counts = countRules(
      GEOMETRY.elements,
      [{ sign: "+", type: "group", text: "nonsense" }],
      subjects,
    );
    expect(counts.named).toEqual([0]);
    expect(counts.steps[0].readable).toBe(false);
    const missing = countRules(GEOMETRY.elements, [{ sign: "+", type: "storey" }], subjects);
    expect(missing.steps[0].resolved).toBe(false);
  });
});

describe("buildSubjects", () => {
  const GEOMETRY = {
    elements: [
      { id: "b", kind: "beam", number: 1, filterValues: { group: 1 } },
      { id: "t", kind: "truss", number: 2, filterValues: { group: 2 } },
      { id: "c", kind: "coupling" },
    ],
    filterTypes: [{ id: "group", title: "Group", numeric: true }],
  };

  it("offers what Graviss owns and what the source declared", () => {
    const titles = buildSubjects(GEOMETRY).map((subject) => subject.title);
    expect(titles).toContain("Kind");
    expect(titles).toContain("Number");
    expect(titles).toContain("Group");
  });

  it("generates a variant per kind that dimension is ever about", () => {
    const keys = buildSubjects(GEOMETRY).map((subject) => subject.key);
    // The coupling carries neither a group nor a number, so neither dimension
    // offers a coupling variant - narrowing to it could only ever name nothing.
    expect(keys).toContain("group|beam");
    expect(keys).toContain("group|truss");
    expect(keys).not.toContain("group|coupling");
    expect(keys).toContain("@number|beam");
    // A kind narrowed to a kind is a question that can only agree with itself.
    expect(keys.filter((key) => key.startsWith("@kind"))).toEqual(["@kind"]);
  });

  it("offers no variant where narrowing would say nothing", () => {
    const single = buildSubjects({
      elements: [{ id: "b", kind: "beam", number: 1, filterValues: { group: 1 } }],
      filterTypes: [{ id: "group", title: "Group", numeric: true }],
    });
    expect(single.map((subject) => subject.key)).toEqual(["@kind", "@number", "group"]);
  });

  it("carries a colour only where the subject is about exactly one kind", () => {
    const subjects = subjectsByKey(buildSubjects(GEOMETRY));
    expect(subjects.get("group").color).toBeNull();
    expect(subjects.get("group|truss").color).toBe("truss");
    // A beam is drawn in the member colour the scheme names rather than one of
    // its own, so the mapping is not the identity.
    expect(subjects.get("group|beam").color).toBe("element");
  });

  it("names the six kinds for the dimension Graviss owns", () => {
    const kind = subjectsByKey(buildSubjects(GEOMETRY)).get("@kind");
    expect(kind.values.map((value) => value.id)).toEqual(["beam", "truss", "coupling"]);
    expect(kind.titles.get("truss")).toBe("Trusses");
  });
});
