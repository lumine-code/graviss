function fail(message) {
  throw new TypeError(`Invalid Graviss model: ${message}`);
}

function isObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isId(value) {
  return (
    (typeof value === "string" && value.length > 0) ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function assertId(value, location) {
  if (!isId(value)) fail(`${location} must be a non-empty string or finite number`);
}

function validateSession(session) {
  if (!isObject(session)) fail("source session must be an object");
  for (const method of ["describe", "getGeometry", "dispose"]) {
    if (typeof session[method] !== "function") {
      fail(`source session must implement ${method}()`);
    }
  }
  for (const method of ["onDidChange", "getLoadCases", "getResult"]) {
    if (session[method] != null && typeof session[method] !== "function") {
      fail(`source session ${method} must be a function when supplied`);
    }
  }
  return session;
}

function validateSourceProvider(provider) {
  if (!isObject(provider)) fail("a graviss.source provider must be an object");
  assertId(provider.id, "provider.id");
  if (typeof provider.createSession !== "function") {
    fail("a graviss.source provider must implement createSession()");
  }
  return provider;
}

module.exports = { fail, isObject, isId, assertId, validateSession, validateSourceProvider };
