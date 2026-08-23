const { GravissPanel } = require("./graviss-panel");
const { isValidNumberFilter } = require("./element-filter");

const FILTER_PANEL_URI = "graviss://filter";

// The kinds a model can be narrowed by, in the order they are worth looking at:
// what carries the structure first, what marks it afterwards.
const KIND_ROWS = Object.freeze([
  Object.freeze({ kind: "beam", label: "Beams", visibility: "beams", color: "element" }),
  Object.freeze({ kind: "truss", label: "Trusses", visibility: "trusses", color: "truss" }),
  Object.freeze({ kind: "cable", label: "Cables", visibility: "cables", color: "cable" }),
  Object.freeze({ kind: "shell", label: "Shells", visibility: "shells", color: "shell" }),
  Object.freeze({ kind: "spring", label: "Springs", visibility: "springs", color: "spring" }),
  Object.freeze({
    kind: "coupling",
    label: "Couplings",
    visibility: "couplings",
    color: "coupling",
  }),
]);

// Which elements are being looked at.
//
// Three questions, in the order they are asked: which kinds, which numbers, and
// which of the dimensions the source itself declared. The panel knows nothing
// about what those dimensions mean - a group, a material, a storey are all the
// same shape to it - which is what keeps every source's own vocabulary out of
// the viewer.
class FilterPanel extends GravissPanel {
  constructor() {
    super({
      uri: FILTER_PANEL_URI,
      title: "Model Filter",
      iconName: "filter",
      className: "graviss-filter-panel",
      deserializerName: "GravissFilterPanel",
    });
    this.expanded = new Set();
    this.facetSearches = new Map();
    this.build();
    this.initialize();
  }

  build() {
    this.body.innerHTML = `
      <section class="graviss-panel-section" data-section="kinds">
        <h3 class="graviss-panel-heading">Elements</h3>
        <ul class="graviss-kind-list"></ul>
      </section>
      <section class="graviss-panel-section" data-section="numbers">
        <h3 class="graviss-panel-heading">Numbers</h3>
        <input type="text" class="input-text native-key-bindings graviss-number-filter"
               placeholder="1-10, 15, 1*, 11??" aria-label="Element numbers">
        <p class="graviss-panel-hint">A range, a number, or a pattern where <code>*</code> is any digits and <code>?</code> is one.</p>
      </section>
      <section class="graviss-panel-section" data-section="facets"></section>
      <footer class="graviss-panel-footer">
        <button type="button" class="btn btn-sm graviss-clear-filter">Show everything</button>
      </footer>
    `;
    this.kindList = this.body.querySelector(".graviss-kind-list");
    this.numberField = this.body.querySelector(".graviss-number-filter");
    this.facetSection = this.body.querySelector('[data-section="facets"]');

    this.numberField.addEventListener("input", () => {
      // Said while it is being typed rather than after it is submitted, and the
      // model is left where it was until the expression is one - narrowing to
      // nothing mid-word would be answering before the question was asked.
      const valid = isValidNumberFilter(this.numberField.value);
      this.numberField.classList.toggle("graviss-invalid", !valid);
      if (valid) this.viewer?.setNumberFilter(this.numberField.value);
    });
    this.body
      .querySelector(".graviss-clear-filter")
      .addEventListener("click", () => this.clearFilter());
  }

  clearFilter() {
    this.numberField.value = "";
    this.numberField.classList.remove("graviss-invalid");
    this.viewer?.clearFilter();
  }

  render() {
    this.renderKinds();
    this.renderNumbers();
    this.renderFacets();
  }

  renderKinds() {
    const counts = this.viewer.elementCounts();
    const rows = KIND_ROWS.filter((row) => counts.has(row.kind));
    this.kindList.replaceChildren(
      ...rows.map((row) => {
        const { total, shown } = counts.get(row.kind);
        const item = document.createElement("li");
        item.className = "graviss-kind-row";
        const label = document.createElement("label");
        const box = document.createElement("input");
        box.type = "checkbox";
        box.className = "input-checkbox";
        box.checked = this.viewer.isVisible(row.visibility);
        box.addEventListener("change", () => this.viewer.toggleVisibility(row.visibility));
        const swatch = document.createElement("span");
        swatch.className = "graviss-kind-swatch";
        // Painted from the renderer's own resolved colour rather than from the
        // stylesheet, so a swatch cannot disagree with what is on screen.
        const color = this.viewer.renderer?.colors?.[row.color];
        if (color) swatch.style.background = `#${color.getHexString()}`;
        const name = document.createElement("span");
        name.className = "graviss-kind-label";
        name.textContent = row.label;
        label.append(box, swatch, name);
        const count = document.createElement("span");
        count.className = "graviss-kind-count";
        count.textContent = shown === total ? `${total}` : `${shown} / ${total}`;
        count.classList.toggle("graviss-kind-count-narrowed", shown !== total);
        item.append(label, count);
        return item;
      }),
    );
    this.kindList.closest(".graviss-panel-section").hidden = rows.length === 0;
  }

  renderNumbers() {
    const stated = this.viewer.getFilterState().numbers;
    // Only when it differs, so that a graphic being restored does not move the
    // caret of a field somebody is typing in.
    if (this.numberField.value !== stated && document.activeElement !== this.numberField) {
      this.numberField.value = stated;
      this.numberField.classList.remove("graviss-invalid");
    }
  }

  renderFacets() {
    const facets = this.viewer.getFacets();
    const chosen = this.viewer.getFilterState().facets;
    this.facetSection.hidden = facets.length === 0;
    this.facetSection.replaceChildren(
      ...facets.map((facet) => this.renderFacet(facet, chosen[facet.id] ?? [])),
    );
  }

  renderFacet(facet, chosen) {
    const wrapper = document.createElement("div");
    wrapper.className = "graviss-facet";
    const open = this.expanded.has(facet.id);

    const heading = document.createElement("button");
    heading.type = "button";
    heading.className = "graviss-facet-heading";
    heading.setAttribute("aria-expanded", String(open));
    // The name is its own element so that the badge can sit at the far end
    // without the name drifting to the middle between them.
    const name = document.createElement("span");
    name.className = "graviss-facet-name";
    name.textContent = facet.title || String(facet.id);
    const badge = document.createElement("span");
    badge.className = "graviss-facet-badge";
    badge.textContent = chosen.length ? `${chosen.length}` : "";
    heading.append(name, badge);
    heading.addEventListener("click", () => {
      if (open) this.expanded.delete(facet.id);
      else this.expanded.add(facet.id);
      this.renderFacets();
    });
    wrapper.append(heading);
    if (!open) return wrapper;

    const search = this.facetSearches.get(facet.id) ?? "";
    // A dimension with a handful of values needs no search box; one with a
    // hundred groups is unusable without it.
    if (facet.values.length > 12) {
      const field = document.createElement("input");
      field.type = "text";
      field.className = "input-text native-key-bindings graviss-facet-search";
      field.placeholder = "Filter values";
      field.value = search;
      field.addEventListener("input", () => {
        this.facetSearches.set(facet.id, field.value);
        this.renderFacets();
        this.facetSection.querySelector(".graviss-facet-search")?.focus();
      });
      wrapper.append(field);
    }

    const matcher = search.trim().toLowerCase();
    const list = document.createElement("ul");
    list.className = "graviss-facet-values";
    const keys = new Set(chosen.map((value) => `${typeof value}:${value}`));
    for (const value of facet.values) {
      const label = value.title || String(value.id);
      if (matcher && !label.toLowerCase().includes(matcher)) continue;
      const item = document.createElement("li");
      const row = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.className = "input-checkbox";
      box.checked = keys.has(`${typeof value.id}:${value.id}`);
      box.addEventListener("change", () => this.toggleFacetValue(facet, value.id, box.checked));
      const text = document.createElement("span");
      text.textContent = label;
      row.append(box, text);
      item.append(row);
      list.append(item);
    }
    wrapper.append(list);
    return wrapper;
  }

  toggleFacetValue(facet, valueId, wanted) {
    const chosen = this.viewer.getFilterState().facets[facet.id] ?? [];
    const key = `${typeof valueId}:${valueId}`;
    const next = wanted
      ? [...chosen, valueId]
      : chosen.filter((value) => `${typeof value}:${value}` !== key);
    // A dimension the source called single-valued still narrows by a set here:
    // choosing two groups is a question about the model, not a claim that an
    // element is in both of them.
    this.viewer.setFacetFilter(facet.id, next);
  }
}

module.exports = { FILTER_PANEL_URI, FilterPanel, KIND_ROWS };
