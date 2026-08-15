function createRendererLoader(importRenderer) {
  let rendererModulePromise = null;

  return function loadRenderer() {
    rendererModulePromise ||= Promise.resolve()
      .then(importRenderer)
      .catch((error) => {
        rendererModulePromise = null;
        throw error;
      });
    return rendererModulePromise;
  };
}

const loadRenderer = createRendererLoader(() => require("./renderer"));

module.exports = { createRendererLoader, loadRenderer };
