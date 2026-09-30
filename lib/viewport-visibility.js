// Observer state gates automatic viewport work. Callers still check the host's
// connection and size before drawing: DOM removal can precede observer delivery.
class ViewportVisibility {
  constructor(host, { onDidChange, onResize, document, observerFactories = {} } = {}) {
    this.host = host;
    this.document = document ?? host.ownerDocument ?? globalThis.document;
    this.onDidChange = onDidChange;
    this.onResize = onResize;
    this.disposed = false;
    // An ordinary attached viewport can draw immediately; the first actual
    // intersection notification then narrows this to the observed screen area.
    this.intersecting = true;
    this.width = host.clientWidth;
    this.height = host.clientHeight;
    this.resizeWidth = this.width;
    this.resizeHeight = this.height;
    this.visible = this.measureVisibility();
    const view = this.document?.defaultView ?? globalThis;
    const createIntersection =
      observerFactories.intersection ??
      (typeof view.IntersectionObserver === "function"
        ? (callback) => new view.IntersectionObserver(callback)
        : null);
    const createResize =
      observerFactories.resize ??
      (typeof view.ResizeObserver === "function"
        ? (callback) => new view.ResizeObserver(callback)
        : null);
    this.intersectionObserver = createIntersection?.((entries) => {
      if (this.disposed) return;
      let changed = false;
      for (const entry of entries) {
        if (entry.target !== this.host) continue;
        this.intersecting = Boolean(entry.isIntersecting);
        changed = true;
      }
      if (changed) this.refresh();
    });
    this.resizeObserver = createResize?.(() => {
      if (this.disposed) return;
      this.refresh();
      if (
        !this.disposed &&
        (this.resizeWidth !== this.width || this.resizeHeight !== this.height)
      ) {
        this.resizeWidth = this.width;
        this.resizeHeight = this.height;
        this.onResize?.(this.width, this.height);
      }
    });
    this.onVisibilityChange = () => this.refresh();
    this.document?.addEventListener("visibilitychange", this.onVisibilityChange);
    this.intersectionObserver?.observe(host);
    this.resizeObserver?.observe(host);
  }

  measureVisibility() {
    return Boolean(
      this.host.isConnected &&
      this.width > 0 &&
      this.height > 0 &&
      !this.document?.hidden &&
      this.intersecting,
    );
  }

  refresh() {
    if (this.disposed) return false;
    this.width = this.host.clientWidth;
    this.height = this.host.clientHeight;
    const visible = this.measureVisibility();
    if (visible !== this.visible) {
      this.visible = visible;
      this.onDidChange?.(visible);
    }
    return visible;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.visible = false;
    this.intersectionObserver?.disconnect();
    this.resizeObserver?.disconnect();
    this.document?.removeEventListener("visibilitychange", this.onVisibilityChange);
  }
}

module.exports = { ViewportVisibility };
