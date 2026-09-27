function createThreeRuntimeLoader(importThree, importOrbitControls, importWideLines = () => ({})) {
  let runtimePromise = null;

  return function loadThreeRuntime() {
    runtimePromise ||= Promise.resolve()
      .then(() => Promise.all([importThree(), importOrbitControls(), importWideLines()]))
      .then(([THREE, { OrbitControls }, wideLines]) => ({ THREE, OrbitControls, ...wideLines }))
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
  () =>
    Promise.all([
      import("three/addons/lines/LineSegments2.js"),
      import("three/addons/lines/LineSegmentsGeometry.js"),
      import("three/addons/lines/LineMaterial.js"),
    ]).then(([{ LineSegments2 }, { LineSegmentsGeometry }, { LineMaterial }]) => ({
      LineSegments2,
      LineSegmentsGeometry,
      LineMaterial,
    })),
);

module.exports = { createThreeRuntimeLoader, loadThreeRuntime };
