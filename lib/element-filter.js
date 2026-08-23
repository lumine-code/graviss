// Which elements a user asked to see.
//
// Three questions, and they are separate because they come from different
// places: which numbers, which kinds, and which of the dimensions a source
// declared. A filter is the conjunction of whichever of them were asked - an
// unstated question does not narrow anything, so an empty filter is every
// element rather than none.

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

// Whether a filter expression can be read at all, for a field that has to say
// so while it is being typed rather than after it is submitted.
function isValidNumberFilter(text) {
  try {
    parseNumberFilter(text);
    return true;
  } catch {
    return false;
  }
}

// The facet values an element holds, as a list however it stated them.
function facetValuesOf(element, facetId) {
  const held = element.facetValues?.[facetId];
  if (held == null) return [];
  return Array.isArray(held) ? held : [held];
}

// One predicate over elements, from whichever parts of a filter were stated.
//
// `kinds` and `facets` are stated as what to KEEP. A facet with no values
// chosen is a facet nobody narrowed by, which is not the same as one that
// admits nothing - the difference is what makes a fresh panel show the whole
// model instead of an empty one.
//
// Numbers and facets answer the absent case differently, and they should. A
// number is an identity every numbered element shares, so an element with no
// number is not any of the numbers asked for. A facet is a classification a
// source applied to whatever part of the model it describes, so an element it
// was never applied to is not something that question was about.
function createElementFilter(filter = {}) {
  const tests = [];

  const numbers = parseNumberFilter(filter.numbers);
  if (numbers) tests.push((element) => numbers(element.number));

  if (Array.isArray(filter.kinds) && filter.kinds.length) {
    const kinds = new Set(filter.kinds);
    tests.push((element) => kinds.has(element.kind));
  }

  for (const [facetId, values] of Object.entries(filter.facets || {})) {
    if (!Array.isArray(values) || !values.length) continue;
    const wanted = new Set(values.map((value) => `${typeof value}:${value}`));
    tests.push((element) => {
      // A dimension an element is not placed on does not narrow it. A source
      // declares a facet over whatever part of the model it describes - the
      // geometric entity a member was meshed from says nothing about an area
      // element - so narrowing by one would otherwise take out every element
      // the dimension was never about in the first place.
      const held = facetValuesOf(element, facetId);
      if (!held.length) return true;
      return held.some((value) => wanted.has(`${typeof value}:${value}`));
    });
  }

  if (!tests.length) return null;
  return (element) => tests.every((test) => test(element));
}

// Whether a filter narrows anything at all. A viewer asks so it can skip the
// work of applying one, and so it can say whether what is on screen is the
// whole model.
function isEmptyFilter(filter) {
  return createElementFilter(filter) === null;
}

module.exports = {
  createElementFilter,
  facetValuesOf,
  isEmptyFilter,
  isValidNumberFilter,
  parseNumberFilter,
};
