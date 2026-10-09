const {
  COMPUTE_VERTEX,
  CORNER_FRAGMENT,
  DRAW_DECLARATIONS,
  NODE_FRAGMENT,
  NORMAL_FRAGMENT,
  POSITION_FRAGMENT,
  TANGENT_FRAGMENT,
} = require("./shell-gpu-shaders");

const MAX_EXACT_FLOAT_INDEX = 2 ** 24;
const PARAMETRIC_EDGES = [
  [0, 1],
  [1, 2],
  [3, 2],
  [0, 3],
];

function atlasSize(count, maximum) {
  const usable = Math.max(1, count);
  if (!Number.isSafeInteger(usable) || usable > maximum * maximum) {
    throw new RangeError("Shell GPU atlas exceeds the available texture size");
  }
  const width = Math.min(maximum, 2 ** Math.ceil(Math.log2(Math.sqrt(usable))));
  return { width, height: Math.ceil(usable / width) };
}

function capabilityReason(renderer) {
  const gpu = renderer?.canvasRenderer;
  const capabilities = gpu?.capabilities;
  if (!gpu || !capabilities?.isWebGL2) return "Shell GPU deformation requires WebGL2";
  if (capabilities.maxVertexTextures < 5 || capabilities.maxTextures < 6) {
    return "Shell GPU deformation requires five vertex and six fragment texture units";
  }
  if (!gpu.extensions.has("EXT_color_buffer_float")) {
    return "Shell GPU deformation requires floating point color attachments";
  }
  const context = gpu.getContext();
  if (context.isContextLost()) return "The WebGL context is lost";
  if (context.getParameter(context.MAX_DRAW_BUFFERS) < 2) {
    return "Shell GPU deformation requires two color attachments";
  }
  return null;
}

function write4(array, index, a, b, c, d) {
  const at = index * 4;
  array[at] = a;
  array[at + 1] = b;
  array[at + 2] = c;
  array[at + 3] = d;
}

// Recipes retain the CPU layout, but wall vertices and edge endpoints alias
// their body's texel. There is only one rounding of a shared endpoint.
function buildShellRecipes(renderer, state, makeAtlas) {
  const vertexCount = state.positions.length / 3;
  const edgeCount = state.edgePositions.length / 6;
  const nodeCount = renderer.restPositions.length / 3;
  let cornerCount = 0;
  let bodyCount = 0;
  let tangentCount = 0;
  for (const item of state.prepared) {
    cornerCount += item.nodes.length;
    bodyCount += (item.surfaceLayout.weights.length / item.nodes.length) * item.layers;
    if (item.surfaceInterpolation === "hermite" && item.surfaceLayout.parameters) {
      tangentCount += 8;
    }
  }
  if (Math.max(vertexCount, bodyCount, cornerCount, nodeCount) >= MAX_EXACT_FLOAT_INDEX) {
    throw new RangeError("Shell GPU indices exceed exact Float32 integer precision");
  }
  const corners = makeAtlas(cornerCount * 2);
  const elements = makeAtlas(state.prepared.length);
  const positionRecipes = makeAtlas(bodyCount * 3);
  const normalRecipes = makeAtlas(vertexCount * 2);
  const tangentRecipes = makeAtlas(tangentCount);
  const vertexAliases = new Float32Array(vertexCount);
  const vertexAttributes = new Float32Array(vertexCount * 3);
  const edgeAttributes = new Float32Array(edgeCount * 3);
  const vertexEntities = new Int32Array(vertexCount);
  const edgeEntityRanges = new Array(state.prepared.length);
  let cornerCursor = 0;
  let bodyCursor = 0;
  let vertexCursor = 0;
  let edgeCursor = 0;
  let tangentCursor = 0;
  const vertex = (alias, entity, source, neighbour, direction) => {
    vertexAliases[vertexCursor] = alias;
    vertexEntities[vertexCursor] = entity;
    const at = vertexCursor * 3;
    vertexAttributes[at] = alias;
    vertexAttributes[at + 1] = vertexCursor;
    vertexAttributes[at + 2] = entity;
    write4(normalRecipes.data, vertexCursor * 2, alias, source, neighbour, direction);
    write4(normalRecipes.data, vertexCursor * 2 + 1, -1, -1, -1, -1);
    return vertexCursor++;
  };
  const edge = (from, to, entity) => {
    const at = edgeCursor++ * 3;
    edgeAttributes[at] = from;
    edgeAttributes[at + 1] = to;
    edgeAttributes[at + 2] = entity;
  };
  for (let entity = 0; entity < state.prepared.length; entity += 1) {
    const item = state.prepared[entity];
    const layout = item.surfaceLayout;
    const count = item.nodes.length;
    const samples = layout.weights.length / count;
    const firstCorner = cornerCursor;
    const edgeStart = edgeCursor;
    const nodeIndices = item.nodeIndices || item.nodes.map((node) => renderer.nodeIndex(node.id));
    for (let corner = 0; corner < count; corner += 1) {
      const normal = state.restNormals;
      const at = cornerCursor * 3;
      const own = item.normals[corner];
      write4(
        corners.data,
        cornerCursor * 2,
        normal ? normal[at] : own.x,
        normal ? normal[at + 1] : own.y,
        normal ? normal[at + 2] : own.z,
        nodeIndices[corner],
      );
      write4(
        corners.data,
        cornerCursor * 2 + 1,
        nodeIndices[(corner + count - 1) % count],
        nodeIndices[(corner + 1) % count],
        entity,
        0,
      );
      cornerCursor += 1;
    }
    let tangentStart = -1;
    if (item.surfaceInterpolation === "hermite" && layout.parameters) {
      tangentStart = tangentCursor;
      for (const [from, to] of PARAMETRIC_EDGES) {
        for (const end of [from, to]) {
          write4(
            tangentRecipes.data,
            tangentCursor++,
            nodeIndices[from],
            nodeIndices[to],
            nodeIndices[end],
            entity,
          );
        }
      }
    }
    write4(elements.data, entity, tangentStart, nodeIndices[0], 0, 0);
    const bodyStarts = new Int32Array(item.layers);
    const vertexStarts = new Int32Array(item.layers);
    for (let layer = 0; layer < item.layers; layer += 1) {
      const away = item.layers === 1 ? 0 : layer === 0 ? 1 : -1;
      bodyStarts[layer] = bodyCursor;
      vertexStarts[layer] = vertexCursor;
      for (let sample = 0; sample < samples; sample += 1) {
        const weightAt = sample * count;
        let middle = 0;
        let half = 0;
        for (let corner = 0; corner < count; corner += 1) {
          const weight = layout.weights[weightAt + corner];
          middle += item.middle[corner] * weight;
          half += (item.half?.[corner] ?? 0) * weight;
        }
        write4(positionRecipes.data, bodyCursor * 3, firstCorner, count, away, entity);
        write4(
          positionRecipes.data,
          bodyCursor * 3 + 1,
          layout.weights[weightAt],
          layout.weights[weightAt + 1],
          layout.weights[weightAt + 2],
          count === 4 ? layout.weights[weightAt + 3] : 0,
        );
        write4(
          positionRecipes.data,
          bodyCursor * 3 + 2,
          middle,
          half,
          layout.parameters?.[sample * 2] ?? 0,
          layout.parameters?.[sample * 2 + 1] ?? 0,
        );
        const ownVertex = vertex(bodyCursor++, entity, vertexCursor, 0, 0);
        if (layout.width) {
          const width = layout.width;
          const row = Math.floor(sample / width);
          const column = sample % width;
          const start = bodyStarts[layer];
          write4(
            normalRecipes.data,
            ownVertex * 2 + 1,
            start + row * width + Math.max(0, column - 1),
            start + row * width + Math.min(width - 1, column + 1),
            start + Math.max(0, row - 1) * width + column,
            start + Math.min(width - 1, row + 1) * width + column,
          );
        }
      }
    }
    if (item.layers === 2) {
      for (let side = 0; side < count; side += 1) {
        if (!item.sideWanted[side]) continue;
        const boundary = layout.boundaries[side];
        for (let layer = 0; layer < 2; layer += 1) {
          for (let along = 0; along < boundary.length; along += 1) {
            const sample = boundary[along];
            const next = along + 1 < boundary.length ? along + 1 : along - 1;
            vertex(
              bodyStarts[layer] + sample,
              entity,
              vertexStarts[layer] + sample,
              bodyStarts[layer] + boundary[next],
              along + 1 < boundary.length ? 1 : -1,
            );
          }
        }
      }
    }
    for (let layer = 0; layer < item.layers; layer += 1) {
      for (const boundary of layout.boundaries) {
        for (let along = 0; along + 1 < boundary.length; along += 1) {
          edge(
            bodyStarts[layer] + boundary[along],
            bodyStarts[layer] + boundary[along + 1],
            entity,
          );
        }
      }
    }
    if (item.layers === 2) {
      for (let corner = 0; corner < count; corner += 1) {
        if (item.joinWanted[corner]) {
          const sample = layout.corners[corner];
          edge(bodyStarts[0] + sample, bodyStarts[1] + sample, entity);
        }
      }
    }
    edgeEntityRanges[entity] = { start: edgeStart, count: edgeCursor - edgeStart };
  }
  if (vertexCursor !== vertexCount || edgeCursor !== edgeCount) {
    throw new Error("Shell GPU recipes do not match the CPU topology");
  }
  return {
    corners,
    elements,
    positionRecipes,
    normalRecipes,
    tangentRecipes,
    vertexAliases,
    vertexAttributes,
    edgeAttributes,
    vertexEntities,
    edgeEntityRanges,
    vertexCount,
    bodyCount,
    cornerCount,
    tangentCount,
    nodeCount,
  };
}

class ShellGpuBackend {
  constructor(renderer, state) {
    this.renderer = renderer;
    this.state = state;
    this.THREE = renderer.THREE;
    this.gpu = renderer.canvasRenderer;
    this.resources = [];
    this.installations = [];
    this.disposed = false;
    this.dirty = true;
    this.fieldRows = undefined;
    this.fieldRotations = undefined;
    this.factor = null;
    this.stats = { frames: 0, resultUploads: 0, filterUploads: 0 };
    try {
      this.initialize();
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  initialize() {
    const THREE = this.THREE;
    const context = this.gpu.getContext();
    const viewport = context.getParameter(context.MAX_VIEWPORT_DIMS);
    this.maximumTextureSize = Math.min(
      this.gpu.capabilities.maxTextureSize,
      viewport[0],
      viewport[1],
    );
    this.recipes = buildShellRecipes(this.renderer, this.state, (count) => this.dataAtlas(count));
    const recipes = this.recipes;
    this.restNodes = this.dataAtlas(recipes.nodeCount);
    this.nodeField = this.dataAtlas(recipes.nodeCount * 2);
    this.filter = this.dataAtlas(this.state.prepared.length);
    for (let node = 0; node < recipes.nodeCount; node += 1) {
      const at = node * 3;
      const rest = this.renderer.restPositions;
      write4(this.restNodes.data, node, rest[at], rest[at + 1], rest[at + 2], 0);
    }
    this.nodeTarget = this.target(recipes.nodeCount, 2);
    this.cornerTarget = this.target(recipes.cornerCount, 2);
    this.tangentTarget = this.target(recipes.tangentCount, 1);
    this.bodyTarget = this.target(recipes.bodyCount, 2);
    this.normalTarget = this.target(recipes.vertexCount, 1);
    this.uniforms = {
      gravissFactor: { value: 0 },
      gravissNormalMode: { value: 0 },
      gravissHasRotations: { value: false },
      gravissHasFilter: { value: false },
      gravissVisibility: { value: this.filter.texture },
      gravissRestNodes: { value: this.restNodes.texture },
      gravissNodeField: { value: this.nodeField.texture },
      gravissNodePositions: { value: this.nodeTarget.textures[0] },
      gravissNodeTrig: { value: this.nodeTarget.textures[1] },
      gravissCornerRecords: { value: recipes.corners.texture },
      gravissCornerPositions: { value: this.cornerTarget.textures[0] },
      gravissCornerDirectors: { value: this.cornerTarget.textures[1] },
      gravissTangentRecipes: { value: recipes.tangentRecipes.texture },
      gravissTangents: { value: this.tangentTarget.texture },
      gravissPositionRecipes: { value: recipes.positionRecipes.texture },
      gravissElementRecords: { value: recipes.elements.texture },
      gravissBodyPositions: { value: this.bodyTarget.textures[0] },
      gravissBodyDirectors: { value: this.bodyTarget.textures[1] },
      gravissNormalRecipes: { value: recipes.normalRecipes.texture },
    };
    this.drawUniforms = {
      gravissShellPositions: { value: this.bodyTarget.textures[0] },
      gravissShellNormals: { value: this.normalTarget.texture },
      gravissShellFilter: { value: this.filter.texture },
      gravissShellElements: { value: recipes.elements.texture },
      gravissShellNodes: { value: this.nodeTarget.textures[0] },
    };
    this.triangle = new THREE.BufferGeometry();
    this.triangle.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3),
    );
    this.resources.push(this.triangle);
    this.camera = new THREE.Camera();
    this.passes = [
      this.pass(this.nodeTarget, recipes.nodeCount, NODE_FRAGMENT),
      this.pass(this.cornerTarget, recipes.cornerCount, CORNER_FRAGMENT),
      this.pass(this.tangentTarget, recipes.tangentCount, TANGENT_FRAGMENT),
      this.pass(this.bodyTarget, recipes.bodyCount, POSITION_FRAGMENT),
      this.pass(this.normalTarget, recipes.vertexCount, NORMAL_FRAGMENT),
    ];
    this.setResult(this.renderer.deformation);
    this.syncFilter();
    this.validateFramebuffer();
    this.memory = {
      staticTextureBytes: this.resources.reduce(
        (total, item) => total + (item.isDataTexture ? item.image.data.byteLength : 0),
        0,
      ),
      targetTextureBytes: this.resources.reduce(
        (total, item) =>
          total +
          (item.isWebGLRenderTarget ? item.width * item.height * 16 * item.textures.length : 0),
        0,
      ),
      drawAttributeBytes:
        this.recipes.vertexAttributes.byteLength + this.recipes.edgeAttributes.byteLength,
    };
  }

  dataAtlas(count) {
    const THREE = this.THREE;
    const { width, height } = atlasSize(count, this.maximumTextureSize);
    const data = new Float32Array(width * height * 4);
    const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
    texture.internalFormat = "RGBA32F";
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    this.resources.push(texture);
    return { data, texture, count, width, height };
  }

  target(count, attachments) {
    const THREE = this.THREE;
    const { width, height } = atlasSize(count, this.maximumTextureSize);
    const target = new THREE.WebGLRenderTarget(width, height, {
      count: attachments,
      format: THREE.RGBAFormat,
      type: THREE.FloatType,
      internalFormat: "RGBA32F",
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.resources.push(target);
    return target;
  }

  pass(target, count, fragmentShader) {
    const THREE = this.THREE;
    const material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        ...this.uniforms,
        gravissOutputWidth: { value: target.width },
        gravissOutputCount: { value: count },
      },
      vertexShader: COMPUTE_VERTEX,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });
    this.resources.push(material);
    const mesh = new THREE.Mesh(this.triangle, material);
    mesh.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(mesh);
    return { target, count, scene, material };
  }

  validateFramebuffer() {
    const target = this.gpu.getRenderTarget();
    const cubeFace = this.gpu.getActiveCubeFace();
    const mipLevel = this.gpu.getActiveMipmapLevel();
    try {
      this.gpu.setRenderTarget(this.nodeTarget);
      const context = this.gpu.getContext();
      if (context.checkFramebufferStatus(context.FRAMEBUFFER) !== context.FRAMEBUFFER_COMPLETE) {
        throw new Error("Shell GPU floating point framebuffer is incomplete");
      }
    } finally {
      this.gpu.setRenderTarget(target, cubeFace, mipLevel);
    }
  }

  setResult(deformation) {
    if (this.disposed) return;
    this.deformation = deformation || null;
    const rows = deformation?.rows ?? null;
    const rotations = deformation?.rotations ?? null;
    if (this.fieldRows === rows && this.fieldRotations === rotations) return;
    this.fieldRows = rows;
    this.fieldRotations = rotations;
    this.nodeField.data.fill(0);
    for (let node = 0; node < this.recipes.nodeCount; node += 1) {
      const at = node * 3;
      write4(
        this.nodeField.data,
        node * 2,
        rows?.[at] ?? 0,
        rows?.[at + 1] ?? 0,
        rows?.[at + 2] ?? 0,
        0,
      );
      if (rotations) {
        const x = rotations[at];
        const y = rotations[at + 1];
        const z = rotations[at + 2];
        const magnitude = Math.hypot(x, y, z);
        write4(
          this.nodeField.data,
          node * 2 + 1,
          magnitude > 1e-12 ? x / magnitude : 0,
          magnitude > 1e-12 ? y / magnitude : 0,
          magnitude > 1e-12 ? z / magnitude : 0,
          magnitude,
        );
      }
    }
    this.nodeField.texture.needsUpdate = true;
    this.stats.resultUploads += 1;
    this.markDirty();
  }

  syncFilter() {
    if (this.disposed) return false;
    let changed = false;
    let filtered = false;
    const elements = this.state.elements;
    for (let index = 0; index < this.state.prepared.length; index += 1) {
      const kept = this.renderer.keepsElement?.(elements[index]) === false ? 0 : 1;
      filtered ||= kept === 0;
      const at = index * 4;
      if (this.filter.data[at] !== kept) {
        this.filter.data[at] = kept;
        changed = true;
      }
    }
    if (changed) {
      this.filter.texture.needsUpdate = true;
      this.stats.filterUploads += 1;
      this.markDirty();
    }
    this.uniforms.gravissHasFilter.value = filtered;
    if (this.edgeDrawAttribute && (changed || this.edgeCompactionStale)) {
      const source = this.recipes.edgeAttributes;
      const target = this.edgeDrawAttribute.array;
      let cursor = 0;
      const active = this.state.activeElementIndices || this.state.prepared.keys();
      for (const entity of active) {
        if (filtered && this.filter.data[entity * 4] === 0) continue;
        const range = this.recipes.edgeEntityRanges[entity];
        target.set(source.subarray(range.start * 3, (range.start + range.count) * 3), cursor * 3);
        cursor += range.count;
      }
      this.edgeDrawAttribute.clearUpdateRanges();
      if (cursor) this.edgeDrawAttribute.addUpdateRange(0, cursor * 3);
      this.edgeDrawAttribute.needsUpdate = true;
      this.edgeDrawGeometry.instanceCount = cursor;
      this.edgeCompactionStale = false;
    }
    return changed;
  }

  markDirty() {
    this.dirty = true;
  }

  ensureFrame(deformation = this.deformation) {
    if (this.disposed) return false;
    if (this.gpu.getContext().isContextLost()) throw new Error("The WebGL context is lost");
    this.prepareDrawBounds();
    this.setResult(deformation);
    const factor = deformation?.factor ?? 0;
    if (!Number.isFinite(Math.fround(factor))) {
      throw new RangeError("Shell GPU factor exceeds Float32 range");
    }
    if (!this.dirty && factor === this.factor) return false;
    this.uniforms.gravissFactor.value = factor;
    this.uniforms.gravissHasRotations.value = Boolean(this.fieldRotations);
    this.uniforms.gravissNormalMode.value =
      this.fieldRotations &&
      (this.state.requiresDisplacementNormals || this.state.requiresSurfaceRotations)
        ? 1
        : this.state.requiresDisplacementNormals
          ? 2
          : 0;
    const gpu = this.gpu;
    const previous = {
      target: gpu.getRenderTarget(),
      cubeFace: gpu.getActiveCubeFace(),
      mipLevel: gpu.getActiveMipmapLevel(),
      autoClear: gpu.autoClear,
      xr: gpu.xr.enabled,
      checkShaderErrors: gpu.debug.checkShaderErrors,
      onShaderError: gpu.debug.onShaderError,
    };
    try {
      // Three completes link validation on first use. Eager compile() alone
      // leaves unused passes with pending programs that a rapid topology
      // rebuild would dispose before that check. Compile and check only the
      // passes actually rendered, including one first needed in a later phase.
      gpu.debug.checkShaderErrors = true;
      gpu.debug.onShaderError = (context, program, vertex, fragment) => {
        const message = `Shell GPU shader failed: ${context.getProgramInfoLog(program)} ${context.getShaderInfoLog(vertex)} ${context.getShaderInfoLog(fragment)}`;
        // Throwing interrupts Three's first-use cleanup before it deletes the
        // attached shaders. Mark them for release here; disposing the failed
        // program then releases them along with the rest of this backend.
        context.deleteShader(vertex);
        context.deleteShader(fragment);
        throw new Error(message);
      };
      gpu.xr.enabled = false;
      gpu.autoClear = false;
      for (let index = 0; index < this.passes.length; index += 1) {
        const pass = this.passes[index];
        if (!pass.count || (index === 2 && (!this.fieldRotations || factor === 0))) continue;
        gpu.setRenderTarget(pass.target);
        gpu.render(pass.scene, this.camera);
      }
    } finally {
      gpu.debug.checkShaderErrors = previous.checkShaderErrors;
      gpu.debug.onShaderError = previous.onShaderError;
      gpu.xr.enabled = previous.xr;
      gpu.autoClear = previous.autoClear;
      // setRenderTarget restores that target's physical viewport and scissor.
      // The passes never alter the renderer's logical viewport/scissor: using
      // their setters here would overwrite a target viewport at DPR > 1.
      gpu.setRenderTarget(previous.target, previous.cubeFace, previous.mipLevel);
    }
    if (this.stats.frames === 0) {
      const context = gpu.getContext();
      const error = context.getError();
      if (error !== context.NO_ERROR) {
        throw new Error(`Shell GPU initialization failed with WebGL error ${error}`);
      }
    }
    this.factor = factor;
    this.dirty = false;
    this.stats.frames += 1;
    return true;
  }

  installMaterials(shellMaterial, edgeMaterial, shellGeometry, edgeGeometry) {
    if (this.disposed) return;
    const THREE = this.THREE;
    shellGeometry.setAttribute(
      "gravissShellVertex",
      new THREE.BufferAttribute(this.recipes.vertexAttributes, 3),
    );
    this.edgeDrawAttribute = new THREE.InstancedBufferAttribute(
      this.recipes.edgeAttributes.slice(),
      3,
    );
    this.edgeDrawGeometry = edgeGeometry;
    this.edgeCompactionStale = true;
    edgeGeometry.setAttribute("gravissShellEndpoints", this.edgeDrawAttribute);
    this.patchMaterial(shellMaterial, shellGeometry, "gravissShellVertex", (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          "void main() {",
          `${DRAW_DECLARATIONS}\nattribute vec3 gravissShellVertex;\nvoid main() {`,
        )
        .replace(
          "#include <beginnormal_vertex>",
          `#include <beginnormal_vertex>\nobjectNormal = gravissShellFetch(gravissShellNormals, int(gravissShellVertex.y)).xyz;`,
        )
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>\ntransformed = gravissShellPosition(gravissShellVertex.x, gravissShellVertex.z);`,
        );
    });
    this.patchMaterial(edgeMaterial, edgeGeometry, "gravissShellEndpoints", (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          "void main() {",
          `${DRAW_DECLARATIONS}\nattribute vec3 gravissShellEndpoints;\nvoid main() {`,
        )
        .replace(
          "vec4 start = modelViewMatrix * vec4( instanceStart, 1.0 );",
          "vec4 start = modelViewMatrix * vec4( gravissShellPosition(gravissShellEndpoints.x, gravissShellEndpoints.z), 1.0 );",
        )
        .replace(
          "vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );",
          "vec4 end = modelViewMatrix * vec4( gravissShellPosition(gravissShellEndpoints.y, gravissShellEndpoints.z), 1.0 );",
        );
    });
    this.syncFilter();
  }

  patchMaterial(material, geometry, attribute, patch) {
    const before = material.onBeforeCompile;
    const cacheKey = material.customProgramCacheKey;
    const installation = {
      material,
      geometry,
      attribute,
      before,
      cacheKey,
      sphere: new this.THREE.Sphere(
        new this.THREE.Vector3(...this.renderer.bounds.center),
        Infinity,
      ),
    };
    this.installations.push(installation);
    material.onBeforeCompile = (shader, gpu) => {
      before.call(material, shader, gpu);
      Object.assign(shader.uniforms, this.drawUniforms);
      patch(shader);
    };
    material.customProgramCacheKey = () => `${cacheKey.call(material)}:graviss-shell-gpu-v1`;
    material.needsUpdate = true;
    this.prepareDrawBounds();
  }

  prepareDrawBounds() {
    // Three also asks for a sphere's centre while sorting, even when frustum
    // culling is disabled. An invalidated CPU sphere would scan every stale
    // mirrored vertex before each GPU draw. A conservative sphere needs no
    // scan and never rejects a CPU raycast; precise boxes remain lazy.
    for (const installed of this.installations) {
      installed.geometry.boundingSphere = installed.sphere;
    }
  }

  readTarget(target, attachment = 0) {
    if (this.disposed) throw new Error("Shell GPU backend has been disposed");
    const values = new Float32Array(target.width * target.height * 4);
    this.gpu.readRenderTargetPixels(
      target,
      0,
      0,
      target.width,
      target.height,
      values,
      undefined,
      attachment,
    );
    return values;
  }

  // Readback is diagnostic only. Runtime picking and framing keep the existing
  // CPU evaluator as a lazy reference and never stall on GPU readback.
  readPositions() {
    this.ensureFrame();
    const body = this.readTarget(this.bodyTarget);
    let nodes = null;
    const into = new Float32Array(this.recipes.vertexCount * 3);
    for (let vertex = 0; vertex < this.recipes.vertexCount; vertex += 1) {
      const entity = this.recipes.vertexEntities[vertex];
      let source = body;
      let from = this.recipes.vertexAliases[vertex] * 4;
      if (this.filter.data[entity * 4] === 0) {
        nodes ||= this.readTarget(this.nodeTarget);
        source = nodes;
        from = this.recipes.elements.data[entity * 4 + 1] * 4;
      }
      const to = vertex * 3;
      into[to] = source[from];
      into[to + 1] = source[from + 1];
      into[to + 2] = source[from + 2];
    }
    return into;
  }

  readNormals() {
    this.ensureFrame();
    const values = this.readTarget(this.normalTarget);
    const into = new Float32Array(this.recipes.vertexCount * 3);
    for (let vertex = 0; vertex < this.recipes.vertexCount; vertex += 1) {
      const from = vertex * 4;
      const to = vertex * 3;
      into[to] = values[from];
      into[to + 1] = values[from + 1];
      into[to + 2] = values[from + 2];
    }
    return into;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const installed of this.installations) {
      installed.material.onBeforeCompile = installed.before;
      installed.material.customProgramCacheKey = installed.cacheKey;
      installed.material.needsUpdate = true;
      // Three releases the GPU buffers by walking the attributes still on the
      // geometry. Removing the alias first would orphan its VBO until context
      // destruction. JS mirror arrays survive dispose and CPU fallback can
      // upload its ordinary attributes again on the next draw.
      installed.geometry.dispose();
      installed.geometry.deleteAttribute(installed.attribute);
      installed.geometry.boundingSphere = null;
    }
    for (const resource of this.resources) resource.dispose();
    this.installations.length = 0;
    this.resources.length = 0;
  }
}

function createShellGpuBackend(renderer, state) {
  const reason = capabilityReason(renderer);
  if (reason) return { backend: null, reason };
  try {
    return { backend: new ShellGpuBackend(renderer, state), reason: null };
  } catch (error) {
    return { backend: null, reason: error.message };
  }
}

module.exports = { ShellGpuBackend, atlasSize, buildShellRecipes, createShellGpuBackend };
