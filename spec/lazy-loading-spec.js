const { createRendererLoader } = require("../lib/renderer-loader");
const { createThreeRuntimeLoader } = require("../lib/three-runtime");

describe("lazy rendering dependencies", () => {
  it("does not request the renderer module until a model is ready", async () => {
    const importRenderer = jasmine
      .createSpy("importRenderer")
      .and.resolveTo({ GravissRenderer: class {} });
    const loadRenderer = createRendererLoader(importRenderer);

    expect(importRenderer).not.toHaveBeenCalled();

    const firstLoad = loadRenderer();
    const secondLoad = loadRenderer();
    expect(firstLoad).toBe(secondLoad);
    expect(importRenderer).not.toHaveBeenCalled();

    await firstLoad;
    expect(importRenderer).toHaveBeenCalledTimes(1);
  });

  it("imports Three.js and OrbitControls only on first renderer creation", async () => {
    const THREE = { Scene: class {} };
    class OrbitControls {}
    const importThree = jasmine.createSpy("importThree").and.resolveTo(THREE);
    const importOrbitControls = jasmine
      .createSpy("importOrbitControls")
      .and.resolveTo({ OrbitControls });
    const loadThreeRuntime = createThreeRuntimeLoader(importThree, importOrbitControls);

    expect(importThree).not.toHaveBeenCalled();
    expect(importOrbitControls).not.toHaveBeenCalled();

    const firstLoad = loadThreeRuntime();
    const secondLoad = loadThreeRuntime();
    expect(firstLoad).toBe(secondLoad);
    expect(importThree).not.toHaveBeenCalled();
    expect(importOrbitControls).not.toHaveBeenCalled();
    await expectAsync(firstLoad).toBeResolvedTo({ THREE, OrbitControls });
    expect(importThree).toHaveBeenCalledTimes(1);
    expect(importOrbitControls).toHaveBeenCalledTimes(1);
  });
});
