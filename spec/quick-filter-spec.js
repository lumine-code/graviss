const {
  compileQuickFilter,
  normalizeQuickFilter,
  parseQuickFilter,
} = require("../lib/quick-filter");

describe("the quick filter language", () => {
  const group = {
    key: "source:group|opaque",
    type: "source:group|opaque",
    title: "Group",
    numeric: true,
    read: (element) => element.filterValues?.group ?? null,
  };
  const named = {
    key: "source:named|opaque",
    type: "source:named|opaque",
    title: "Named set",
    numeric: false,
    read: (element) => element.filterValues?.named ?? null,
    titles: new Map([["DECK", "Main deck"]]),
  };
  const number = {
    key: "@number",
    type: "@number",
    title: "Number",
    numeric: true,
    quickAll: true,
    read: (element) => (Number.isFinite(element.number) ? element.number : null),
  };
  let aliases;

  beforeEach(() => {
    aliases = new Map([
      ["G", group],
      ["GB", { ...group, key: "source:group|opaque|beam", kinds: ["beam"] }],
      ["GQ", { ...group, key: "source:group|opaque|shell", kinds: ["shell"] }],
      ["SG", named],
      ["SGB", { ...named, key: "source:named|opaque|beam", kinds: ["beam"] }],
      ["N", number],
      ["B", { ...number, key: "@number|beam", kinds: ["beam"] }],
      ["Q", { ...number, key: "@number|shell", kinds: ["shell"] }],
      ["S", { ...number, key: "@number|spring", kinds: ["spring"] }],
    ]);
  });

  it("normalizes whitespace everywhere and reads compact ordered clauses", () => {
    const text = " + g 12 - 15 ; - q 1 ? ? 1 * ";
    expect(normalizeQuickFilter(text)).toBe("+g12-15;-q1??1*");
    expect(parseQuickFilter(text, aliases)).toEqual([
      { sign: "+", type: group.type, text: "12-15" },
      { sign: "-", type: "@number", kinds: ["shell"], text: "1??1*" },
    ]);
    // Whitespace cannot separate number terms in this language.
    expect(parseQuickFilter("G1 2,3", aliases)[0].text).toBe("12,3");
  });

  it("reads the complete selector code and uses colons for unquoted named expressions", () => {
    expect(parseQuickFilter('SG"DECK";SGB"DECK"', aliases)).toEqual([
      { sign: "+", type: named.type, text: '"DECK"' },
      { sign: "+", type: named.type, kinds: ["beam"], text: '"DECK"' },
    ]);
    expect(parseQuickFilter("SG:BEARING", aliases)).toEqual([
      { sign: "+", type: named.type, text: "BEARING" },
    ]);
    expect(() => parseQuickFilter("SGBEARING", aliases)).toThrowError(
      /unknown filter selector "SGBEARING"/,
    );
    expect(() => parseQuickFilter("SGDECK", aliases)).toThrowError(
      /unknown filter selector "SGDECK"/,
    );
    expect(() => parseQuickFilter("SG*", aliases)).toThrowError(/put a colon/);
    expect(() => parseQuickFilter("SG12", aliases)).toThrowError(/put a colon/);
    expect(() => parseQuickFilter("SGUNKNOWN:DECK", aliases)).toThrowError(
      /unknown filter selector "SGUNKNOWN"/,
    );
  });

  it("preserves quoted semicolons and JSON escapes as part of named expressions", () => {
    const escaped = JSON.stringify('A";B');
    const text = `SG"A;B";SG${escaped};-GB12`;
    expect(parseQuickFilter(text, aliases)).toEqual([
      { sign: "+", type: named.type, text: '"A;B"' },
      { sign: "+", type: named.type, text: escaped },
      { sign: "-", type: group.type, kinds: ["beam"], text: "12" },
    ]);
    const compiled = compileQuickFilter(text, aliases);
    expect(compiled.predicate({ kind: "beam", filterValues: { named: 'A";B' } })).toBe(true);
    expect(compiled.predicate({ kind: "beam", filterValues: { named: "A;B" } })).toBe(true);
    expect(compiled.predicate({ kind: "beam", filterValues: { named: "A" } })).toBe(false);
  });

  it("removes literal quoted whitespace while retaining encoded JSON escapes", () => {
    const compiled = compileQuickFilter('SG"A B"', aliases);
    expect(compiled.text).toBe('SG"AB"');
    expect(compiled.predicate({ kind: "beam", filterValues: { named: "AB" } })).toBe(true);
    expect(compiled.predicate({ kind: "beam", filterValues: { named: "A B" } })).toBe(false);
    const escaped = compileQuickFilter('SG"A\\u0020B"', aliases);
    expect(escaped.predicate({ kind: "beam", filterValues: { named: "A B" } })).toBe(true);
  });

  it("keeps named patterns, title matching and exact case-sensitive IDs", () => {
    expect(
      compileQuickFilter("SG:main*", aliases).predicate({
        kind: "beam",
        filterValues: { named: "DECK" },
      }),
    ).toBe(true);
    expect(
      compileQuickFilter("SG:deck", aliases).predicate({
        kind: "beam",
        filterValues: { named: "DECK" },
      }),
    ).toBe(true);
    expect(
      compileQuickFilter('SG"deck"', aliases).predicate({
        kind: "beam",
        filterValues: { named: "DECK" },
      }),
    ).toBe(false);
  });

  it("applies additions and subtractions in order with the first sign choosing the seed", () => {
    const elements = [
      { id: "b", kind: "beam", number: 1001, filterValues: { group: 12 } },
      { id: "q", kind: "shell", number: 1001, filterValues: { group: 12 } },
      { id: "t", kind: "truss", number: 1001, filterValues: { group: 16 } },
    ];
    const kept = (text) =>
      elements.filter(compileQuickFilter(text, aliases).predicate).map(({ id }) => id);
    expect(kept("G12-15;-Q1??1*")).toEqual(["b"]);
    expect(kept("-G12;+Q1001")).toEqual(["q", "t"]);
    expect(kept("+Q1001;-G12")).toEqual([]);
    expect(kept("GB12;+Q1001")).toEqual(["b", "q"]);
  });

  it("matches all values of a bare provider selector within its declared domain", () => {
    const predicate = compileQuickFilter("GB", aliases).predicate;
    expect(predicate({ kind: "beam", filterValues: { group: 1 } })).toBe(true);
    expect(predicate({ kind: "beam", filterValues: {} })).toBe(false);
    expect(predicate({ kind: "shell", filterValues: { group: 1 } })).toBe(false);
    const base = { ...group, kinds: ["beam"] };
    aliases.set("BASE", base);
    expect(parseQuickFilter("BASE", aliases)).toEqual([{ sign: "+", type: group.type, text: "" }]);
    expect(
      compileQuickFilter("BASE", aliases).predicate({ kind: "shell", filterValues: { group: 1 } }),
    ).toBe(false);
  });

  it("includes unnumbered core members for bare selectors but requires numbers for patterns", () => {
    const unnumbered = { kind: "beam" };
    expect(compileQuickFilter("B", aliases).predicate(unnumbered)).toBe(true);
    expect(compileQuickFilter("B:", aliases).predicate(unnumbered)).toBe(true);
    expect(compileQuickFilter("B,", aliases).predicate(unnumbered)).toBe(true);
    expect(compileQuickFilter("B1*", aliases).predicate(unnumbered)).toBe(false);
    expect(compileQuickFilter("B", aliases).predicate({ kind: "shell" })).toBe(false);
    expect(compileQuickFilter("N", aliases).predicate({ kind: "coupling" })).toBe(true);
    expect(compileQuickFilter("-B", aliases).predicate(unnumbered)).toBe(false);
    expect(compileQuickFilter("-B", aliases).predicate({ kind: "coupling" })).toBe(true);
  });

  it("disables the quick predicate for empty text and permits one trailing separator", () => {
    expect(parseQuickFilter(" \n \t ", aliases)).toEqual([]);
    expect(compileQuickFilter(null, aliases)).toEqual({ text: "", rules: [], predicate: null });
    expect(parseQuickFilter("G12;", aliases)).toEqual([
      { sign: "+", type: group.type, text: "12" },
    ]);
    expect(compileQuickFilter("G12; ", aliases).text).toBe("G12;");
  });

  it("rejects the whole query for unknown selectors, empty clauses or malformed expressions", () => {
    for (const text of [
      "X12",
      "G1;;Q2",
      ";G1",
      ";",
      "G1;X2",
      "G1;Qbad",
      'SG"A',
      'G1;SG"A\\x"',
      "G:1-",
      "++G1",
      "G1;-",
    ]) {
      expect(() => parseQuickFilter(text, aliases)).toThrowError(RangeError);
      expect(() => compileQuickFilter(text, aliases)).toThrowError(RangeError);
    }
    expect(() => parseQuickFilter("G1;Q:bad", aliases)).toThrowError(
      /Clause 2 \(Q\): "bad" is not a number/,
    );
    expect(() => parseQuickFilter('UNKNOWN"unterminated', aliases)).toThrowError(
      /unknown filter selector/,
    );
    const previous = compileQuickFilter("G12", aliases);
    expect(() => compileQuickFilter("G12;Qbad", aliases)).toThrowError();
    expect(previous.predicate({ kind: "beam", filterValues: { group: 12 } })).toBe(true);
  });

  it("copies scoped rule kinds without mutating aliases or exposing subject objects", () => {
    const rules = parseQuickFilter("GB12", aliases);
    rules[0].kinds.push("shell");
    expect(aliases.get("GB").kinds).toEqual(["beam"]);
    expect([...aliases.keys()]).toEqual(["G", "GB", "GQ", "SG", "SGB", "N", "B", "Q", "S"]);
    expect(Object.keys(rules[0])).toEqual(["sign", "type", "kinds", "text"]);
  });
});
