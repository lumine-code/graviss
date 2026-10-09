// The body atlas is the common source of positions for fills and wide edges.
// Normals are a second pass: sampled surface normals need neighbouring body
// positions, and a wall uses that surface normal rather than its director.
const COMPUTE_VERTEX = `
precision highp float;
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const COMPUTE_COMMON = `
precision highp float;
precision highp int;
precision highp sampler2D;
uniform int gravissOutputWidth;
uniform int gravissOutputCount;
uniform float gravissFactor;
uniform int gravissNormalMode;
uniform bool gravissHasRotations;
uniform bool gravissHasFilter;
uniform sampler2D gravissVisibility;
uniform sampler2D gravissRestNodes;
uniform sampler2D gravissNodeField;
uniform sampler2D gravissNodePositions;
uniform sampler2D gravissNodeTrig;
uniform sampler2D gravissCornerRecords;
uniform sampler2D gravissCornerPositions;
uniform sampler2D gravissCornerDirectors;
uniform sampler2D gravissTangentRecipes;
uniform sampler2D gravissTangents;
uniform sampler2D gravissPositionRecipes;
uniform sampler2D gravissElementRecords;
uniform sampler2D gravissBodyPositions;
uniform sampler2D gravissBodyDirectors;
uniform sampler2D gravissNormalRecipes;
vec4 gravissFetch(sampler2D atlas, int index) {
  int width = textureSize(atlas, 0).x;
  return texelFetch(atlas, ivec2(index % width, index / width), 0);
}
bool gravissHidden(int element) {
  return gravissHasFilter && gravissFetch(gravissVisibility, element).x < 0.5;
}
int gravissOutputIndex() {
  return int(gl_FragCoord.y) * gravissOutputWidth + int(gl_FragCoord.x);
}
vec3 gravissRotate(vec3 value, int node) {
  vec3 axis = gravissFetch(gravissNodeField, node * 2 + 1).xyz;
  vec3 trig = gravissFetch(gravissNodeTrig, node).xyz;
  // Row coefficients match the CPU's Rodrigues matrix, including the small
  // angle identity branch. Do not normalize its already aligned axis again.
  float sine = trig.x;
  float cosine = trig.y;
  float rest = trig.z;
  return vec3(
    (cosine + axis.x * axis.x * rest) * value.x +
      (axis.x * axis.y * rest - axis.z * sine) * value.y +
      (axis.x * axis.z * rest + axis.y * sine) * value.z,
    (axis.y * axis.x * rest + axis.z * sine) * value.x +
      (cosine + axis.y * axis.y * rest) * value.y +
      (axis.y * axis.z * rest - axis.x * sine) * value.z,
    (axis.z * axis.x * rest - axis.y * sine) * value.x +
      (axis.z * axis.y * rest + axis.x * sine) * value.y +
      (cosine + axis.z * axis.z * rest) * value.z
  );
}
`;

const NODE_FRAGMENT = `${COMPUTE_COMMON}
layout(location = 0) out vec4 gravissPosition;
layout(location = 1) out vec4 gravissTrig;
void main() {
  int index = gravissOutputIndex();
  if (index >= gravissOutputCount) {
    gravissPosition = vec4(0.0);
    gravissTrig = vec4(0.0, 1.0, 0.0, 0.0);
    return;
  }
  vec3 rest = gravissFetch(gravissRestNodes, index).xyz;
  vec3 move = gravissFetch(gravissNodeField, index * 2).xyz;
  float angle = gravissFetch(gravissNodeField, index * 2 + 1).w * gravissFactor;
  gravissPosition = vec4(rest + move * gravissFactor, 1.0);
  // Keep the pair on the unit circle even when a software driver approximates
  // sine and cosine independently, so Rodrigues remains a rigid rotation.
  vec2 rotation = normalize(vec2(sin(angle), cos(angle)));
  gravissTrig = abs(angle) <= 1e-9
    ? vec4(0.0, 1.0, 0.0, 0.0)
    : vec4(rotation.x, rotation.y, 1.0 - rotation.y, 0.0);
}
`;

const CORNER_FRAGMENT = `${COMPUTE_COMMON}
layout(location = 0) out vec4 gravissPosition;
layout(location = 1) out vec4 gravissDirector;
void main() {
  int index = gravissOutputIndex();
  if (index >= gravissOutputCount) {
    gravissPosition = vec4(0.0);
    gravissDirector = vec4(0.0);
    return;
  }
  vec4 own = gravissFetch(gravissCornerRecords, index * 2);
  vec4 neighbours = gravissFetch(gravissCornerRecords, index * 2 + 1);
  if (gravissHidden(int(neighbours.z))) discard;
  int node = int(own.w);
  vec3 point = gravissFetch(gravissNodePositions, node).xyz;
  vec3 normal = own.xyz;
  if (gravissNormalMode == 1) {
    normal = gravissRotate(normal, node);
  } else if (gravissNormalMode == 2) {
    vec3 previous = gravissFetch(gravissNodePositions, int(neighbours.x)).xyz;
    vec3 next = gravissFetch(gravissNodePositions, int(neighbours.y)).xyz;
    normal = cross(next - point, previous - point);
    float length = length(normal);
    normal = length > 0.0 ? normal / length : vec3(0.0);
  }
  gravissPosition = vec4(point, 1.0);
  gravissDirector = vec4(normal, 1.0);
}
`;

const TANGENT_FRAGMENT = `${COMPUTE_COMMON}
layout(location = 0) out vec4 gravissTangent;
void main() {
  int index = gravissOutputIndex();
  if (index >= gravissOutputCount) {
    gravissTangent = vec4(0.0);
    return;
  }
  vec4 recipe = gravissFetch(gravissTangentRecipes, index);
  if (gravissHidden(int(recipe.w))) discard;
  vec3 edge = gravissFetch(gravissRestNodes, int(recipe.y)).xyz -
    gravissFetch(gravissRestNodes, int(recipe.x)).xyz;
  // Shell Hermite tangents are rotated reference edges, with their original
  // length. Normalizing them would change the formulation the provider chose.
  gravissTangent = vec4(gravissRotate(edge, int(recipe.z)), 1.0);
}
`;

const POSITION_FRAGMENT = `${COMPUTE_COMMON}
layout(location = 0) out vec4 gravissPosition;
layout(location = 1) out vec4 gravissDirector;
vec3 gravissHermite(vec3 start, vec3 end, vec3 first, vec3 last, float t) {
  float t2 = t * t;
  float t3 = t2 * t;
  return (2.0 * t3 - 3.0 * t2 + 1.0) * start +
    (t3 - 2.0 * t2 + t) * first +
    (-2.0 * t3 + 3.0 * t2) * end + (t3 - t2) * last;
}
void main() {
  int index = gravissOutputIndex();
  if (index >= gravissOutputCount) {
    gravissPosition = vec4(0.0);
    gravissDirector = vec4(0.0);
    return;
  }
  vec4 recipe = gravissFetch(gravissPositionRecipes, index * 3);
  if (gravissHidden(int(recipe.w))) discard;
  vec4 weights = gravissFetch(gravissPositionRecipes, index * 3 + 1);
  vec4 detail = gravissFetch(gravissPositionRecipes, index * 3 + 2);
  int firstCorner = int(recipe.x);
  int corners = int(recipe.y);
  vec3 points[4];
  vec3 point = vec3(0.0);
  vec3 director = vec3(0.0);
  bool atCorner = false;
  for (int corner = 0; corner < 4; ++corner) {
    points[corner] = vec3(0.0);
    if (corner < corners) {
      points[corner] = gravissFetch(gravissCornerPositions, firstCorner + corner).xyz;
      point += points[corner] * weights[corner];
      director += gravissFetch(gravissCornerDirectors, firstCorner + corner).xyz * weights[corner];
      if (weights[corner] == 1.0) atCorner = true;
    }
  }
  int tangentStart = int(gravissFetch(gravissElementRecords, int(recipe.w)).x);
  if (tangentStart >= 0 && gravissHasRotations && gravissFactor != 0.0) {
    float s = detail.z;
    float t = detail.w;
    vec3 bottom = gravissHermite(points[0], points[1],
      gravissFetch(gravissTangents, tangentStart).xyz,
      gravissFetch(gravissTangents, tangentStart + 1).xyz, s);
    vec3 right = gravissHermite(points[1], points[2],
      gravissFetch(gravissTangents, tangentStart + 2).xyz,
      gravissFetch(gravissTangents, tangentStart + 3).xyz, t);
    vec3 top = gravissHermite(points[3], points[2],
      gravissFetch(gravissTangents, tangentStart + 4).xyz,
      gravissFetch(gravissTangents, tangentStart + 5).xyz, s);
    vec3 left = gravissHermite(points[0], points[3],
      gravissFetch(gravissTangents, tangentStart + 6).xyz,
      gravissFetch(gravissTangents, tangentStart + 7).xyz, t);
    vec3 bilinear = (1.0 - s) * (1.0 - t) * points[0] +
      s * (1.0 - t) * points[1] + s * t * points[2] + (1.0 - s) * t * points[3];
    point = (1.0 - t) * bottom + t * top + (1.0 - s) * left + s * right - bilinear;
  }
  float normalLength = length(director);
  if (!atCorner && normalLength > 1e-9) director /= normalLength;
  gravissPosition = vec4(point + director * (detail.x + recipe.z * detail.y), 1.0);
  gravissDirector = vec4(director, 1.0);
}
`;

const NORMAL_FRAGMENT = `${COMPUTE_COMMON}
layout(location = 0) out vec4 gravissNormal;
vec3 gravissBodyNormal(int vertex) {
  vec4 recipe = gravissFetch(gravissNormalRecipes, vertex * 2);
  vec4 neighbours = gravissFetch(gravissNormalRecipes, vertex * 2 + 1);
  vec3 normal = gravissFetch(gravissBodyDirectors, int(recipe.x)).xyz;
  if (neighbours.x >= 0.0) {
    vec3 left = gravissFetch(gravissBodyPositions, int(neighbours.x)).xyz;
    vec3 right = gravissFetch(gravissBodyPositions, int(neighbours.y)).xyz;
    vec3 lower = gravissFetch(gravissBodyPositions, int(neighbours.z)).xyz;
    vec3 upper = gravissFetch(gravissBodyPositions, int(neighbours.w)).xyz;
    vec3 sampled = cross(right - left, upper - lower);
    float magnitude = length(sampled);
    if (magnitude > 1e-12) normal = sampled / magnitude;
  }
  return normal;
}
void main() {
  int index = gravissOutputIndex();
  if (index >= gravissOutputCount) { gravissNormal = vec4(0.0); return; }
  vec4 recipe = gravissFetch(gravissNormalRecipes, index * 2);
  if (gravissHasFilter) {
    int element = int(gravissFetch(gravissPositionRecipes, int(recipe.x) * 3).w);
    if (gravissHidden(element)) discard;
  }
  vec3 normal;
  if (recipe.w == 0.0) {
    normal = gravissBodyNormal(index);
  } else {
    vec3 own = gravissFetch(gravissBodyPositions, int(recipe.x)).xyz;
    vec3 neighbour = gravissFetch(gravissBodyPositions, int(recipe.z)).xyz;
    normal = cross(gravissBodyNormal(int(recipe.y)), (neighbour - own) * recipe.w);
    float magnitude = length(normal);
    if (magnitude > 1e-9) normal /= magnitude;
  }
  gravissNormal = vec4(normal, 1.0);
}
`;

const DRAW_DECLARATIONS = `
precision highp sampler2D;
uniform sampler2D gravissShellPositions;
uniform sampler2D gravissShellNormals;
uniform sampler2D gravissShellFilter;
uniform sampler2D gravissShellElements;
uniform sampler2D gravissShellNodes;
vec4 gravissShellFetch(sampler2D atlas, int index) {
  int width = textureSize(atlas, 0).x;
  return texelFetch(atlas, ivec2(index % width, index / width), 0);
}
vec3 gravissShellPosition(float positionIndex, float elementIndex) {
  int element = int(elementIndex);
  vec3 point = gravissShellFetch(gravissShellPositions, int(positionIndex)).xyz;
  if (gravissShellFetch(gravissShellFilter, element).x < 0.5) {
    int node = int(gravissShellFetch(gravissShellElements, element).y);
    point = gravissShellFetch(gravissShellNodes, node).xyz;
  }
  return point;
}
`;

module.exports = {
  COMPUTE_VERTEX,
  CORNER_FRAGMENT,
  DRAW_DECLARATIONS,
  NODE_FRAGMENT,
  NORMAL_FRAGMENT,
  POSITION_FRAGMENT,
  TANGENT_FRAGMENT,
};
