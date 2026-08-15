const ICON_DRAWINGS = Object.freeze({
  "previous-graphic": `
    <rect x="6" y="3.5" width="10" height="13" rx="1.2"></rect>
    <path d="M4 6v9.5h9M10 7l-3 3 3 3M7 10h6"></path>
  `,
  "next-graphic": `
    <rect x="4" y="3.5" width="10" height="13" rx="1.2"></rect>
    <path d="M16 6v9.5H7M10 7l3 3-3 3M13 10H7"></path>
  `,
  fit: `
    <path d="M7 3H3v4M13 3h4v4M17 13v4h-4M7 17H3v-4"></path>
    <rect x="7" y="7" width="6" height="6" rx=".7"></rect>
  `,
  isometric: `
    <path d="M10 2.8l6.3 3.6v7.2L10 17.2l-6.3-3.6V6.4L10 2.8Z"></path>
    <path d="m3.7 6.4 6.3 3.7 6.3-3.7M10 10.1v7.1"></path>
  `,
  top: `
    <path class="graviss-icon-fill" d="M10 2.8l6.3 3.6-6.3 3.7-6.3-3.7L10 2.8Z"></path>
    <path d="M10 2.8l6.3 3.6v7.2L10 17.2l-6.3-3.6V6.4L10 2.8Z"></path>
    <path d="m3.7 6.4 6.3 3.7 6.3-3.7M10 10.1v7.1"></path>
  `,
  front: `
    <path class="graviss-icon-fill" d="m3.7 6.4 6.3 3.7v7.1l-6.3-3.6V6.4Z"></path>
    <path d="M10 2.8l6.3 3.6v7.2L10 17.2l-6.3-3.6V6.4L10 2.8Z"></path>
    <path d="m3.7 6.4 6.3 3.7 6.3-3.7M10 10.1v7.1"></path>
  `,
  right: `
    <path class="graviss-icon-fill" d="m10 10.1 6.3-3.7v7.2L10 17.2v-7.1Z"></path>
    <path d="M10 2.8l6.3 3.6v7.2L10 17.2l-6.3-3.6V6.4L10 2.8Z"></path>
    <path d="m3.7 6.4 6.3 3.7 6.3-3.7M10 10.1v7.1"></path>
  `,
  perspective: `
    <circle cx="3.5" cy="10" r="1.2"></circle>
    <rect x="10" y="5.2" width="6.5" height="9.6" rx=".7"></rect>
    <path d="m4.7 9.4 5.3-4.2M4.7 10.6l5.3 4.2M7.3 7.4v5.2"></path>
  `,
  orthographic: `
    <rect x="3.5" y="7" width="9" height="10" rx=".7"></rect>
    <rect x="7.5" y="3" width="9" height="10" rx=".7"></rect>
    <path d="m3.5 7 4-4M12.5 7l4-4M12.5 17l4-4"></path>
  `,
  members: `
    <path d="M4.2 15.8 15.8 4.2" stroke-width="2.4"></path>
    <circle cx="4.2" cy="15.8" r="2"></circle>
    <circle cx="15.8" cy="4.2" r="2"></circle>
  `,
  shells: `
    <path class="graviss-icon-fill" d="m3.2 6.2 10.9-3 2.7 10.6-10.9 3-2.7-10.6Z"></path>
    <path d="m3.2 6.2 10.9-3 2.7 10.6-10.9 3-2.7-10.6ZM3.2 6.2l13.6 7.6"></path>
  `,
  nodes: `
    <path d="M5 15 10 5l5 10H5Z"></path>
    <circle cx="10" cy="5" r="2" fill="currentColor" stroke="none"></circle>
    <circle cx="5" cy="15" r="2" fill="currentColor" stroke="none"></circle>
    <circle cx="15" cy="15" r="2" fill="currentColor" stroke="none"></circle>
  `,
  supports: `
    <circle cx="10" cy="4" r="1.8" fill="currentColor" stroke="none"></circle>
    <path d="M10 5.8V12M4 12h12M5 12l-2 3M9 12l-2 3M13 12l-2 3M17 12l-2 3"></path>
  `,
  grid: `
    <path d="m10 3 7 4-7 10-7-4 7-10Z"></path>
    <path d="m6.5 5 7 10M13.5 5l-7 10M3.8 9l6.2 3.6L16.2 9"></path>
  `,
  axes: `
    <circle cx="5" cy="15" r="1.4" fill="currentColor" stroke="none"></circle>
    <path d="M5 15h11m-2-2 2 2-2 2M5 15V4M3 6l2-2 2 2M5 15l7-7M8.5 8H12v3.5"></path>
  `,
  "local-axes": `
    <path d="M4 15.5 9.5 10m0 0 6.5-.5M9.5 10l.5-6.5"></path>
    <path d="m14.2 7.9 1.8 1.6-1.5 1.9M7.8 5.3 10 3.5l1.6 2M4 12.8v2.7h2.7"></path>
    <circle cx="9.5" cy="10" r="1.35" fill="currentColor" stroke="none"></circle>
  `,
  mesh: `
    <rect x="3.2" y="3.2" width="13.6" height="13.6" rx="1.2"></rect>
    <path d="M7.7 3.2v13.6M12.3 3.2v13.6M3.2 7.7h13.6M3.2 12.3h13.6"></path>
  `,
  "detail-section": `
    <path d="m5.6 14.4 8.8-8.8" stroke-width="2.6"></path>
    <path d="M3.4 12.2 7.8 16.6M12.2 3.4l4.4 4.4"></path>
  `,
  background: `
    <rect x="3" y="4" width="14" height="12" rx="1.3"></rect>
    <path class="graviss-icon-fill" d="M10 4h5.7c.7 0 1.3.6 1.3 1.3v9.4c0 .7-.6 1.3-1.3 1.3H10V4Z"></path>
    <path d="M10 4v12M4.5 14l3.4-3.7 2.1 2.1 2.4-3 3.1 4.6"></path>
    <circle cx="6.7" cy="7.6" r="1.3"></circle>
  `,
});

function toolbarIcon(name) {
  const drawing = ICON_DRAWINGS[name];
  if (!drawing) throw new RangeError(`Unknown Graviss toolbar icon: ${name}`);
  return `<svg class="icon graviss-toolbar-icon" data-icon="${name}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${drawing}</svg>`;
}

module.exports = { ICON_DRAWINGS, toolbarIcon };
