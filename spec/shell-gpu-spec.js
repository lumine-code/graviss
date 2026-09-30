const { GravissRenderer } = require("../lib/renderer");
const { atlasSize, buildShellRecipes, createShellGpuBackend } = require("../lib/shell-gpu");

function hostElement() {
  const root = document.createElement("div");
  root.className = "graviss";
  root.style.cssText = "position:relative;width:640px;height:480px";
  root.innerHTML = `<div class="graviss-canvas-host" style="width:640px;height:480px"></div><canvas class="graviss-view-cube" style="width:90px;height:90px"></canvas><svg class="graviss-axis-gizmo">${["x", "y", "z"].map((axis) => `<g data-gizmo-axis="${axis}"><line/><circle/><text>${axis}</text></g>`).join("")}</svg><div class="graviss-orbit-pivot"></div><div class="graviss-print-region"></div>`;
  document.body.append(root);
  return { root, host: root.querySelector(".graviss-canvas-host") };
}

function field(nodes, rotations, offset = 0) {
  const components = rotations ? 6 : 3;
  const values = new Float32Array(nodes.length * components);
  for (let index = 0; index < nodes.length; index += 1) {
    const at = index * components;
    values[at] = 0.002 * Math.sin(index + offset);
    values[at + 1] = 0.001 * Math.cos(index + offset);
    values[at + 2] = 0.004 * Math.sin(index + offset + 0.1);
    if (rotations) {
      values[at + 3] = 0.002 * Math.sin(index + offset + 0.3);
      values[at + 4] = 0.001 * Math.cos(index + offset);
      values[at + 5] = 0.0005 * Math.sin(index + offset);
    }
  }
  return { components, nodes: { values } };
}

function shellGeometry(interpolation, thick) {
  const nodes = [
    { id: 0, x: 0, y: 0, z: 0 },
    { id: 1, x: 2, y: 0, z: 0.05 },
    { id: 2, x: 2, y: 1.5, z: 0.1 },
    { id: 3, x: 0, y: 1.5, z: -0.02 },
  ];
  return {
    nodes,
    elements: [
      {
        id: 1,
        kind: "shell",
        nodeIds: interpolation === "triangle" ? [0, 1, 2] : [0, 1, 2, 3],
        surfaceInterpolation: interpolation === "triangle" ? "linear" : interpolation,
        thickness: thick ? [0.15, 0.2, 0.21, 0.17] : 0,
        offset: thick ? [0.01, 0.02, 0.03, 0.01] : 0,
      },
    ],
  };
}

function maximumError(actual, expected, renderer) {
  let maximum = 0;
  expect(actual.length).toBe(expected.length);
  const state = renderer.shellState;
  const ranges = state.entityRanges || renderer.meshes.shells.userData.gravissEntityRanges;
  for (let entity = 0; entity < state.elements.length; entity += 1) {
    // A filtered-out CPU body is deliberately stale until a query asks for a
    // full snapshot. Only the active bodies belong to this rendered comparison.
    if (!renderer.keepsElement(state.elements[entity])) continue;
    const range = ranges[entity];
    for (let index = range.start * 3; index < (range.start + range.count) * 3; index += 1) {
      if (!Number.isFinite(actual[index])) return Infinity;
      maximum = Math.max(maximum, Math.abs(actual[index] - expected[index]));
    }
  }
  return maximum;
}

function renderMask(renderer, width, height) {
  const gpu = renderer.canvasRenderer;
  const target = new renderer.THREE.WebGLRenderTarget(width, height, { stencilBuffer: true });
  const previousTarget = gpu.getRenderTarget();
  const previousColor = gpu.getClearColor(new renderer.THREE.Color()).clone();
  const previousAlpha = gpu.getClearAlpha();
  const background = renderer.scene.background;
  const furniture = [renderer.sky, renderer.grid, renderer.axes].filter(Boolean);
  const visibility = furniture.map((item) => item.visible);
  const pixels = new Uint8Array(width * height * 4);
  try {
    for (const item of furniture) item.visible = false;
    renderer.scene.background = null;
    renderer.camera.updateMatrixWorld(true);
    gpu.setRenderTarget(target);
    gpu.setClearColor(0, 0);
    gpu.clear(true, true, true);
    gpu.render(renderer.scene, renderer.camera);
    gpu.readRenderTargetPixels(target, 0, 0, width, height, pixels);
  } finally {
    gpu.setRenderTarget(previousTarget);
    gpu.setClearColor(previousColor, previousAlpha);
    renderer.scene.background = background;
    furniture.forEach((item, index) => {
      item.visible = visibility[index];
    });
    target.dispose();
  }
  return Uint8Array.from({ length: width * height }, (_, index) =>
    Number(pixels[index * 4 + 3] > 0),
  );
}

function outsidePixelBand(first, second, width, height) {
  let outside = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = y * width + x;
      if (!first[at] || second[at]) continue;
      let neighbour = false;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height && second[ny * width + nx]) {
            neighbour = true;
          }
        }
      }
      if (!neighbour) outside += 1;
    }
  }
  return outside;
}

describe("shell GPU deformation", () => {
  let fixture;

  function disposeFixture() {
    if (!fixture) return;
    fixture.backend?.dispose();
    fixture.renderer?.destroy();
    fixture.root.remove();
    fixture = null;
  }

  async function createFixture(geometry, rotations) {
    const { root, host } = hostElement();
    fixture = { root };
    const renderer = await GravissRenderer.create(
      host,
      geometry,
      {},
      { deferInitialRender: true, shellDeformationBackend: "cpu" },
    );
    fixture.renderer = renderer;
    renderer.setResult(field(geometry.nodes, rotations));
    renderer.setDeformationScale(30);
    const created = createShellGpuBackend(renderer, renderer.shellState);
    if (!created.backend) {
      if (/requires|available texture|context is lost/.test(created.reason))
        pending(created.reason);
      throw new Error(created.reason);
    }
    fixture.backend = created.backend;
    const shell = renderer.meshes.shells;
    created.backend.installMaterials(
      shell.material,
      shell.userData.gravissEdges.material,
      renderer.shellState.geometry,
      renderer.shellState.edgeGeometry,
    );
    return fixture;
  }

  function expectParity(context) {
    const { backend, renderer } = fixture;
    backend.ensureFrame(renderer.deformation);
    expect(maximumError(backend.readPositions(), renderer.shellState.positions, renderer))
      .withContext(`${context}: positions`)
      .toBeLessThan(3e-5);
    expect(maximumError(backend.readNormals(), renderer.shellState.normalValues, renderer))
      .withContext(`${context}: normals`)
      .toBeLessThan(3e-4);
    expect(renderer.canvasRenderer.getContext().getError()).toBe(0);
  }

  afterEach(disposeFixture);

  it("checks texture capacity and Float32 index limits before allocating GPU data", () => {
    expect(atlasSize(25, 16)).toEqual({ width: 8, height: 4 });
    expect(atlasSize(0, 16)).toEqual({ width: 1, height: 1 });
    expect(() => atlasSize(257, 16)).toThrowError(RangeError);
    expect(() =>
      buildShellRecipes(
        { restPositions: { length: 3 } },
        { positions: { length: 3 * 2 ** 24 }, edgePositions: { length: 0 }, prepared: [] },
        () => {
          throw new Error("Capacity must be checked before allocating a texture");
        },
      ),
    ).toThrowError(RangeError, /Float32/);
    expect(createShellGpuBackend({}, {})).toEqual({
      backend: null,
      reason: "Shell GPU deformation requires WebGL2",
    });
  });

  for (const interpolation of ["triangle", "linear", "q4", "hermite"]) {
    it(`retains ${interpolation} positions, directors and wall normals across animation phases`, async () => {
      for (const thick of [false, true]) {
        for (const rotations of [false, true]) {
          const geometry = shellGeometry(interpolation, thick);
          const { backend, renderer } = await createFixture(geometry, rotations);
          const index = renderer.shellState.indexValues.slice();
          const textureVersion = backend.nodeField.texture.version;
          const attributeVersion =
            renderer.shellState.geometry.getAttribute("gravissShellVertex").version;
          for (const phase of [0, 1, -1, 0.27]) {
            renderer.setDeformationPhase(phase);
            expectParity(
              `${interpolation}, thick ${thick}, rotations ${rotations}, phase ${phase}`,
            );
          }
          renderer.setDeformationScale(1000);
          expectParity(`${interpolation}, factor 270`);
          expect(renderer.shellState.indexValues).toEqual(index);
          expect(backend.nodeField.texture.version).toBe(textureVersion);
          expect(renderer.shellState.geometry.getAttribute("gravissShellVertex").version).toBe(
            attributeVersion,
          );
          // Compile and draw both final materials too. The atlas must work
          // through StandardMaterial lighting and LineMaterial screen width.
          renderer.paintFrame();
          expect(renderer.canvasRenderer.getContext().getError()).toBe(0);
          disposeFixture();
        }
      }
    }, 30000);
  }

  it("changes field textures only for a new result and restores material hooks on disposal", async () => {
    const geometry = shellGeometry("hermite", true);
    const { renderer, backend } = await createFixture(geometry, true);
    const state = renderer.shellState;
    const shellMaterial = renderer.meshes.shells.material;
    const hooks = backend.installations.map((item) => ({
      material: item.material,
      before: item.before,
      key: item.cacheKey,
    }));
    expectParity("first result");
    const initialUploads = backend.stats.resultUploads;
    backend.ensureFrame(renderer.deformation);
    expect(backend.stats.resultUploads).toBe(initialUploads);
    renderer.setResult(field(geometry.nodes, true, 1.2));
    expect(renderer.shellState).toBe(state);
    expectParity("replacement result");
    expect(backend.stats.resultUploads).toBe(initialUploads + 1);
    backend.dispose();
    backend.dispose();
    for (const hook of hooks) {
      expect(hook.material.onBeforeCompile).toBe(hook.before);
      expect(hook.material.customProgramCacheKey).toBe(hook.key);
    }
    expect(shellMaterial.onBeforeCompile).toBe(hooks[0].before);
    expect(state.geometry.getAttribute("gravissShellVertex")).toBeUndefined();
    expect(state.edgeGeometry.getAttribute("gravissShellEndpoints")).toBeUndefined();
    expect(backend.ensureFrame(renderer.deformation)).toBe(false);
  });

  it("releases both custom VBOs on disposal and can draw the surviving CPU mirror arrays", async () => {
    const { backend, renderer } = await createFixture(shellGeometry("q4", true), true);
    const context = renderer.canvasRenderer.getContext();
    const arrays = [backend.recipes.vertexAttributes, backend.edgeDrawAttribute.array];
    const custom = new Set();
    const deleted = new Set();
    const bound = new Map();
    const bind = context.bindBuffer.bind(context);
    const upload = context.bufferData.bind(context);
    const remove = context.deleteBuffer.bind(context);
    spyOn(context, "bindBuffer").and.callFake((target, buffer) => {
      bound.set(target, buffer);
      return bind(target, buffer);
    });
    spyOn(context, "bufferData").and.callFake((target, data, ...rest) => {
      if (arrays.includes(data)) custom.add(bound.get(target));
      return upload(target, data, ...rest);
    });
    spyOn(context, "deleteBuffer").and.callFake((buffer) => {
      deleted.add(buffer);
      return remove(buffer);
    });
    backend.ensureFrame(renderer.deformation);
    renderMask(renderer, 256, 192);
    expect(custom.size).toBe(2);
    backend.dispose();
    for (const buffer of custom) expect(deleted.has(buffer)).toBe(true);
    const cpu = renderMask(renderer, 256, 192);
    expect(cpu.reduce((sum, pixel) => sum + pixel, 0)).toBeGreaterThan(1000);
    expect(context.getError()).toBe(0);
  });

  it("does not scan mirrored vertices for render sorting after their bounds were invalidated", async () => {
    const { backend, renderer } = await createFixture(shellGeometry("q4", true), true);
    const state = renderer.shellState;
    spyOn(state.geometry, "computeBoundingSphere").and.callThrough();
    spyOn(state.edgeGeometry, "computeBoundingSphere").and.callThrough();
    backend.ensureFrame(renderer.deformation);
    state.geometry.boundingSphere = null;
    state.edgeGeometry.boundingSphere = null;
    // A cached atlas still has to restore the cheap draw bounds. Three reads
    // sphere centres for sorting even when frustum culling is disabled.
    expect(backend.ensureFrame(renderer.deformation)).toBe(false);
    renderer.paintFrame();
    expect(state.geometry.computeBoundingSphere).not.toHaveBeenCalled();
    expect(state.edgeGeometry.computeBoundingSphere).not.toHaveBeenCalled();
    expect(state.geometry.boundingSphere.radius).toBe(Infinity);
  });

  it("restores an offscreen target's physical viewport and scissor at a doubled pixel ratio", async () => {
    const { backend, renderer } = await createFixture(shellGeometry("q4", true), true);
    const gpu = renderer.canvasRenderer;
    const THREE = renderer.THREE;
    const target = new THREE.WebGLRenderTarget(96, 64);
    target.viewport.set(7, 9, 73, 41);
    target.scissor.set(10, 12, 51, 29);
    target.scissorTest = true;
    const ratio = gpu.getPixelRatio();
    gpu.setPixelRatio(2);
    gpu.setRenderTarget(target);
    const defaultViewport = gpu.getViewport(new THREE.Vector4()).clone();
    const context = gpu.getContext();
    try {
      backend.markDirty();
      backend.ensureFrame(renderer.deformation);
      expect(gpu.getRenderTarget()).toBe(target);
      expect(gpu.getViewport(new THREE.Vector4())).toEqual(defaultViewport);
      expect(Array.from(context.getParameter(context.VIEWPORT))).toEqual([7, 9, 73, 41]);
      expect(Array.from(context.getParameter(context.SCISSOR_BOX))).toEqual([10, 12, 51, 29]);
      expect(context.getParameter(context.SCISSOR_TEST)).toBe(true);
    } finally {
      gpu.setRenderTarget(null);
      gpu.setPixelRatio(ratio);
      target.dispose();
    }
  });

  it("aligns sparse seven-component result rows without moving missing nodes or treating warping as rotation", async () => {
    const geometry = shellGeometry("hermite", true);
    const { backend, renderer } = await createFixture(geometry, true);
    renderer.setResult({
      components: 7,
      nodes: {
        ids: [2, 0],
        values: new Float32Array([
          0.001, -0.002, 0.003, 0.004, 0.005, 0.006, 99, -0.003, 0.0004, 0.0031, 0.02, -0.01, 0.03,
          -50,
        ]),
      },
    });
    renderer.setDeformationScale(10);
    renderer.setDeformationPhase(-0.3);
    expectParity("sparse seven components");
    expect(Array.from(renderer.deformation.rows.slice(3, 6))).toEqual([0, 0, 0]);
    expect(Array.from(renderer.deformation.rows.slice(9, 12))).toEqual([0, 0, 0]);
    expect(renderer.deformation.rotations[6]).toBeCloseTo(0.004, 7);
    expect(renderer.deformation.rotations[7]).toBeCloseTo(0.005, 7);
    expect(renderer.deformation.rotations[8]).toBeCloseTo(0.006, 7);
    spyOn(backend, "readTarget").and.callThrough();
    renderer.setDeformationPhase(0.61);
    backend.ensureFrame(renderer.deformation);
    expect(backend.readTarget).not.toHaveBeenCalled();
  });

  it("matches CPU rendered masks within one pixel for offset bodies and beam stencil intersections", async () => {
    const width = 256;
    const height = 192;
    for (const interpolation of ["linear", "q4", "hermite"]) {
      for (const filtered of [false, true]) {
        const geometry = {
          nodes: [
            { id: 0, x: 0, y: 0, z: 0 },
            { id: 1, x: 2, y: 0, z: 0 },
            { id: 2, x: 4, y: 0, z: 0 },
            { id: 3, x: 0, y: 1.5, z: 0 },
            { id: 4, x: 2, y: 1.5, z: 0 },
            { id: 5, x: 4, y: 1.5, z: 0 },
            { id: 6, x: 0, y: 0.75, z: 0 },
            { id: 7, x: 4, y: 0.75, z: 0 },
          ],
          elements: [
            {
              id: 1,
              kind: "shell",
              nodeIds: [0, 1, 4, 3],
              thickness: 0.2,
              surfaceInterpolation: interpolation,
            },
            {
              id: 2,
              kind: "shell",
              nodeIds: [1, 2, 5, 4],
              thickness: 0.2,
              offset: 0.05,
              surfaceInterpolation: interpolation,
            },
            {
              id: 3,
              kind: "beam",
              nodeIds: [6, 7],
              sectionId: 1,
              lineInterpolation: "linear",
              localAxes: { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
            },
          ],
          sections: [{ id: 1, shape: { kind: "rectangle", width: 0.2, height: 0.2 } }],
        };
        const { backend, renderer } = await createFixture(geometry, true);
        renderer.setStandardView("iso");
        renderer.setDeformationPhase(-0.61);
        renderer.setColorByDisplacement(true);
        if (filtered) {
          renderer.setElementFilter((element) => element.id !== 1);
          backend.syncFilter();
        }
        backend.ensureFrame(renderer.deformation);
        const gpu = renderMask(renderer, width, height);
        backend.dispose();
        const cpu = renderMask(renderer, width, height);
        const context = `${interpolation}, filtered ${filtered}`;
        expect(cpu.reduce((sum, pixel) => sum + pixel, 0))
          .withContext(context)
          .toBeGreaterThan(1000);
        expect(outsidePixelBand(cpu, gpu, width, height))
          .withContext(context)
          .toBe(0);
        expect(outsidePixelBand(gpu, cpu, width, height))
          .withContext(context)
          .toBe(0);
        disposeFixture();
      }
    }
  }, 30000);

  it("keeps edge aliases in active element order when filtering and restoring adjacent shells", async () => {
    const geometry = {
      nodes: [
        { id: 0, x: 0, y: 0, z: 0 },
        { id: 1, x: 1, y: 0, z: 0 },
        { id: 2, x: 2, y: 0, z: 0 },
        { id: 3, x: 0, y: 1, z: 0 },
        { id: 4, x: 1, y: 1, z: 0 },
        { id: 5, x: 2, y: 1, z: 0 },
      ],
      elements: [
        { id: 1, kind: "shell", nodeIds: [0, 1, 4, 3], thickness: 0.2 },
        { id: 2, kind: "shell", nodeIds: [1, 2, 5, 4], thickness: 0.2 },
      ],
    };
    const { backend, renderer } = await createFixture(geometry, true);
    const source = backend.recipes.edgeAttributes.slice();
    renderer.setDeformationPhase(-0.43);
    expectParity("adjacent before filter");
    renderer.setElementFilter((element) => element.id === 2);
    backend.syncFilter();
    expectParity("adjacent with filter");
    const range = backend.recipes.edgeEntityRanges[1];
    expect(renderer.shellState.edgeGeometry.instanceCount).toBe(range.count);
    expect(Array.from(backend.edgeDrawAttribute.array.slice(0, range.count * 3))).toEqual(
      Array.from(source.slice(range.start * 3, (range.start + range.count) * 3)),
    );
    const filterVersion = backend.filter.texture.version;
    renderer.setDeformationPhase(0.61);
    expectParity("filtered next phase");
    expect(backend.filter.texture.version).toBe(filterVersion);
    const frames = backend.stats.frames;
    const factor = renderer.deformation.factor;
    renderer.setElementFilter(null);
    backend.syncFilter();
    expect(renderer.deformation.factor).toBe(factor);
    expect(backend.ensureFrame(renderer.deformation)).toBe(true);
    expect(backend.stats.frames).toBe(frames + 1);
    expectParity("adjacent restored");
    expect(Array.from(backend.edgeDrawAttribute.array)).toEqual(Array.from(source));
    expect(renderer.shellState.edgeGeometry.instanceCount).toBe(source.length / 3);
  });
});
