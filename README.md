# graviss

Explore finite element models in an interactive engineering viewport.

## Features

- **Engineering viewport**: orbits and zooms about the element under the pointer, pans, fits, and switches between standard camera views and projection modes.
- **Model geometry**: switches beam members, shells, nodes, supports, springs, couplings, mesh lines, grids, and global or element-local axes independently, in the model's declared coordinate system.
- **Section profiles**: renders rectangular, circular, tubular, tee, and polygonal beam sections with instanced meshes.
- **Multiple graphics**: stores several named graphics in one `.grv` file, each with its own camera, visibility, section rendering, appearance, and print region.
- **Native documents**: participates in modified tabs, Save and Save As, external reloads, deletion state, and conflicted-save handling.
- **Document history**: records camera and toolbar changes in a private `TextBuffer` so Undo and Redo cover the complete view document.
- **Navigation integration**: exposes named graphics to the navigation panel and activates a graphic when its outline entry is selected.
- **Live sources**: rebuilds the scene when a source reports that its geometry changed, keeping the camera the view document holds.
- **Symbols and connectors**: draws springs as coils and couplings as ticked links, and sizes every mark from the model with one slider.

## Installation

To install `graviss` search for it in the Install pane of the Lumine settings, or run the command `lumine --install lumine-code/graviss`.

## Commands

Commands available in `.graviss`:

- `graviss:fit-view`: fit the complete model in the viewport,
- `graviss:previous-graphic`: activate the previous graphic,
- `graviss:next-graphic`: activate the next graphic,
- `graviss:choose-background`: open the engineering-background picker,
- `graviss:toggle-projection`: switch between perspective and orthographic projection,
- `graviss:retry-loading-model`: retry a failed model load,
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
- `graviss:perspective-projection`: use perspective projection,
- `graviss:orthographic-projection`: use orthographic projection,
- `graviss:toggle-members`: show or hide beam members,
- `graviss:toggle-shells`: show or hide shells,
- `graviss:toggle-nodes`: show or hide nodes,
- `graviss:toggle-supports`: show or hide support symbols,
- `graviss:toggle-springs`: show or hide springs,
- `graviss:toggle-couplings`: show or hide couplings,
- `graviss:toggle-mesh`: show or hide the mesh lines over shell surfaces,
- `graviss:toggle-grid`: show or hide the engineering grid,
- `graviss:toggle-axes`: show or hide the global axes,
- `graviss:toggle-local-axes`: show or hide element-local axes,
- `graviss:toggle-section-rendering`: switch between rendered sections and plain lines and surfaces,
- `graviss:save-as-image`: render the active graphic and save it as a PNG,
- `graviss:copy-to-clipboard`: render the active graphic and copy it to the clipboard,
- `graviss:select-print-region`: drag a rectangle over the canvas to set the print region,
- `graviss:set-print-region-from-view`: use what the viewport currently covers as the print region,
- `graviss:auto-select`: frame the structure exactly,
- `graviss:auto-select-with-border`: frame the structure with a margin of two per cent of its longer side,
- `graviss:enter-selection-mode`: work the print region without holding the modifier,
- `graviss:exit-selection-mode`: hand every pointer back to the model,
- `graviss:clear-print-region`: drop the print region and cover the whole model again,
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

These files are meant to be written by hand and by other tools, so everything in one is optional — the extension is what makes it a view — and a file holds only what someone set. What is left out is worked out: a pane is named after its file, a graphic after its position, a view with no camera frames the model. A change writes down itself and nothing else, so a file kept short stays short.

The narrowest complete document is therefore `{}`, and a useful one is little more:

```json
{ "source": "model.dat" }
```

A graphic is identified by where it sits in `graphics`, and by nothing else, so nothing about it can collide or be misspelt. `activeGraphic` names the one to show as a position, counting from zero. It may carry an `id` and be named by that instead, which is easier to write by hand; an `id` is an alias rather than an identity, so two graphics may share one and the first wins.

Anything a graphic states is taken when it can be read and replaced by what leaving it out would have meant when it cannot — a camera that does not parse frames the model, an unknown appearance follows the theme. Only two things make a document unreadable rather than merely incomplete: a `format` or `version` naming something Graviss does not know, where reading it hopefully would be guessing. Such a file is not opened as a canvas at all; it opens as text, which is where it can be fixed.

A `title` names the model when someone wants it named, and most documents have no reason to: without one the pane is named after its file, extension included, exactly as the source of the same file is named. The two tabs then read alike and the icon is what tells the render from the source.

The canvas keeps its canonical JSON in a private `TextBuffer`, without creating or registering a hidden text editor. Clean external changes reload immediately. Changes that overlap unsaved work remain conflicted until the normal Lumine save flow resolves them.

Graviss owns the canvas and every command. Source packages provide the `graviss.source` service and own only recognition, file or database access, translation, and session disposal — no package but Graviss creates a viewer or registers an opener.

Dragging with the left button turns the model about whatever is under the pointer when the drag begins, so the detail being examined stays where it was rather than swinging out of frame. A mark shows the pinned point for as long as the drag runs. Started over empty space, where there is nothing to pin to, the drag turns about the camera target as it always did. The wheel is anchored the same way, moving along the ray under the pointer so that whatever it is over stays where it is.

A rendered image covers the active graphic's print region: a rectangle drawn over the viewport, held in fractions of it so it survives a resize and stays where it was drawn. Moving, rotating and zooming the camera change what falls inside it, which is how a view is composed through it. Every gesture on the frame is held behind the command modifier — Command on macOS, Control elsewhere — so the model keeps every unmodified pointer: orbit, pan, pick and the wheel all reach it through the frame. Held, a press inside the frame moves it, on an edge or a corner resizes it, outside it draws a new one, and a right-click drops it. One gesture is one undo step. **Enter Selection Mode** latches the modifier on for anyone who would rather not hold a key. Without one the image covers the whole model with a margin of two per cent of its longer side — the whole of it, including whatever the viewport is cropping away, and measured from what is drawn rather than from where the nodes are, so a rendered section is never cut off. It is still the view on screen, reaching past its edges: the camera never moves, because moving it would change the perspective and the image would be taken from somewhere the viewport never was.

Restoring a window rebuilds its panes before it wires up the packages' services, so a `.grv` reopened from the last session is built while no provider is registered and briefly reports that there is none. It loads itself as soon as one arrives, keeping the camera the document holds.

Each session describes its capabilities before Graviss asks for geometry, and a source may report that its data changed so Graviss rebuilds the scene. Values are SI: lengths in metres, forces in newtons. See the [service contract](docs/graviss.source.md) for the normalized model interface.

## Customization

Override the public custom properties in your `styles.css` to adjust the toolbar, the engineering-axis colors, and the mark that shows where a rotation is pinned:

```css
.graviss {
  --graviss-toolbar-height: 40px;
  --graviss-axis-x-color: #d9574f;
  --graviss-axis-y-color: #3b9c61;
  --graviss-axis-z-color: #3f88d8;
}

.graviss-orbit-pivot {
  --graviss-pivot-size: 16px;
}
```

## Services

- [`graviss.source`](docs/graviss.source.md): consumed to discover, open, and read FEM models supplied by source packages.
- `navigation.adapter`: provided to expose named graphics to the navigation panel.
- `tree-view.selection`: consumed to resolve selected `.grv` files for **Open Source**.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
