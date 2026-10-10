const { GravissPanel } = require("./graviss-panel");
const {
  ANIMATION_MODE_IDS,
  DEFAULT_CYCLE_ID,
  defaultCycle,
  phaseOf,
  positionForPhase,
} = require("./animation");
const { colorScaleStops } = require("./color-scale");

const RESULTS_PANEL_URI = "graviss://results";
const SCALE_PRESETS = Object.freeze([0, 1, 10, 100, 1000]);
const RESULT_KINDS = Object.freeze({
  displacement: "Displacement",
  memberDiagram: "Member results",
});
const CYCLE_LABELS = Object.freeze({
  [DEFAULT_CYCLE_ID]: "Default",
  pingPong: "Swing",
  thereAndBack: "Positive",
});
const CYCLE_HINTS = Object.freeze({
  [DEFAULT_CYCLE_ID]: "Swing for mode shapes and buckling; Positive for ordinary load cases.",
  pingPong: "Full shape one way, then the other. A mode shape has no sign.",
  thereAndBack: "Ease from undeformed to the full shape and smoothly back again.",
});

// Factors, rather than linear numbers, give each decade the same room. Zero
// has its own preset so a small thumb movement never hides the deformation.
const SLIDER_STEPS = 1000;
const SLIDER_LOW = -2;
const SLIDER_HIGH = 4;
const PERIOD_MIN = 250;

function scaleForSlider(position) {
  const decade = SLIDER_LOW + (position / SLIDER_STEPS) * (SLIDER_HIGH - SLIDER_LOW);
  return 10 ** decade;
}

function sliderForScale(scale) {
  if (!(scale > 0)) return 0;
  const decade = Math.log10(scale);
  const position = ((decade - SLIDER_LOW) / (SLIDER_HIGH - SLIDER_LOW)) * SLIDER_STEPS;
  return Math.round(Math.min(SLIDER_STEPS, Math.max(0, position)));
}

function formatDisplacement(metres) {
  if (!Number.isFinite(metres)) return "";
  if (Math.abs(metres) < 1) return `${(metres * 1000).toPrecision(3)} mm`;
  return `${metres.toPrecision(3)} m`;
}

function formatQuantity(value, quantity, units = true) {
  if (!Number.isFinite(value)) return "—";
  const number = Number((value * quantity.displayFactor).toPrecision(5));
  return `${number > 0 ? "+" : ""}${number}${units && quantity.displayUnit ? ` ${quantity.displayUnit}` : ""}`;
}

function forceLocation(point) {
  return point ? `Member ${point.elementId} · x = ${Number(point.x.toPrecision(5))} m` : "";
}

function formatScale(scale) {
  if (scale === 0) return "0";
  if (scale >= 100) return `${Math.round(scale)}`;
  if (scale >= 10) return scale.toFixed(1);
  return scale.toFixed(2);
}

function caseKey(id) {
  return id == null ? null : `${typeof id}:${id}`;
}

function setText(element, value) {
  if (element.textContent !== value) element.textContent = value;
}

function kindLabel(kind) {
  return kind === "eigenmode"
    ? "Mode shape"
    : `${kind.charAt(0).toUpperCase()}${kind.slice(1).replaceAll("-", " ")}`;
}

class ResultsPanel extends GravissPanel {
  constructor() {
    super({
      uri: RESULTS_PANEL_URI,
      title: "Results",
      iconName: "graph",
      className: "graviss-results-panel",
      deserializerName: "GravissResultsPanel",
    });
    this.previewIndex = null;
    this.previewTimer = null;
    this.caseRows = new Map();
    this.caseQuery = "";
    this.caseKind = "all";
    this.build();
    this.initialize();
  }

  build() {
    this.body.innerHTML = `
      <div class="graviss-panel-scroll">
      <section class="graviss-panel-section graviss-case-browser" data-section="cases">
        <div class="graviss-panel-section-heading">
          <h3 class="graviss-panel-heading">Load cases</h3>
          <span class="graviss-case-count"></span>
        </div>
        <button type="button" class="btn btn-sm graviss-case-system">System <span>No results</span></button>
        <div class="graviss-case-search-controls">
          <input type="search" class="input-text native-key-bindings graviss-case-search" placeholder="Find a load case…" aria-label="Find a load case">
          <span class="graviss-case-kind-host"></span>
        </div>
        <ul class="graviss-case-list" tabindex="0" role="listbox" aria-label="Load cases"></ul>
        <div class="graviss-case-no-matches" hidden>No matching load cases.</div>
        <div class="graviss-case-navigation">
          <button type="button" class="btn btn-sm graviss-case-previous" aria-label="Previous load case">←</button>
          <span class="graviss-case-position"></span>
          <button type="button" class="btn btn-sm graviss-case-next" aria-label="Next load case">→</button>
        </div>
        <div class="graviss-result-error" hidden>
          <span class="graviss-result-error-message" role="alert"></span>
          <button type="button" class="btn btn-sm graviss-result-retry">Retry</button>
        </div>
      </section>
      <section class="graviss-panel-section" data-section="quantity">
        <h3 class="graviss-panel-heading">Result quantity</h3>
        <span class="graviss-result-kind-host"></span>
      </section>
      <section class="graviss-panel-section graviss-beam-results" data-section="member-diagrams" hidden>
        <h3 class="graviss-panel-heading">Member results</h3>
        <span class="graviss-member-group-host"></span>
        <span class="graviss-force-component-host"></span>
        <div class="graviss-force-empty" role="status"></div>
        <div class="graviss-force-extrema">
          <div><span>Minimum</span><strong class="graviss-force-min"></strong><small class="graviss-force-min-location"></small></div>
          <div><span>Maximum</span><strong class="graviss-force-max"></strong><small class="graviss-force-max-location"></small></div>
        </div>
        <div class="graviss-force-count"></div>
        <div class="graviss-force-label-notice" role="status" hidden></div>
        <label class="graviss-force-scale-label" for="graviss-force-scale">Diagram scale</label>
        <div class="graviss-force-scale-controls">
          <input id="graviss-force-scale" type="number" class="input-text native-key-bindings graviss-force-scale-input" min="0" step="any" aria-label="Diagram scale">
          <span class="graviss-force-scale-unit"></span>
          <button type="button" class="btn btn-sm graviss-force-scale-auto" aria-pressed="false">Auto</button>
        </div>
        <div class="graviss-force-scale-error" role="alert" hidden>Enter a finite scale greater than zero.</div>
        <label class="graviss-force-plane-label">Diagram direction</label>
        <span class="graviss-force-plane-host"></span>
        <div class="graviss-force-options">
          <label><input type="checkbox" class="input-checkbox graviss-force-flip"><span>Flip diagram side</span></label>
          <label><input type="checkbox" class="input-checkbox graviss-force-filled"><span>Filled diagrams</span></label>
          <label><input type="checkbox" class="input-checkbox graviss-force-labels"><span>Show extrema labels</span></label>
        </div>
        <div class="graviss-force-hint">Quantities and units are supplied by the source. Flipping the diagram changes its side only; missing values remain unavailable.</div>
        <div class="graviss-force-selected" hidden>
          <h3 class="graviss-panel-heading graviss-force-selected-title"></h3>
          <div class="graviss-force-station-scroll"><table class="graviss-force-stations"><thead><tr><th scope="col">x [m]</th><th scope="col" class="graviss-force-station-quantity"></th></tr></thead><tbody></tbody></table></div>
        </div>
      </section>
      <section class="graviss-panel-section" data-section="scale">
        <div class="graviss-panel-section-heading">
          <h3 class="graviss-panel-heading">Amplification</h3>
          <span class="graviss-scale-value"></span>
        </div>
        <div class="graviss-scale-controls">
          <label class="graviss-scale-field"><span>×</span><input type="number" class="input-text native-key-bindings graviss-scale-input" min="0" step="any" aria-label="Amplification factor"></label>
          <button type="button" class="btn btn-sm graviss-scale-auto" aria-pressed="false">Auto</button>
          <span class="graviss-scale-mode"></span>
        </div>
        <div class="graviss-scale-error" role="alert" hidden>Enter a finite factor of zero or greater.</div>
        <div class="graviss-scale-presets"></div>
        <input type="range" class="graviss-scale-slider" min="0" max="${SLIDER_STEPS}" step="1" aria-label="Amplification">
      </section>
      <section class="graviss-panel-section" data-section="animation">
        <h3 class="graviss-panel-heading">Animation</h3>
        <div class="graviss-animation-controls">
          <button type="button" class="btn btn-sm graviss-play" aria-pressed="false"></button>
          <span class="graviss-cycle-host"></span>
        </div>
        <label class="graviss-animation-position-control">
          <span class="graviss-animation-position-value">Deformation 0%</span>
          <input type="range" class="graviss-animation-position" min="0" max="100" step="0.1" aria-label="Deformation percentage">
        </label>
        <label class="graviss-period-field"><span>Period</span><input type="number" class="input-text native-key-bindings graviss-period-input" min="${PERIOD_MIN / 1000}" step="0.05" aria-label="Animation period in seconds"><span>s</span></label>
      </section>
      <section class="graviss-panel-section" data-section="colors">
        <label class="graviss-color-toggle">
          <input type="checkbox" class="input-checkbox graviss-color-by">
          <span>Colours |u|</span>
        </label>
        <div class="graviss-color-hint">True displacement magnitude, independent of amplification.</div>
        <div class="graviss-legend" hidden>
          <div class="graviss-legend-ramp"></div>
          <div class="graviss-legend-ends"><span class="graviss-legend-min"></span><span class="graviss-legend-max"></span></div>
        </div>
      </section>
      </div>
      <footer class="graviss-panel-footer"><div class="graviss-result-status graviss-panel-status" role="status"></div></footer>
    `;
    for (const [name, selector] of Object.entries({
      caseList: ".graviss-case-list",
      caseSearch: ".graviss-case-search",
      caseCount: ".graviss-case-count",
      casePosition: ".graviss-case-position",
      casePrevious: ".graviss-case-previous",
      caseNext: ".graviss-case-next",
      systemButton: ".graviss-case-system",
      resultStatus: ".graviss-result-status",
      resultError: ".graviss-result-error",
      retryButton: ".graviss-result-retry",
      scaleValue: ".graviss-scale-value",
      scaleInput: ".graviss-scale-input",
      scaleAuto: ".graviss-scale-auto",
      scaleMode: ".graviss-scale-mode",
      scaleError: ".graviss-scale-error",
      scalePresets: ".graviss-scale-presets",
      scaleSlider: ".graviss-scale-slider",
      playButton: ".graviss-play",
      positionSlider: ".graviss-animation-position",
      positionValue: ".graviss-animation-position-value",
      periodInput: ".graviss-period-input",
      colorToggle: ".graviss-color-by",
      legend: ".graviss-legend",
      beamSection: ".graviss-beam-results",
      forceEmpty: ".graviss-force-empty",
      forceExtrema: ".graviss-force-extrema",
      forceMin: ".graviss-force-min",
      forceMax: ".graviss-force-max",
      forceMinLocation: ".graviss-force-min-location",
      forceMaxLocation: ".graviss-force-max-location",
      forceCount: ".graviss-force-count",
      forceLabelNotice: ".graviss-force-label-notice",
      forceScaleInput: ".graviss-force-scale-input",
      forceScaleUnit: ".graviss-force-scale-unit",
      forceScaleAuto: ".graviss-force-scale-auto",
      forceScaleError: ".graviss-force-scale-error",
      forceFlip: ".graviss-force-flip",
      forceFilled: ".graviss-force-filled",
      forceLabels: ".graviss-force-labels",
      forceSelected: ".graviss-force-selected",
      forceSelectedTitle: ".graviss-force-selected-title",
      forceStationQuantity: ".graviss-force-station-quantity",
      forceStations: ".graviss-force-stations tbody",
    })) {
      this[name] = this.body.querySelector(selector);
    }
    this.buildScalePresets();
    this.kindSelect = lumine.menu.createSelectBox({
      items: [{ value: "all", label: "All types" }],
      value: "all",
      ariaLabel: "Load case type",
      className: "graviss-case-kind-filter",
    });
    this.body.querySelector(".graviss-case-kind-host").replaceWith(this.kindSelect.element);
    this.cycleSelect = lumine.menu.createSelectBox({
      items: this.cycleItems(),
      value: DEFAULT_CYCLE_ID,
      ariaLabel: "Cycle",
      className: "graviss-cycle",
    });
    this.body.querySelector(".graviss-cycle-host").replaceWith(this.cycleSelect.element);
    this.resultKindSelect = lumine.menu.createSelectBox({
      items: Object.entries(RESULT_KINDS).map(([value, label]) => ({ value, label })),
      value: "displacement",
      ariaLabel: "Result quantity",
      className: "graviss-result-kind",
    });
    this.body.querySelector(".graviss-result-kind-host").replaceWith(this.resultKindSelect.element);
    this.memberGroupSelect = lumine.menu.createSelectBox({
      items: [],
      ariaLabel: "Member result category",
      className: "graviss-member-group",
    });
    this.body
      .querySelector(".graviss-member-group-host")
      .replaceWith(this.memberGroupSelect.element);
    this.forceComponentSelect = lumine.menu.createSelectBox({
      items: [],
      ariaLabel: "Member result quantity",
      className: "graviss-force-component",
    });
    this.body
      .querySelector(".graviss-force-component-host")
      .replaceWith(this.forceComponentSelect.element);
    this.forcePlaneSelect = lumine.menu.createSelectBox({
      items: [
        { value: "auto", label: "Automatic · source direction" },
        { value: "y", label: "Local y" },
        { value: "z", label: "Local z" },
      ],
      value: "auto",
      ariaLabel: "Diagram direction",
      className: "graviss-force-plane",
    });
    this.body.querySelector(".graviss-force-plane-host").replaceWith(this.forcePlaneSelect.element);
    this.body.querySelector(".graviss-legend-ramp").style.background =
      `linear-gradient(to right, ${colorScaleStops().join(", ")})`;

    this.caseSearch.addEventListener("input", () => {
      this.caseQuery = this.caseSearch.value;
      this.changeCaseFilter();
    });
    this.systemButton.addEventListener("click", () => {
      this.resetPreview();
      void this.viewer?.selectLoadCase(null);
    });
    this.casePrevious.addEventListener("click", () => this.stepBy(-1));
    this.caseNext.addEventListener("click", () => this.stepBy(1));
    this.retryButton.addEventListener("click", () => void this.viewer?.retryLoadCase());
    this.scaleAuto.addEventListener("click", () => {
      const scale = this.viewer?.getResultsState().scale;
      const factor = this.viewer?.renderer?.getDeformation()?.scale ?? 1;
      this.viewer?.setDeformationScale(scale === "auto" ? factor : "auto");
    });
    this.scaleInput.addEventListener("input", () => {
      const scale = Number(this.scaleInput.value);
      const valid = this.scaleInput.value.trim() !== "" && Number.isFinite(scale) && scale >= 0;
      this.scaleInput.setAttribute("aria-invalid", String(!valid));
      this.scaleError.hidden = valid;
      if (valid) this.viewer?.setDeformationScale(scale);
    });
    this.scaleInput.addEventListener("blur", () => {
      if (this.viewer && !this.emptyReason()) this.renderScale(this.viewer.getResultsState(), true);
    });
    this.scaleSlider.addEventListener("input", () =>
      this.viewer?.setDeformationScale(scaleForSlider(Number(this.scaleSlider.value))),
    );
    this.periodInput.addEventListener("input", () => {
      const seconds = Number(this.periodInput.value);
      const valid =
        this.periodInput.value.trim() !== "" &&
        Number.isFinite(seconds) &&
        seconds >= PERIOD_MIN / 1000;
      this.periodInput.setAttribute("aria-invalid", String(!valid));
      if (valid) this.viewer?.setAnimationPeriod(seconds * 1000);
    });
    this.periodInput.addEventListener("blur", () => {
      if (this.viewer && !this.emptyReason()) {
        this.renderAnimation(this.viewer.getResultsState(), true);
      }
    });
    this.positionSlider.addEventListener("input", () => {
      this.viewer?.setAnimationPosition(
        positionForPhase(
          this.resolvedCycle(),
          Number(this.positionSlider.value) / 100,
          this.viewer.getAnimationPosition() ?? 0,
        ),
      );
    });
    this.bindWheel(this.scaleInput, 1, () => this.viewer.renderer?.getDeformation()?.scale);
    this.bindWheel(
      this.periodInput,
      0.05,
      () => Number(this.viewer.getResultsState().period ?? 2000) / 1000,
    );
    this.bindWheel(this.scaleSlider, 10);
    this.bindWheel(this.positionSlider, 1);
    this.playButton.addEventListener("click", () => this.viewer?.toggleAnimation());
    this.colorToggle.addEventListener("change", () => this.viewer?.toggleColorByDisplacement());
    this.forceScaleInput.addEventListener("input", () => {
      const value = Number(this.forceScaleInput.value);
      const quantity = this.currentMemberQuantity();
      const scale = value * quantity?.displayFactor;
      const valid = this.forceScaleInput.value.trim() !== "" && Number.isFinite(scale) && scale > 0;
      this.forceScaleInput.setAttribute("aria-invalid", String(!valid));
      this.forceScaleError.hidden = valid;
      this.forceScaleError.textContent = "Enter a finite scale greater than zero.";
      if (valid) this.applyMemberDiagramOptions({ diagramScale: scale });
    });
    this.forceScaleInput.addEventListener("blur", () => {
      if (this.viewer && !this.emptyReason())
        this.renderMemberDiagram(this.viewer.getResultsState(), true);
    });
    this.forceScaleAuto.addEventListener("click", () => {
      const state = this.viewer?.getResultsState();
      const scale = this.viewer?.renderer?.getMemberDiagramSummary()?.scale;
      if (!state) return;
      this.applyMemberDiagramOptions({
        diagramScale: state.diagramScale === "auto" && scale > 0 ? scale : "auto",
      });
    });
    for (const [field, key] of [
      [this.forceFlip, "diagramFlip"],
      [this.forceFilled, "diagramFilled"],
      [this.forceLabels, "diagramLabels"],
    ]) {
      field.addEventListener("change", () =>
        this.applyMemberDiagramOptions({ [key]: field.checked }),
      );
    }
    this.subscriptions.add(
      this.kindSelect.onDidChange(({ value }) => {
        this.caseKind = value;
        this.changeCaseFilter();
      }),
      this.cycleSelect.onDidChange(({ value }) => this.viewer?.setAnimationCycle(value)),
      this.resultKindSelect.onDidChange(({ value }) => {
        this.resetPreview();
        void this.viewer?.setResultKind(value);
      }),
      this.forceComponentSelect.onDidChange(({ value }) =>
        this.applyMemberDiagramOptions({ component: value }),
      ),
      this.memberGroupSelect.onDidChange(({ value }) => {
        const quantity = this.memberQuantities().find((component) => component.group === value);
        if (quantity) this.applyMemberDiagramOptions({ component: quantity.id });
      }),
      this.forcePlaneSelect.onDidChange(({ value }) =>
        this.applyMemberDiagramOptions({ diagramPlane: value }),
      ),
      lumine.commands.add(this.caseList, {
        "core:move-up": () => this.previewBy(-1),
        "core:move-down": () => this.previewBy(1),
        "core:move-to-top": () => this.previewTo(0),
        "core:move-to-bottom": () => this.previewTo(this.cases().length - 1),
        "core:confirm": () => this.commitPreview(),
        "core:cancel": () => this.cancelPreview(),
      }),
    );
  }

  bindWheel(field, step, fallback = () => Number(field.value)) {
    field.addEventListener(
      "wheel",
      (event) => {
        if (!this.viewer || this.body.hidden || field.disabled || !event.deltaY) return;
        const min = field.min === "" ? -Infinity : Number(field.min);
        const max = field.max === "" ? Infinity : Number(field.max);
        let current = Number(field.value);
        if (!field.value.trim() || !Number.isFinite(current) || current < min || current > max) {
          current = fallback();
        }
        if (!Number.isFinite(current)) return;
        event.preventDefault();
        event.stopPropagation();
        const next = current - Math.sign(event.deltaY) * step * (event.shiftKey ? 10 : 1);
        field.value = String(Number(Math.min(max, Math.max(min, next)).toPrecision(12)));
        field.dispatchEvent(new Event("input", { bubbles: true }));
      },
      { passive: false },
    );
  }

  buildScalePresets() {
    this.scalePresets.append(
      ...SCALE_PRESETS.map((preset) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn btn-sm graviss-scale-preset";
        button.dataset.scale = String(preset);
        button.textContent = `×${preset}`;
        button.addEventListener("click", () => this.viewer?.setDeformationScale(preset));
        return button;
      }),
    );
  }

  emptyReason() {
    const inherited = super.emptyReason();
    if (inherited) return inherited;
    if (!this.viewer.hasResults() && !this.viewer.resultsError) {
      return "This model carries no analysis results.";
    }
    return null;
  }

  cases() {
    const query = this.caseQuery.trim().toLocaleLowerCase();
    return (this.viewer?.getLoadCases() ?? []).filter(
      (loadCase) =>
        (this.caseKind === "all" || loadCase.kind === this.caseKind) &&
        (!query || `${loadCase.id} ${loadCase.title}`.toLocaleLowerCase().includes(query)),
    );
  }

  loadState() {
    return (
      this.viewer.getResultLoadState?.() ?? {
        pendingLoadCaseId: this.viewer.resultSelection?.loadCase.id ?? null,
        failedLoadCaseId: null,
        error: this.viewer.resultsError,
        displayedLoadCaseId: this.viewer.result?.loadCaseId ?? null,
      }
    );
  }

  selectedCaseId(loadState = this.loadState()) {
    return (
      loadState.pendingLoadCaseId ?? loadState.failedLoadCaseId ?? loadState.displayedLoadCaseId
    );
  }

  render() {
    const state = this.viewer.getResultsState();
    const force = this.forceControlSync === true;
    this.renderKinds();
    this.renderCases();
    this.renderResultKinds(state);
    this.renderMemberDiagram(state, force);
    this.renderScale(state, force);
    this.renderAnimation(state, force);
    this.renderColors(state);
    this.forceControlSync = false;
  }

  renderEmpty() {
    this.resetPreview();
    this.caseRows.clear();
    this.caseList.replaceChildren();
    this.caseCount.textContent = "";
    this.scaleValue.textContent = "";
    this.legend.hidden = true;
    this.resultError.hidden = true;
    this.forceSelected.hidden = true;
    this.forceStations.replaceChildren();
  }

  renderKinds() {
    const kinds = [...new Set(this.viewer.getLoadCases().map((loadCase) => loadCase.kind))]
      .filter(Boolean)
      .sort();
    const signature = JSON.stringify(kinds);
    if (signature === this.kindsSignature) return;
    this.kindsSignature = signature;
    if (!kinds.includes(this.caseKind)) this.caseKind = "all";
    this.kindSelect.setItems(
      [
        { value: "all", label: "All types" },
        ...kinds.map((kind) => ({ value: kind, label: kindLabel(kind) })),
      ],
      { value: this.caseKind },
    );
  }

  requestedKind(state = this.viewer.getResultsState()) {
    const loadState = this.loadState();
    return loadState.pendingKind ?? loadState.failedKind ?? state.kind ?? "displacement";
  }

  renderResultKinds(state) {
    const capabilities = this.viewer.description?.capabilities?.results ?? {};
    const kind = this.requestedKind(state);
    const items = Object.entries(RESULT_KINDS)
      .filter(([value]) => capabilities[value] || value === kind)
      .map(([value, label]) => ({ value, label, disabled: !capabilities[value] }));
    const signature = JSON.stringify(items);
    if (signature !== this.resultKindsSignature) {
      this.resultKindsSignature = signature;
      this.resultKindSelect.setItems(items, { value: kind });
    } else this.resultKindSelect.setValue(kind);
    this.resultKindSelect.setEnabled(items.some((item) => !item.disabled));
    this.beamSection.hidden = kind !== "memberDiagram";
    for (const section of ["scale", "animation", "colors"]) {
      this.body.querySelector(`[data-section="${section}"]`).hidden = kind !== "displacement";
    }
  }

  memberQuantities() {
    return this.viewer?.result?.kind === "memberDiagram" ? this.viewer.result.components : [];
  }

  currentMemberQuantity() {
    return (
      this.viewer?.renderer?.getMemberDiagramSummary?.()?.quantity ??
      this.memberQuantities().find(({ id }) => id === this.viewer.getResultsState().component) ??
      null
    );
  }

  applyMemberDiagramOptions(options) {
    if (!this.viewer) return;
    try {
      this.viewer.setMemberDiagramOptions(options);
    } catch (error) {
      this.renderMemberDiagram(this.viewer.getResultsState());
      this.forceScaleInput.setAttribute("aria-invalid", "true");
      this.forceScaleError.textContent = error.message ?? String(error);
      this.forceScaleError.hidden = false;
    }
  }

  renderMemberDiagram(state, force = false) {
    const summary = this.viewer.renderer?.getMemberDiagramSummary?.();
    const result = this.viewer.result?.kind === "memberDiagram" ? this.viewer.result : null;
    const quantities = this.memberQuantities();
    const quantity = this.currentMemberQuantity();
    const component = quantity?.id ?? state.component;
    const groups = [...new Set(quantities.map(({ group }) => group))];
    const groupItems = groups.map((group) => ({ value: group, label: group }));
    const groupSignature = JSON.stringify([groups, quantity?.group]);
    if (groupSignature !== this.memberGroupsSignature) {
      this.memberGroupsSignature = groupSignature;
      this.memberGroupSelect.setItems(groupItems, { value: quantity?.group });
    }
    this.memberGroupSelect.setEnabled(Boolean(result));
    const items = quantities
      .filter(({ group }) => group === quantity?.group)
      .map(({ id, title, displayUnit }) => ({
        value: id,
        label: `${id === title ? title : `${id} · ${title}`}${displayUnit ? ` [${displayUnit}]` : ""}`,
      }));
    const signature = JSON.stringify([items, component]);
    if (signature !== this.forceComponentsSignature) {
      this.forceComponentsSignature = signature;
      this.forceComponentSelect.setItems(items, { value: component });
    }
    this.forceComponentSelect.setEnabled(Boolean(result));
    const empty = !summary || summary.empty;
    const available = Boolean(quantity);
    this.forceEmpty.hidden = !empty;
    this.forceEmpty.textContent = !result
      ? "Select a load case to display member results."
      : !available
        ? "This load case has no available member result quantities."
        : result.elements.length === 0
          ? "This load case contains no member results."
          : `No values for ${quantity.title} in the visible model.`;
    if (!result && this.loadState().pendingKind === "memberDiagram") {
      this.forceEmpty.textContent = "Loading member results…";
    } else if (!result && this.loadState().failedKind === "memberDiagram") {
      this.forceEmpty.textContent = `Member results could not be loaded.${this.viewer.result ? " The previous result remains displayed." : ""}`;
    }
    this.forceExtrema.hidden = empty;
    this.forceMin.textContent = formatQuantity(summary?.min, quantity);
    this.forceMax.textContent = formatQuantity(summary?.max, quantity);
    this.forceMinLocation.textContent = forceLocation(summary?.minimum);
    this.forceMaxLocation.textContent = forceLocation(summary?.maximum);
    this.forceCount.textContent = summary
      ? `${summary.elementCount} of ${summary.totalElementCount} members · ${summary.stationCount} stations`
      : "";
    this.forceLabelNotice.hidden = !(
      state.diagramLabels && summary?.labelsTotal > summary?.labelsShown
    );
    this.forceLabelNotice.textContent = this.forceLabelNotice.hidden
      ? ""
      : `Showing ${summary.labelsShown} of ${summary.labelsTotal} labels. Select a member to inspect its stations.`;
    const displayUnit = quantity?.displayUnit ?? "";
    const unit = !quantity
      ? ""
      : !displayUnit
        ? "m"
        : /^[a-zA-Z]+$/.test(displayUnit)
          ? `m/${displayUnit}`
          : `m/(${displayUnit})`;
    this.forceScaleUnit.textContent = unit;
    this.forceScaleInput.setAttribute("aria-label", `Diagram scale in ${unit}`);
    const scale =
      state.diagramScale === "auto" || state.diagramScale == null
        ? summary?.scale
        : state.diagramScale;
    if (force || document.activeElement !== this.forceScaleInput) {
      this.forceScaleInput.value =
        Number.isFinite(scale) && quantity
          ? String(Number((scale / quantity.displayFactor).toPrecision(8)))
          : "";
      this.forceScaleInput.setAttribute("aria-invalid", "false");
      this.forceScaleError.hidden = true;
    }
    const automatic = state.diagramScale == null || state.diagramScale === "auto";
    this.forceScaleAuto.classList.toggle("selected", automatic);
    this.forceScaleAuto.setAttribute("aria-pressed", String(automatic));
    this.forceScaleInput.disabled = this.forceScaleAuto.disabled = !result || !available;
    this.forcePlaneSelect.setValue(state.diagramPlane ?? "auto");
    this.forcePlaneSelect.setEnabled(Boolean(result));
    this.forcePlaneSelect.element.title = summary
      ? `Positive ordinate: ${summary.directionSign < 0 ? "−" : "+"}local ${summary.plane}`
      : "";
    for (const [field, value] of [
      [this.forceFlip, state.diagramFlip ?? false],
      [this.forceFilled, state.diagramFilled ?? true],
      [this.forceLabels, state.diagramLabels ?? true],
    ]) {
      field.checked = value;
      field.disabled = !result;
    }
    this.renderForceStations(summary?.selected, quantity);
  }

  renderForceStations(selected, quantity) {
    this.forceSelected.hidden = !selected || !quantity;
    if (!selected || !quantity) {
      this.forceStations.replaceChildren();
      this.forceStationsSignature = null;
      return;
    }
    const signature = JSON.stringify([selected, quantity]);
    if (signature === this.forceStationsSignature) return;
    this.forceStationsSignature = signature;
    this.forceSelectedTitle.textContent = `Member ${selected.elementId}`;
    this.forceStationQuantity.textContent = `${quantity.id}${quantity.displayUnit ? ` [${quantity.displayUnit}]` : ""}`;
    this.forceStations.replaceChildren(
      ...selected.stations.map((station, index, stations) => {
        const row = document.createElement("tr");
        const position = document.createElement("td");
        const value = document.createElement("td");
        const side =
          station.x === stations[index + 1]?.x
            ? "−"
            : station.x === stations[index - 1]?.x
              ? "+"
              : "";
        position.textContent = `${Number(station.x.toPrecision(5))}${side}`;
        if (side) position.title = side === "−" ? "Left limit" : "Right limit";
        value.textContent = Number.isFinite(station.value)
          ? formatQuantity(station.value, quantity, false)
          : "Unavailable";
        value.classList.toggle("graviss-station-unavailable", !Number.isFinite(station.value));
        row.append(position, value);
        return row;
      }),
    );
  }

  createCaseRow(loadCase) {
    const row = document.createElement("li");
    row.className = "graviss-case-row";
    row.setAttribute("role", "option");
    row.dataset.caseId = caseKey(loadCase.id);
    row.id = `graviss-case-${encodeURIComponent(caseKey(loadCase.id))}`;
    const number = document.createElement("span");
    number.className = "graviss-case-number";
    const title = document.createElement("span");
    title.className = "graviss-case-title";
    const kind = document.createElement("span");
    kind.className = "graviss-case-kind";
    const status = document.createElement("span");
    status.className = "graviss-case-state";
    row.append(number, title, status, kind);
    row.addEventListener("click", () => {
      this.caseList.focus();
      const index = this.cases().findIndex((item) => caseKey(item.id) === row.dataset.caseId);
      this.select(index);
    });
    return row;
  }

  renderCases() {
    const cases = this.cases();
    const loadState = this.loadState();
    const selectedKey = caseKey(this.selectedCaseId(loadState));
    const displayedKey = caseKey(loadState.displayedLoadCaseId);
    const pendingKey = caseKey(loadState.pendingLoadCaseId);
    const failedKey = caseKey(loadState.failedLoadCaseId);
    const allKeys = new Set(this.viewer.getLoadCases().map((item) => caseKey(item.id)));
    for (const [key, row] of this.caseRows) {
      if (!allKeys.has(key)) {
        row.remove();
        this.caseRows.delete(key);
      }
    }
    const visibleRows = new Set();
    cases.forEach((loadCase, index) => {
      const key = caseKey(loadCase.id);
      let row = this.caseRows.get(key);
      if (!row) {
        row = this.createCaseRow(loadCase);
        this.caseRows.set(key, row);
      }
      visibleRows.add(row);
      const selected = key === selectedKey;
      const pending = key === pendingKey;
      const failed = key === failedKey;
      row.classList.toggle("graviss-case-selected", selected);
      row.classList.toggle("graviss-case-displayed", key === displayedKey);
      row.classList.toggle("graviss-case-pending", pending);
      row.classList.toggle("graviss-case-failed", failed);
      row.classList.toggle("graviss-case-preview", index === this.previewIndex && !selected);
      row.setAttribute("aria-selected", String(selected));
      row.setAttribute("aria-busy", String(pending));
      const [number, title, status, kind] = row.children;
      setText(number, String(loadCase.id));
      setText(title, loadCase.title);
      if (title.title !== loadCase.title) title.title = loadCase.title;
      setText(kind, kindLabel(loadCase.kind ?? "linear"));
      const statusText = pending ? "Loading…" : failed ? "Failed" : "";
      setText(status, statusText);
      status.hidden = !statusText;
      // Ordinary updates leave the children exactly where they are, preserving
      // scroll and focus while a result, scale or animation control changes.
      if (this.caseList.children[index] !== row) {
        this.caseList.insertBefore(row, this.caseList.children[index] ?? null);
      }
    });
    for (const row of [...this.caseList.children]) {
      if (!visibleRows.has(row)) row.remove();
    }
    this.systemButton.classList.toggle("graviss-case-selected", selectedKey == null);
    this.systemButton.setAttribute("aria-pressed", String(selectedKey == null));
    this.caseCount.textContent = `${cases.length} of ${this.viewer.getLoadCases().length}`;
    this.body.querySelector(".graviss-case-no-matches").hidden = cases.length > 0;
    this.renderNavigation(cases, selectedKey);
    this.renderResultStatus(loadState);
  }

  renderNavigation(cases, selectedKey) {
    const index = this.previewIndex ?? cases.findIndex((item) => caseKey(item.id) === selectedKey);
    this.casePrevious.disabled = !cases.length || index === 0 || (index < 0 && selectedKey == null);
    this.caseNext.disabled = !cases.length || index === cases.length - 1;
    this.casePosition.textContent =
      index >= 0
        ? `${index + 1} of ${cases.length}`
        : selectedKey == null
          ? "System"
          : "Outside filter";
    const row = index >= 0 ? this.caseList.children[index] : null;
    if (row) this.caseList.setAttribute("aria-activedescendant", row.id);
    else this.caseList.removeAttribute("aria-activedescendant");
  }

  describeCase(id) {
    if (id == null) return "System";
    const loadCase = this.viewer.getLoadCases().find((item) => caseKey(item.id) === caseKey(id));
    return loadCase ? `LC ${loadCase.id} · ${loadCase.title}` : `LC ${id}`;
  }

  renderResultStatus(loadState) {
    const displayedKind = loadState.displayedKind ?? this.viewer.result?.kind;
    const displayed = `${this.describeCase(loadState.displayedLoadCaseId)}${displayedKind ? ` · ${RESULT_KINDS[displayedKind]}` : ""}`;
    const pending = loadState.pendingLoadCaseId != null;
    this.resultStatus.classList.toggle("is-loading", pending);
    this.resultStatus.textContent = pending
      ? `Loading ${this.describeCase(loadState.pendingLoadCaseId)} · ${RESULT_KINDS[loadState.pendingKind ?? this.viewer.getResultsState().kind ?? "displacement"]} · still displaying ${displayed}`
      : loadState.displayedLoadCaseId == null
        ? "System · No result field"
        : displayed;
    this.resultStatus.title = this.resultStatus.textContent;
    this.resultError.hidden = !loadState.error;
    const failed =
      loadState.failedLoadCaseId == null
        ? "load cases"
        : `${this.describeCase(loadState.failedLoadCaseId)}${loadState.failedKind ? ` · ${RESULT_KINDS[loadState.failedKind]}` : ""}`;
    this.resultError.querySelector(".graviss-result-error-message").textContent = loadState.error
      ? `Could not read ${failed}: ${loadState.error.message ?? loadState.error}`
      : "";
    this.retryButton.disabled = pending;
  }

  renderScale(state, force = false) {
    const deformation = this.viewer.renderer?.getDeformation();
    const scale = deformation?.scale ?? 1;
    const automatic = state.scale === "auto";
    this.scaleValue.textContent = `×${formatScale(scale)}${automatic ? " (auto)" : ""}`;
    this.scaleMode.textContent = automatic ? "Automatic" : "Manual";
    this.scaleAuto.classList.toggle("selected", automatic);
    this.scaleAuto.setAttribute("aria-pressed", String(automatic));
    for (const button of this.scalePresets.querySelectorAll(".graviss-scale-preset")) {
      button.classList.toggle("selected", !automatic && Number(button.dataset.scale) === scale);
      button.disabled = !deformation?.result;
    }
    if (force || document.activeElement !== this.scaleInput) {
      this.scaleInput.value = String(Number(scale.toPrecision(8)));
      this.scaleInput.setAttribute("aria-invalid", "false");
      this.scaleError.hidden = true;
    }
    if (force || document.activeElement !== this.scaleSlider) {
      this.scaleSlider.value = String(sliderForScale(scale));
    }
    this.scaleSlider.disabled =
      this.scaleInput.disabled =
      this.scaleAuto.disabled =
        !deformation?.result;
  }

  cycleItems(state = {}) {
    const loadCase = this.viewer
      ?.getLoadCases()
      .find((item) => caseKey(item.id) === caseKey(state.loadCaseId));
    return ANIMATION_MODE_IDS.map((id) => ({
      value: id,
      label:
        id === DEFAULT_CYCLE_ID
          ? `Default · ${defaultCycle(loadCase) === "pingPong" ? "−1 ↔ +1" : "0 ↔ +1"}`
          : (CYCLE_LABELS[id] ?? id),
      title: CYCLE_HINTS[id] ?? "",
    }));
  }

  renderAnimation(state, force = false) {
    const animation = this.viewer.renderer?.getDeformation()
      ? this.viewer.renderer.getAnimation()
      : null;
    const playing = Boolean(state.playing);
    this.playButton.textContent = playing ? "Pause" : "Play";
    this.playButton.classList.toggle("selected", playing);
    this.playButton.setAttribute("aria-pressed", String(playing));
    const disabled = this.viewer.result?.kind !== "displacement";
    this.playButton.disabled = disabled;
    const cycleItems = this.cycleItems(state);
    const signature = JSON.stringify(cycleItems);
    if (signature !== this.cycleSignature) {
      this.cycleSignature = signature;
      this.cycleSelect.setItems(cycleItems, { value: state.cycle ?? DEFAULT_CYCLE_ID });
    } else this.cycleSelect.setValue(state.cycle ?? DEFAULT_CYCLE_ID);
    this.cycleSelect.setEnabled(!disabled);
    const period = state.period ?? animation?.period ?? 2000;
    if (force || document.activeElement !== this.periodInput) {
      this.periodInput.value = String(period / 1000);
      this.periodInput.setAttribute("aria-invalid", "false");
    }
    this.periodInput.disabled = this.positionSlider.disabled = disabled;
    this.renderPosition(disabled ? null : (this.viewer.getAnimationPosition?.() ?? null));
  }

  resolvedCycle() {
    if (this.viewer?.renderer?.getDeformation()) return this.viewer.renderer.getAnimation().cycle;
    const state = this.viewer?.getResultsState() ?? {};
    const loadCase = this.viewer
      ?.getLoadCases()
      .find((item) => caseKey(item.id) === caseKey(state.loadCaseId));
    return state.cycle ?? defaultCycle(loadCase);
  }

  renderPosition(fraction) {
    const cycle = this.resolvedCycle();
    this.positionSlider.min = cycle === "pingPong" ? "-100" : "0";
    if (fraction == null || !Number.isFinite(fraction)) {
      this.positionValue.textContent = "Deformation —";
      this.positionSlider.removeAttribute("aria-valuetext");
      this.positionSlider.value = "0";
      return;
    }
    const position = phaseOf(cycle, fraction) * 100;
    const rounded = Math.round(position);
    const percentage = `${rounded > 0 ? "+" : ""}${rounded === 0 ? 0 : rounded}%`;
    this.positionValue.textContent = `Deformation ${percentage}`;
    // The thumb follows the same eased motion as the model, even while it has
    // keyboard focus. Dragging pauses the clock at the matching pose.
    this.positionSlider.value = String(position);
    this.positionSlider.setAttribute("aria-valuetext", `${percentage} deformation`);
  }

  didChangeAnimationPosition(fraction) {
    if (this.positionSlider && !this.destroyed && this.viewer?.result?.kind === "displacement")
      this.renderPosition(fraction);
  }

  renderColors(state) {
    this.colorToggle.checked = Boolean(state.colorByDisplacement);
    this.colorToggle.disabled = this.viewer.result?.kind !== "displacement";
    const range = this.viewer.renderer?.colorScaleRange();
    this.legend.hidden = !state.colorByDisplacement || !range;
    if (!range) return;
    this.legend.querySelector(".graviss-legend-min").textContent = formatDisplacement(range.min);
    this.legend.querySelector(".graviss-legend-max").textContent = formatDisplacement(range.max);
  }

  changeCaseFilter() {
    this.resetPreview();
    if (this.viewer && !this.emptyReason()) this.renderCases();
  }

  select(index) {
    const loadCase = this.cases()[index];
    if (!loadCase) return;
    this.resetPreview();
    void this.viewer?.selectLoadCase(loadCase.id);
  }

  nextIndex(delta) {
    const cases = this.cases();
    if (!cases.length) return null;
    const selected = caseKey(this.selectedCaseId());
    const from = this.previewIndex ?? cases.findIndex((item) => caseKey(item.id) === selected);
    if (from < 0) return delta > 0 ? 0 : cases.length - 1;
    return Math.min(cases.length - 1, Math.max(0, from + delta));
  }

  stepBy(delta) {
    const index = this.nextIndex(delta);
    if (index != null) this.select(index);
  }

  // Moving the cursor reads no field until stepping stops for 250 ms.
  previewBy(delta) {
    const index = this.nextIndex(delta);
    if (index != null) this.previewTo(index);
  }

  previewTo(index) {
    if (!this.cases()[index]) return;
    this.previewIndex = index;
    this.renderCases();
    this.caseList.children[index]?.scrollIntoView({ block: "nearest" });
    this.scheduleCommit();
  }

  scheduleCommit() {
    clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => this.commitPreview(), 250);
  }

  commitPreview() {
    const index = this.previewIndex;
    this.resetPreview();
    if (index != null) this.select(index);
  }

  cancelPreview() {
    this.resetPreview();
    this.update();
  }

  resetPreview() {
    clearTimeout(this.previewTimer);
    this.previewTimer = null;
    this.previewIndex = null;
  }

  didChangeViewer() {
    this.resetPreview();
    this.forceControlSync = true;
    this.caseQuery = "";
    this.caseKind = "all";
    this.caseSearch.value = "";
    this.kindsSignature = null;
    this.caseRows.clear();
    this.caseList.replaceChildren();
    if (this.viewer?.onDidChangeSelection) {
      this.viewerSubscriptions.add(
        this.viewer.onDidChangeSelection(() => {
          if (!this.body.hidden) this.renderMemberDiagram(this.viewer.getResultsState());
        }),
      );
    }
  }

  didChangeGraphic() {
    // The list is shared by a model, but a deferred selection belongs to the
    // graphic the user was inspecting when the cursor moved.
    this.resetPreview();
    this.forceControlSync = true;
  }

  focus() {
    if (this.body.hidden) super.focus();
    else this.caseList.focus();
  }

  destroy() {
    this.resetPreview();
    this.kindSelect.destroy();
    this.cycleSelect.destroy();
    this.resultKindSelect.destroy();
    this.forceComponentSelect.destroy();
    this.memberGroupSelect.destroy();
    this.forcePlaneSelect.destroy();
    super.destroy();
  }
}

module.exports = {
  CYCLE_LABELS,
  RESULTS_PANEL_URI,
  ResultsPanel,
  formatDisplacement,
  scaleForSlider,
  sliderForScale,
};
