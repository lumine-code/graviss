// How much of an element is drawn: its reference line, its cross-section, or the
// section with area elements given their real thickness. The order is the cycle
// a hand reaches for, from least to most drawn.

const DETAIL_LEVELS = Object.freeze(["axis", "section", "full"]);

module.exports = { DETAIL_LEVELS };
