const { BUILT_IN_TYPES, KIND_COLORS, KIND_TITLES } = require("./filter-types");

const KIND_CODES = Object.freeze({
  B: "beam",
  Q: "shell",
  T: "truss",
  C: "cable",
  S: "spring",
  K: "coupling",
});

const CORE_CODES = Object.freeze(["N", ...Object.keys(KIND_CODES)]);
const CODE = /^[A-Za-z]+$/;

// A base code also claims every possible kind suffix. Reserving them even when
// a kind is absent keeps a source's vocabulary stable when its model grows.
function validateQuickFilterCodes(filterTypes, location = "geometry.filterTypes") {
  if (!Array.isArray(filterTypes)) {
    throw new RangeError(`${location} must be an array`);
  }
  const claimed = new Map(CORE_CODES.map((code) => [code, "Graviss's built-in codes"]));
  for (let index = 0; index < filterTypes.length; index += 1) {
    const supplied = filterTypes[index]?.quickFilterCode;
    if (supplied == null) continue;
    const at = `${location}[${index}].quickFilterCode`;
    if (typeof supplied !== "string" || !CODE.test(supplied)) {
      throw new RangeError(`${at} must contain one or more ASCII letters`);
    }
    const code = supplied.toUpperCase();
    for (const alias of [code, ...Object.keys(KIND_CODES).map((suffix) => code + suffix)]) {
      const previous = claimed.get(alias);
      if (previous) {
        throw new RangeError(
          `${at} ${JSON.stringify(code)} conflicts at ${JSON.stringify(alias)} with ${previous}`,
        );
      }
      claimed.set(alias, at);
    }
  }
}

// These subjects are virtual: the ordinary catalogue need not add a redundant
// "Group (beams)" entry to a model whose group dimension holds only beams.
function buildQuickFilterAliases(geometry, subjects = []) {
  const types = geometry?.filterTypes ?? [];
  validateQuickFilterCodes(types);
  // A generated panel key may equal another source's opaque base id. Index
  // only bases here so a kind variant cannot replace that dimension's reader.
  const byKey = new Map(
    subjects
      .filter((subject) => subject.key === subject.type)
      .map((subject) => [subject.key, subject]),
  );
  const numberType = BUILT_IN_TYPES.find(({ id }) => id === "@number");
  const declaredNumber = byKey.get("@number");
  const numbers = {
    key: "@number",
    type: "@number",
    title: numberType.title,
    kinds: null,
    numeric: true,
    multiple: false,
    hint: numberType.hint,
    titles: new Map(),
    values: [],
    ...declaredNumber,
    read: declaredNumber?.read ?? numberType.read,
  };
  const aliases = new Map([
    ["N", { ...numbers, kinds: null, title: "Element numbers", code: "N", quickAll: true }],
  ]);
  for (const [code, kind] of Object.entries(KIND_CODES)) {
    aliases.set(code, {
      ...numbers,
      key: `@number|${kind}`,
      kinds: [kind],
      title: KIND_TITLES[kind],
      color: KIND_COLORS[kind],
      code,
      quickAll: true,
    });
  }
  const present = new Set((geometry?.elements ?? []).map(({ kind }) => kind));
  for (const type of types) {
    if (type.quickFilterCode == null) continue;
    const base = byKey.get(type.id);
    if (!base) continue;
    const code = type.quickFilterCode.toUpperCase();
    const alias = { ...base, code };
    delete alias.quickAll;
    aliases.set(code, alias);
    const domain = new Set(type.kinds?.length ? type.kinds : present);
    for (const [suffix, kind] of Object.entries(KIND_CODES)) {
      if (!present.has(kind) || !domain.has(kind)) continue;
      aliases.set(code + suffix, {
        ...alias,
        key: `${type.id}|${kind}`,
        kinds: [kind],
        title: `${base.title} (${KIND_TITLES[kind].toLowerCase()})`,
        color: KIND_COLORS[kind],
        code: code + suffix,
      });
    }
  }
  return aliases;
}

module.exports = { KIND_CODES, buildQuickFilterAliases, validateQuickFilterCodes };
