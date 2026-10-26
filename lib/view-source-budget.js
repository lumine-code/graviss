const MAX_SOURCE_UNITS = 8 * 1024 * 1024;
const MAX_JSON_UNITS = 64 * 1024 * 1024;
const MAX_VALUES = 100000;
const { types } = require("node:util");

function sourceLimitError() {
  return Object.assign(
    new RangeError(
      "The Graviss configuration exceeds the view source budget (8 Mi UTF-16 text, 100,000 values, 128 nesting levels). Open it as text to inspect or edit its complete contents; geometry belongs in the external model source.",
    ),
    { code: "ERR_GRAVISS_SOURCE_LIMIT" },
  );
}

function readSource(buffer) {
  if (!buffer.canMaterializeText(MAX_SOURCE_UNITS)) throw sourceLimitError();
  return buffer.getText();
}

// Bound both native JSON expansion and object traversal before the next value
// is emitted. Configuration snapshots are JSON; arbitrary source text remains
// in the native buffer and never passes through this serializer.
function stringify(value, space = 0) {
  if (!Number.isInteger(space) || space < 0 || space > 10)
    throw new TypeError("JSON indentation must be an integer from 0 to 10");
  let units = 0,
    values = 0;
  const ancestors = [];
  return JSON.stringify(
    value,
    function (key, item) {
      // JSON unboxes these values after the replacer. Do it before inspecting
      // keys, since a boxed string exposes one enumerable key per character.
      if (types.isStringObject(item)) item = String(item);
      else if (types.isNumberObject(item)) item = +item;
      else if (types.isBooleanObject(item)) item = Boolean.prototype.valueOf.call(item);
      while (ancestors.length && ancestors.at(-1) !== this) ancestors.pop();
      if (++values > MAX_VALUES || ancestors.length > 128) throw sourceLimitError();
      units += 32 + ancestors.length * space * 2 + (typeof item === "string" ? item.length * 6 : 0);
      if (item && typeof item === "object") {
        if (Array.isArray(item)) {
          if (item.length > MAX_VALUES) throw sourceLimitError();
        } else {
          const keys = Object.keys(item);
          if (keys.length > MAX_VALUES) throw sourceLimitError();
          for (const name of keys) units += name.length * 6 + 8;
        }
        ancestors.push(item);
      }
      if (units > MAX_JSON_UNITS) throw sourceLimitError();
      return item;
    },
    space,
  );
}

module.exports = { MAX_SOURCE_UNITS, readSource, sourceLimitError, stringify };
