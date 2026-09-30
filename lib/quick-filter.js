const { compileStep, parseNameFilter, parseNumberFilter, startsWhole } = require("./filter-rules");

// Whitespace has no meaning in the quick language, including inside quoted
// names. The advanced expression parser remains unchanged.
function normalizeQuickFilter(text) {
  return String(text ?? "").replace(/\s+/g, "");
}

function splitClauses(text) {
  const clauses = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted && character === "\\") index += 1;
    else if (character === '"') quoted = !quoted;
    else if (!quoted && character === ";") {
      clauses.push(text.slice(start, index));
      start = index + 1;
    }
  }
  clauses.push(text.slice(start));
  // A final separator is useful while the next clause is being started. An
  // empty clause anywhere else would silently drop part of the user's query.
  if (clauses.at(-1) === "") clauses.pop();
  return clauses;
}

function parseClauses(value, aliases) {
  const text = normalizeQuickFilter(value);
  if (!text) return { text, rules: [], subjects: [], whole: [] };
  const rules = [];
  const subjects = [];
  const whole = [];
  for (const [index, clause] of splitClauses(text).entries()) {
    const at = `Clause ${index + 1}`;
    if (!clause) throw new RangeError(`${at}: enter a selector between separators.`);
    const signed = clause[0] === "+" || clause[0] === "-";
    const sign = signed ? clause[0] : "+";
    const body = signed ? clause.slice(1) : clause;
    const letters = /^[a-z]+/i.exec(body)?.[0] ?? "";
    if (!letters) throw new RangeError(`${at}: start with a filter selector code.`);
    const explicit = body[letters.length] === ":";
    const code = letters.toUpperCase();
    const subject = aliases.get(code);
    if (!subject) throw new RangeError(`${at}: unknown filter selector "${code}".`);
    const expression = body.slice(code.length + (explicit ? 1 : 0));
    if (!subject.numeric && expression && !explicit && expression[0] !== '"') {
      throw new RangeError(`${at} (${code}): put a colon before an unquoted named expression.`);
    }
    let match;
    try {
      match = subject.numeric
        ? parseNumberFilter(expression)
        : parseNameFilter(expression, subject);
    } catch (error) {
      throw new RangeError(`${at} (${code}): ${error.message}`, { cause: error });
    }
    rules.push({
      sign,
      type: subject.type,
      ...(subject.key !== subject.type && subject.kinds?.length
        ? { kinds: [...subject.kinds] }
        : {}),
      text: expression,
    });
    subjects.push(subject);
    whole.push(match == null);
  }
  return { text, rules, subjects, whole };
}

function parseQuickFilter(text, aliases) {
  return parseClauses(text, aliases).rules;
}

function compileQuickFilter(text, aliases) {
  const parsed = parseClauses(text, aliases);
  const { rules, subjects, whole } = parsed;
  if (!rules.length) return { text: parsed.text, rules, predicate: null };
  const steps = rules.map((rule, index) => {
    const subject = subjects[index];
    if (!subject.quickAll || !whole[index]) return compileStep(rule, subject);
    // Core number aliases also name unnumbered members when used without an
    // expression. Their domain comes from the alias, never from an ID prefix.
    const domain = subject.kinds?.length ? new Set(subject.kinds) : null;
    return {
      add: rule.sign !== "-",
      select: (element) => !domain || domain.has(element.kind),
    };
  });
  const start = startsWhole(rules);
  return {
    text: parsed.text,
    rules,
    predicate(element) {
      let kept = start;
      for (const step of steps) if (step.select(element)) kept = step.add;
      return kept;
    },
  };
}

module.exports = { compileQuickFilter, normalizeQuickFilter, parseQuickFilter };
