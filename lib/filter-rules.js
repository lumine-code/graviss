// Which elements a user asked to see, as an ordered list of signed rules.
//
// A rule is a sign, a dimension, and an expression naming values of it:
//
//   + Group          11,12,21-29
//   - Number (shells) 110001
//   + Group (trusses) 31
//
// They are applied in order and the last rule that names an element decides it,
// so the list reads the way a person builds a selection - take these, drop that
// one, put those back. It is also how the sources themselves store a selection:
// a SOFiSTiK secondary group is a list band followed by add bands and subtract
// bands, applied in that order.
//
// The list expresses union and difference and never intersection. "Group 11"
// then "trusses" is group eleven OR every truss, not the trusses of group
// eleven; the one conjunction that actually comes up - a dimension narrowed to
// one element kind - is carried by the rule's own `kinds`, which is what
// "Group (trusses)" is.

// The number expression, in the spelling every FEM tool writes it in:
//
//   1-10      a range, ends included
//   15        one number
//   1*        anything that starts with 1
//   11??      eleven followed by exactly two more digits
//
// separated by commas or whitespace. A term nobody can read is refused rather
// than ignored, because a filter that silently means something else is worse
// than one that says it cannot be read.
const RANGE = /^(\d+)\s*-\s*(\d+)$/;
const LITERAL = /^\d+$/;
const GLOB = /^[\d?]*\*?[\d?]*$/;

function parseNumberFilter(text) {
  const terms = String(text ?? "")
    // A range written with room around its dash is one term, not three. Closing
    // that gap first is what lets whitespace separate terms at all.
    .replace(/\s*-\s*/g, "-")
    .split(/[,\s]+/)
    .filter(Boolean);
  if (!terms.length) return null;
  const tests = terms.map((term) => parseTerm(term));
  return (number) => Number.isFinite(number) && tests.some((test) => test(number));
}

function parseTerm(term) {
  const range = RANGE.exec(term);
  if (range) {
    const low = Number(range[1]);
    const high = Number(range[2]);
    // Written the other way round is still a range; nobody means the empty set.
    const from = Math.min(low, high);
    const to = Math.max(low, high);
    return (number) => number >= from && number <= to;
  }
  if (LITERAL.test(term)) {
    const value = Number(term);
    return (number) => number === value;
  }
  if (GLOB.test(term) && /[*?]/.test(term)) {
    // `?` is one digit and `*` is any run of them, including none. Matched
    // against the number as written, which is what a user is looking at.
    const pattern = new RegExp(`^${term.replace(/\?/g, "\\d").replace(/\*/g, "\\d*")}$`);
    return (number) => pattern.test(String(number));
  }
  throw new RangeError(`"${term}" is not a number, a range, or a pattern of digits.`);
}

// Values named rather than numbered - a secondary group called `PP`, a material
// called `C30`. The same `*` and `?` as the number expression, and a title
// counts as a name because nobody types an id they were never shown.
//
// Case-insensitive, and it never throws: every string is a legal name term, so
// only a numeric dimension can produce a rule nobody can read.
function parseNameFilter(text, subject) {
  const terms = String(text ?? "")
    .split(/[,\s]+/)
    .filter(Boolean);
  if (!terms.length) return null;
  const tests = terms.map((term) => {
    const pattern = new RegExp(
      `^${term
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\\\?/g, ".")
        .replace(/\\\*/g, ".*")}$`,
      "i",
    );
    return (value) => {
      if (pattern.test(String(value))) return true;
      const title = subject?.titles?.get(String(value));
      return Boolean(title) && pattern.test(title);
    };
  });
  return (value) => tests.some((test) => test(value));
}

// Whether an expression can be read at all, for a row that has to say so while
// it is being typed rather than after it is submitted.
function isValidNumberFilter(text) {
  try {
    parseNumberFilter(text);
    return true;
  } catch {
    return false;
  }
}

function isReadableExpression(text, subject) {
  if (!subject?.numeric) return true;
  return isValidNumberFilter(text);
}

// Which dimension a rule is about, including the kind it was narrowed to. The
// same string `buildSubjects` keys its map by.
function subjectKey(rule) {
  if (!rule?.type) return "";
  if (!rule.kinds?.length) return rule.type;
  return `${rule.type}|${[...rule.kinds].sort().join("|")}`;
}

// A rule counts once it names a dimension. A row with nothing chosen yet is not
// a question, which is what lets "Add rule" put one on the screen without the
// model moving underneath it.
function countingRules(rules) {
  return (rules ?? []).filter((rule) => typeof rule?.type === "string" && rule.type.length > 0);
}

const NEVER = () => false;

// One rule, as the set it names and the answer it gives about that set.
//
// A dimension this model has not got and an expression nobody can read are the
// same answer: the rule names no element. That is the same thing as leaving the
// rule out, which is what keeps the start rule below free of special cases -
// but the rule is still there, still counts for the start, and the row says so.
function compileStep(rule, subject) {
  const add = rule.sign !== "-";
  if (!subject) return { add, select: NEVER, resolved: false, readable: true };
  let match;
  try {
    match = subject.numeric ? parseNumberFilter(rule.text) : parseNameFilter(rule.text, subject);
  } catch {
    return { add, select: NEVER, resolved: true, readable: false };
  }
  const domain = subject.kinds?.length ? new Set(subject.kinds) : null;
  const read = subject.read;
  return {
    add,
    resolved: true,
    readable: true,
    select(element) {
      // Outside the dimension's own kinds this rule is not about the element at
      // all, and says nothing about it in either direction.
      if (domain && !domain.has(element.kind)) return false;
      const held = read(element);
      // In the domain but holding no value is a miss, not a match. A blank
      // expression is the union of every value that could have been listed, so
      // "Group" with nothing typed is every grouped element and not the
      // ungrouped ones beside them.
      if (held == null) return false;
      if (!match) return true;
      return Array.isArray(held) ? held.some(match) : match(held);
    },
  };
}

// The whole list, as one predicate - or nothing at all, which is the whole
// model and the same answer an unfiltered viewer has always given.
function compileRules(rules, subjects) {
  const counting = countingRules(rules);
  if (!counting.length) return null;
  const steps = counting.map((rule) => compileStep(rule, subjects?.get(subjectKey(rule))));
  const start = startsWhole(counting);
  return (element) => {
    let kept = start;
    for (let index = 0; index < steps.length; index += 1) {
      if (steps[index].select(element)) kept = steps[index].add;
    }
    return kept;
  };
}

// Where the fold begins. A list that opens by adding starts from nothing and
// builds up; one that opens by taking away starts from the whole model and cuts
// it down. Both leading characters then carry information - seed always-whole
// and a leading `+` says nothing, seed always-empty and a leading `-` blanks
// the screen.
//
// Read from the first rule AS WRITTEN, whether or not its dimension exists in
// this model and whether or not its expression can be read. Seeding from the
// first rule that happened to compile would turn an additive list into a
// subtractive one the moment a document was opened against the wrong database,
// and show the complement of what was asked for.
function startsWhole(rules) {
  const counting = countingRules(rules);
  return counting.length === 0 || counting[0].sign === "-";
}

// How many elements each rule names, and how many survive the whole list.
//
// `named[i]` is the size of rule i's own set, not its net contribution: a net
// figure is meaningless once a later rule overrules it, and it would flicker as
// rows are dragged. Nought is the direct diagnosis of a typo.
function countRules(elements, rules, subjects) {
  const counting = countingRules(rules);
  const steps = counting.map((rule) => compileStep(rule, subjects?.get(subjectKey(rule))));
  const start = startsWhole(counting);
  const named = new Array(steps.length).fill(0);
  let shown = 0;
  for (const element of elements) {
    let kept = start;
    for (let index = 0; index < steps.length; index += 1) {
      if (!steps[index].select(element)) continue;
      named[index] += 1;
      kept = steps[index].add;
    }
    if (kept) shown += 1;
  }
  return { named, shown, total: elements.length, steps };
}

module.exports = {
  compileRules,
  compileStep,
  countRules,
  countingRules,
  isReadableExpression,
  isValidNumberFilter,
  parseNameFilter,
  parseNumberFilter,
  startsWhole,
  subjectKey,
};
