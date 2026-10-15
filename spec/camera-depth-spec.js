const { GravissRenderer } = require("../lib/renderer");
const { loadThreeRuntime } = require("../lib/three-runtime");

describe("Graviss camera clipping depth", () => {
  let THREE;
  beforeAll(async () => {
    ({ THREE } = await loadThreeRuntime());
  });

  for (const projection of ["perspective", "orthographic"]) {
    it(`keeps the near corner of a long model in an oblique ${projection} view`, () => {
      const renderer = Object.create(GravissRenderer.prototype);
      renderer.THREE = THREE;
      renderer.sceneBox = new THREE.Box3(
        new THREE.Vector3(-31, -2.5, -4.1),
        new THREE.Vector3(31, 2.5, 4.1),
      );
      renderer.bounds = { radius: renderer.sceneBox.getBoundingSphere(new THREE.Sphere()).radius };
      renderer.controls = { target: new THREE.Vector3() };
      renderer.camera =
        projection === "perspective"
          ? new THREE.PerspectiveCamera(42, 1.5)
          : new THREE.OrthographicCamera(-45, 45, 30, -30);
      renderer.camera.up.set(0, 0, 1);
      renderer.camera.position.set(-25.3, -39, 31.2);
      renderer.camera.lookAt(renderer.controls.target);
      renderer.camera.updateMatrixWorld(true);
      renderer.updateDepthRange();
      for (const x of [-31, 31])
        for (const y of [-2.5, 2.5])
          for (const z of [-4.1, 4.1]) {
            const point = new THREE.Vector3(x, y, z);
            const depth = -point.clone().applyMatrix4(renderer.camera.matrixWorldInverse).z;
            expect(renderer.camera.near).toBeLessThan(depth);
            expect(renderer.camera.far).toBeGreaterThan(depth);
            expect(point.project(renderer.camera).z).toBeGreaterThanOrEqual(-1);
          }
      expect(renderer.updateDepthRange()).toBe(false);
    });
  }
});
