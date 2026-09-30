// CPU reference for shell kinematics. The GPU backend must reproduce this field.

function prepareShellSurfaceTangents(renderer, state, item, into) {
  if (
    item.nodes.length !== 4 ||
    item.surfaceInterpolation !== "hermite" ||
    item.nodeIndices.some((node) => node < 0) ||
    state.rotationSource !== renderer.deformation?.rotations
  ) {
    return false;
  }
  for (let edge = 0; edge < QUAD_PARAMETRIC_EDGES.length; edge += 1) {
    const [fromCorner, toCorner] = QUAD_PARAMETRIC_EDGES[edge];
    const fromNode = item.nodeIndices[fromCorner];
    const toNode = item.nodeIndices[toCorner];
    const fromAt = fromNode * 3;
    const toAt = toNode * 3;
    const restX = renderer.restPositions[toAt] - renderer.restPositions[fromAt];
    const restY = renderer.restPositions[toAt + 1] - renderer.restPositions[fromAt + 1];
    const restZ = renderer.restPositions[toAt + 2] - renderer.restPositions[fromAt + 2];
    for (let end = 0; end < 2; end += 1) {
      const node = end === 0 ? fromNode : toNode;
      const matrixAt = node * 9;
      const targetAt = (edge * 2 + end) * 3;
      into[targetAt] =
        state.rotationMatrices[matrixAt] * restX +
        state.rotationMatrices[matrixAt + 1] * restY +
        state.rotationMatrices[matrixAt + 2] * restZ;
      into[targetAt + 1] =
        state.rotationMatrices[matrixAt + 3] * restX +
        state.rotationMatrices[matrixAt + 4] * restY +
        state.rotationMatrices[matrixAt + 5] * restZ;
      into[targetAt + 2] =
        state.rotationMatrices[matrixAt + 6] * restX +
        state.rotationMatrices[matrixAt + 7] * restY +
        state.rotationMatrices[matrixAt + 8] * restZ;
    }
  }
  return true;
}

function shellCoonsPosition(renderer, nodes, tangents, s, t, target) {
  for (let axis = 0; axis < 3; axis += 1) {
    const key = axis === 0 ? "x" : axis === 1 ? "y" : "z";
    const bottom = cubicHermite(
      nodes[0][key],
      nodes[1][key],
      tangents[axis],
      tangents[3 + axis],
      s,
    );
    const right = cubicHermite(
      nodes[1][key],
      nodes[2][key],
      tangents[6 + axis],
      tangents[9 + axis],
      t,
    );
    const top = cubicHermite(
      nodes[3][key],
      nodes[2][key],
      tangents[12 + axis],
      tangents[15 + axis],
      s,
    );
    const left = cubicHermite(
      nodes[0][key],
      nodes[3][key],
      tangents[18 + axis],
      tangents[21 + axis],
      t,
    );
    const bilinear =
      (1 - s) * (1 - t) * nodes[0][key] +
      s * (1 - t) * nodes[1][key] +
      s * t * nodes[2][key] +
      (1 - s) * t * nodes[3][key];
    target[axis] = (1 - t) * bottom + t * top + (1 - s) * left + s * right - bilinear;
  }
  return target;
}

function writeSampledShellNormals(renderer, positions, normalValues, layerStart, width) {
  for (let row = 0; row < width; row += 1) {
    const lowerRow = row > 0 ? row - 1 : row;
    const upperRow = row + 1 < width ? row + 1 : row;
    for (let column = 0; column < width; column += 1) {
      const leftColumn = column > 0 ? column - 1 : column;
      const rightColumn = column + 1 < width ? column + 1 : column;
      const left = (layerStart + row * width + leftColumn) * 3;
      const right = (layerStart + row * width + rightColumn) * 3;
      const lower = (layerStart + lowerRow * width + column) * 3;
      const upper = (layerStart + upperRow * width + column) * 3;
      const tangentSX = positions[right] - positions[left];
      const tangentSY = positions[right + 1] - positions[left + 1];
      const tangentSZ = positions[right + 2] - positions[left + 2];
      const tangentTX = positions[upper] - positions[lower];
      const tangentTY = positions[upper + 1] - positions[lower + 1];
      const tangentTZ = positions[upper + 2] - positions[lower + 2];
      let normalX = tangentSY * tangentTZ - tangentSZ * tangentTY;
      let normalY = tangentSZ * tangentTX - tangentSX * tangentTZ;
      let normalZ = tangentSX * tangentTY - tangentSY * tangentTX;
      const length = Math.hypot(normalX, normalY, normalZ);
      if (!(length > 1e-12)) continue;
      normalX /= length;
      normalY /= length;
      normalZ /= length;
      const sample = layerStart + row * width + column;
      normalValues[sample * 3] = normalX;
      normalValues[sample * 3 + 1] = normalY;
      normalValues[sample * 3 + 2] = normalZ;
    }
  }
}

function writeShellSurface(
  renderer,
  state,
  { entityRanges = null, faceToEntityIndex = null, writeEdges = true, allElements = false } = {},
) {
  const { prepared, positions, normalValues, indexValues } = state;
  const edgePositions = entityRanges
    ? state.edgePositions
    : state.edgeBuffer?.array || state.edgePositions;
  const maximumSamples = state.maximumSurfaceSamples;
  let sampleScratch = renderer.shellSurfaceSampleScratch;
  if (!sampleScratch || sampleScratch.capacity < maximumSamples) {
    sampleScratch = renderer.shellSurfaceSampleScratch = {
      capacity: maximumSamples,
      positions: new Float64Array(maximumSamples * 3),
      normals: new Float64Array(maximumSamples * 3),
      middle: new Float64Array(maximumSamples),
      half: new Float64Array(maximumSamples),
      layerStarts: new Int32Array(2),
      tangents: new Float64Array(8 * 3),
      coons: new Float64Array(3),
    };
  }
  let vertexCursor = 0;
  let indexCursor = 0;
  let edgeCursor = 0;
  let faceCursor = 0;
  prepared.forEach((item, entityIndex) => {
    if (!entityRanges && !allElements && !renderer.keepsElement(state.elements[entityIndex])) {
      vertexCursor = item.vertexStart + item.vertexCount;
      faceCursor = item.faceStart + item.faceCount;
      return;
    }
    const { nodes, layers, half, middle, normals, sideWanted, joinWanted, surfaceLayout } = item;
    const {
      weights: surfaceWeights,
      indices: surfaceIndices,
      boundaries: surfaceBoundaries,
      corners: surfaceCorners,
      parameters: surfaceParameters,
    } = surfaceLayout;
    const start = vertexCursor;
    const edgeStart = edgeCursor;
    const indexStart = indexCursor;
    const faceStart = faceCursor;
    // An area element narrowed away keeps every offset it had and is folded
    // onto one of its own corners afterwards. A triangle with no area
    // rasterises to nothing, a line with no length likewise, and neither can
    // be hit by a ray - so the element is gone from the picture without the
    // surface being laid out again around its absence, and without the ranges
    // that index it having to move.
    const hidden = state.elements ? !renderer.keepsElement(state.elements[entityIndex]) : false;
    const surfaceSamples = surfaceWeights.length / nodes.length;
    const curved =
      surfaceParameters &&
      renderer.deformation?.rotations &&
      renderer.deformation.factor !== 0 &&
      renderer.prepareShellSurfaceTangents(state, item, sampleScratch.tangents);
    for (let sample = 0; sample < surfaceSamples; sample += 1) {
      const weightAt = sample * nodes.length;
      const sampleAt = sample * 3;
      let x = 0;
      let y = 0;
      let z = 0;
      let normalX = 0;
      let normalY = 0;
      let normalZ = 0;
      let sampleMiddle = 0;
      let sampleHalf = 0;
      let cornerSample = false;
      for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
        const weight = surfaceWeights[weightAt + nodeIndex];
        if (weight === 1) cornerSample = true;
        const node = nodes[nodeIndex];
        const normal = normals[nodeIndex];
        x += node.x * weight;
        y += node.y * weight;
        z += node.z * weight;
        normalX += normal.x * weight;
        normalY += normal.y * weight;
        normalZ += normal.z * weight;
        sampleMiddle += middle[nodeIndex] * weight;
        sampleHalf += (half ? half[nodeIndex] : 0) * weight;
      }
      if (curved) {
        const s = surfaceParameters[sample * 2];
        const t = surfaceParameters[sample * 2 + 1];
        const coons = renderer.shellCoonsPosition(
          nodes,
          sampleScratch.tangents,
          s,
          t,
          sampleScratch.coons,
        );
        x = coons[0];
        y = coons[1];
        z = coons[2];
      }
      const normalLength = Math.hypot(normalX, normalY, normalZ);
      // A corner must be bit-identical to the separately stored mesh edge
      // endpoint. Re-normalising an already unit corner director changes a
      // few float bits and lets the fill win random depth samples along an
      // otherwise coincident line during animation.
      if (!cornerSample && normalLength > 1e-9) {
        normalX /= normalLength;
        normalY /= normalLength;
        normalZ /= normalLength;
      }
      sampleScratch.positions[sampleAt] = x;
      sampleScratch.positions[sampleAt + 1] = y;
      sampleScratch.positions[sampleAt + 2] = z;
      sampleScratch.normals[sampleAt] = normalX;
      sampleScratch.normals[sampleAt + 1] = normalY;
      sampleScratch.normals[sampleAt + 2] = normalZ;
      sampleScratch.middle[sample] = sampleMiddle;
      sampleScratch.half[sample] = sampleHalf;
    }
    for (let layer = 0; layer < layers; layer += 1) {
      const away = layers === 1 ? 0 : layer === 0 ? 1 : -1;
      const layerStart = vertexCursor;
      sampleScratch.layerStarts[layer] = layerStart;
      for (let sample = 0; sample < surfaceSamples; sample += 1) {
        const sampleAt = sample * 3;
        const normalX = sampleScratch.normals[sampleAt];
        const normalY = sampleScratch.normals[sampleAt + 1];
        const normalZ = sampleScratch.normals[sampleAt + 2];
        const side = sampleScratch.middle[sample] + away * sampleScratch.half[sample];
        positions[vertexCursor * 3] = sampleScratch.positions[sampleAt] + normalX * side;
        positions[vertexCursor * 3 + 1] = sampleScratch.positions[sampleAt + 1] + normalY * side;
        positions[vertexCursor * 3 + 2] = sampleScratch.positions[sampleAt + 2] + normalZ * side;
        normalValues[vertexCursor * 3] = normalX;
        normalValues[vertexCursor * 3 + 1] = normalY;
        normalValues[vertexCursor * 3 + 2] = normalZ;
        vertexCursor += 1;
      }
      if (surfaceLayout.width) {
        renderer.writeSampledShellNormals(positions, normalValues, layerStart, surfaceLayout.width);
      }
      if (entityRanges) {
        for (let index = 0; index < surfaceIndices.length; index += 1) {
          indexValues[indexCursor] = layerStart + surfaceIndices[index];
          indexCursor += 1;
          if ((index + 1) % 3 === 0) {
            if (faceToEntityIndex) faceToEntityIndex[faceCursor] = entityIndex;
            faceCursor += 1;
          }
        }
      } else {
        faceCursor += surfaceIndices.length / 3;
      }
    }
    if (layers === 2) {
      // Close the solid: one side face per exposed perimeter edge, spanning
      // the two sampled faces. Following the same boundary samples keeps the
      // side attached to a warped Q4 face instead of cutting through it.
      for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
        if (!sideWanted[nodeIndex]) continue;
        const boundary = surfaceBoundaries[nodeIndex];
        const sideStart = vertexCursor;
        for (let layer = 0; layer < 2; layer += 1) {
          for (let along = 0; along < boundary.length; along += 1) {
            const sample = boundary[along];
            const sourceVertex = sampleScratch.layerStarts[layer] + sample;
            const sourceAt = sourceVertex * 3;
            positions[vertexCursor * 3] = positions[sourceAt];
            positions[vertexCursor * 3 + 1] = positions[sourceAt + 1];
            positions[vertexCursor * 3 + 2] = positions[sourceAt + 2];
            const neighbourAlong = along + 1 < boundary.length ? along + 1 : along - 1;
            const neighbour = boundary[neighbourAlong];
            const neighbourAt = (sampleScratch.layerStarts[layer] + neighbour) * 3;
            const direction = along + 1 < boundary.length ? 1 : -1;
            const tangentX = (positions[neighbourAt] - positions[sourceAt]) * direction;
            const tangentY = (positions[neighbourAt + 1] - positions[sourceAt + 1]) * direction;
            const tangentZ = (positions[neighbourAt + 2] - positions[sourceAt + 2]) * direction;
            const normalX = normalValues[sourceAt];
            const normalY = normalValues[sourceAt + 1];
            const normalZ = normalValues[sourceAt + 2];
            let sideNormalX = normalY * tangentZ - normalZ * tangentY;
            let sideNormalY = normalZ * tangentX - normalX * tangentZ;
            let sideNormalZ = normalX * tangentY - normalY * tangentX;
            const sideNormalLength = Math.hypot(sideNormalX, sideNormalY, sideNormalZ);
            if (sideNormalLength > 1e-9) {
              sideNormalX /= sideNormalLength;
              sideNormalY /= sideNormalLength;
              sideNormalZ /= sideNormalLength;
            }
            normalValues[vertexCursor * 3] = sideNormalX;
            normalValues[vertexCursor * 3 + 1] = sideNormalY;
            normalValues[vertexCursor * 3 + 2] = sideNormalZ;
            vertexCursor += 1;
          }
        }
        for (let segment = 0; segment + 1 < boundary.length; segment += 1) {
          if (entityRanges) {
            const sideCorners = [
              sideStart + segment,
              sideStart + segment + 1,
              sideStart + boundary.length + segment + 1,
              sideStart + boundary.length + segment,
            ];
            for (const triangle of QUAD_FACES) {
              for (const cornerIndex of triangle) {
                indexValues[indexCursor] = sideCorners[cornerIndex];
                indexCursor += 1;
              }
              if (faceToEntityIndex) faceToEntityIndex[faceCursor] = entityIndex;
              faceCursor += 1;
            }
          } else {
            faceCursor += 2;
          }
        }
      }
    }
    if (entityRanges) entityRanges.push({ start, count: vertexCursor - start });
    for (let layer = 0; writeEdges && layer < layers; layer += 1) {
      const layerStart = sampleScratch.layerStarts[layer];
      for (const boundary of surfaceBoundaries) {
        for (let segment = 0; segment + 1 < boundary.length; segment += 1) {
          const from = (layerStart + boundary[segment]) * 3;
          const to = (layerStart + boundary[segment + 1]) * 3;
          edgePositions[edgeCursor * 6] = positions[from];
          edgePositions[edgeCursor * 6 + 1] = positions[from + 1];
          edgePositions[edgeCursor * 6 + 2] = positions[from + 2];
          edgePositions[edgeCursor * 6 + 3] = positions[to];
          edgePositions[edgeCursor * 6 + 4] = positions[to + 1];
          edgePositions[edgeCursor * 6 + 5] = positions[to + 2];
          edgeCursor += 1;
        }
      }
    }
    if (writeEdges && layers === 2) {
      for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
        if (!joinWanted[nodeIndex]) continue;
        const sample = surfaceCorners[nodeIndex];
        const above = (sampleScratch.layerStarts[0] + sample) * 3;
        const below = (sampleScratch.layerStarts[1] + sample) * 3;
        edgePositions[edgeCursor * 6] = positions[above];
        edgePositions[edgeCursor * 6 + 1] = positions[above + 1];
        edgePositions[edgeCursor * 6 + 2] = positions[above + 2];
        edgePositions[edgeCursor * 6 + 3] = positions[below];
        edgePositions[edgeCursor * 6 + 4] = positions[below + 1];
        edgePositions[edgeCursor * 6 + 5] = positions[below + 2];
        edgeCursor += 1;
      }
    }
    if (hidden) {
      const fold = nodes[0];
      for (let vertex = start; vertex < vertexCursor; vertex += 1) {
        positions[vertex * 3] = fold.x;
        positions[vertex * 3 + 1] = fold.y;
        positions[vertex * 3 + 2] = fold.z;
      }
      for (let edge = edgeStart; edge < edgeCursor; edge += 1) {
        for (let part = 0; part < 6; part += 1) {
          edgePositions[edge * 6 + part] =
            part % 3 === 0 ? fold.x : part % 3 === 1 ? fold.y : fold.z;
        }
      }
    }
    if (entityRanges) {
      item.vertexStart = start;
      item.vertexCount = vertexCursor - start;
      item.indexStart = indexStart;
      item.indexCount = indexCursor - indexStart;
      item.faceStart = faceStart;
      item.faceCount = faceCursor - faceStart;
      item.edgeStart = edgeStart;
      item.edgeCount = edgeCursor - edgeStart;
    }
  });
}

function updateShellNormalsFromRotations(renderer, state) {
  const rotations = renderer.deformation.rotations;
  const factor = renderer.deformation.factor;
  const matrices = state.rotationMatrices;
  const parameters = state.rotationParameters;
  if (state.rotationSource !== rotations) {
    for (let node = 0; node < rotations.length / 3; node += 1) {
      const rotationAt = node * 3;
      const parameterAt = node * 4;
      const rx = rotations[rotationAt];
      const ry = rotations[rotationAt + 1];
      const rz = rotations[rotationAt + 2];
      const magnitude = Math.hypot(rx, ry, rz);
      if (magnitude > 1e-12) {
        parameters[parameterAt] = rx / magnitude;
        parameters[parameterAt + 1] = ry / magnitude;
        parameters[parameterAt + 2] = rz / magnitude;
      } else {
        parameters[parameterAt] = 0;
        parameters[parameterAt + 1] = 0;
        parameters[parameterAt + 2] = 0;
      }
      parameters[parameterAt + 3] = magnitude;
    }
    state.rotationSource = rotations;
  }
  for (let node = 0; node < rotations.length / 3; node += 1) {
    const parameterAt = node * 4;
    const matrixAt = node * 9;
    const angle = parameters[parameterAt + 3] * factor;
    if (Math.abs(angle) <= 1e-9) {
      matrices[matrixAt] = 1;
      matrices[matrixAt + 1] = 0;
      matrices[matrixAt + 2] = 0;
      matrices[matrixAt + 3] = 0;
      matrices[matrixAt + 4] = 1;
      matrices[matrixAt + 5] = 0;
      matrices[matrixAt + 6] = 0;
      matrices[matrixAt + 7] = 0;
      matrices[matrixAt + 8] = 1;
      continue;
    }
    const x = parameters[parameterAt];
    const y = parameters[parameterAt + 1];
    const z = parameters[parameterAt + 2];
    const sine = Math.sin(angle);
    const cosine = Math.cos(angle);
    const oneMinusCosine = 1 - cosine;
    matrices[matrixAt] = cosine + x * x * oneMinusCosine;
    matrices[matrixAt + 1] = x * y * oneMinusCosine - z * sine;
    matrices[matrixAt + 2] = x * z * oneMinusCosine + y * sine;
    matrices[matrixAt + 3] = y * x * oneMinusCosine + z * sine;
    matrices[matrixAt + 4] = cosine + y * y * oneMinusCosine;
    matrices[matrixAt + 5] = y * z * oneMinusCosine - x * sine;
    matrices[matrixAt + 6] = z * x * oneMinusCosine - y * sine;
    matrices[matrixAt + 7] = z * y * oneMinusCosine + x * sine;
    matrices[matrixAt + 8] = cosine + z * z * oneMinusCosine;
  }

  let corner = 0;
  for (const item of state.prepared) {
    for (const target of item.normals) {
      const from = corner * 3;
      const node = state.nodeIndices[corner];
      let x = state.restNormals[from];
      let y = state.restNormals[from + 1];
      let z = state.restNormals[from + 2];
      if (node >= 0) {
        const matrixAt = node * 9;
        const rotatedX =
          matrices[matrixAt] * x + matrices[matrixAt + 1] * y + matrices[matrixAt + 2] * z;
        const rotatedY =
          matrices[matrixAt + 3] * x + matrices[matrixAt + 4] * y + matrices[matrixAt + 5] * z;
        const rotatedZ =
          matrices[matrixAt + 6] * x + matrices[matrixAt + 7] * y + matrices[matrixAt + 8] * z;
        x = rotatedX;
        y = rotatedY;
        z = rotatedZ;
      }
      target.x = x;
      target.y = y;
      target.z = z;
      corner += 1;
    }
  }
}

function updateShellNormals(renderer, state) {
  const prepared = state.prepared;
  const scratch = (renderer.shellNormalScratch ||= { x: 0, y: 0, z: 0 });
  for (let item = 0; item < prepared.length; item += 1) {
    if (!renderer.keepsElement(state.elements[item])) continue;
    const nodes = prepared[item].nodes;
    const normals = prepared[item].normals;
    for (let at = 0; at < nodes.length; at += 1) {
      const normal = cornerNormalAt(nodes, at, scratch);
      const target = normals[at];
      if (!normal) {
        target.x = 0;
        target.y = 0;
        target.z = 0;
        continue;
      }
      target.x = normal.x;
      target.y = normal.y;
      target.z = normal.z;
    }
  }
}

// The wheel only needs the coarse proxy's corners and centre. Materialize
// those vertices without evaluating every sampled patch and side wall.
function writeShellProxy(renderer, state) {
  const scratch = (renderer.shellProxyScratch ||= {
    tangents: new Float64Array(24),
    coons: new Float64Array(3),
  });
  for (const entity of state.activeElementIndices) {
    const item = state.prepared[entity];
    const { nodes, normals, middle, half, layers, surfaceLayout } = item;
    const samples = surfaceLayout.weights.length / nodes.length;
    let vertices = item.proxyVertices;
    if (!vertices) {
      const range = state.zoomEntityRanges[entity];
      vertices = item.proxyVertices = [
        ...new Set(state.zoomIndices.subarray(range.start, range.start + range.count)),
      ];
    }
    const curved =
      surfaceLayout.parameters &&
      renderer.deformation?.rotations &&
      renderer.deformation.factor !== 0 &&
      renderer.prepareShellSurfaceTangents(state, item, scratch.tangents);
    for (const vertex of vertices) {
      const local = vertex - item.vertexStart;
      const sample = local % samples;
      const layer = Math.floor(local / samples);
      const weightAt = sample * nodes.length;
      let x = 0,
        y = 0,
        z = 0;
      let nx = 0,
        ny = 0,
        nz = 0;
      let offset = 0,
        thickness = 0;
      let corner = false;
      for (let node = 0; node < nodes.length; node += 1) {
        const weight = surfaceLayout.weights[weightAt + node];
        if (weight === 1) corner = true;
        x += nodes[node].x * weight;
        y += nodes[node].y * weight;
        z += nodes[node].z * weight;
        nx += normals[node].x * weight;
        ny += normals[node].y * weight;
        nz += normals[node].z * weight;
        offset += middle[node] * weight;
        thickness += (half ? half[node] : 0) * weight;
      }
      if (curved) {
        const p = renderer.shellCoonsPosition(
          nodes,
          scratch.tangents,
          surfaceLayout.parameters[sample * 2],
          surfaceLayout.parameters[sample * 2 + 1],
          scratch.coons,
        );
        x = p[0];
        y = p[1];
        z = p[2];
      }
      const length = Math.hypot(nx, ny, nz);
      if (!corner && length > 1e-9) {
        nx /= length;
        ny /= length;
        nz /= length;
      }
      const side = offset + (layers === 1 ? 0 : layer === 0 ? thickness : -thickness);
      state.positions[vertex * 3] = x + nx * side;
      state.positions[vertex * 3 + 1] = y + ny * side;
      state.positions[vertex * 3 + 2] = z + nz * side;
    }
  }
}

function cubicHermite(start, end, startTangent, endTangent, fraction) {
  const t2 = fraction * fraction;
  const t3 = t2 * fraction;
  return (
    (2 * t3 - 3 * t2 + 1) * start +
    (t3 - 2 * t2 + fraction) * startTangent +
    (-2 * t3 + 3 * t2) * end +
    (t3 - t2) * endTangent
  );
}

function cornerNormalAt(nodes, index, target = null) {
  const corner = nodes[index];
  const next = nodes[(index + 1) % nodes.length];
  const previous = nodes[(index + nodes.length - 1) % nodes.length];
  const ax = next.x - corner.x;
  const ay = next.y - corner.y;
  const az = next.z - corner.z;
  const bx = previous.x - corner.x;
  const by = previous.y - corner.y;
  const bz = previous.z - corner.z;
  const x = ay * bz - az * by;
  const y = az * bx - ax * bz;
  const z = ax * by - ay * bx;
  const length = Math.sqrt(x * x + y * y + z * z);
  if (!(length > 0)) return null;
  const normal = target || { x: 0, y: 0, z: 0 };
  normal.x = x / length;
  normal.y = y / length;
  normal.z = z / length;
  return normal;
}

const QUAD_PARAMETRIC_EDGES = Object.freeze([
  Object.freeze([0, 1]),
  Object.freeze([1, 2]),
  Object.freeze([3, 2]),
  Object.freeze([0, 3]),
]);

const QUAD_FACES = [
  [0, 1, 2],
  [0, 2, 3],
];

module.exports = {
  writeShellProxy,
  prepareShellSurfaceTangents,
  shellCoonsPosition,
  writeSampledShellNormals,
  writeShellSurface,
  updateShellNormalsFromRotations,
  updateShellNormals,
  cornerNormalAt,
};
