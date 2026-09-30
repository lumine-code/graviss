const { ViewportVisibility } = require("../lib/viewport-visibility");

function createFixture({ connected = true, width = 800, height = 500, hidden = false } = {}) {
  const listeners = new Map();
  let documentHidden = hidden;
  const ownerDocument = {
    get hidden() {
      return documentHidden;
    },
    addEventListener: jasmine.createSpy("add document listener").and.callFake((name, callback) => {
      listeners.set(name, callback);
    }),
    removeEventListener: jasmine
      .createSpy("remove document listener")
      .and.callFake((name, callback) => {
        if (listeners.get(name) === callback) listeners.delete(name);
      }),
  };
  const host = { isConnected: connected, clientWidth: width, clientHeight: height, ownerDocument };
  let intersectionCallback;
  let resizeCallback;
  const intersectionObserver = jasmine.createSpyObj("intersection observer", [
    "observe",
    "disconnect",
  ]);
  const resizeObserver = jasmine.createSpyObj("resize observer", ["observe", "disconnect"]);
  const onDidChange = jasmine.createSpy("viewport visibility");
  const onResize = jasmine.createSpy("viewport dimensions");
  const monitor = new ViewportVisibility(host, {
    onDidChange,
    onResize,
    document: ownerDocument,
    observerFactories: {
      intersection: (callback) => {
        intersectionCallback = callback;
        return intersectionObserver;
      },
      resize: (callback) => {
        resizeCallback = callback;
        return resizeObserver;
      },
    },
  });
  return {
    host,
    ownerDocument,
    monitor,
    intersectionObserver,
    resizeObserver,
    onDidChange,
    onResize,
    intersect: (isIntersecting, target = host) =>
      intersectionCallback([{ target, isIntersecting }]),
    resize: () => resizeCallback([]),
    setDocumentHidden(value) {
      documentHidden = value;
      listeners.get("visibilitychange")?.();
    },
    listeners,
  };
}

describe("Graviss viewport visibility", () => {
  let fixture;

  afterEach(() => fixture?.monitor.dispose());

  it("starts from connection, positive dimensions and document visibility", () => {
    for (const [options, expected] of [
      [{}, true],
      [{ connected: false }, false],
      [{ width: 0 }, false],
      [{ height: 0 }, false],
      [{ hidden: true }, false],
    ]) {
      const current = createFixture(options);
      expect(current.monitor.visible).toBe(expected);
      expect(current.onDidChange).not.toHaveBeenCalled();
      expect(current.onResize).not.toHaveBeenCalled();
      expect(current.intersectionObserver.observe).toHaveBeenCalledWith(current.host);
      expect(current.resizeObserver.observe).toHaveBeenCalledWith(current.host);
      current.monitor.dispose();
    }
  });

  it("reports intersection transitions once and ignores another target", () => {
    fixture = createFixture();
    fixture.intersect(false, {});
    expect(fixture.monitor.visible).toBe(true);
    fixture.intersect(false);
    fixture.intersect(false);
    expect(fixture.monitor.visible).toBe(false);
    fixture.intersect(true);
    fixture.intersect(true);
    expect(fixture.monitor.visible).toBe(true);
    expect(fixture.onDidChange.calls.allArgs()).toEqual([[false], [true]]);
  });

  it("gates intersections on document visibility and resumes when the document returns", () => {
    fixture = createFixture();
    fixture.setDocumentHidden(true);
    fixture.intersect(true);
    expect(fixture.monitor.visible).toBe(false);
    fixture.setDocumentHidden(false);
    expect(fixture.monitor.visible).toBe(true);
    fixture.intersect(false);
    fixture.setDocumentHidden(true);
    fixture.setDocumentHidden(false);
    expect(fixture.monitor.visible).toBe(false);
    expect(fixture.onDidChange.calls.allArgs()).toEqual([[false], [true], [false]]);
  });

  it("suspends a zero-sized viewport and resumes after a resize recovery", () => {
    fixture = createFixture();
    fixture.host.clientWidth = 0;
    fixture.resize();
    expect(fixture.monitor.visible).toBe(false);
    fixture.host.clientWidth = 640;
    fixture.host.clientHeight = 480;
    fixture.resize();
    fixture.resize();
    expect(fixture.monitor.visible).toBe(true);
    expect(fixture.onDidChange.calls.allArgs()).toEqual([[false], [true]]);
    expect(fixture.onResize.calls.allArgs()).toEqual([
      [0, 500],
      [640, 480],
    ]);
  });

  it("does not mistake an off-screen resize for an intersection recovery", () => {
    fixture = createFixture();
    fixture.intersect(false);
    fixture.host.clientWidth = 900;
    fixture.resize();
    expect(fixture.monitor.visible).toBe(false);
    expect(fixture.onResize).toHaveBeenCalledWith(900, 500);
    fixture.intersect(true);
    expect(fixture.monitor.visible).toBe(true);
  });

  it("refreshes removed and reattached hosts synchronously without an observer notification", () => {
    fixture = createFixture();
    fixture.host.isConnected = false;
    expect(fixture.monitor.refresh()).toBe(false);
    fixture.host.isConnected = true;
    expect(fixture.monitor.refresh()).toBe(true);
    fixture.host.clientHeight = 0;
    expect(fixture.monitor.refresh()).toBe(false);
    fixture.host.clientHeight = 300;
    expect(fixture.monitor.refresh()).toBe(true);
    expect(fixture.onDidChange.calls.allArgs()).toEqual([[false], [true], [false], [true]]);
    expect(fixture.onResize).not.toHaveBeenCalled();
  });

  it("keeps a disconnected host hidden despite intersection and resize notifications", () => {
    fixture = createFixture({ connected: false });
    fixture.intersect(true);
    fixture.resize();
    expect(fixture.monitor.visible).toBe(false);
    expect(fixture.onDidChange).not.toHaveBeenCalled();
  });

  it("still reports a resize after refresh already measured the new dimensions", () => {
    fixture = createFixture();
    fixture.host.clientWidth = 640;
    fixture.host.clientHeight = 480;
    expect(fixture.monitor.refresh()).toBe(true);
    expect(fixture.onResize).not.toHaveBeenCalled();
    fixture.resize();
    fixture.resize();
    expect(fixture.onResize).toHaveBeenCalledOnceWith(640, 480);
  });

  it("works without observers and uses the host's owner document by default", () => {
    const ownerDocument = {
      hidden: false,
      addEventListener: jasmine.createSpy("add listener"),
      removeEventListener: jasmine.createSpy("remove listener"),
    };
    const host = { isConnected: true, clientWidth: 10, clientHeight: 20, ownerDocument };
    const monitor = new ViewportVisibility(host, {
      observerFactories: { intersection: () => null, resize: () => null },
    });
    expect(monitor.visible).toBe(true);
    const listener = ownerDocument.addEventListener.calls.mostRecent().args;
    expect(listener[0]).toBe("visibilitychange");
    expect(typeof listener[1]).toBe("function");
    host.clientWidth = 0;
    expect(monitor.refresh()).toBe(false);
    expect(() => monitor.dispose()).not.toThrow();
  });

  it("disconnects once and ignores late observer or document callbacks after disposal", () => {
    fixture = createFixture();
    const visibilityChange = fixture.listeners.get("visibilitychange");
    fixture.monitor.dispose();
    fixture.monitor.dispose();
    fixture.intersect(false);
    fixture.host.clientWidth = 200;
    fixture.resize();
    visibilityChange();
    expect(fixture.monitor.refresh()).toBe(false);
    expect(fixture.monitor.visible).toBe(false);
    expect(fixture.onDidChange).not.toHaveBeenCalled();
    expect(fixture.onResize).not.toHaveBeenCalled();
    expect(fixture.intersectionObserver.disconnect).toHaveBeenCalledTimes(1);
    expect(fixture.resizeObserver.disconnect).toHaveBeenCalledTimes(1);
    expect(fixture.ownerDocument.removeEventListener).toHaveBeenCalledWith(
      "visibilitychange",
      visibilityChange,
    );
  });

  it("does not issue a resize after a visibility callback disposes the monitor", () => {
    fixture = createFixture();
    fixture.onDidChange.and.callFake(() => fixture.monitor.dispose());
    fixture.host.clientWidth = 0;
    fixture.resize();
    expect(fixture.onDidChange).toHaveBeenCalledOnceWith(false);
    expect(fixture.onResize).not.toHaveBeenCalled();
  });
});
