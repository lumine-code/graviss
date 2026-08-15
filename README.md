# graviss

Explore finite element models in an interactive engineering viewport.

## Features

- **Engineering viewport**: orbits, pans, zooms, fits, and switches between standard camera views and projection modes.
- **Model geometry**: switches beam members, shells, nodes, supports, mesh lines, grids, and global or element-local axes independently, in the model's declared coordinate system.
- **Section profiles**: renders rectangular, circular, tubular, tee, and polygonal beam sections with instanced meshes.
- **Multiple graphics**: stores several named graphics, independent cameras, visibility, appearance, and the last active graphic in one `.grv` file.
- **Native documents**: participates in modified tabs, Save and Save As, external reloads, deletion state, and conflicted-save handling.
- **Document history**: records camera and toolbar changes in a private `TextBuffer` so Undo and Redo cover the complete view document.
- **Navigation integration**: exposes named graphics to the navigation panel and activates a graphic when its outline entry is selected.
- **Live sources**: rebuilds the scene when a source reports that its geometry changed, keeping the camera the view document holds.
- **Section rendering**: switches between extruded cross-sections with closed area-element solids and plain lines with reference surfaces.

## Installation

To install `graviss` search for it in the Install pane of the Lumine settings, or run the command `lumine --install lumine-code/graviss`.

## Commands

Commands available in `.graviss`:

- `graviss:fit-view`: fit the complete model in the viewport,
- `graviss:previous-graphic`: activate the previous graphic,
- `graviss:next-graphic`: activate the next graphic,
- `graviss:choose-background`: open the engineering-background picker,
- `graviss:toggle-projection`: switch between perspective and orthographic projection,
- `graviss:retry`: retry a failed model load,
- `graviss:view-isometric`: use the isometric orientation,
- `graviss:view-top`: use the top orientation,
- `graviss:view-bottom`: use the bottom orientation,
- `graviss:view-front`: use the front orientation,
- `graviss:view-back`: use the back orientation,
- `graviss:view-right`: use the right orientation,
- `graviss:view-left`: use the left orientation,
- `graviss:view-top-left`: use the top-left orientation,
- `graviss:view-top-back`: use the top-back orientation,
- `graviss:view-top-right`: use the top-right orientation,
- `graviss:view-top-front`: use the top-front orientation,
- `graviss:view-front-left`: use the front-left orientation,
- `graviss:view-front-right`: use the front-right orientation,
- `graviss:view-bottom-front`: use the bottom-front orientation,
- `graviss:view-bottom-back`: use the bottom-back orientation,
- `graviss:view-bottom-left`: use the bottom-left orientation,
- `graviss:view-bottom-right`: use the bottom-right orientation,
- `graviss:view-back-left`: use the back-left orientation,
- `graviss:view-back-right`: use the back-right orientation,
- `graviss:view-top-back-left`: use the top-back-left orientation,
- `graviss:view-top-back-right`: use the top-back-right orientation,
- `graviss:view-top-front-right`: use the top-front-right orientation,
- `graviss:view-top-front-left`: use the top-front-left orientation,
- `graviss:view-bottom-front-left`: use the bottom-front-left orientation,
- `graviss:view-bottom-front-right`: use the bottom-front-right orientation,
- `graviss:view-bottom-back-left`: use the bottom-back-left orientation,
- `graviss:view-bottom-back-right`: use the bottom-back-right orientation,
- `graviss:projection-perspective`: use perspective projection,
- `graviss:projection-orthographic`: use orthographic projection,
- `graviss:toggle-members`: show or hide beam members,
- `graviss:toggle-shells`: show or hide shells,
- `graviss:toggle-nodes`: show or hide nodes,
- `graviss:toggle-supports`: show or hide support symbols,
- `graviss:toggle-mesh`: show or hide the mesh lines over shell surfaces,
- `graviss:toggle-grid`: show or hide the engineering grid,
- `graviss:toggle-axes`: show or hide the global axes,
- `graviss:toggle-local-axes`: show or hide element-local axes,
- `graviss:toggle-sections`: switch between rendered sections and plain lines and surfaces,
- `graviss:background-auto`: follow the active theme for the background,
- `graviss:background-cloud`: use the Cloud appearance,
- `graviss:background-midnight`: use the Midnight appearance,
- `graviss:background-paper`: use the Paper appearance,
- `graviss:background-white`: use the White appearance,
- `graviss:move-left`: move the camera left,
- `graviss:move-right`: move the camera right,
- `graviss:move-up`: move the camera up,
- `graviss:move-down`: move the camera down,
- `graviss:rotate-left`: rotate the camera left,
- `graviss:rotate-right`: rotate the camera right,
- `graviss:rotate-up`: rotate the camera up,
- `graviss:rotate-down`: rotate the camera down,
- `graviss:zoom-in`: move closer to the model,
- `graviss:zoom-out`: move farther from the model.

Commands available in `lumine-workspace`:

- `graviss:open-source`: open the active or selected `.grv` document as JSON source.

## Usage

A `.grv` document stores view configuration and an optional source path. When the source is omitted, registered providers can resolve a supported model with the same basename. Graviss opens the view as a canvas; **Open Source** opens the same file in a normal JSON editor.

The canvas keeps its canonical JSON in a private `TextBuffer`, without creating or registering a hidden text editor. Clean external changes reload immediately. Changes that overlap unsaved work remain conflicted until the normal Lumine save flow resolves them.

Graviss owns the canvas and every command. Source packages provide the `graviss.source` service and own only recognition, file or database access, translation, and session disposal — no package but Graviss creates a viewer or registers an opener.

Each session describes its capabilities before Graviss asks for geometry, and a source may report that its data changed so Graviss rebuilds the scene. Values are SI: lengths in metres, forces in newtons. See the [service contract](docs/graviss.source.md) for the normalized model interface.

## Customization

Override the public custom properties in your `styles.css` to adjust the toolbar and engineering-axis colors:

```css
.graviss {
  --graviss-toolbar-height: 40px;
  --graviss-axis-x-color: #d9574f;
  --graviss-axis-y-color: #3b9c61;
  --graviss-axis-z-color: #3f88d8;
}
```

## Services

- [`graviss.source`](docs/graviss.source.md): consumed to discover, open, and read FEM models supplied by source packages.
- `navigation.adapter`: provided to expose named graphics to the navigation panel.
- `tree-view.selection`: consumed to resolve selected `.grv` files for **Open Source**.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
