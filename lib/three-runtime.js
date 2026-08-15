function createThreeRuntimeLoader(importThree, importOrbitControls) {
  let runtimePromise = null;

  return function loadThreeRuntime() {
    runtimePromise ||= Promise.resolve()
      .then(() => Promise.all([importThree(), importOrbitControls()]))
      .then(([THREE, { OrbitControls }]) => ({ THREE, OrbitControls }))
      .catch((error) => {
        runtimePromise = null;
        throw error;
      });
    return runtimePromise;
  };
}

const loadThreeRuntime = createThreeRuntimeLoader(
  () => import("three"),
  () => import("three/addons/controls/OrbitControls.js"),
);

module.exports = { createThreeRuntimeLoader, loadThreeRuntime };
