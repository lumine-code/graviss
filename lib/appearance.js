const APPEARANCES = Object.freeze({
  cloud: Object.freeze({
    label: "Cloud",
    background: 0xc9ddeb,
    member: 0xaeb8bc,
    shell: 0x82aebe,
    shellEdge: 0x4f7482,
    node: 0xffffff,
    support: 0x00a9e8,
    grid: 0x78919b,
    gridCenter: 0x526d79,
    cubeFace: 0xdde7eb,
    cubeBorder: 0x6f858f,
    cubeText: 0x405861,
  }),
  midnight: Object.freeze({
    label: "Midnight",
    background: 0x101b24,
    member: 0x53646d,
    shell: 0x276f82,
    shellEdge: 0x6ca8b8,
    node: 0xffffff,
    support: 0x22b9e9,
    grid: 0x526976,
    gridCenter: 0x718b96,
    cubeFace: 0x30434d,
    cubeBorder: 0xa7bac2,
    cubeText: 0xe5f0f3,
  }),
  paper: Object.freeze({
    label: "Paper",
    background: 0xeee9df,
    member: 0xc5c1b8,
    shell: 0xb9b1a4,
    shellEdge: 0x756f65,
    node: 0xffffff,
    support: 0x007da9,
    grid: 0xa8aaa4,
    gridCenter: 0x737d7c,
    cubeFace: 0xe5e1d8,
    cubeBorder: 0x687778,
    cubeText: 0x3e5051,
  }),
  white: Object.freeze({
    label: "White",
    background: 0xffffff,
    member: 0xb4bec2,
    shell: 0xc8d8de,
    shellEdge: 0x708791,
    node: 0xffffff,
    support: 0x00a9e8,
    grid: 0xb8c5ca,
    gridCenter: 0x7b929b,
    cubeFace: 0xf1f5f6,
    cubeBorder: 0x637a84,
    cubeText: 0x334b55,
  }),
});

const APPEARANCE_IDS = Object.freeze(Object.keys(APPEARANCES));

function appearanceDefinition(name) {
  return APPEARANCES[name] || APPEARANCES.cloud;
}

module.exports = { APPEARANCES, APPEARANCE_IDS, appearanceDefinition };
