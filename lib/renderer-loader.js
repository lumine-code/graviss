function createRendererLoader(importRenderer) {
  let rendererModulePromise = null;

  return function loadRenderer() {
    rendererModulePromise ||= Promise.resolve()
      .then(importRenderer)
      .then((rendererModule) => rendererModule.default ?? rendererModule)
      .catch((error) => {
        rendererModulePromise = null;
        throw error;
      });
    return rendererModulePromise;
  };
}

const loadRenderer = createRendererLoader(() => import("./renderer.js"));

module.exports = { createRendererLoader, loadRenderer };
