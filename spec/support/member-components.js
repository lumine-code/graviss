function memberComponents(ids) {
  return ids.map((id) => ({
    id,
    title: `${id} result`,
    group: "Internal forces",
    unit: id.startsWith("M") ? "N·m" : "N",
    displayUnit: id.startsWith("M") ? "kN·m" : "kN",
    displayFactor: 0.001,
    plane: ["My", "Vz"].includes(id) ? "z" : "y",
    directionSign: id === "Mz" ? -1 : 1,
  }));
}

module.exports = { memberComponents };
