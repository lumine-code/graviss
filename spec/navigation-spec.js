const THREE = require("three");
const { APPEARANCE_IDS, appearanceDefinition } = require("../lib/appearance");
const {
  CAMERA_VIEW_IDS,
  CAMERA_VIEWS,
  cameraViewDefinition,
  cameraViewIdForDirection,
  orthographicFitHeight,
  perspectiveDistanceForHeight,
  perspectiveVisibleHeight,
  sphereFitDistance,
} = require("../lib/camera-navigation");
const {
  UP_AXES,
  canonicalDirectionToModel,
  coordinateSystemDefinition,
  modelDirectionToCanonical,
} = require("../lib/coordinate-system");
const { projectGlobalAxes } = require("../lib/orientation-gizmo");
const { isWorldPointVisible } = require("../lib/renderer");
const {
  createLabelTexture,
  cubeFaceQuaternion,
  cubeFaceRegions,
  cubeTargetDefinitions,
  viewCubePixelRatio,
  viewCubeRotation,
} = require("../lib/view-cube");

describe("Graviss engineering navigation", () => {
  it("defines all Z-up cube faces, edges, and corners", () => {
    expect(CAMERA_VIEWS.top.direction).toEqual([0, 0, 1]);
    expect(CAMERA_VIEWS["top-front"].direction).toEqual([0, -1, 1]);
    expect(CAMERA_VIEWS["top-front-right"].direction).toEqual([1, -1, 1]);
    expect(CAMERA_VIEW_IDS.length).toBe(26);
    expect(cameraViewIdForDirection([-4, 0, -3])).toBe("bottom-left");
    expect(cameraViewDefinition("unsupported")).toBe(CAMERA_VIEWS["top-front-right"]);
  });

  it("orients navigation to signed model up axes without changing model coordinates", () => {
    const coordinateSystem = { upAxis: "-z", handedness: "right" };
    const top = cameraViewDefinition("top", coordinateSystem);
    const front = cameraViewDefinition("front", coordinateSystem);

    expect(top.direction).toEqual([0, 0, -1]);
    expect(top.up).toEqual([0, -1, 0]);
    expect(front.direction).toEqual([0, 1, 0]);
    expect(front.up).toEqual([0, 0, -1]);
    expect(cameraViewIdForDirection([0, 4, -3], coordinateSystem)).toBe("top-front");
    expect(canonicalDirectionToModel([2, -4, 6], coordinateSystem)).toEqual([2, 4, -6]);
    expect(modelDirectionToCanonical([2, 4, -6], coordinateSystem)).toEqual([2, -4, 6]);
    expect(
      cubeTargetDefinitions(coordinateSystem).find(({ viewId }) => viewId === "top").direction,
    ).toEqual([0, 0, -1]);
  });

  it("builds a right-handed navigation frame for every supported model up axis", () => {
    const expectedUp = {
      x: [1, 0, 0],
      "-x": [-1, 0, 0],
      y: [0, 1, 0],
      "-y": [0, -1, 0],
      z: [0, 0, 1],
      "-z": [0, 0, -1],
    };

    for (const upAxis of UP_AXES) {
      const definition = coordinateSystemDefinition({ upAxis });
      expect(definition.up).toEqual(expectedUp[upAxis]);
      expect(determinant(definition.modelFromCanonical)).toBe(1);
    }
  });

  it("exposes every cube target through its adjacent face regions", () => {
    const targets = cubeTargetDefinitions();
    const regions = cubeFaceRegions(THREE);

    expect(targets.filter(({ part }) => part === "face").length).toBe(6);
    expect(targets.filter(({ part }) => part === "edge").length).toBe(12);
    expect(targets.filter(({ part }) => part === "corner").length).toBe(8);
    expect(regions.length).toBe(54);
    expect(regions.filter(({ viewId }) => viewId === "top-front").length).toBe(2);
    expect(regions.filter(({ viewId }) => viewId === "top-front-right").length).toBe(3);
  });

  it("keeps side-face labels aligned with positive global Z", () => {
    const localUp = new THREE.Vector3(0, 1, 0);
    const localNormal = new THREE.Vector3(0, 0, 1);
    const frontRotation = cubeFaceQuaternion(THREE, [0, -1, 0]);
    const topRotation = cubeFaceQuaternion(THREE, [0, 0, 1]);

    expect(localUp.clone().applyQuaternion(frontRotation).toArray().map(round)).toEqual([0, 0, 1]);
    expect(localUp.clone().applyQuaternion(topRotation).toArray().map(round)).toEqual([0, 1, 0]);
    expect(localNormal.clone().applyQuaternion(frontRotation).toArray().map(round)).toEqual([
      0, -1, 0,
    ]);
    expect(() => cubeFaceQuaternion(THREE, [0, 0, 0])).toThrowError(/nonzero direction/);
  });

  it("supersamples the cube and minifies labels with mipmaps and anisotropy", () => {
    expect(viewCubePixelRatio(1)).toBe(2);
    expect(viewCubePixelRatio(2.5)).toBe(2.5);
    expect(viewCubePixelRatio(4)).toBe(3);

    const texture = createLabelTexture(THREE, "Front", 8);
    expect(texture.generateMipmaps).toBe(true);
    expect(texture.minFilter).toBe(THREE.LinearMipmapLinearFilter);
    expect(texture.magFilter).toBe(THREE.LinearFilter);
    expect(texture.anisotropy).toBe(8);
    texture.dispose();
  });

  it("rotates the cube and axis gizmo with the main camera", () => {
    const camera = new THREE.PerspectiveCamera();
    camera.up.set(0, 0, 1);
    camera.position.set(10, -8, 6);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    const projected = projectGlobalAxes(THREE, camera.quaternion);
    const cubeRotation = viewCubeRotation(THREE, camera.quaternion);

    expect(
      cubeRotation.clone().multiply(camera.quaternion).angleTo(new THREE.Quaternion()),
    ).toBeLessThan(1e-7);
    expect(Math.abs(projected.z.y)).toBeGreaterThan(0.1);
    expect(() => viewCubeRotation(THREE, {})).toThrowError(/Three.js camera quaternion/);
  });

  it("shows the fallback axes only when the world origin is outside the camera", () => {
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, -10, 5);
    camera.up.set(0, 0, 1);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);

    expect(isWorldPointVisible(new THREE.Vector3(0, 0, 0), camera)).toBe(true);
    expect(isWorldPointVisible(new THREE.Vector3(100, 0, 0), camera)).toBe(false);
    expect(isWorldPointVisible(new THREE.Vector3(0, -20, 10), camera)).toBe(false);
  });

  it("fits portrait views and preserves scale across projections", () => {
    expect(sphereFitDistance(10, 42, 9 / 16)).toBeGreaterThan(sphereFitDistance(10, 42, 16 / 9));
    const visibleHeight = perspectiveVisibleHeight(24, 42);
    expect(Math.abs(perspectiveDistanceForHeight(visibleHeight, 42) - 24)).toBeLessThan(1e-12);
    expect(orthographicFitHeight(10, 9 / 16)).toBeGreaterThan(orthographicFitHeight(10, 16 / 9));
  });

  it("provides the four established engineering appearances", () => {
    expect(APPEARANCE_IDS).toEqual(["cloud", "midnight", "paper", "white"]);
    expect(appearanceDefinition("midnight").background).toBe(0x101b24);
    expect(appearanceDefinition("unsupported")).toBe(appearanceDefinition("cloud"));
  });
});

function round(value) {
  const result = Number(value.toFixed(6));
  return Object.is(result, -0) ? 0 : result;
}

function determinant(matrix) {
  return (
    matrix[0][0] * (matrix[1][1] * matrix[2][2] - matrix[1][2] * matrix[2][1]) -
    matrix[0][1] * (matrix[1][0] * matrix[2][2] - matrix[1][2] * matrix[2][0]) +
    matrix[0][2] * (matrix[1][0] * matrix[2][1] - matrix[1][1] * matrix[2][0])
  );
}
