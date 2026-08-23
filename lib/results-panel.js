const { GravissPanel } = require("./graviss-panel");
const { CYCLE_IDS } = require("./animation");
const { SCALE_PRESETS } = require("./deformation");
const { colorScaleStops } = require("./color-scale");

const RESULTS_PANEL_URI = "graviss://results";

// What each cycle is, said in the terms a user picks one by rather than in the
// terms it is computed in.
const CYCLE_LABELS = Object.freeze({
  pingPong: "Swing",
  thereAndBack: "There and back",
  ramp: "Ramp",
  sweep: "Sweep the cases",
});

const CYCLE_HINTS = Object.freeze({
  pingPong: "Full shape one way, then the other. A mode shape has no sign.",
  thereAndBack: "Undeformed to the full shape and back again.",
  ramp: "Undeformed to the full shape, then start over.",
  sweep: "Each case in turn, held still and shown whole.",
});

// The slider runs over factors rather than over numbers, because a hundredfold
// is one step of interest and a hundred and one is not. Zero is not on it: it is
// a preset, since a slider that could land on nothing would be a slider that
// occasionally showed nothing.
const SLIDER_STEPS = 1000;
const SLIDER_LOW = -2;
const SLIDER_HIGH = 4;

const PERIOD_MIN = 250;
const PERIOD_MAX = 6000;

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

// A displacement in the unit somebody would say it in. The contract is metres,
// and a bridge deflecting three tenths of a millimetre is not a reading anybody
// wants written as 0.0003.
function formatDisplacement(metres) {
  if (!Number.isFinite(metres)) return "";
  if (Math.abs(metres) < 1) return `${(metres * 1000).toPrecision(3)} mm`;
  return `${metres.toPrecision(3)} m`;
}

function formatScale(scale) {
  if (scale === 0) return "0";
  if (scale >= 100) return `${Math.round(scale)}`;
  if (scale >= 10) return scale.toFixed(1);
  return scale.toFixed(2);
}

// What is being shown of the analysis.
//
// The list is hand-rolled rather than borrowed from the select-list package,
// because that one is a modal picker: it takes the window until it is dismissed,
// and this list is meant to be stepped through while the model is watched.
class ResultsPanel extends GravissPanel {
  constructor() {
    super({
      uri: RESULTS_PANEL_URI,
      title: "Model Results",
      iconName: "graph",
      className: "graviss-results-panel",
      deserializerName: "GravissResultsPanel",
    });
    this.previewIndex = null;
    this.wheelDelta = 0;
    this.wheelTimer = null;
    this.build();
    this.initialize();
  }

  build() {
    this.body.innerHTML = `
      <section class="graviss-panel-section" data-section="cases">
        <h3 class="graviss-panel-heading">Load cases</h3>
        <ul class="graviss-case-list" tabindex="0" role="listbox" aria-label="Load cases"></ul>
      </section>
      <section class="graviss-panel-section" data-section="scale">
        <h3 class="graviss-panel-heading">Amplification <span class="graviss-scale-value"></span></h3>
        <div class="graviss-scale-presets btn-group btn-group-sm"></div>
        <input type="range" class="graviss-scale-slider" min="0" max="${SLIDER_STEPS}" step="1" aria-label="Amplification">
      </section>
      <section class="graviss-panel-section" data-section="animation">
        <h3 class="graviss-panel-heading">Animation</h3>
        <div class="graviss-animation-controls">
          <button type="button" class="btn btn-sm graviss-play"></button>
          <select class="input-select graviss-cycle" aria-label="Cycle"></select>
        </div>
        <label class="graviss-speed">
          <span>Period <span class="graviss-period-value"></span></span>
          <input type="range" class="graviss-period-slider" min="${PERIOD_MIN}" max="${PERIOD_MAX}" step="50" aria-label="Period">
        </label>
      </section>
      <section class="graviss-panel-section" data-section="colors">
        <label class="graviss-color-toggle">
          <input type="checkbox" class="input-checkbox graviss-color-by">
          <span>Colour by displacement</span>
        </label>
        <div class="graviss-legend" hidden>
          <div class="graviss-legend-ramp"></div>
          <div class="graviss-legend-ends"><span class="graviss-legend-min"></span><span class="graviss-legend-max"></span></div>
        </div>
      </section>
    `;
    this.caseList = this.body.querySelector(".graviss-case-list");
    this.scaleValue = this.body.querySelector(".graviss-scale-value");
    this.scalePresets = this.body.querySelector(".graviss-scale-presets");
    this.scaleSlider = this.body.querySelector(".graviss-scale-slider");
    this.playButton = this.body.querySelector(".graviss-play");
    this.cycleSelect = this.body.querySelector(".graviss-cycle");
    this.periodValue = this.body.querySelector(".graviss-period-value");
    this.periodSlider = this.body.querySelector(".graviss-period-slider");
    this.colorToggle = this.body.querySelector(".graviss-color-by");
    this.legend = this.body.querySelector(".graviss-legend");

    this.buildScalePresets();
    this.buildCycles();
    this.body.querySelector(".graviss-legend-ramp").style.background =
      `linear-gradient(to right, ${colorScaleStops().join(", ")})`;

    this.scaleSlider.addEventListener("input", () =>
      this.viewer?.setDeformationScale(scaleForSlider(Number(this.scaleSlider.value))),
    );
    this.periodSlider.addEventListener("input", () =>
      this.viewer?.setAnimationPeriod(Number(this.periodSlider.value)),
    );
    this.cycleSelect.addEventListener("change", () =>
      this.viewer?.setAnimationCycle(this.cycleSelect.value),
    );
    this.playButton.addEventListener("click", () => this.viewer?.toggleAnimation());
    this.colorToggle.addEventListener("change", () => this.viewer?.toggleColorByDisplacement());

    this.caseList.addEventListener("wheel", (event) => this.stepByWheel(event), { passive: false });
    this.subscriptions.add(
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

  buildScalePresets() {
    const auto = document.createElement("button");
    auto.type = "button";
    auto.className = "btn graviss-scale-auto";
    auto.textContent = "Auto";
    auto.addEventListener("click", () => this.viewer?.setDeformationScale("auto"));
    this.scalePresets.append(
      auto,
      ...SCALE_PRESETS.map((preset) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn graviss-scale-preset";
        button.dataset.scale = String(preset);
        button.textContent = `×${preset}`;
        button.addEventListener("click", () => this.viewer?.setDeformationScale(preset));
        return button;
      }),
    );
  }

  buildCycles() {
    this.cycleSelect.append(
      ...CYCLE_IDS.map((id) => {
        const option = document.createElement("option");
        option.value = id;
        option.textContent = CYCLE_LABELS[id] ?? id;
        option.title = CYCLE_HINTS[id] ?? "";
        return option;
      }),
    );
  }

  emptyReason() {
    const inherited = super.emptyReason();
    if (inherited) return inherited;
    if (this.viewer.resultsError)
      return `The analysis could not be read: ${this.viewer.resultsError.message}`;
    if (!this.viewer.hasResults()) return "This model carries no analysis results.";
    return null;
  }

  cases() {
    return this.viewer?.getLoadCases() ?? [];
  }

  render() {
    const state = this.viewer.getResultsState();
    this.renderCases(state);
    this.renderScale(state);
    this.renderAnimation(state);
    this.renderColors(state);
  }

  renderCases(state) {
    const cases = this.cases();
    const active = state.loadCaseId == null ? null : String(state.loadCaseId);
    this.caseList.replaceChildren(
      ...cases.map((loadCase, index) => {
        const row = document.createElement("li");
        row.className = "graviss-case-row";
        row.setAttribute("role", "option");
        const selected = String(loadCase.id) === active;
        row.classList.toggle("graviss-case-selected", selected);
        row.classList.toggle("graviss-case-preview", index === this.previewIndex && !selected);
        row.setAttribute("aria-selected", String(selected));
        const number = document.createElement("span");
        number.className = "graviss-case-number";
        number.textContent = String(loadCase.id);
        const title = document.createElement("span");
        title.className = "graviss-case-title";
        title.textContent = loadCase.title;
        row.append(number, title);
        if (loadCase.kind && loadCase.kind !== "linear") {
          const kind = document.createElement("span");
          kind.className = "graviss-case-kind";
          kind.textContent = loadCase.kind;
          row.append(kind);
        }
        row.addEventListener("click", () => this.select(index));
        return row;
      }),
    );
  }

  renderScale(state) {
    const deformation = this.viewer.renderer?.getDeformation();
    const scale = deformation?.scale ?? 1;
    const automatic = state.scale === "auto";
    this.scaleValue.textContent = `×${formatScale(scale)}${automatic ? " (auto)" : ""}`;
    this.scalePresets.querySelector(".graviss-scale-auto").classList.toggle("selected", automatic);
    for (const button of this.scalePresets.querySelectorAll(".graviss-scale-preset")) {
      button.classList.toggle("selected", !automatic && Number(button.dataset.scale) === scale);
    }
    if (document.activeElement !== this.scaleSlider) {
      this.scaleSlider.value = String(sliderForScale(scale));
    }
    this.scaleSlider.disabled = !deformation?.result;
  }

  renderAnimation(state) {
    const animation = this.viewer.renderer?.getDeformation()
      ? this.viewer.renderer.getAnimation()
      : null;
    const playing = Boolean(state.playing);
    this.playButton.textContent = playing ? "Pause" : "Play";
    this.playButton.classList.toggle("selected", playing);
    this.playButton.disabled = !this.viewer.result;
    this.cycleSelect.value = state.cycle ?? animation?.cycle ?? "thereAndBack";
    this.cycleSelect.title = CYCLE_HINTS[this.cycleSelect.value] ?? "";
    const period = state.period ?? animation?.period ?? 2000;
    this.periodValue.textContent = `${(period / 1000).toFixed(1)} s`;
    if (document.activeElement !== this.periodSlider) this.periodSlider.value = String(period);
  }

  renderColors(state) {
    this.colorToggle.checked = Boolean(state.colorByDisplacement);
    const range = this.viewer.renderer?.colorScaleRange();
    this.legend.hidden = !state.colorByDisplacement || !range;
    if (!range) return;
    this.legend.querySelector(".graviss-legend-min").textContent = formatDisplacement(range.min);
    this.legend.querySelector(".graviss-legend-max").textContent = formatDisplacement(range.max);
  }

  // --- Stepping through the cases --------------------------------------------

  select(index) {
    const loadCase = this.cases()[index];
    if (!loadCase) return;
    this.previewIndex = null;
    void this.viewer?.selectLoadCase(loadCase.id);
  }

  // A preview moves the cursor without reading the case, because reading one is
  // thousands of records and a list being stepped through would queue a read a
  // row. What is under the cursor is shown once the stepping stops.
  previewBy(delta) {
    const cases = this.cases();
    if (!cases.length) return;
    const from =
      this.previewIndex ??
      cases.findIndex(
        (loadCase) => String(loadCase.id) === String(this.viewer.getResultsState().loadCaseId),
      );
    const next = Math.min(cases.length - 1, Math.max(0, (from < 0 ? 0 : from) + delta));
    this.previewTo(next);
  }

  previewTo(index) {
    if (!this.cases()[index]) return;
    this.previewIndex = index;
    this.render();
    this.caseList.children[index]?.scrollIntoView({ block: "nearest" });
    this.scheduleCommit();
  }

  scheduleCommit() {
    clearTimeout(this.wheelTimer);
    this.wheelTimer = setTimeout(() => this.commitPreview(), 250);
  }

  commitPreview() {
    clearTimeout(this.wheelTimer);
    this.wheelTimer = null;
    if (this.previewIndex == null) return;
    this.select(this.previewIndex);
  }

  cancelPreview() {
    clearTimeout(this.wheelTimer);
    this.wheelTimer = null;
    this.previewIndex = null;
    this.render();
  }

  // One notch is one case however far the wheel says it turned, and a shifted
  // notch is ten - which is the same bargain the viewer's own symbol wheel
  // strikes, so a trackpad's flood of tiny deltas steps once rather than
  // sixty times.
  stepByWheel(event) {
    if (!this.cases().length) return;
    event.preventDefault();
    this.wheelDelta += event.deltaY;
    const notches = Math.trunc(this.wheelDelta / 40);
    if (notches === 0) return;
    this.wheelDelta -= notches * 40;
    this.previewBy(notches * (event.shiftKey ? 10 : 1));
  }

  destroy() {
    clearTimeout(this.wheelTimer);
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
