// The dimensions a model can be narrowed by, and the entries the panel's
// dropdown offers for them.
//
// Two of them are Graviss's own, because two facts about an element are in the
// contract and so belong to no provider: what kind of thing it is, and the
// number the source knows it by. Everything else - groups, secondary groups,
// the axis a member was generated along - is declared by whoever read the file,
// and Graviss never parses a type id. `group:truss` would pass through here as
// ten opaque characters.
//
// An id beginning with `@` is reserved to the two below, which is what lets a
// provider's ids and Graviss's own share one namespace without a collision
// nobody could have predicted.

const KIND_TITLES = Object.freeze({
  beam: "Beams",
  truss: "Trusses",
  cable: "Cables",
  shell: "Shells",
  spring: "Springs",
  coupling: "Couplings",
});

// Which colour in the scheme stands for each kind. A beam is drawn in the
// member colour the scheme names rather than one of its own, so the mapping is
// not the identity and has to be written down.
const KIND_COLORS = Object.freeze({
  beam: "element",
  truss: "truss",
  cable: "cable",
  shell: "shell",
  spring: "spring",
  coupling: "coupling",
});

const KIND_ORDER = Object.freeze(["beam", "truss", "cable", "shell", "spring", "coupling"]);

const BUILT_IN_TYPES = Object.freeze([
  Object.freeze({
    id: "@kind",
    title: "Kind",
    // Never numeric: a kind is named, not numbered, and the six words are the
    // contract's own. `element.kind` is always there, so the blank case never
    // arises and the expression always carries the answer.
    read: (element) => element.kind ?? null,
    kindValues: true,
  }),
  Object.freeze({
    id: "@number",
    title: "Number",
    numeric: true,
    hint: "1-10, 15, 1*, 11??",
    // The element's own number in the source, which is what a user types when
    // they ask for elements 110001 to 110200. An element the source numbered
    // nothing - a coupling keyed on its node - holds no value here, and so is
    // neither added nor removed by a question about numbers.
    read: (element) => (Number.isFinite(element.number) ? element.number : null),
  }),
]);

// One entry in the dropdown: a dimension, optionally narrowed to a single
// element kind.
//
// The kind-narrowed variants are generated rather than declared, from the kinds
// the model actually holds within the dimension's own domain - so a model of
// nothing but beams offers no "(beams)" variant, because narrowing to it would
// say nothing. This is where the user's `group:all` / `group:truss` / `quad:id`
// vocabulary comes from without a provider having to enumerate the product.
function buildSubjects(geometry) {
  const elements = geometry?.elements ?? [];
  const declared = geometry?.filterTypes ?? [];
  const kindsPresent = new Set(elements.map((element) => element.kind));
  const subjects = [];

  for (const type of [...BUILT_IN_TYPES, ...declared]) {
    const base = describeSubject(type, null, elements, kindsPresent);
    subjects.push(base);
    // `@kind` narrowed to a kind is a rule that can only agree with itself.
    if (type.kindValues) continue;
    const held = kindsHolding(type, base, elements, kindsPresent);
    if (held.length < 2) continue;
    for (const kind of held) subjects.push(describeSubject(type, kind, elements, kindsPresent));
  }
  return subjects;
}

// Which kinds actually hold a value for this dimension. Fewer than two and a
// variant would be either impossible or the same question as the base.
function kindsHolding(type, base, elements, kindsPresent) {
  const domain = type.kinds?.length
    ? type.kinds.filter((kind) => kindsPresent.has(kind))
    : [...kindsPresent];
  const held = new Set();
  for (const element of elements) {
    if (held.size === domain.length) break;
    if (!domain.includes(element.kind)) continue;
    if (base.read(element) != null) held.add(element.kind);
  }
  return KIND_ORDER.filter((kind) => held.has(kind));
}

function describeSubject(type, kind, elements, kindsPresent) {
  const kinds = kind
    ? [kind]
    : type.kinds?.length
      ? type.kinds.filter((name) => kindsPresent.has(name))
      : null;
  const read = type.read ?? ((element) => element.filterValues?.[type.id] ?? null);
  const titles = new Map();
  for (const value of type.values ?? []) {
    if (value.title) titles.set(String(value.id), value.title);
  }
  const values = type.kindValues
    ? KIND_ORDER.filter((name) => kindsPresent.has(name)).map((name) => ({
        id: name,
        title: KIND_TITLES[name],
      }))
    : (type.values ?? []);
  if (type.kindValues) for (const value of values) titles.set(String(value.id), value.title);

  return {
    key: kind ? `${type.id}|${kind}` : type.id,
    type: type.id,
    // The dimension, and the kind it was narrowed to, said the way a person
    // would read it back: "Group (trusses)".
    title: kind ? `${type.title} (${KIND_TITLES[kind].toLowerCase()})` : type.title,
    kinds,
    numeric: Boolean(type.numeric),
    multiple: Boolean(type.multiple),
    hint: type.hint ?? null,
    // Only a subject that resolves to exactly one kind has a colour to show,
    // which is what the row's swatch is for.
    color: kinds?.length === 1 ? KIND_COLORS[kinds[0]] : null,
    read,
    titles,
    values,
  };
}

function subjectsByKey(subjects) {
  return new Map(subjects.map((subject) => [subject.key, subject]));
}

module.exports = {
  BUILT_IN_TYPES,
  KIND_COLORS,
  KIND_ORDER,
  KIND_TITLES,
  buildSubjects,
  subjectsByKey,
};
