// One blue engineering family across every scheme, with real tonal separation
// between the surface elements, the members extruded from them, and the mesh
// lines that describe both. The schemes differ in the background they sit on
// and in how far the family has to move to stay readable against it.
//
// The family sits light. A model is mostly its own elements, and a dark one
// reads as a mass of ink rather than as a structure standing in a room — the
// edge lines carry the definition instead, which is why they are the one part
// that stayed dark.

const APPEARANCES = Object.freeze({
  cloud: Object.freeze({
    label: "Cloud",
    background: 0xdcedfa,
    member: 0x5e8bb1,
    shell: 0x85b2d7,
    shellEdge: 0x2a4359,
    node: 0x61b571,
    support: 0x3dbeee,
    spring: 0x76c043,
    coupling: 0xe08a4a,
    grid: 0xa3bcca,
    gridCenter: 0x6d8a9a,
    cubeFace: 0xf4f9fd,
    cubeBorder: 0x4a7ea6,
    cubeText: 0x1d4b6d,
  }),
  midnight: Object.freeze({
    label: "Midnight",
    background: 0x101b24,
    member: 0xaad2ef,
    shell: 0x6995b6,
    shellEdge: 0xc4dbe9,
    node: 0x85e2a6,
    support: 0x57caee,
    spring: 0x9ad86a,
    coupling: 0xf3a86a,
    grid: 0x3a4c58,
    gridCenter: 0x5f7a89,
    cubeFace: 0x2b3f4c,
    cubeBorder: 0x7fa8c2,
    cubeText: 0xdcecf5,
  }),
  paper: Object.freeze({
    label: "Paper",
    background: 0xeee9df,
    member: 0x5c809d,
    shell: 0x84aecb,
    shellEdge: 0x304956,
    node: 0x61aa73,
    support: 0x3d9cbe,
    spring: 0x6aad3c,
    coupling: 0xd07a38,
    grid: 0xb3b1a6,
    gridCenter: 0x7d8378,
    cubeFace: 0xf3efe6,
    cubeBorder: 0x4f7288,
    cubeText: 0x27485c,
  }),
  white: Object.freeze({
    label: "White",
    background: 0xffffff,
    member: 0x5e8bb1,
    shell: 0x85b2d7,
    shellEdge: 0x2a4359,
    node: 0x61b571,
    support: 0x3dbeee,
    spring: 0x76c043,
    coupling: 0xe08a4a,
    grid: 0xc3d2da,
    gridCenter: 0x8ba2ae,
    cubeFace: 0xfbfdfe,
    cubeBorder: 0x4a7ea6,
    cubeText: 0x1d4b6d,
  }),
});

const APPEARANCE_IDS = Object.freeze(Object.keys(APPEARANCES));

function appearanceDefinition(name) {
  return APPEARANCES[name] || APPEARANCES.cloud;
}

module.exports = { APPEARANCES, APPEARANCE_IDS, appearanceDefinition };
