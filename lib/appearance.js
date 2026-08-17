// One blue engineering family across every scheme, with real tonal separation
// between the surface elements, the members extruded from them, and the mesh
// lines that describe both. The schemes differ in the background they sit on
// and in how far the family has to move to stay readable against it.

const APPEARANCES = Object.freeze({
  cloud: Object.freeze({
    label: "Cloud",
    background: 0xdcedfa,
    member: 0x2b6699,
    shell: 0x5f9acb,
    shellEdge: 0x0d2942,
    node: 0x2f9e44,
    support: 0x00a9e8,
    spring: 0xc2703a,
    coupling: 0x8a5bb5,
    grid: 0xa3bcca,
    gridCenter: 0x6d8a9a,
    cubeFace: 0xf4f9fd,
    cubeBorder: 0x4a7ea6,
    cubeText: 0x1d4b6d,
  }),
  midnight: Object.freeze({
    label: "Midnight",
    background: 0x101b24,
    member: 0x8fc4ea,
    shell: 0x39749f,
    shellEdge: 0xbcd6e6,
    node: 0x5fd98a,
    support: 0x22b9e9,
    spring: 0xf0a468,
    coupling: 0xc7a0ee,
    grid: 0x3a4c58,
    gridCenter: 0x5f7a89,
    cubeFace: 0x2b3f4c,
    cubeBorder: 0x7fa8c2,
    cubeText: 0xdcecf5,
  }),
  paper: Object.freeze({
    label: "Paper",
    background: 0xeee9df,
    member: 0x28587e,
    shell: 0x5d94bb,
    shellEdge: 0x14303f,
    node: 0x2f8f47,
    support: 0x007da9,
    spring: 0xb3652f,
    coupling: 0x7a4da6,
    grid: 0xb3b1a6,
    gridCenter: 0x7d8378,
    cubeFace: 0xf3efe6,
    cubeBorder: 0x4f7288,
    cubeText: 0x27485c,
  }),
  white: Object.freeze({
    label: "White",
    background: 0xffffff,
    member: 0x2b6699,
    shell: 0x5f9acb,
    shellEdge: 0x0d2942,
    node: 0x2f9e44,
    support: 0x00a9e8,
    spring: 0xc2703a,
    coupling: 0x8a5bb5,
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
