const {
  AUTOMATIC_TARGET,
  Deformation,
  SCALE_PRESETS,
  alignToNodes,
  automaticScale,
  extentOf,
  memberBow,
} = require("../lib/deformation");
const { Animation, CYCLE_IDS, defaultCycle, phaseOf } = require("../lib/animation");
const { STOPS, colorScaleStops, sampleColorScale } = require("../lib/color-scale");

const NODES = [
  { id: 1, x: 0, y: 0, z: 0 },
  { id: 2, x: 4, y: 0, z: 0 },
  { id: 3, x: 8, y: 0, z: 0 },
];
const indexOfId = (id) => NODES.findIndex((node) => node.id === id);

function fieldOf(values, ids) {
  return { kind: "displacement", loadCaseId: 1, components: 3, nodes: { ids, values } };
}

describe("automaticScale", () => {
  it("draws the largest displacement as a readable fraction of the model", () => {
    // A millimetre on a thirty-metre bridge is invisible at true size, which is
    // the whole reason a viewer amplifies at all.
    expect(automaticScale(0.001, 30)).toBeCloseTo((30 * AUTOMATIC_TARGET) / 0.001, 6);
    expect(automaticScale(0.001, 30) * 0.001).toBeCloseTo(30 * AUTOMATIC_TARGET, 9);
  });

  it("has no answer for a model that did not move", () => {
    expect(automaticScale(0, 30)).toBeNull();
    expect(automaticScale(0.01, 0)).toBeNull();
    expect(automaticScale(Number.NaN, 30)).toBeNull();
  });

  it("offers zero among its presets, because that is how you see what moved", () => {
    expect(SCALE_PRESETS).toContain(0);
    expect(SCALE_PRESETS).toEqual([0, 0.5, 1, 2, 10, 100, 1000]);
  });
});

describe("alignToNodes", () => {
  it("puts a field that names its nodes into the geometry's own order", () => {
    // The result lists node 3 first; the renderer wants node order.
    const rows = alignToNodes(fieldOf([9, 0, 0, 1, 0, 0], [3, 1]), NODES, indexOfId);
    expect(Array.from(rows)).toEqual([1, 0, 0, 0, 0, 0, 9, 0, 0]);
  });

  it("takes a field that names no nodes as already in that order", () => {
    const rows = alignToNodes(fieldOf([1, 2, 3, 4, 5, 6, 7, 8, 9]), NODES, indexOfId);
    expect(Array.from(rows)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("leaves a node the field says nothing about where it is", () => {
    const rows = alignToNodes(fieldOf([1, 1, 1], [2]), NODES, indexOfId);
    expect(Array.from(rows)).toEqual([0, 0, 0, 1, 1, 1, 0, 0, 0]);
    // A node the result names and the model does not is simply dropped.
    expect(Array.from(alignToNodes(fieldOf([1, 1, 1], [99]), NODES, indexOfId))).toEqual(
      new Array(9).fill(0),
    );
  });

  it("reads six components a node as three translations and three rotations", () => {
    const result = {
      components: 6,
      nodes: { ids: [1], values: [1, 2, 3, 0.1, 0.2, 0.3] },
    };
    expect(Array.from(alignToNodes(result, NODES, indexOfId)).slice(0, 3)).toEqual([1, 2, 3]);
  });
});

describe("Deformation", () => {
  function deformation() {
    return new Deformation({ nodes: NODES, indexOfId, radius: 10 });
  }

  it("moves a model by the scale and the phase together", () => {
    const rest = Float32Array.from([0, 0, 0, 4, 0, 0, 8, 0, 0]);
    const into = new Float32Array(rest.length);
    const moved = deformation().setResult(fieldOf([0, 0, 0, 0, 0, 1, 0, 0, 0]));
    moved.setScale(2);
    moved.setPhase(0.5);
    moved.apply(rest, into);
    expect(Array.from(into)).toEqual([0, 0, 0, 4, 0, 1, 8, 0, 0]);
  });

  it("puts the model back exactly where it was at a scale of zero", () => {
    // Not approximately: a preset of zero is how a user checks what moved, so
    // the rest state has to come back bit for bit.
    const rest = Float32Array.from([0.1, 0.2, 0.3, 4, 0, 0, 8, 0, 0]);
    const into = new Float32Array(rest.length);
    const moved = deformation().setResult(fieldOf([1, 1, 1, 1, 1, 1, 1, 1, 1]));
    moved.setScale(0);
    moved.apply(rest, into);
    expect(Array.from(into)).toEqual(Array.from(rest));
    expect(moved.active).toBe(false);
  });

  it("chooses its own scale until a user chooses one", () => {
    const moved = deformation();
    moved.setResult({ ...fieldOf([0, 0, 0.001], [1]), extent: 0.001 });
    expect(moved.automatic).toBe(true);
    expect(moved.scale).toBeCloseTo((10 * AUTOMATIC_TARGET) / 0.001, 6);

    moved.setScale(100);
    expect(moved.automatic).toBe(false);
    expect(moved.scale).toBe(100);
    // Another case does not take the scale back off the user.
    moved.setResult({ ...fieldOf([0, 0, 0.01], [1]), extent: 0.01 });
    expect(moved.scale).toBe(100);
    // Until they ask for it back.
    moved.setAutomatic(true);
    expect(moved.scale).toBeCloseTo((10 * AUTOMATIC_TARGET) / 0.01, 6);
  });

  it("is the undeformed model with no result at all", () => {
    const rest = Float32Array.from([1, 2, 3]);
    const into = new Float32Array(3);
    const moved = deformation().setResult(null);
    expect(moved.active).toBe(false);
    expect(moved.factor).toBe(0);
    expect(Array.from(moved.apply(rest, into))).toEqual([1, 2, 3]);
  });

  it("measures a field that did not say how far it went", () => {
    expect(extentOf(fieldOf([3, 4, 0, 0, 0, 0, 0, 0, 0]))).toBeCloseTo(5, 6);
    expect(extentOf({ ...fieldOf([1, 1, 1]), extent: 0.5 })).toBe(0.5);
    expect(extentOf(null)).toBe(0);
  });
});

describe("animation cycles", () => {
  it("swings a mode about zero and runs a load case up from it", () => {
    // A mode shape is defined up to a factor, so it has no sign; a load case is
    // a real state of the structure and does.
    expect(defaultCycle({ kind: "eigenmode" })).toBe("pingPong");
    expect(defaultCycle({ kind: "buckling" })).toBe("pingPong");
    expect(defaultCycle({ kind: "linear" })).toBe("thereAndBack");
    expect(defaultCycle(undefined)).toBe("thereAndBack");
  });

  it("puts each cycle where it belongs at every quarter of its period", () => {
    expect(phaseOf("pingPong", 0)).toBeCloseTo(0, 9);
    expect(phaseOf("pingPong", 0.25)).toBeCloseTo(1, 9);
    expect(phaseOf("pingPong", 0.5)).toBeCloseTo(0, 9);
    expect(phaseOf("pingPong", 0.75)).toBeCloseTo(-1, 9);

    expect(phaseOf("thereAndBack", 0)).toBeCloseTo(0, 9);
    expect(phaseOf("thereAndBack", 0.5)).toBeCloseTo(1, 9);
    expect(phaseOf("thereAndBack", 1)).toBeCloseTo(0, 9);

    expect(phaseOf("ramp", 0)).toBeCloseTo(0, 9);
    expect(phaseOf("ramp", 0.9)).toBeCloseTo(0.9, 9);

    // Whole periods away is the same place in the swing.
    expect(phaseOf("pingPong", 3.25)).toBeCloseTo(1, 9);
    expect(CYCLE_IDS).toEqual(["pingPong", "thereAndBack", "ramp", "sweep"]);
  });
});

describe("Animation", () => {
  function driver() {
    const frames = [];
    let time = 0;
    let scheduled = 0;
    const animation = new Animation({
      onFrame: (phase, index) => frames.push([Math.round(phase * 1000) / 1000, index]),
      requestFrame: () => (scheduled += 1),
      now: () => time,
    });
    return {
      animation,
      frames,
      scheduled: () => scheduled,
      at: (next) => {
        time = next;
        return next;
      },
    };
  }

  it("asks for a frame rather than drawing one", () => {
    // Rendering is on demand, so an animation that drew would be drawing behind
    // the renderer's back.
    const { animation, scheduled, at, frames } = driver();
    animation.setPeriod(1000);
    animation.start();
    expect(scheduled()).toBe(1);
    // A quarter of the way through, `thereAndBack` is halfway up: it reaches
    // the full shape at the middle of its period and returns by the end.
    animation.advance(at(250));
    expect(frames).toEqual([[0.5, 0]]);
    expect(scheduled()).toBe(2);
    animation.advance(at(500));
    expect(frames.at(-1)).toEqual([1, 0]);
  });

  it("stops asking when it is stopped, and resumes where it was", () => {
    const { animation, at, frames } = driver();
    animation.setPeriod(1000);
    animation.start();
    animation.advance(at(250));
    animation.stop();
    // A stopped animation advances nothing and schedules nothing.
    expect(animation.advance(at(500))).toBe(false);
    expect(frames.length).toBe(1);
    // Restarting picks the swing up where it was rather than snapping back to
    // the start, so pausing to look at something does not lose it.
    animation.start();
    animation.advance(at(500));
    expect(frames.at(-1)).toEqual([0.5, 0]);
    animation.advance(at(750));
    expect(frames.at(-1)).toEqual([1, 0]);
  });

  it("steps a sweep through the cases instead of swinging", () => {
    const { animation, at, frames } = driver();
    animation.setCycle("sweep");
    animation.setPeriod(1000);
    animation.setCount(4);
    animation.start();
    for (const time of [0, 300, 600, 900]) animation.advance(at(time));
    expect(frames.map(([, index]) => index)).toEqual([0, 1, 2, 3]);
    // Each case is held still and shown whole.
    expect(frames.every(([phase]) => phase === 1)).toBe(true);
  });

  it("keeps a period that would otherwise divide by zero above a floor", () => {
    const { animation } = driver();
    expect(animation.setPeriod(0)).toBe(2000);
    expect(animation.setPeriod(-5)).toBe(2000);
    expect(animation.setPeriod(10)).toBe(50);
  });
});

describe("the colour scale", () => {
  it("runs from one end of the ramp to the other and stops there", () => {
    expect(sampleColorScale(0)).toEqual([...STOPS[0]]);
    expect(sampleColorScale(1)).toEqual([...STOPS.at(-1)]);
    // A value off either end is drawn as that end rather than as nothing.
    expect(sampleColorScale(-2)).toEqual([...STOPS[0]]);
    expect(sampleColorScale(4)).toEqual([...STOPS.at(-1)]);
    expect(sampleColorScale(Number.NaN)).toEqual([...STOPS[0]]);
  });

  it("lands on each stop and interpolates between them", () => {
    STOPS.forEach((stop, index) => {
      const sampled = sampleColorScale(index / (STOPS.length - 1));
      sampled.forEach((channel, part) => expect(channel).toBeCloseTo(stop[part], 6));
    });
    const middle = sampleColorScale(0.125);
    middle.forEach((channel, part) =>
      expect(channel).toBeCloseTo((STOPS[0][part] + STOPS[1][part]) / 2, 6),
    );
  });

  it("states its stops as colours a legend can be painted with", () => {
    expect(colorScaleStops().length).toBe(STOPS.length);
    expect(colorScaleStops()[0]).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
  });
});

describe("displacement magnitudes", () => {
  it("measures how far each node went, once, whatever the phase is", () => {
    const moved = new Deformation({ nodes: NODES, indexOfId, radius: 10 });
    moved.setResult(fieldOf([3, 4, 0, 0, 0, 0, 0, 0, 1]));
    expect(Array.from(moved.magnitudes)).toEqual([5, 0, 1]);
    // The phase scales every node by the same factor, so it moves the field up
    // and down without changing which parts of it are the larger ones.
    moved.setPhase(0.5);
    expect(Array.from(moved.magnitudes)).toEqual([5, 0, 1]);
    moved.setResult(null);
    expect(moved.magnitudes).toBeNull();
  });
});

describe("memberBow", () => {
  // A ten-metre cantilever whose tip drops half a metre. Its tip slope is one
  // and a half times the deflection over the length, which is what a cantilever
  // under a point load at its end does.
  const TIP = -0.5;
  const SLOPE = (1.5 * 0.5) / 10;
  const CANTILEVER = [
    { x: 0, u: [0, 0, 0], phi: [0, 0, 0] },
    { x: 10, u: [0, 0, TIP], phi: [0, SLOPE, 0] },
  ];

  it("is nothing at either end, because the ends are already where they went", () => {
    expect(memberBow(CANTILEVER, 10, 0)).toEqual({ y: 0, z: 0 });
    expect(memberBow(CANTILEVER, 10, 1).y).toBeCloseTo(0, 12);
    expect(memberBow(CANTILEVER, 10, 1).z).toBeCloseTo(0, 12);
  });

  it("stands the cantilever off its own chord by what the cubic says", () => {
    // At mid-span the four basis values are 1/2, 1/8, 1/2 and -1/8, so the
    // curve sits at -0.15625 where the straight line sits at -0.25.
    expect(memberBow(CANTILEVER, 10, 0.5).z).toBeCloseTo(0.09375, 12);
    // Bending about the local y axis moves a member along local z and not
    // along local y - a bow that leaked across would be a sign error.
    expect(memberBow(CANTILEVER, 10, 0.5).y).toBeCloseTo(0, 12);
  });

  it("bows a member whose ends did not move at all but turned", () => {
    // Both ends held, the far one turned about local z: the member has to leave
    // the line between them, and it leaves it on the side the rotation implies.
    const turned = [
      { x: 0, u: [0, 0, 0], phi: [0, 0, 0] },
      { x: 4, u: [0, 0, 0], phi: [0, 0, 0.01] },
    ];
    expect(memberBow(turned, 4, 0.5).y).toBeCloseTo(-0.125 * 4 * 0.01, 12);
    expect(memberBow(turned, 4, 0.5).z).toBeCloseTo(0, 12);
  });

  it("has no bow to give without two stations, a length, or a member at all", () => {
    expect(memberBow(null, 10, 0.5)).toEqual({ y: 0, z: 0 });
    expect(memberBow([CANTILEVER[0]], 10, 0.5)).toEqual({ y: 0, z: 0 });
    expect(memberBow(CANTILEVER, 0, 0.5)).toEqual({ y: 0, z: 0 });
    // A station that states no rotation is a station with none, not an error.
    const flat = [
      { x: 0, u: [0, 0, 0] },
      { x: 10, u: [0, 0, TIP] },
    ];
    expect(memberBow(flat, 10, 0.5).z).toBeCloseTo(0, 12);
  });
});
