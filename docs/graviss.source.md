# graviss.source

Supplies FEM model sessions that Graviss opens and renders.

|             |                                                  |
| ----------- | ------------------------------------------------ |
| Version     | `1.0.0`                                          |
| Provided by | source packages that read a FEM file or database |
| Consumed by | `graviss` through `consumeGravissSource()`       |
| Owner       | `graviss`                                        |

Graviss owns the canvas and every command; a provider owns file and database access and answers questions about one model. A provider never creates a viewer, registers an opener, or ships a deserializer.

## Registration

Declare the service in the source package's `package.json`:

```json
{
  "providedServices": {
    "graviss.source": {
      "versions": {
        "1.0.0": "provideGravissSource"
      }
    }
  }
}
```

Return the provider object from that method. Graviss revokes it when the package deactivates, so a provider keeps no registration bookkeeping of its own.

## Contract

The following TypeScript-style block describes the service, provider sessions, and normalized model data. IDs are stable non-empty strings or finite numbers.

```ts
type Id = string | number;
type Vector3 = [number, number, number];

type SourceProvider = {
  id: Id;
  createSession(context: {
    filePath: string;
    viewDocument: GravissViewDocument;
  }): ModelSession | null | undefined;
};

type ModelSession = {
  describe(): ModelDescription | Promise<ModelDescription>;
  getGeometry(): Geometry | Promise<Geometry>;
  dispose(): void | Promise<void>;
  onDidChange?(callback: (event: ChangeEvent) => void): Disposable;
  getLoadCases?(): LoadCase[] | Promise<LoadCase[]>;
  getResult?(request: ResultRequest): Result | Promise<Result>;
};

type ChangeEvent = { scope: "all" | "geometry" | "results" };

type ModelDescription = {
  model: {
    id: Id;
    title: string;
    source: string;
    coordinateSystem: {
      upAxis: "x" | "-x" | "y" | "-y" | "z" | "-z";
      handedness?: "left" | "right";
      gravityAxis?: string;
    };
  };
  capabilities: {
    geometry:
      | true
      | {
          elementKinds: ("beam" | "truss" | "cable" | "shell" | "spring" | "coupling")[];
          supports?: boolean;
          sections?: boolean;
          localAxes?: boolean;
        };
    results?: {
      displacement?: boolean;
      loadCases: true;
      beamStations?: boolean;
      memberDiagram?: boolean;
    };
    filterTypes?: true;
  };
};

type LoadCase = {
  id: Id;
  title: string;
  kind?:
    "linear" | "nonlinear" | "superposition" | "eigenmode" | "buckling" | "design" | "transient";
  actionType?: string;
  factor?: number;
  hasResults?: boolean;
};

type ResultRequest = { loadCaseId: Id; kind: "displacement" | "memberDiagram" };

type Result = DisplacementResult | MemberDiagramResult;

type DisplacementResult = {
  kind: "displacement";
  loadCaseId: Id;
  components: 3 | 6 | 7;
  nodes: { ids?: Id[]; values: Float32Array | number[] };
  extent?: number;
  activeElementIds?: Id[];
  elements?: {
    id: Id;
    stations: { x: number; u: Vector3; phi?: Vector3; warping?: number }[];
  }[];
};

type MemberQuantity = {
  id: string; // unique, stable source-defined identifier
  title: string;
  group: string; // source-defined category in the Results panel
  unit: string; // SI unit of the values
  displayUnit: string;
  displayFactor: number; // positive multiplier from SI to display units
  plane: "y" | "z"; // automatic diagram plane
  directionSign: 1 | -1; // positive ordinate direction within that plane
  interpolation?: "linear" | "point"; // defaults to linear
};
type MemberDiagramResult = {
  kind: "memberDiagram";
  loadCaseId: Id;
  components: MemberQuantity[];
  elements: {
    id: Id;
    stations: { x: number; values: (number | null)[] | Float32Array | Float64Array }[];
  }[];
  activeElementIds?: Id[];
};

type FilterType = {
  id: string; // never begins with "@", which is reserved to Graviss's own
  title: string;
  numeric?: boolean; // its values are numbers, so ranges and digit globs apply
  multiple?: boolean; // an element may hold several
  kinds?: Element["kind"][]; // the element kinds it can ever be about
  hint?: string; // an example expression, shown as the field's placeholder
  quickFilterCode?: string; // one or more ASCII letters for the toolbar selector
  values?: { id: Id; title?: string }[]; // optional: titles and an integrity check
};

type Geometry = {
  nodes: Node[];
  elements: Element[];
  supports?: Support[];
  sections?: Section[];
  filterTypes?: FilterType[];
};

type Node = { id: Id; x: number; y: number; z: number };

type Element = {
  id: Id;
  kind: "beam" | "truss" | "cable" | "shell" | "spring" | "coupling";
  nodeIds: [Id] | [Id, Id] | [Id, Id, Id] | [Id, Id, Id, Id];
  number?: number;
  filterValues?: Record<string, Id | Id[]>;
  sectionId?: Id;
  thickness?: number | number[];
  offset?: number | number[];
  surfaceInterpolation?: "linear" | "q4" | "hermite";
  lineInterpolation?: "linear" | "hermite";
  direction?: Vector3;
  rotational?: boolean;
  stiffness?: number;
  transverseStiffness?: number;
  rotationalStiffness?: number;
  localAxes?: { x: Vector3; y: Vector3; z: Vector3 };
};

type Support = {
  id: Id;
  nodeId: Id;
  restraints: [boolean, boolean, boolean, boolean, boolean, boolean];
};

type Section = {
  id: Id;
  name?: string;
  area?: number;
  materialId?: Id;
  ineffective?: { points: [number, number][]; holes?: [number, number][][] }[];
  shape?:
    | { kind: "rectangle"; width: number; height: number }
    | { kind: "circle"; diameter: number }
    | { kind: "tube"; diameter: number; thickness: number }
    | {
        kind: "tee";
        webWidth: number;
        height: number;
        flangeWidth: number;
        flangeThickness: number;
      }
    | { kind: "polygon"; points: [number, number][]; holes?: [number, number][][] }
    | { kind: "polygon"; parts: { points: [number, number][]; holes?: [number, number][][] }[] }
    | {
        kind: "plates";
        plates: {
          from: [number, number];
          to: [number, number];
          thickness: number;
          unitWarping?: [number, number];
        }[];
      };
};
```

`id` and `createSession` are the required provider fields. `describe`, `getGeometry`, and `dispose` are the required session methods; `onDidChange`, `getLoadCases` and `getResult` are optional, and a session that answers only the three required ones is a whole provider.

### Member result diagrams

A result-capable source declares `loadCases: true` and at least one of `displacement: true` and `memberDiagram: true`. These capabilities are independent. The load-case index includes cases with either kind of data. `getResult` must return the exact requested `kind` and typed `loadCaseId`; a different result is an error and cannot replace the previously displayed field.

The source owns the quantity catalogue. Each component descriptor supplies a unique string ID, title, category, SI unit, display unit, positive display multiplier and automatic local drawing direction. Graviss does not contain a fixed list of six force components: a source can supply forces, moments, bimoments, translations, rotations, bedding forces, stresses or other scalar member results without changing the viewer. Distinct material, stress-point or other result qualifiers must have distinct component IDs and descriptive titles. For example, a bending moment uses SI N·m and display kN·m with factor 0.001, a bimoment uses N·m² and kN·m², a displacement uses m and mm with factor 1000, and stress uses Pa and MPa with factor 0.000001. Quantity IDs and values must never disguise one physical dimension as another.

Every station's `values` follows the descriptor order. Values are signed, finite SI numbers; null means that this quantity is unavailable at this station. Null never means zero and breaks an interpolated curve. Typed numerical arrays are permitted only when every value is known; NaN is not a missing-value marker. Converted display values must also be finite. An empty `elements` array means no member data for that case; measured zeroes remain valid data. Quantities may be listed even when unavailable in a particular case, so the panel can state that absence explicitly.

Each entry references a unique existing beam, truss or cable with explicit orthogonal, right-handed `localAxes`; local x must point from its first node to its second. Stations are measured in metres along that undeformed chord, ordered by nondecreasing x within the member length. Float32 endpoint roundoff up to `max(1e-7, length * 1e-6)` is accepted. Exactly two coincident stations represent left and right limits, in that order; more than two are ambiguous and rejected. A single known station is drawn as an ordinate without inventing a span. `activeElementIds` follows the construction-stage mask used by displacement results.

Linear quantities join consecutive known station values, split fills at zero crossings, and preserve jumps without smoothing. A source supplies sufficient stations for nonlinear distributions; the viewer cannot reconstruct distributed loads or analytical extrema from endpoints alone. Partial station spans remain partial; no end extrapolation or averaging across neighbouring elements occurs. A point quantity, such as a discrete hinge reaction, sets `interpolation: "point"`: every station is drawn independently, without connecting or filling between unrelated points. When combining source record families on different grids, providers must preserve each quantity's own piecewise interpolation and gaps rather than treating absent grid entries as zeroes.

Diagrams stand on the undeformed model and are independent of displacement amplification and animation. Automatic orientation follows the descriptor's local plane and direction sign. For positive-face, right-handed section forces, N is positive in tension; positive My produces tension on local +z and positive Mz on local −y. A provider can encode those tension-side directions in the descriptors. An explicit y or z plane uses its positive local direction; flipping changes only the drawn side, never the reported sign. One scale is used across the visible result-bearing members. Filtering, layer visibility and the activity mask also narrow the reported extrema. Extrema refer to supplied samples; member IDs and positions appear alongside the selected member's station table.

Per-graphic `results` stores `kind: "memberDiagram"`, `component` (the source quantity ID), `diagramScale` (`"auto"` or a positive number in model metres per SI unit), `diagramPlane` (`"auto"`, `"y"` or `"z"`), and boolean `diagramFlip`, `diagramFilled` and `diagramLabels`. The panel converts manual scale to metres per displayed unit. Labels prioritize the selected member and global extrema, with a 300-label budget, screen-space collision culling and an explicit count when reduced; the station table retains every value. Export lays out labels for its own projection and restores the viewport layout afterwards. Camera-fit bounds include all candidate labels to avoid feedback between framing and culling.

### Line elements

**`beam`, `truss` and `cable` are all drawn as members** — a run of structure between two nodes, drawn as its centreline or as its section extruded along it. They are separate kinds because they carry different things: a beam bends, a truss takes axial force alone, and a cable takes only tension. That decides the analysis and not the picture, so a provider says which it read and Graviss draws all three the same way — as the same shape, in a colour and behind a switch of their own, so that a model can be looked at a kind at a time without a provider being asked to separate them. A provider states the kind and nothing else about how it is shown.

A truss or a cable is often stored without a cross-section orientation, because an axial member has no bending for one to matter to. **A provider that knows the convention its source is written in should state `localAxes` anyway**, computed if need be: the roll Graviss picks when none is given is arbitrary, so an asymmetric section left to it may well be drawn upside down against every beam beside it. A provider with nothing to go on leaves it out and Graviss chooses. Either way the member's own axis is the run between its two nodes and never the provider's to state.

`lineInterpolation` tells Graviss whether a displaced member follows the straight chord between its translated end nodes or a cubic Hermite curve whose end slopes come from result stations. Members default to `hermite` when stations are supplied and to `linear` without them; a provider states `linear` when its own result viewer represents each finite element as a straight displaced segment. This choice affects the member axis and section alignment, not twist or warping: station rotations about the axis and the seventh degree of freedom remain available on a linear path.

### How much of an element is drawn

Graviss draws line and area elements at one of three levels, and the user switches between them. What a provider supplies decides how far it can go:

| level     | line element                | area element                   | needs                                                                 |
| --------- | --------------------------- | ------------------------------ | --------------------------------------------------------------------- |
| `axis`    | its centreline              | its mid-surface                | nothing beyond geometry                                               |
| `section` | its cross-section, extruded | its mid-surface                | `sectionId` and that section's `shape`, plus `localAxes` to orient it |
| `full`    | its cross-section, extruded | extruded to its real thickness | the above, plus `thickness` on area elements                          |

A provider that supplies no section falls back to a thin centreline, and one that supplies no thickness draws its area elements flat. Neither is an error: the model is drawn as completely as it was described.

`surfaceInterpolation` tells Graviss how an area element's displaced mid-surface is reconstructed between its nodes. `linear` joins its corners by triangles, `q4` applies the four-node bilinear isoparametric shape functions, and `hermite` forms a Coons patch whose boundary tangents come from the nodal rotations in a six- or seven-component result. A triangle defaults to `linear` and a four-node shell to `q4`; a provider states `hermite` only when its element formulation defines rotations as surface slopes. This belongs to the provider because the same six nodal values mean different kinematics in a Kirchhoff shell and in a shear-deformable shell whose rotations describe an independent director. If a Hermite element receives a result without rotations, Graviss falls back to Q4 rather than inventing slopes.

A `plates` section is a **thin-walled** one: a cross-section that is not a filled outline but the plates it is built from — a welded plate girder, a rolled angle, a cold-formed channel. Each plate is a straight run of material of one thickness, and the run given is its **middle**: the plate stands half a thickness either side of it and ends square at both ends, so a source that trims two plates to meet has them drawn meeting. Nothing extends or mitres a corner, because lengthening a plate would put material in the section that the source did not put there, and nothing merges the plates into one outline — the seam between two of them is an edge the section really has. Plates may be given in any order and need not touch: the section is what stands where they stand.

`unitWarping` optionally gives the section's unit-warping ordinate `W0` at a plate's `from` and `to` points, in square metres. A seven-component displacement result puts `d(phi-x)/dx` in its seventh nodal component, in inverse metres, and a beam station repeats that value as `warping`; Graviss multiplies the station value by `W0` to draw the resulting axial displacement of each point in the section. A source that has the seventh degree of freedom but no unit-warping shape data still reports all seven components and the station values, but the cross-section cannot be warped from information it was not given.

An area element's `thickness` may be one number or one per node, in the order its nodes are given. A list is how an element that tapers across itself is described, and it is drawn tapering rather than as parallel plates of its first corner's thickness. A list shorter than the element has nodes repeats its last value. A single number is exact for that element: neighbouring elements may state different thicknesses and then meet with a real step; Graviss never invents a nodal mean. `offset` follows the same rule. Every corner is displaced along that element's own surface normal, never a normal averaged with its neighbours, so a warped quad — four base nodes off one plane — extrudes as the warped surface it is and a shared node cannot bevel or rotate another panel's end.

`ineffective` names the parts of a section that do not carry — a slender plate past its effective width, a deck slab left out of a construction stage, an area a code sets aside — and Graviss draws them in a grey rather than in the member colour, so what is being counted is visible without a legend. Each is an area in the section's own plane, in the same coordinates and the same spelling as a polygon shape's parts, and **each is already cut to the section**: a source states the material that does not count, not the rule that produced it. A rule is what a source has and an area is what a viewer can draw, and only the source can turn one into the other. Areas may overlap and need not be connected. Stating them changes nothing about the section's own `shape`, which is still the whole of it.

`offset` moves an area element off the nodes it was meshed on, along its own normal — the right-handed normal of its node order, so the sign follows the order the nodes were given in. It is the distance from that plane to the element's mid-surface, in metres, and it may be negative. A slab modelled at its top face and a deck sitting on beams both mesh at nodes the element does not physically occupy; the analysis keeps the nodes where it put them and Graviss draws the element where it is. Nodes are shared between elements that offset differently, so this belongs to the element and never to the node, and a provider must not fold it into node coordinates. Like `thickness` it may be one number or one per node. An eccentric element that tapers needs the list: its nodes sit on a face of the plate, and a face is a different distance from the middle wherever the plate is a different thickness. It positions the body, so it applies while sections render — with or without a thickness, an offset flat surface is still drawn where it physically sits. Without section rendering the element is the analysis surface itself, drawn on its nodes, which is where the supports, springs and couplings that meet it attach. Line elements ignore it.

A `spring` and a `coupling` join two nodes without being structure, so Graviss draws them as marks rather than as members: a helix for a spring, and for a coupling the plain line that a rigid link is the whole of. `stiffness` is the spring's positive axial stiffness in N/m. `transverseStiffness`, also in N/m, acts isotropically in the plane perpendicular to the spring axis and is drawn as two perpendicular helices in that plane. `rotationalStiffness`, in Nm/rad, acts about the axis and is drawn as a ring; the older `rotational: true` remains the shorthand for a purely rotational spring whose one `stiffness` value is rotational. Components may coexist and are then all drawn. A spring may name a single node and a `direction`, which is how a spring between a node and the ground states its principal axis. These values let Graviss optionally scale each component against the stiffest spring of the same dimensional kind; a missing value means the source cannot make that comparison and leaves that component at full size. Neither connector takes a section or a thickness.

Everything Graviss draws as a mark rather than as structure — nodes, supports, springs, couplings — takes one base length the user holds, taken from the model until they say otherwise. With relative spring scaling off that is every mark's size; with it on the stiffest spring keeps the base size and the other known spring stiffnesses scale linearly beneath it. A provider therefore says where marks are and may state spring stiffness, but never chooses their display size.

### Units

**Values are SI base units: lengths in metres, forces in newtons, rotations in radians.** A source that records its own units converts them at this boundary. A source whose format carries no units — a bare mesh file — passes its numbers through unchanged and is read as metres. Graviss never rescales what a provider returns, so a model is only as correct as the conversion its provider performs.

This is the one rule a provider cannot quietly skip, because most analysis formats are not written in SI. A database that stores a unit set of its own has to be read for it and converted here, field by field, and a factor that is wrong by a thousand looks entirely plausible on screen — a bridge deflecting a metre under its own weight is a picture, not an error. A provider is the only party that can tell, so it is the party that must check.

### Results

A source that has analysis results says so with `capabilities.results` and answers two more questions: `getLoadCases()` for what has been computed, and `getResult()` for one of them. Both are optional, and a provider that has neither is a provider of geometry, which is all Graviss ever required.

`getLoadCases()` lists what the model was solved for. `title` is the source's own designation and is shown as written; `kind` is the one classification Graviss asks a provider to make, because **an eigenmode and a buckling mode have no sign**. A mode shape is defined only up to a factor, so Graviss animates one about zero and swings it both ways; an ordinary load case is a real state of the structure and is animated from zero up to itself. A provider that cannot tell leaves `kind` out and gets the ordinary treatment. `hasResults` says a case exists but was never solved, which is commoner than it sounds — a model may name a hundred cases and hold results for three.

The Results panel searches the supplied IDs and titles and filters by `kind`, so a provider needs no additional browsing API. A requested case and the displayed result are separate states: the current field remains displayed while the next one loads or after its read fails, and Retry repeats the failed request. These controls keep `getResult({ loadCaseId, kind })` unchanged.

`getResult()` returns true displacements, never amplified ones. **The scale factor and the animation phase belong to Graviss**, exactly as the symbol size and the camera do: a provider that pre-multiplied its own numbers would make the viewer's scale meaningless and its readout a lie. `nodes.values` runs three, six or seven components a node — translations, then rotations where the source has them, then `d(phi-x)/dx` for a beam model with warping — in `geometry.nodes` order unless `ids` says otherwise. `extent` is the largest resultant translation, and stating it saves Graviss a pass over the whole field to choose an automatic scale.

`activeElementIds` optionally lists the complete set of elements participating in this result's load case, using unique IDs from `geometry.elements`. It applies to every element kind, including springs and couplings. An empty list means no elements participate; omitting the field leaves the complete model available. Graviss intersects this set with the user's element filter for drawing, picking and export, and restores the complete model when the result is cleared. Node and support symbols remain for endpoints of active elements and for standalone nodes that belong to no element. Missing nodal displacement rows never determine activity: a fixed active endpoint still belongs to the model. Animation at zero displacement retains the selected load case's topology.

The graphic's optional `results.cyclePosition` is a normalized fraction from `0` to `1` of a full cycle. It belongs to the `.grv` document, never to a source result. Pause records the displayed cycle position and Play resumes from it. The panel's Deformation slider shows the actual factor instead: `0%` to `100%` for Positive, or `−100%` to `100%` for Swing, following the cycle's smooth acceleration. Dragging pauses at that factor and stores its corresponding cycle position while preserving the direction of motion. Without an explicit stored position, paused graphics continue showing the positive full shape and playing graphics start at zero. The Results panel accepts exact amplification factors and presents the period in seconds; the stored `results.period` uses milliseconds.

`elements[].stations` carries a member's local displacement, rotation and warping along its axis. On a Hermite member Graviss uses the end rotations to bend the axis; on a provider-selected linear member the translated nodal chord remains straight while twist and warping still act on the section. `x` is the distance from the element's start. Two stations already determine the cubic, twist and warping progression, so a source with only the ends is worth reporting. `localAxes` is the rotation into global, which is one more reason for an axial member to state it.

### Filter types

A model is usually divided into more than its element kinds — groups, sub-structures, the geometric entity an element was meshed from — and every source names those divisions differently. Rather than learn each one, Graviss takes them as **filter types**: a provider declares the dimensions it has, and says which values each element holds. Graviss builds the filter surface from that and interprets none of it — a type id is compared, never parsed, so a provider may spell its ids however its own domain does. An id beginning with `@` is reserved to the two dimensions Graviss owns outright, `@kind` and `@number`, because both facts are declared on `Element` itself.

`numeric` says the dimension's values are numbers, so a range and a digit glob mean something for them and the values need not be enumerated at all. `values` is optional and supplies catalogue titles, names a user can type instead of IDs for non-numeric dimensions, and a check that an element's value is one the model declared. `kinds` is the element kinds the dimension can ever be about, and Graviss neither adds nor removes an element outside them by a rule over it. `multiple` says an element may hold several values — one element belongs to exactly one group in most systems and to any number of selection sets. `hint` is an example expression, shown where the user will type one.

An element states its values in `filterValues`, keyed by type id; a dimension a given element says nothing about simply does not filter it, in either direction — a rule that subtracts by group does not touch the ungrouped, and one that adds by group does not bring them along.

The Filter catalogue combines the declared values with values actually held by the model, retaining titles and declared values with zero matches. Counts are elements holding that value within the chosen subject's kinds; a repeated value in one element's list counts once. Selecting catalogue values creates one ordered Add or Subtract rule when the action is pressed. An empty selection creates no rule. The built-in Number subject uses an expression instead of enumerating element IDs. Each rule's match count describes its own set; the final In filter count is independent of which layers are currently drawn.

`quickFilterCode` optionally exposes a dimension in the toolbar's compact filter. It contains one or more ASCII letters and is compared case-insensitively; the dimension's `id` remains opaque and unchanged. Graviss reserves `N` for all elements and `B`, `Q`, `T`, `C`, `S`, and `K` for beams, shells, trusses, cables, springs, and couplings. Each provider code also reserves all six kind suffixes: `G` claims `GB`, `GQ`, `GT`, `GC`, `GS`, and `GK`. Codes and these generated families must not collide with core codes or another dimension's family, even when a corresponding kind is absent. Geometry validation rejects such collisions. Generated aliases are offered for kinds present within the dimension's declared domain, so `GB12` means group 12 restricted to beams when `G` names the group dimension.

The optional graphic-level `quickFilter` string is independent of `filter.rules`; an element must satisfy both predicates. Its clauses are applied in order, with optional `+` or `-` signs and semicolons between clauses. The first sign chooses the seed: addition starts empty and subtraction starts with every element; the last matching clause decides. A bare provider code matches elements holding a value of that dimension. A bare core kind code also matches unnumbered elements; adding a number expression requires a finite element number. An empty `quickFilter` string disables only the toolbar predicate. One trailing semicolon is accepted, but leading or interior empty clauses are rejected.

Quick input removes all whitespace, including whitespace inside quoted strings, so terms within a clause use commas. A selector consumes the full leading run of ASCII letters; unquoted named expressions require a colon, such as `SG:DECK`, while quoted exact IDs may follow directly as `SG"DECK"`. The existing case-insensitive patterns and title matching apply to unquoted names; JSON-quoted strings select exact, case-sensitive IDs. Semicolons inside quoted strings do not split clauses, and JSON escapes preserve literal characters such as the space in `SG"Temporary\u0020works"`. The toolbar's syntax help is generated from the model's codes and requires no provider UI.

Enter applies a quick-filter draft; Escape cancels it. A failed edit leaves the previous committed predicate active, and the clear button removes only the toolbar predicate. An invalid expression restored from a saved graphic retains its text and error but admits no elements, so an unavailable provider code cannot silently widen a saved view. The final In filter count includes the intersection of the panel and toolbar predicates; the panel's per-rule match counts still describe their own sets.

In panel rules, unquoted named expressions match IDs or declared titles case-insensitively, with `*` and `?` as patterns and commas or whitespace separating terms. JSON-quoted strings match exact, case-sensitive IDs only: `"Pier piles"`, `"A,B"`, or `"A*"` each names one literal value. JSON escaping preserves quotes, backslashes, and other characters inside an ID. The catalogue writes quoted terms for named selections, so a provider's IDs need no renaming or additional service fields. Unreadable numeric expressions or malformed quoted names leave the last valid UI rule active and show an inline error.

`element.number` is separate, and is the element's own number in the source rather than the `id` Graviss keys it by. Ids must be unique across every kind, so a provider that has both a beam 5 and a shell 5 has to qualify them; the bare number is what a user types when they ask for elements 110001 to 110200, and only the provider knows it. It is expected to be a non-negative integer, because the expression grammar reads digits.

## Minimal example

```js
module.exports = {
  provideGravissSource() {
    return {
      id: "graviss-example",
      createSession({ filePath, viewDocument }) {
        const sourcePath = resolveSourceBeside(viewDocument.getData(), filePath);
        return sourcePath?.endsWith(".example") ? createExampleSession(sourcePath) : null;
      },
    };
  },
};
```

## Behavior

Graviss always calls `describe()` before requesting geometry. Geometry validation rejects duplicate IDs, non-finite coordinates, invalid element topology, missing references, degenerate elements, invalid section dimensions, and malformed restraints or local axes.

Geometry remains in the provider's model coordinate system. Graviss does not rotate, reflect, swap, or translate it. The signed `coordinateSystem.upAxis` controls the physical-up direction used by orbit navigation, standard views, the view cube, the reference grid, and support symbols; global and local axis graphics continue to show the model's original X, Y, and Z directions.

**A planar model is recognised from its own nodes, and a provider states nothing.** Where every node lies in a plane normal to a global axis, and the nodes span that plane rather than a line, Graviss first shows the model along that normal instead of from the isometric corner, and lays its reference grid in the model's own plane a step behind it. A plane frame, a grillage, a slab meshed flat and a cross-section all read the same way to a viewer, whatever the source calls the system they came from, and the measurement is exact where a declaration could only ever agree with it.

### Discovery

**Graviss opens `.grv` documents and nothing else.** A provider never registers a file extension or an opener of its own; a model is always reached through the view document that names it. `createSession` receives that document and its path, and the provider either honours an explicit `source` field or looks for a model with the same basename beside it.

A provider returns `null` or `undefined` when it does not recognize the document. An explicit `source` always wins. Beyond that, providers are queried in registration order and the first session returned owns the model, so **providers must keep their recognized extensions disjoint** — the order two packages activate in is not defined.

### Reporting a change

A source that can notice its own data moving on implements `onDidChange`. `geometry` and `all` reload the model and rebuild the scene; the camera survives, because it belongs to the view document. `results` is the narrow one — the model stands and only what was solved for it has moved, so Graviss re-reads the load cases and the displayed case and leaves the scene where it is. A re-analysis that also remeshed is `geometry`, not `results`. Debounce inside the provider — it knows how its source is written.

## Teardown

Graviss revokes the provider when the providing package deactivates, so a provider disposes nothing itself. Graviss calls the active session's `dispose()` when its pane closes, unsubscribes from `onDidChange` at the same time, and destroys a supplied view document with the pane.

## Versioning

`1.0.0` is provided and `^1.0.0` is consumed. Adding optional capabilities, geometry fields, or change scopes is additive. Changing required provider fields or session methods, ID semantics, unit interpretation, or normalized geometry topology requires a new service name.
