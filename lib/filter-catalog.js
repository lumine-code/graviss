const { parseNameFilter, parseNumberFilter } = require("./filter-rules");

// A catalogue describes the model rather than the current filter. Each element
// contributes once to a value, even when its multi-value list repeats that id.
function buildValueCatalog(geometry, subject) {
  if (!subject || subject.type === "@number") return [];
  const entries = new Map();
  const add = (id, title = null) => {
    const key = String(id);
    let entry = entries.get(key);
    if (!entry) {
      entry = { id, key, title: title ?? subject.titles?.get(key) ?? "", count: 0 };
      const error = expressionError(expressionForValues([entry], subject), subject);
      entry.error = error;
      entry.selectable = !error;
      entries.set(key, entry);
    } else if (title) entry.title = title;
    return entry;
  };
  for (const value of subject.values ?? []) add(value.id, value.title);
  const kinds = subject.kinds?.length ? new Set(subject.kinds) : null;
  for (const element of geometry?.elements ?? []) {
    if (kinds && !kinds.has(element.kind)) continue;
    const held = subject.read(element);
    if (held == null) continue;
    const seen = new Set();
    for (const id of Array.isArray(held) ? held : [held]) {
      if (id == null || seen.has(String(id))) continue;
      seen.add(String(id));
      add(id).count += 1;
    }
  }
  return [...entries.values()].sort((a, b) =>
    subject.numeric
      ? Number(a.id) - Number(b.id)
      : a.key.localeCompare(b.key, undefined, { numeric: true }),
  );
}

function searchCatalog(entries, text) {
  const query = String(text ?? "")
    .trim()
    .toLocaleLowerCase();
  return query
    ? entries.filter((entry) => `${entry.key}\n${entry.title}`.toLocaleLowerCase().includes(query))
    : entries;
}

function expressionForValues(entries, subject) {
  return entries
    .map((entry) => (subject?.numeric ? String(entry.id) : JSON.stringify(String(entry.id))))
    .join(", ");
}

function expressionError(text, subject) {
  if (!subject) return null;
  try {
    if (subject.numeric) parseNumberFilter(text);
    else parseNameFilter(text, subject);
    return null;
  } catch (error) {
    return error.message;
  }
}

class FilterCatalog {
  clear() {
    this.geometry = null;
    this.subjects = null;
    this.entries = new Map();
  }

  get(geometry, subjects, subject) {
    if (!this.entries || geometry !== this.geometry || subjects !== this.subjects) {
      this.geometry = geometry;
      this.subjects = subjects;
      this.entries = new Map();
    }
    if (!this.entries.has(subject)) {
      this.entries.set(subject, buildValueCatalog(geometry, subject));
    }
    return this.entries.get(subject);
  }
}

module.exports = {
  FilterCatalog,
  buildValueCatalog,
  expressionError,
  expressionForValues,
  searchCatalog,
};
