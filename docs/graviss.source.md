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
};

type ChangeEvent = { scope: "all" | "geometry" };

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
          elementKinds: ("beam" | "shell")[];
          supports?: boolean;
          sections?: boolean;
          localAxes?: boolean;
        };
  };
};

type Geometry = {
  nodes: Node[];
  elements: Element[];
  supports?: Support[];
  sections?: Section[];
};

type Node = { id: Id; x: number; y: number; z: number };

type Element = {
  id: Id;
  kind: "beam" | "shell" | "spring" | "coupling";
  nodeIds: [Id] | [Id, Id] | [Id, Id, Id] | [Id, Id, Id, Id];
  sectionId?: Id;
  thickness?: number;
  offset?: number;
  direction?: Vector3;
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
    | { kind: "polygon"; points: [number, number][]; holes?: [number, number][][] };
};
```

`id` and `createSession` are the required provider fields. `describe`, `getGeometry`, and `dispose` are the required session methods.

### How much of an element is drawn

Graviss draws line and area elements at one of three levels, and the user switches between them. What a provider supplies decides how far it can go:

| level     | line element                | area element                   | needs                                                                 |
| --------- | --------------------------- | ------------------------------ | --------------------------------------------------------------------- |
| `axis`    | its centreline              | its mid-surface                | nothing beyond geometry                                               |
| `section` | its cross-section, extruded | its mid-surface                | `sectionId` and that section's `shape`, plus `localAxes` to orient it |
| `full`    | its cross-section, extruded | extruded to its real thickness | the above, plus `thickness` on area elements                          |

A provider that supplies no section falls back to a thin centreline, and one that supplies no thickness draws its area elements flat. Neither is an error: the model is drawn as completely as it was described.

`offset` moves an area element off the nodes it was meshed on, along its own normal — the right-handed normal of its node order, so the sign follows the order the nodes were given in. It is the distance from that plane to the element's mid-surface, in metres, and it may be negative. A slab modelled at its top face and a deck sitting on beams both mesh at nodes the element does not physically occupy; the analysis keeps the nodes where it put them and Graviss draws the element where it is. Nodes are shared between elements that offset differently, so this belongs to the element and never to the node, and a provider must not fold it into node coordinates. It applies at every level, with or without a thickness: an offset flat surface is still offset. Line elements ignore it.

A `spring` and a `coupling` join two nodes without being structure, so Graviss draws them as marks rather than as members: a coil for a spring, a link with a tick across each end for a coupling. A spring may instead name a single node and a `direction`, which is how a spring between a node and the ground is expressed — it is then drawn reaching out that way from the node it holds. Neither takes a section or a thickness.

Everything Graviss draws as a mark rather than as structure — nodes, supports, springs, couplings — is sized from the model and from one control the user holds, so a provider says where these are and never how big they should look.

### Units

**Values are SI base units: lengths in metres, forces in newtons.** A source that records its own units converts them at this boundary. A source whose format carries no units — a bare mesh file — passes its numbers through unchanged and is read as metres. Graviss never rescales what a provider returns, so a model is only as correct as the conversion its provider performs.

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

### Discovery

**Graviss opens `.grv` documents and nothing else.** A provider never registers a file extension or an opener of its own; a model is always reached through the view document that names it. `createSession` receives that document and its path, and the provider either honours an explicit `source` field or looks for a model with the same basename beside it.

A provider returns `null` or `undefined` when it does not recognize the document. An explicit `source` always wins. Beyond that, providers are queried in registration order and the first session returned owns the model, so **providers must keep their recognized extensions disjoint** — the order two packages activate in is not defined.

### Reporting a change

A source that can notice its own data moving on implements `onDidChange`. Both scopes Graviss understands today, `geometry` and `all`, reload the model and rebuild the scene; the camera survives, because it belongs to the view document. Debounce inside the provider — it knows how its source is written.

## Teardown

Graviss revokes the provider when the providing package deactivates, so a provider disposes nothing itself. Graviss calls the active session's `dispose()` when its pane closes, unsubscribes from `onDidChange` at the same time, and destroys a supplied view document with the pane.

## Versioning

`1.0.0` is provided and `^1.0.0` is consumed. Adding optional capabilities, geometry fields, or change scopes is additive. Changing required provider fields or session methods, ID semantics, unit interpretation, or normalized geometry topology requires a new service name.
