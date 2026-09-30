const { cornerNormalAt } = require("./shell-deformation");

function stableIdKey(id) {
  return `${typeof id}:${id}`;
}

function prepareShellTopology(renderer, nodesById, elements, layouts) {
  const {
    TRIANGLE_SURFACE_LAYOUT,
    LINEAR_QUAD_SURFACE_LAYOUT,
    SAMPLED_QUAD_SURFACE_LAYOUT,
    QUAD_SURFACE_LAYOUT,
  } = layouts;
  const prepared = elements.map((element) => {
    const nodes = element.nodeIds.map((nodeId) => nodesById.get(`${typeof nodeId}:${nodeId}`));
    const restNodes = element.nodeIds.map((nodeId) =>
      renderer.restNodesById.get(stableIdKey(nodeId)),
    );
    const nodeIndices = element.nodeIds.map(
      (nodeId) => renderer.nodeIndexById.get(stableIdKey(nodeId)) ?? -1,
    );
    const layers = renderer.shellLayerCount(element);
    const ownNormals = nodes.map(
      (unused, index) => cornerNormalAt(restNodes, index) || { x: 0, y: 0, z: 0 },
    );
    // Half the thickness either side, along the element's own normal — and
    // per node, because an area element can be thicker at one corner than at
    // another. A single number is the same number at every one of them.
    const half = layers === 2 ? elementHalfThickness(element, nodes.length) : null;
    // Where the element's own body sits relative to the nodes it was meshed
    // on. A slab modelled at its top face, a deck sitting on beams: the
    // nodes stay where the analysis put them and the body is drawn where it
    // physically is. Nodes are shared between elements that offset
    // differently, so renderer belongs to the element and never to the node —
    // and it belongs to the body alone: without section rendering the
    // element is the analysis surface itself, and that surface is where the
    // nodes are. Drawn eccentric it would hang half a thickness clear of the
    // supports, springs and couplings that meet it there.
    const middle = renderer.sectionRendering
      ? elementOffsets(element, nodes.length)
      : new Array(nodes.length).fill(0);
    // Displaced along the surface normal at each node, never along one plane
    // for the whole element: a quad's four nodes need not be planar, and a
    // single normal would flatten a warped element onto the plane of its
    // first three corners.
    const normals = ownNormals;
    const surfaceInterpolation =
      element.surfaceInterpolation ?? (nodes.length === 3 ? "linear" : "q4");
    const surfaceLayout =
      nodes.length === 3
        ? TRIANGLE_SURFACE_LAYOUT
        : surfaceInterpolation === "linear"
          ? LINEAR_QUAD_SURFACE_LAYOUT
          : renderer.shellSurfaceSteps > 1
            ? SAMPLED_QUAD_SURFACE_LAYOUT
            : QUAD_SURFACE_LAYOUT;
    const sideKeys =
      layers === 2
        ? nodes.map((unused, index) =>
            sideFaceKey(restNodes, normals, middle, half, index, (index + 1) % nodes.length),
          )
        : null;
    return {
      nodes,
      nodeIndices,
      layers,
      half,
      middle,
      normals,
      sideKeys,
      surfaceLayout,
      surfaceInterpolation,
    };
  });
  // A side face exists to close a body against open air. Where two elements
  // meet with the same displaced corners the body continues through the seam
  // and each element's wall lies exactly on its neighbour's — a coincident
  // twin the depth buffer cannot order, so at distance the seam flickers as
  // one or the other wins pixel by pixel. Neither wall is drawn: a seam both
  // bodies continue through has no wall to show. A genuine step keeps both,
  // because its corners differ by the length of the step.
  const sideFaceOwners = new Map();
  for (const { sideKeys } of prepared) {
    for (const key of sideKeys ?? []) {
      sideFaceOwners.set(key, (sideFaceOwners.get(key) ?? 0) + 1);
    }
  }
  let triangleCount = 0;
  let vertexCount = 0;
  let edgeCount = 0;
  let maximumSurfaceSamples = 0;
  for (const item of prepared) {
    item.sideWanted = item.sideKeys?.map((key) => sideFaceOwners.get(key) === 1) ?? null;
    // The lines that join the two faces mark facet boundaries on the side
    // band, so one is kept while either side face beside it shows; a corner
    // whose walls are all suppressed sits inside the body.
    item.joinWanted =
      item.sideWanted?.map(
        (unused, index, wanted) =>
          wanted[index] || wanted[(index - 1 + wanted.length) % wanted.length],
      ) ?? null;
    const corners = item.nodes.length;
    const samples = item.surfaceLayout.weights.length / corners;
    maximumSurfaceSamples = Math.max(maximumSurfaceSamples, samples);
    triangleCount += (item.surfaceLayout.indices.length / 3) * item.layers;
    vertexCount += samples * item.layers;
    // A thick element is a closed solid: each exposed perimeter edge carries
    // a side face of two triangles between the two parallel faces.
    if (item.layers === 2) {
      for (let side = 0; side < item.sideWanted.length; side += 1) {
        if (!item.sideWanted[side]) continue;
        const boundarySamples = item.surfaceLayout.boundaries[side].length;
        triangleCount += (boundarySamples - 1) * 2;
        vertexCount += boundarySamples * 2;
      }
    }
    for (const boundary of item.surfaceLayout.boundaries) {
      edgeCount += (boundary.length - 1) * item.layers;
    }
    // A solid's side faces need the edges that join its two faces, or each
    // one reads as a single band running the length of the plate rather than
    // as the row of element facets it is.
    if (item.layers === 2) edgeCount += item.joinWanted.filter(Boolean).length;
  }
  return { prepared, vertexCount, triangleCount, edgeCount, maximumSurfaceSamples };
}

const SIDE_FACE_QUANTUM = 1e-6;
function sideFaceKey(nodes, normals, middle, half, from, to) {
  const corner = (at) => {
    const node = nodes[at];
    const normal = normals[at];
    const parts = [];
    for (const side of [middle[at] + half[at], middle[at] - half[at]]) {
      parts.push(
        Math.round((node.x + normal.x * side) / SIDE_FACE_QUANTUM),
        Math.round((node.y + normal.y * side) / SIDE_FACE_QUANTUM),
        Math.round((node.z + normal.z * side) / SIDE_FACE_QUANTUM),
      );
    }
    return parts.join(",");
  };
  const a = corner(from);
  const b = corner(to);
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

module.exports = { prepareShellTopology };

function elementHalfThickness(element, count) {
  const declared = element.thickness;
  if (Array.isArray(declared)) {
    if (!declared.length) return null;
    return Array.from({ length: count }, (unused, index) => {
      const value = declared[Math.min(index, declared.length - 1)];
      return Number.isFinite(value) ? Math.abs(value) / 2 : 0;
    });
  }
  const half = Math.abs(declared || 0) / 2;
  return new Array(count).fill(half);
}

function elementOffsets(element, count) {
  const declared = element.offset;
  if (Array.isArray(declared)) {
    return Array.from({ length: count }, (unused, index) => {
      const value = declared[Math.min(index, declared.length - 1)];
      return Number.isFinite(value) ? value : 0;
    });
  }
  if (!Number.isFinite(declared) || declared === 0) return new Array(count).fill(0);
  return new Array(count).fill(declared);
}
