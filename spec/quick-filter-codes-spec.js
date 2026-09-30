const { buildSubjects } = require("../lib/filter-types");
const { compileStep } = require("../lib/filter-rules");
const {
  KIND_CODES,
  buildQuickFilterAliases,
  validateQuickFilterCodes,
} = require("../lib/quick-filter-codes");

describe("quick-filter code registry", () => {
  it("keeps the six FE kind codes fixed and supplies bare selectors without inventing numbers", () => {
    expect(Object.isFrozen(KIND_CODES)).toBe(true);
    expect(KIND_CODES).toEqual({
      B: "beam",
      Q: "shell",
      T: "truss",
      C: "cable",
      S: "spring",
      K: "coupling",
    });
    const aliases = buildQuickFilterAliases({ elements: [{ kind: "coupling" }] });
    expect([...aliases.keys()]).toEqual(["N", "B", "Q", "T", "C", "S", "K"]);
    expect(aliases.get("N").kinds).toBeNull();
    expect(aliases.get("N").quickAll).toBe(true);
    expect(aliases.get("N").read({ number: 123 })).toBe(123);
    expect(aliases.get("N").read({ kind: "coupling" })).toBeNull();
    for (const [code, kind] of Object.entries(KIND_CODES)) {
      const subject = aliases.get(code);
      expect(subject.key).toBe(`@number|${kind}`);
      expect(subject.kinds).toEqual([kind]);
      expect(subject.quickAll).toBe(true);
      expect(subject.numeric).toBe(true);
      expect(subject.read({ number: 123 })).toBe(123);
      expect(subject.title.toLowerCase()).toContain(kind);
    }
  });

  it("never derives a provider code from its id or title", () => {
    const geometry = {
      elements: [{ kind: "beam", filterValues: { group: 11 } }],
      filterTypes: [{ id: "group", title: "Group", numeric: true }],
    };
    const subjects = buildSubjects(geometry);
    expect(buildQuickFilterAliases(geometry, subjects).has("G")).toBe(false);
    expect(() => validateQuickFilterCodes(geometry.filterTypes)).not.toThrow();
  });

  it("normalizes lowercase and multiletter codes without mutating source metadata or subjects", () => {
    const geometry = {
      elements: [{ kind: "beam", filterValues: { selections: ["DECK"] } }],
      filterTypes: [
        { id: "selections", title: "Selections", quickFilterCode: "sG", multiple: true },
      ],
    };
    const subjects = buildSubjects(geometry);
    const base = subjects.find(({ key }) => key === "selections");
    const aliases = buildQuickFilterAliases(geometry, subjects);
    const alias = aliases.get("SG");
    expect(alias).not.toBe(base);
    expect(alias.code).toBe("SG");
    expect(alias.title).toBe(base.title);
    expect(alias.read).toBe(base.read);
    expect(alias.multiple).toBe(true);
    expect(alias.numeric).toBe(false);
    expect("quickAll" in alias).toBe(false);
    expect(aliases.get("SGB").read).toBe(base.read);
    expect(geometry.filterTypes[0].quickFilterCode).toBe("sG");
    expect("code" in base).toBe(false);
  });

  it("creates a virtual GB subject for a single-kind dimension without changing the catalogue", () => {
    const geometry = {
      elements: [
        { kind: "beam", filterValues: { group: 11 } },
        { kind: "beam", filterValues: { group: 12 } },
      ],
      filterTypes: [
        { id: "group", title: "Group", numeric: true, quickFilterCode: "G", kinds: ["beam"] },
      ],
    };
    const subjects = buildSubjects(geometry);
    expect(subjects.some(({ key }) => key === "group|beam")).toBe(false);
    const alias = buildQuickFilterAliases(geometry, subjects).get("GB");
    expect(alias.key).toBe("group|beam");
    expect(alias.kinds).toEqual(["beam"]);
    expect(alias.title).toContain("beam");
    expect("quickAll" in alias).toBe(false);
    const step = compileStep({ sign: "+", text: "11" }, alias);
    expect(geometry.elements.map((element) => step.select(element))).toEqual([true, false]);
    expect(subjects.some(({ key }) => key === "group|beam")).toBe(false);
  });

  it("scopes all provider kind suffixes safely when no kinds were declared", () => {
    const geometry = {
      elements: Object.values(KIND_CODES).map((kind) => ({
        kind,
        filterValues: { group: 11 },
      })),
      filterTypes: [{ id: "group", title: "Group", numeric: true, quickFilterCode: "G" }],
    };
    const subjects = buildSubjects(geometry);
    const base = subjects.find(({ key }) => key === "group");
    const aliases = buildQuickFilterAliases(geometry, subjects);
    for (const [code, kind] of Object.entries(KIND_CODES)) {
      const alias = aliases.get(`G${code}`);
      expect(alias.key).toBe(`group|${kind}`);
      expect(alias.title).toContain(base.title);
      expect(alias.title.toLowerCase()).toContain(kind);
      expect(alias.read).toBe(base.read);
      expect(alias.numeric).toBe(true);
      expect(alias.kinds).toEqual([kind]);
      const step = compileStep({ sign: "+", text: "11" }, alias);
      for (const element of geometry.elements) {
        expect(step.select(element)).toBe(element.kind === kind);
      }
    }
  });

  it("intersects declared kinds with the model while preserving opaque type ids", () => {
    const id = "group:all|beam";
    const geometry = {
      elements: [
        { kind: "beam", filterValues: { [id]: 11 } },
        { kind: "shell", filterValues: { [id]: 11 } },
      ],
      filterTypes: [
        {
          id,
          title: "Opaque group",
          numeric: true,
          quickFilterCode: "G",
          kinds: ["beam", "truss"],
        },
      ],
    };
    const aliases = buildQuickFilterAliases(geometry, buildSubjects(geometry));
    expect(aliases.get("G").type).toBe(id);
    expect(aliases.get("GB").key).toBe(`${id}|beam`);
    expect(aliases.get("GB").type).toBe(id);
    expect(aliases.get("GB").read(geometry.elements[0])).toBe(11);
    expect(aliases.has("GQ")).toBe(false);
    expect(aliases.has("GT")).toBe(false);
  });

  it("keeps an opaque base id distinct from another dimension's generated panel key", () => {
    const geometry = {
      elements: [
        { kind: "beam", filterValues: { "group|beam": 1, group: 12 } },
        { kind: "beam", filterValues: { "group|beam": 2, group: 1 } },
        { kind: "shell", filterValues: { group: 12 } },
      ],
      filterTypes: [
        {
          id: "group|beam",
          title: "Opaque dimension",
          numeric: true,
          quickFilterCode: "H",
          kinds: ["beam"],
        },
        { id: "group", title: "Group", numeric: true, quickFilterCode: "G" },
      ],
    };
    const subjects = buildSubjects(geometry);
    expect(subjects.filter(({ key }) => key === "group|beam").length).toBe(2);
    const aliases = buildQuickFilterAliases(geometry, subjects);
    expect(aliases.get("H").type).toBe("group|beam");
    expect(aliases.get("H").title).toBe("Opaque dimension");
    const opaque = compileStep({ sign: "+", text: "1" }, aliases.get("H"));
    const scoped = compileStep({ sign: "+", text: "12" }, aliases.get("GB"));
    expect(geometry.elements.map((element) => opaque.select(element))).toEqual([
      true,
      false,
      false,
    ]);
    expect(geometry.elements.map((element) => scoped.select(element))).toEqual([
      true,
      false,
      false,
    ]);
  });

  it("rejects non-ASCII, empty and non-letter codes with their metadata location", () => {
    for (const quickFilterCode of ["", "1", "G1", "G_B", "G B", "Ł", 12, true]) {
      expect(() => validateQuickFilterCodes([{ quickFilterCode }], "filters")).toThrowError(
        RangeError,
        /filters\[0\]\.quickFilterCode.*ASCII letters/,
      );
    }
  });

  it("rejects reserved and duplicate codes case-insensitively", () => {
    for (const quickFilterCode of ["n", ...Object.keys(KIND_CODES)]) {
      expect(() => validateQuickFilterCodes([{ quickFilterCode }])).toThrowError(
        RangeError,
        /conflicts.*built-in codes/,
      );
    }
    expect(() =>
      validateQuickFilterCodes([{ quickFilterCode: "G" }, { quickFilterCode: "g" }]),
    ).toThrowError(RangeError, /conflicts at "G".*filterTypes\[0\]/);
  });

  it("reserves generated suffixes even for kinds absent from the source, in either order", () => {
    const base = { id: "group", quickFilterCode: "G", kinds: ["shell"] };
    for (const suffix of Object.keys(KIND_CODES)) {
      const other = { id: "other", quickFilterCode: `g${suffix.toLowerCase()}` };
      for (const types of [
        [base, other],
        [other, base],
      ]) {
        expect(() => validateQuickFilterCodes(types)).toThrowError(RangeError, /conflicts/);
      }
    }
    expect(() =>
      validateQuickFilterCodes([{ quickFilterCode: "SG" }, { quickFilterCode: "SGB" }]),
    ).toThrowError(RangeError, /conflicts at "SGB"/);
  });
});
