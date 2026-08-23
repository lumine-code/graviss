// The ramp a result is read through.
//
// Blue through cyan, green and yellow to red, which is what every analysis tool
// draws a field in and what an engineer reads without a second thought. It is
// not the most perceptually even ramp there is, and a monotone one would order
// the values better - but a legend is read against a convention, and a model
// drawn in a ramp nobody recognises is one whose colours have to be looked up
// rather than known.

const STOPS = Object.freeze([
  Object.freeze([0.169, 0.294, 0.608]),
  Object.freeze([0.18, 0.698, 0.784]),
  Object.freeze([0.31, 0.749, 0.353]),
  Object.freeze([0.949, 0.773, 0.239]),
  Object.freeze([0.851, 0.267, 0.212]),
]);

// The colour at a fraction of the way up the scale, as red, green and blue in
// nought-to-one. Anything off the ends takes the end it went off, so a value
// that should not exist is still drawn as something rather than as black.
function sampleColorScale(fraction) {
  if (!Number.isFinite(fraction)) return [...STOPS[0]];
  const clamped = Math.min(1, Math.max(0, fraction));
  const position = clamped * (STOPS.length - 1);
  const lower = Math.min(STOPS.length - 2, Math.floor(position));
  const within = position - lower;
  const from = STOPS[lower];
  const to = STOPS[lower + 1];
  return [
    from[0] + (to[0] - from[0]) * within,
    from[1] + (to[1] - from[1]) * within,
    from[2] + (to[2] - from[2]) * within,
  ];
}

// The stops as CSS colours, for a legend drawn as a gradient rather than as a
// row of samples.
function colorScaleStops() {
  return STOPS.map(([red, green, blue]) => {
    const channel = (value) => Math.round(value * 255);
    return `rgb(${channel(red)}, ${channel(green)}, ${channel(blue)})`;
  });
}

module.exports = { STOPS, colorScaleStops, sampleColorScale };
