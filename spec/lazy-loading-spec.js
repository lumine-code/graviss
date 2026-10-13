const { createRequire } = require("node:module");
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

  it("shares a renderer import and retries with its CommonJS default after failure", async () => {
    const failure = new Error("Renderer import failed");
    const renderer = { GravissRenderer: class {} };
    const importRenderer = jasmine
      .createSpy("importRenderer")
      .and.returnValues(Promise.reject(failure), Promise.resolve({ default: renderer }));
    const loadRenderer = createRendererLoader(importRenderer);
    const failed = loadRenderer();
    expect(loadRenderer()).toBe(failed);
    await expectAsync(failed).toBeRejectedWith(failure);
    const retry = loadRenderer();

    expect(retry).not.toBe(failed);
    expect(loadRenderer()).toBe(retry);
    await expectAsync(retry).toBeResolvedTo(renderer);
    expect(importRenderer).toHaveBeenCalledTimes(2);
  });

  it("loads the active renderer constructor through the native async import", async () => {
    const currentRequire = createRequire(__filename);
    const { loadRenderer } = currentRequire("../lib/renderer-loader");
    const first = loadRenderer();
    expect(loadRenderer()).toBe(first);
    const loaded = await first;
    const renderer = currentRequire("../lib/renderer");

    expect(loaded.GravissRenderer).toBe(renderer.GravissRenderer);
    expect(loaded.DEFAULT_VISIBILITY).toBe(renderer.DEFAULT_VISIBILITY);
    expect(typeof loaded.GravissRenderer.create).toBe("function");
  });

  it("creates a new renderer load after package unload while sharing installed Three.js", async () => {
    const currentRequire = createRequire(__filename);
    await lumine.packages.activatePackage("graviss");
    const firstLoader = currentRequire("../lib/renderer-loader");
    const firstPromise = firstLoader.loadRenderer();
    const firstRenderer = await firstPromise;
    const firstRuntime = await currentRequire("../lib/three-runtime").loadThreeRuntime();
    await lumine.packages.unloadPackage("graviss");
    await lumine.packages.activatePackage("graviss");
    const secondLoader = currentRequire("../lib/renderer-loader");
    const secondPromise = secondLoader.loadRenderer();
    const secondRenderer = await secondPromise;
    const secondRuntime = await currentRequire("../lib/three-runtime").loadThreeRuntime();

    expect(secondLoader).not.toBe(firstLoader);
    expect(secondPromise).not.toBe(firstPromise);
    expect(secondLoader.loadRenderer()).toBe(secondPromise);
    expect(secondRenderer.GravissRenderer).not.toBe(firstRenderer.GravissRenderer);
    expect(secondRenderer.GravissRenderer).toBe(currentRequire("../lib/renderer").GravissRenderer);
    expect(firstLoader.loadRenderer()).toBe(firstPromise);
    expect(secondRuntime.THREE.Mesh).toBe(firstRuntime.THREE.Mesh);
    expect(secondRuntime.OrbitControls).toBe(firstRuntime.OrbitControls);
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

  it("loads every addon against the same native ESM Three.js constructors", async () => {
    // Earlier lifecycle suites may have unloaded the module generation used
    // while this spec was declared. Resolve the runtime that is active now.
    const { loadThreeRuntime } = createRequire(__filename)("../lib/three-runtime");
    const [{ THREE, OrbitControls, LineSegments2, LineSegmentsGeometry, LineMaterial }, imported] =
      await Promise.all([loadThreeRuntime(), import("three")]);

    expect(THREE.Object3D).toBe(imported.Object3D);
    expect(Object.getPrototypeOf(OrbitControls.prototype)).toBe(THREE.Controls.prototype);
    expect(Object.getPrototypeOf(LineSegments2.prototype)).toBe(THREE.Mesh.prototype);
    expect(Object.getPrototypeOf(LineSegmentsGeometry.prototype)).toBe(
      THREE.InstancedBufferGeometry.prototype,
    );
    expect(Object.getPrototypeOf(LineMaterial.prototype)).toBe(THREE.ShaderMaterial.prototype);
  });
});
