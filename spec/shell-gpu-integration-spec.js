const { GravissRenderer } = require("../lib/renderer");

describe("Graviss GPU shell integration", () => {
  let gpu;
  let cpu;
  let roots;

  beforeEach(() => {
    jasmine.useRealClock();
    roots = [];
  });

  afterEach(() => {
    gpu?.destroy();
    cpu?.destroy();
    for (const root of roots) root.remove();
    gpu = null;
    cpu = null;
  });

  function host() {
    const root = document.createElement("div");
    root.className = "graviss";
    root.style.cssText = "position:absolute;inset:0;width:640px;height:480px";
    root.innerHTML = `<div class="host" style="width:640px;height:480px"></div>
      <canvas class="graviss-view-cube" style="width:80px;height:80px"></canvas>
      <svg class="graviss-axis-gizmo">${["x", "y", "z"].map((axis) => `<g data-gizmo-axis="${axis}"><line/><circle/><text/></g>`).join("")}</svg>`;
    jasmine.attachToDOM(root);
    roots.push(root);
    return root.querySelector(".host");
  }

  function geometry() {
    return {
      nodes: [
        { id: 1, x: 0, y: 0, z: 0 },
        { id: 2, x: 1, y: 0, z: 0 },
        { id: 3, x: 2, y: 0, z: 0 },
        { id: 4, x: 0, y: 1, z: 0 },
        { id: 5, x: 1, y: 1, z: 0 },
        { id: 6, x: 2, y: 1, z: 0 },
      ],
      elements: [
        {
          id: "A",
          kind: "shell",
          nodeIds: [1, 2, 5, 4],
          thickness: [0.2, 0.3, 0.3, 0.2],
          offset: 0.1,
          surfaceInterpolation: "hermite",
        },
        {
          id: "B",
          kind: "shell",
          nodeIds: [2, 3, 6, 5],
          thickness: [0.3, 0.4, 0.4, 0.3],
          offset: 0.1,
          surfaceInterpolation: "q4",
        },
      ],
      supports: [],
    };
  }

  async function models() {
    const data = geometry();
    gpu = await GravissRenderer.create(
      host(),
      data,
      {},
      { shellDeformationBackend: "gpu", deferInitialRender: true },
    );
    cpu = await GravissRenderer.create(
      host(),
      data,
      {},
      { shellDeformationBackend: "cpu", deferInitialRender: true },
    );
    const field = {
      kind: "displacement",
      loadCaseId: 1,
      components: 7,
      extent: 0.04,
      nodes: {
        ids: data.nodes.map((node) => node.id),
        values: data.nodes.flatMap((node) => [
          0,
          0,
          node.x * node.y * 0.02,
          0.01 * node.y,
          0.01 * node.x,
          0,
          0,
        ]),
      },
    };
    gpu.setResult(field);
    cpu.setResult(field);
    gpu.setDeformationScale(1);
    cpu.setDeformationScale(1);
    gpu.ensureGpuShellFrame();
  }

  function parity() {
    const a = gpu.shellState.positions;
    const b = cpu.shellState.positions;
    expect(a.length).toBe(b.length);
    for (const entity of gpu.shellState.activeElementIndices) {
      const item = gpu.shellState.prepared[entity];
      for (let at = item.vertexStart * 3; at < (item.vertexStart + item.vertexCount) * 3; at += 1) {
        expect(a[at]).toBeCloseTo(b[at], 6);
      }
    }
  }

  function trackShaderResources(context) {
    const createShader = context.createShader.bind(context);
    const deleteShader = context.deleteShader.bind(context);
    const created = [];
    const deleted = [];
    spyOn(context, "createShader").and.callFake((type) => {
      const shader = createShader(type);
      created.push(shader);
      return shader;
    });
    spyOn(context, "deleteShader").and.callFake((shader) => {
      deleted.push(shader);
      deleteShader(shader);
    });
    return { created, deleted };
  }

  it("keeps normal animation on GPU and materializes proxy and exact CPU geometry independently", async () => {
    await models();
    const writer = spyOn(gpu, "writeShellSurface").and.callThrough();
    const positionVersion = gpu.shellState.geometry.getAttribute("position").version;
    const normalVersion = gpu.shellState.geometry.getAttribute("normal").version;
    const edgeVersion = gpu.shellState.edgeBuffer.version;
    const resultUploads = gpu.shellGpu.stats.resultUploads;
    gpu.setDeformationPhase(-0.5);
    cpu.setDeformationPhase(-0.5);
    gpu.ensureGpuShellFrame();
    expect(writer).not.toHaveBeenCalled();
    expect(gpu.shellGpu.stats.resultUploads).toBe(resultUploads);
    expect(gpu.shellState.geometry.getAttribute("position").version).toBe(positionVersion);
    expect(gpu.shellState.geometry.getAttribute("normal").version).toBe(normalVersion);
    expect(gpu.shellState.edgeBuffer.version).toBe(edgeVersion);
    gpu.ensureCpuShellGeometry("proxy");
    expect(writer).not.toHaveBeenCalled();
    expect(gpu.shellState.cpuProxyVersion).toBe(gpu.shellState.poseVersion);
    expect(gpu.shellState.cpuFullVersion).not.toBe(gpu.shellState.poseVersion);
    for (const vertex of gpu.shellState.zoomIndices) {
      for (let axis = 0; axis < 3; axis += 1)
        expect(gpu.shellState.positions[vertex * 3 + axis]).toBeCloseTo(
          cpu.shellState.positions[vertex * 3 + axis],
          6,
        );
    }
    gpu.ensureCpuShellGeometry();
    expect(writer).toHaveBeenCalledTimes(1);
    parity();
    gpu.ensureCpuShellGeometry();
    expect(writer).toHaveBeenCalledTimes(1);
    expect(gpu.shellState.geometry.getAttribute("position").version).toBe(positionVersion);
  });

  it("uses the current field for exact raycasts and the wheel proxy without a GPU readback", async () => {
    await models();
    gpu.setDeformationPhase(-0.5);
    cpu.setDeformationPhase(-0.5);
    const readback = spyOn(gpu.canvasRenderer, "readRenderTargetPixels").and.callThrough();
    const rect = gpu.host.getBoundingClientRect();
    const event = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    const raycast = spyOn(gpu.raycaster, "intersectObjects").and.callThrough();
    gpu.zoomIntersectionAt(event);
    expect(raycast).toHaveBeenCalled();
    expect(gpu.shellState.cpuProxyVersion).toBe(gpu.shellState.poseVersion);
    expect(gpu.shellState.cpuFullVersion).not.toBe(gpu.shellState.poseVersion);
    gpu.intersectionAt(event);
    expect(gpu.shellState.cpuFullVersion).toBe(gpu.shellState.poseVersion);
    parity();
    expect(readback).not.toHaveBeenCalled();
  });

  it("rebuilds GPU topology at rest and retains a current CPU reference for filtered bounds", async () => {
    await models();
    gpu.setDeformationPhase(0.5);
    cpu.setDeformationPhase(0.5);
    const original = Array.from(gpu.shellState.restNormals);
    const count = gpu.shellState.positions.length;
    const oldBackend = gpu.shellGpu;
    for (const model of [gpu, cpu]) {
      model.setSectionRendering(false);
      model.setSectionRendering(true);
      model.setElementFilter((element) => element.id === "B");
    }
    expect(oldBackend.disposed).toBe(true);
    expect(gpu.shellState.positions.length).toBe(count);
    expect(Array.from(gpu.shellState.restNormals)).toEqual(original);
    gpu.ensureCpuShellGeometry();
    parity();
    const a = gpu.visibleModelBounds();
    const b = cpu.visibleModelBounds();
    expect(a.min.toArray()).toEqual(b.min.toArray());
    expect(a.max.toArray()).toEqual(b.max.toArray());
    gpu.ensureGpuShellFrame();
  });

  it("creates programs only for rendered passes and releases each rendered generation once", async () => {
    await models();
    const context = gpu.canvasRenderer.getContext();
    const createProgram = context.createProgram.bind(context);
    const deleteProgram = context.deleteProgram.bind(context);
    const created = [];
    const deleted = [];
    spyOn(context, "createProgram").and.callFake(() => {
      const program = createProgram();
      created.push(program);
      return program;
    });
    spyOn(context, "deleteProgram").and.callFake((program) => {
      deleted.push(program);
      deleteProgram(program);
    });
    expect(context.getError()).toBe(context.NO_ERROR);
    gpu.setSectionRendering(false);
    const intermediate = gpu.shellGpu;
    expect(intermediate.stats.frames).toBe(0);
    expect(created.length).toBe(0);
    const released = deleted.length;
    gpu.setSectionRendering(true);
    expect(intermediate.disposed).toBe(true);
    expect(created.length).toBe(0);
    expect(deleted.length).toBe(released);
    expect(context.getError()).toBe(context.NO_ERROR);
    gpu.ensureGpuShellFrame();
    expect(created.length).toBeGreaterThan(0);
    expect(context.getError()).toBe(context.NO_ERROR);
    const rendered = gpu.shellGpu;
    rendered.dispose();
    expect(deleted.length).toBe(released + created.length);
    expect(new Set(deleted).size).toBe(deleted.length);
    expect(context.getError()).toBe(context.NO_ERROR);
    rendered.dispose();
    expect(deleted.length).toBe(released + created.length);
    gpu.shellGpu = null;
  });

  it("reports first-use shader errors and restores the renderer's diagnostic state", async () => {
    await models();
    gpu.setSectionRendering(false);
    const backend = gpu.shellGpu;
    const canvas = gpu.canvasRenderer;
    const shaders = trackShaderResources(canvas.getContext());
    const previousTarget = canvas.getRenderTarget();
    const onShaderError = jasmine.createSpy("previous shader error callback");
    canvas.debug.onShaderError = onShaderError;
    canvas.debug.checkShaderErrors = false;
    backend.passes[0].material.fragmentShader = "void main() { not_valid_glsl; }";
    backend.passes[0].material.needsUpdate = true;
    expect(() => gpu.ensureGpuShellFrame()).toThrowError(/Shell GPU shader failed/);
    expect(backend.disposed).toBe(true);
    expect(gpu.shellGpu).toBeNull();
    expect(gpu.shellState.gpuUnavailable).toMatch(/Shell GPU shader failed/);
    expect(canvas.getRenderTarget()).toBe(previousTarget);
    expect(canvas.debug.onShaderError).toBe(onShaderError);
    expect(canvas.debug.checkShaderErrors).toBe(false);
    expect(onShaderError).not.toHaveBeenCalled();
    expect(shaders.created.length).toBe(2);
    expect(new Set(shaders.deleted)).toEqual(new Set(shaders.created));
    expect(canvas.getContext().getError()).toBe(canvas.getContext().NO_ERROR);
  });

  it("checks a tangent shader first needed after the zero-displacement frame", async () => {
    await models();
    gpu.setDeformationPhase(0);
    gpu.setSectionRendering(false);
    const backend = gpu.shellGpu;
    const canvas = gpu.canvasRenderer;
    gpu.ensureGpuShellFrame();
    expect(backend.stats.frames).toBe(1);
    expect(backend.passes[2].count).toBeGreaterThan(0);
    expect(canvas.properties.get(backend.passes[2].material).currentProgram).toBeUndefined();
    const shaders = trackShaderResources(canvas.getContext());
    backend.passes[2].material.fragmentShader = "void main() { not_valid_glsl; }";
    backend.passes[2].material.needsUpdate = true;
    const previousTarget = canvas.getRenderTarget();
    const target = new gpu.THREE.WebGLRenderTarget(12, 12, { depthBuffer: false });
    const previousXr = canvas.xr.enabled;
    const previousAutoClear = canvas.autoClear;
    const onShaderError = jasmine.createSpy("previous late shader error callback");
    canvas.debug.onShaderError = onShaderError;
    canvas.debug.checkShaderErrors = false;
    canvas.xr.enabled = true;
    canvas.autoClear = true;
    canvas.setRenderTarget(target);
    try {
      gpu.setDeformationPhase(0.5);
      expect(() => gpu.ensureGpuShellFrame()).toThrowError(/Shell GPU shader failed/);
      expect(backend.disposed).toBe(true);
      expect(gpu.shellGpu).toBeNull();
      expect(canvas.getRenderTarget()).toBe(target);
      expect(canvas.debug.onShaderError).toBe(onShaderError);
      expect(canvas.debug.checkShaderErrors).toBe(false);
      expect(canvas.xr.enabled).toBe(true);
      expect(canvas.autoClear).toBe(true);
      expect(onShaderError).not.toHaveBeenCalled();
      expect(shaders.created.length).toBe(2);
      expect(new Set(shaders.deleted)).toEqual(new Set(shaders.created));
      expect(canvas.getContext().getError()).toBe(canvas.getContext().NO_ERROR);
    } finally {
      canvas.setRenderTarget(previousTarget);
      canvas.xr.enabled = previousXr;
      canvas.autoClear = previousAutoClear;
      target.dispose();
    }
  });

  it("prepares the same GPU phase for crop export and silhouettes without materializing CPU patches", async () => {
    await models();
    gpu.setDeformationPhase(-0.5);
    const writer = spyOn(gpu, "writeShellSurface").and.callThrough();
    const prepare = spyOn(gpu.shellGpu, "ensureFrame").and.callThrough();
    const crop = gpu.renderRegionCrop(
      { x: 0, y: 0, width: 1, height: 1 },
      { maxEdge: 160, maxPixels: 25600 },
    );
    expect(crop.dataUrl.startsWith("data:image/png")).toBe(true);
    expect(prepare).toHaveBeenCalled();
    expect(gpu.deformation.phase).toBe(-0.5);
    gpu.rasterizedModelScreenRect({ x: 0, y: 0, width: 1, height: 1 });
    expect(writer).not.toHaveBeenCalled();
    expect(gpu.shellGpu.factor).toBe(gpu.deformation.factor);
  });

  it("restores the drawing buffer after an explicit export of a hidden view", async () => {
    await models();
    const original = gpu.canvasRenderer.getSize(new gpu.THREE.Vector2());
    const root = gpu.host.parentElement;
    root.style.display = "none";
    expect(gpu.isViewportDrawable()).toBe(false);
    const crop = gpu.renderRegionCrop(
      { x: 0, y: 0, width: 1, height: 1 },
      { maxEdge: 160, maxPixels: 25600 },
    );
    expect(crop.dataUrl.startsWith("data:image/png")).toBe(true);
    expect(gpu.canvasRenderer.getSize(new gpu.THREE.Vector2())).toEqual(original);
    expect(gpu.viewportPixels()).toEqual({ width: 640, height: 480 });
  });

  it("falls back to the CPU reference when an automatic GPU frame fails", async () => {
    await models();
    const backend = gpu.shellGpu;
    gpu.shellDeformationBackend = "auto";
    spyOn(backend, "ensureFrame").and.throwError("GPU frame failed");
    gpu.setDeformationPhase(-0.5);
    cpu.setDeformationPhase(-0.5);
    expect(() => gpu.ensureGpuShellFrame()).not.toThrow();
    expect(backend.disposed).toBe(true);
    expect(gpu.shellGpu).toBeNull();
    expect(gpu.shellState.gpuUnavailable).toBe("GPU frame failed");
    parity();
    gpu.setDeformationPhase(0.5);
    cpu.setDeformationPhase(0.5);
    parity();
  });

  it("releases GPU state during context loss and rebuilds it when the context is restored", async () => {
    await models();
    const oldBackend = gpu.shellGpu;
    gpu.onContextLost();
    expect(gpu.webglContextLost).toBe(true);
    expect(gpu.isViewportDrawable()).toBe(false);
    expect(oldBackend.disposed).toBe(true);
    expect(gpu.shellGpu).toBeNull();
    gpu.onContextRestored();
    expect(gpu.webglContextLost).toBe(false);
    expect(gpu.shellGpu === oldBackend).toBe(false);
    expect(gpu.shellGpu.disposed).toBe(false);
    gpu.ensureGpuShellFrame();
    gpu.ensureCpuShellGeometry();
    parity();
  });
});
