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
      displacement: true;
      loadCases: true;
      beamStations?: boolean;
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

type ResultRequest = { loadCaseId: Id; kind: "displacement" };

type Result = {
  kind: "displacement";
  loadCaseId: Id;
  components: 3 | 6;
  nodes: { ids?: Id[]; values: Float32Array | number[] };
  extent?: number;
  elements?: {
    id: Id;
    stations: { x: number; u: Vector3; phi?: Vector3 }[];
  }[];
};

type FilterType = {
  id: string; // never begins with "@", which is reserved to Graviss's own
  title: string;
  numeric?: boolean; // its values are numbers, so ranges and digit globs apply
  multiple?: boolean; // an element may hold several
  kinds?: Element["kind"][]; // the element kinds it can ever be about
  hint?: string; // an example expression, shown as the field's placeholder
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
  direction?: Vector3;
  rotational?: boolean;
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
        plates: { from: [number, number]; to: [number, number]; thickness: number }[];
      };
};
```

`id` and `createSession` are the required provider fields. `describe`, `getGeometry`, and `dispose` are the required session methods; `onDidChange`, `getLoadCases` and `getResult` are optional, and a session that answers only the three required ones is a whole provider.

### Line elements

**`beam`, `truss` and `cable` are all drawn as members** — a run of structure between two nodes, drawn as its centreline or as its section extruded along it. They are separate kinds because they carry different things: a beam bends, a truss takes axial force alone, and a cable takes only tension. That decides the analysis and not the picture, so a provider says which it read and Graviss draws all three the same way — as the same shape, in a colour and behind a switch of their own, so that a model can be looked at a kind at a time without a provider being asked to separate them. A provider states the kind and nothing else about how it is shown.

A truss or a cable is often stored without a cross-section orientation, because an axial member has no bending for one to matter to. **A provider that knows the convention its source is written in should state `localAxes` anyway**, computed if need be: the roll Graviss picks when none is given is arbitrary, so an asymmetric section left to it may well be drawn upside down against every beam beside it. A provider with nothing to go on leaves it out and Graviss chooses. Either way the member's own axis is the run between its two nodes and never the provider's to state.

### How much of an element is drawn

Graviss draws line and area elements at one of three levels, and the user switches between them. What a provider supplies decides how far it can go:

| level     | line element                | area element                   | needs                                                                 |
| --------- | --------------------------- | ------------------------------ | --------------------------------------------------------------------- |
| `axis`    | its centreline              | its mid-surface                | nothing beyond geometry                                               |
| `section` | its cross-section, extruded | its mid-surface                | `sectionId` and that section's `shape`, plus `localAxes` to orient it |
| `full`    | its cross-section, extruded | extruded to its real thickness | the above, plus `thickness` on area elements                          |

A provider that supplies no section falls back to a thin centreline, and one that supplies no thickness draws its area elements flat. Neither is an error: the model is drawn as completely as it was described.

A `plates` section is a **thin-walled** one: a cross-section that is not a filled outline but the plates it is built from — a welded plate girder, a rolled angle, a cold-formed channel. Each plate is a straight run of material of one thickness, and the run given is its **middle**: the plate stands half a thickness either side of it and ends square at both ends, so a source that trims two plates to meet has them drawn meeting. Nothing extends or mitres a corner, because lengthening a plate would put material in the section that the source did not put there, and nothing merges the plates into one outline — the seam between two of them is an edge the section really has. Plates may be given in any order and need not touch: the section is what stands where they stand.

An area element's `thickness` may be one number or one per node, in the order its nodes are given. A list is how an element that tapers across itself is described, and it is drawn tapering rather than as parallel plates of its first corner's thickness. A list shorter than the element has nodes repeats its last value. Neighbouring elements that state single numbers which differ are drawn meeting at their mean at the nodes they share — a thickness that varies across a run of elements describes a surface, not a stair — and a single `offset` is read the same way; a list is exact and never averaged. Every corner is displaced along the surface normal at its own node, so a warped quad — four base nodes off one plane — extrudes as the warped surface it is, and a folded or curved run extrudes as one continuous solid.

`ineffective` names the parts of a section that do not carry — a slender plate past its effective width, a deck slab left out of a construction stage, an area a code sets aside — and Graviss draws them in a grey rather than in the member colour, so what is being counted is visible without a legend. Each is an area in the section's own plane, in the same coordinates and the same spelling as a polygon shape's parts, and **each is already cut to the section**: a source states the material that does not count, not the rule that produced it. A rule is what a source has and an area is what a viewer can draw, and only the source can turn one into the other. Areas may overlap and need not be connected. Stating them changes nothing about the section's own `shape`, which is still the whole of it.

`offset` moves an area element off the nodes it was meshed on, along its own normal — the right-handed normal of its node order, so the sign follows the order the nodes were given in. It is the distance from that plane to the element's mid-surface, in metres, and it may be negative. A slab modelled at its top face and a deck sitting on beams both mesh at nodes the element does not physically occupy; the analysis keeps the nodes where it put them and Graviss draws the element where it is. Nodes are shared between elements that offset differently, so this belongs to the element and never to the node, and a provider must not fold it into node coordinates. Like `thickness` it may be one number or one per node. An eccentric element that tapers needs the list: its nodes sit on a face of the plate, and a face is a different distance from the middle wherever the plate is a different thickness. It positions the body, so it applies while sections render — with or without a thickness, an offset flat surface is still drawn where it physically sits. Without section rendering the element is the analysis surface itself, drawn on its nodes, which is where the supports, springs and couplings that meet it attach. Line elements ignore it.

A `spring` and a `coupling` join two nodes without being structure, so Graviss draws them as marks rather than as members: a helix for a spring, and for a coupling the plain line that a rigid link is the whole of. A spring that acts about its axis rather than along it says so with `rotational`, and is drawn as a turn about that axis — a ring across it — instead of a helix along it. A spring may instead name a single node and a `direction`, which is how a spring between a node and the ground is expressed — it is then drawn reaching out that way from the node it holds. Neither takes a section or a thickness.

Everything Graviss draws as a mark rather than as structure — nodes, supports, springs, couplings — is sized by one length the user holds, taken from the model until they say otherwise, so a provider says where these are and never how big they should look.

### Units

**Values are SI base units: lengths in metres, forces in newtons, rotations in radians.** A source that records its own units converts them at this boundary. A source whose format carries no units — a bare mesh file — passes its numbers through unchanged and is read as metres. Graviss never rescales what a provider returns, so a model is only as correct as the conversion its provider performs.

This is the one rule a provider cannot quietly skip, because most analysis formats are not written in SI. A database that stores a unit set of its own has to be read for it and converted here, field by field, and a factor that is wrong by a thousand looks entirely plausible on screen — a bridge deflecting a metre under its own weight is a picture, not an error. A provider is the only party that can tell, so it is the party that must check.

### Results

A source that has analysis results says so with `capabilities.results` and answers two more questions: `getLoadCases()` for what has been computed, and `getResult()` for one of them. Both are optional, and a provider that has neither is a provider of geometry, which is all Graviss ever required.

`getLoadCases()` lists what the model was solved for. `title` is the source's own designation and is shown as written; `kind` is the one classification Graviss asks a provider to make, because **an eigenmode and a buckling mode have no sign**. A mode shape is defined only up to a factor, so Graviss animates one about zero and swings it both ways; an ordinary load case is a real state of the structure and is animated from zero up to itself. A provider that cannot tell leaves `kind` out and gets the ordinary treatment. `hasResults` says a case exists but was never solved, which is commoner than it sounds — a model may name a hundred cases and hold results for three.

`getResult()` returns true displacements, never amplified ones. **The scale factor and the animation phase belong to Graviss**, exactly as the symbol size and the camera do: a provider that pre-multiplied its own numbers would make the viewer's scale meaningless and its readout a lie. `nodes.values` runs three or six components a node — translations, then rotations where the source has them — in `geometry.nodes` order unless `ids` says otherwise. `extent` is the largest resultant translation, and stating it saves Graviss a pass over the whole field to choose an automatic scale.

`elements[].stations` is how a member bends. A line element drawn between its two displaced end nodes is a straight chord, which is what a deflected beam is not; a source that solved for the deflection along the member can hand back the stations it computed, in the element's own local frame, and Graviss sweeps the section along the curve they describe. `x` is the distance from the element's start. Two stations and their rotations already determine the curve, so a source with only the ends is worth reporting. `localAxes` is the rotation into global, which is one more reason for an axial member to state it.

### Filter types

A model is usually divided into more than its element kinds — groups, sub-structures, the geometric entity an element was meshed from — and every source names those divisions differently. Rather than learn each one, Graviss takes them as **filter types**: a provider declares the dimensions it has, and says which values each element holds. Graviss builds the filter surface from that and interprets none of it — a type id is compared, never parsed, so a provider may spell its ids however its own domain does. An id beginning with `@` is reserved to the two dimensions Graviss owns outright, `@kind` and `@number`, because both facts are declared on `Element` itself.

`numeric` says the dimension's values are numbers, so a range and a digit glob mean something for them and the values need not be enumerated at all. `values` is optional and buys three things where it is supplied: titles for completion, a name a user can type instead of an id, and a check that an element's value is one the model declared. `kinds` is the element kinds the dimension can ever be about, and Graviss neither adds nor removes an element outside them by a rule over it. `multiple` says an element may hold several values — one element belongs to exactly one group in most systems and to any number of selection sets. `hint` is an example expression, shown where the user will type one.

An element states its values in `filterValues`, keyed by type id; a dimension a given element says nothing about simply does not filter it, in either direction — a rule that subtracts by group does not touch the ungrouped, and one that adds by group does not bring them along.

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
