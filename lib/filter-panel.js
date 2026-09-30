const { CompositeDisposable } = require("lumine");
const { GravissPanel } = require("./graviss-panel");
const { isReadableExpression, parseNumberFilter, startsWhole } = require("./filter-rules");
const {
  FilterCatalog,
  expressionError,
  expressionForValues,
  searchCatalog,
} = require("./filter-catalog");

const FILTER_PANEL_URI = "graviss://filter";
const RULE_DRAG_TYPE = "graviss-filter-rule-event";

// Which elements are being looked at, as an ordered list of rules.
//
// Each row is a sign, a dimension and an expression naming values of it. They
// are applied in order and the last rule that names an element decides it, so
// the list reads the way a person builds a selection: take these, drop that
// one, put those back. The row that is not a rule - the seed at the top - is
// where the fold begins, and it is the only place the difference between "start
// from nothing" and "start from the whole model" is visible.
//
// The panel knows nothing about what a dimension means. A group, a material, a
// storey are all the same shape to it, and a type id is compared and never
// parsed - which is what keeps every source's own vocabulary out of a
// general-purpose viewer.
class FilterPanel extends GravissPanel {
  constructor() {
    super({
      uri: FILTER_PANEL_URI,
      title: "Filter",
      iconName: "filter",
      className: "graviss-filter-panel",
      deserializerName: "GravissFilterPanel",
    });
    // One row object per rule, kept by the rule's own id. Rebuilding the list
    // from scratch on every change would take the caret out of whatever is
    // being typed, and `did-change-filter` fires for a toolbar toggle too.
    this.rows = new Map();
    this.dragging = null;
    this.catalog = new FilterCatalog();
    this.selectedValues = new Set();
    this.catalogRows = new Map();
    this.graphicIndex = this.viewer?.activeGraphicIndex ?? null;
    this.graphicCount = this.viewer?.graphics?.length ?? 0;
    this.build();
    this.initialize();
  }

  build() {
    this.body.innerHTML = `
      <div class="graviss-panel-scroll">
        <section class="graviss-panel-section" data-section="rules">
          <div class="graviss-panel-heading"><h3>Rules in order</h3><span class="graviss-filter-rule-count"></span>
            <details class="graviss-filter-more"><summary>More</summary><button type="button" class="btn btn-sm graviss-add-rule">Blank rule</button></details>
          </div>
          <ol class="graviss-rule-list" aria-label="Filter rules"><li class="graviss-rule-seed"></li></ol>
          <p class="graviss-panel-hint">Applied in order; the last matching rule decides. Rules combine with "either", never "both".</p>
        </section>
        <section class="graviss-panel-section graviss-filter-catalog" data-section="catalog">
          <div class="graviss-panel-heading"><h3>Add a rule</h3></div>
          <span class="graviss-filter-dimension-host"></span>
          <input type="search" class="input-text native-key-bindings graviss-catalog-search" placeholder="Find a value by number or name…" aria-label="Search filter values">
          <ul class="graviss-catalog-values" aria-label="Model values"></ul>
          <p class="graviss-catalog-empty graviss-panel-hint" hidden>No matching values.</p>
          <input type="text" class="input-text native-key-bindings graviss-catalog-number" placeholder="1-10, 15, 1*, 11??" aria-label="Element number expression" hidden>
          <p class="graviss-catalog-error" role="status" hidden></p>
          <div class="graviss-catalog-selection"><span class="graviss-catalog-status"></span><button type="button" class="btn btn-xs graviss-catalog-clear">Clear selection</button></div>
          <div class="graviss-catalog-actions"><button type="button" class="btn btn-sm btn-primary" data-catalog-action="+" disabled>Add</button><button type="button" class="btn btn-sm" data-catalog-action="-" disabled>Subtract</button></div>
        </section>
      </div>
      <footer class="graviss-panel-footer">
        <div><span class="graviss-panel-footer-label">In filter</span><span class="graviss-rule-total" title="Elements accepted by the filter, independent of which layers are drawn."></span></div>
        <button type="button" class="btn btn-sm graviss-clear-filter">Show entire model</button>
      </footer>
    `;
    this.list = this.body.querySelector(".graviss-rule-list");
    this.seed = this.body.querySelector(".graviss-rule-seed");
    this.total = this.body.querySelector(".graviss-rule-total");
    this.clearButton = this.body.querySelector(".graviss-clear-filter");
    this.ruleCount = this.body.querySelector(".graviss-filter-rule-count");
    this.buildCatalog();

    this.body.querySelector(".graviss-add-rule").addEventListener("click", () => this.addRule());
    this.body
      .querySelector(".graviss-clear-filter")
      .addEventListener("click", () => this.viewer?.clearFilter());

    // One delegated listener for the whole list rather than two per row, which
    // is the idiom the viewer's own toolbar already uses.
    this.list.addEventListener("click", (event) => {
      const action = event.target.closest("[data-rule-action]");
      if (!action || !this.list.contains(action)) return;
      event.preventDefault();
      event.stopPropagation();
      const id = action.closest(".graviss-rule-row")?.dataset.ruleId;
      if (!id) return;
      if (action.dataset.ruleAction === "remove") this.removeRule(id);
      else if (action.dataset.ruleAction === "up") this.moveRule(id, -1);
      else if (action.dataset.ruleAction === "down") this.moveRule(id, 1);
      else this.toggleSign(id);
    });

    this.bindDragging();
    this.subscriptions.add(
      lumine.commands.add(this.element, {
        "graviss:move-rule-up": {
          description: "Move the filter rule holding focus one place earlier.",
          didDispatch: () => this.moveFocusedRule(-1),
        },
        "graviss:move-rule-down": {
          description: "Move the filter rule holding focus one place later.",
          didDispatch: () => this.moveFocusedRule(1),
        },
      }),
    );
  }

  addRule() {
    const id = this.viewer?.addRule({ sign: "+", type: "", text: "" });
    // A fresh row names no dimension, so it changes nothing - which is what
    // lets it appear without the model moving underneath it. The cursor goes
    // where the next decision is.
    if (id) this.rows.get(id)?.select.focus();
    return id;
  }

  toggleSign(id) {
    const rule = this.viewer?.getFilterState().rules.find((entry) => entry.id === id);
    if (rule) this.viewer.updateRule(id, { sign: rule.sign === "-" ? "+" : "-" });
  }

  removeRule(id) {
    const rules = this.viewer?.getFilterState().rules ?? [];
    const index = rules.findIndex((rule) => rule.id === id);
    const focused = this.rows.get(id)?.element.contains(document.activeElement);
    const neighbor = rules[index + 1] ?? rules[index - 1];
    this.viewer?.removeRule(id);
    if (focused) {
      if (neighbor) this.rows.get(neighbor.id)?.field.focus();
      else this.dimensionSelect.focus();
    }
  }

  moveFocusedRule(step) {
    const row = document.activeElement?.closest?.(".graviss-rule-row");
    const id = row?.dataset.ruleId;
    this.moveRule(id, step);
  }

  moveRule(id, step) {
    if (!id || !this.viewer) return;
    const rules = this.viewer.getFilterState().rules;
    const from = rules.findIndex((rule) => rule.id === id);
    if (from < 0) return;
    // Whatever had focus keeps it: the row objects survive a reorder, so the
    // moved row is the same element it was a moment ago.
    const focused = document.activeElement;
    const caret = focused?.selectionStart ?? null;
    this.viewer.moveRule(id, from + step);
    if (focused?.disabled) this.rows.get(id)?.field.focus();
    else focused?.focus?.();
    if (caret != null && focused?.setSelectionRange) focused.setSelectionRange(caret, caret);
  }

  render() {
    const state = this.viewer.getFilterState();
    const quickActive = Boolean(this.viewer.getQuickFilterState?.().text);
    this.clearButton.textContent = quickActive ? "Clear panel filter" : "Show entire model";
    this.clearButton.title = quickActive
      ? "Clear these rules; the toolbar's quick filter stays active."
      : "Clear the panel's filter rules.";
    const counts = this.viewer.getRuleCounts();
    this.reconcile(state.rules);
    let counting = 0;
    for (const rule of state.rules) {
      const named = rule.type ? (counts.named[counting++] ?? null) : null;
      this.rows.get(rule.id)?.update(rule, named);
    }
    this.renderSeed(state.rules);
    this.total.textContent = counts.total ? `${counts.shown} of ${counts.total} elements` : "";
    this.ruleCount.textContent = `${state.rules.length} ${state.rules.length === 1 ? "rule" : "rules"}`;
    this.renderCatalog();
    for (const [index, rule] of state.rules.entries()) {
      const row = this.rows.get(rule.id);
      row.up.disabled = index === 0;
      row.down.disabled = index === state.rules.length - 1;
    }
  }

  renderEmpty() {
    this.reconcile([]);
    this.total.textContent = "";
    this.ruleCount.textContent = "";
    this.resetCatalog();
  }

  buildCatalog() {
    this.dimensionSelect = lumine.menu.createSelectBox({
      items: [],
      ariaLabel: "Catalogue dimension",
      className: "graviss-filter-dimension",
    });
    this.body
      .querySelector(".graviss-filter-dimension-host")
      .replaceWith(this.dimensionSelect.element);
    this.catalogSearch = this.body.querySelector(".graviss-catalog-search");
    this.catalogList = this.body.querySelector(".graviss-catalog-values");
    this.catalogEmpty = this.body.querySelector(".graviss-catalog-empty");
    this.catalogNumber = this.body.querySelector(".graviss-catalog-number");
    this.catalogError = this.body.querySelector(".graviss-catalog-error");
    this.catalogError.id = "graviss-catalog-error";
    this.catalogNumber.setAttribute("aria-describedby", this.catalogError.id);
    this.catalogStatus = this.body.querySelector(".graviss-catalog-status");
    this.catalogClear = this.body.querySelector(".graviss-catalog-clear");
    this.catalogButtons = [...this.body.querySelectorAll("[data-catalog-action]")];
    this.dimensionSelect.onDidChange(() => this.renderCatalog());
    this.catalogSearch.addEventListener("input", () => this.renderCatalogValues());
    this.catalogNumber.addEventListener("input", () => this.updateCatalogSelection());
    this.catalogClear.addEventListener("click", () => {
      this.selectedValues.clear();
      this.catalogNumber.value = "";
      this.updateCatalogSelection();
    });
    this.catalogList.addEventListener("click", (event) => {
      const button = event.target.closest("[data-catalog-key]");
      if (!button || !this.catalogList.contains(button) || button.disabled) return;
      const key = button.dataset.catalogKey;
      if (this.selectedValues.has(key)) this.selectedValues.delete(key);
      else this.selectedValues.add(key);
      this.updateCatalogSelection();
    });
    for (const button of this.catalogButtons) {
      button.addEventListener("click", () => this.appendCatalogRule(button.dataset.catalogAction));
    }
  }

  renderCatalog() {
    const subjects = this.viewer?.getFilterSubjects() ?? [];
    if (subjects !== this.catalogSubjects) {
      this.catalogSubjects = subjects;
      const preferred = subjects.findIndex(
        (subject) => subject.type !== "@kind" && subject.type !== "@number",
      );
      this.dimensionSelect.setItems(
        subjects.map((subject, index) => ({ value: String(index), label: subject.title })),
        { value: subjects.length ? String(Math.max(0, preferred)) : null },
      );
    }
    const subject = subjects[Number(this.dimensionSelect.value)] ?? null;
    const values = this.catalog.get(this.viewer?.geometry, subjects, subject);
    if (subject === this.catalogSubject && values === this.catalogValues) return;
    this.catalogSubject = subject;
    this.catalogValues = values;
    this.selectedValues.clear();
    this.catalogSearch.value = "";
    this.catalogNumber.value = "";
    const numbers = subject?.type === "@number";
    this.catalogSearch.hidden = numbers;
    this.catalogList.hidden = numbers;
    this.catalogNumber.hidden = !numbers;
    this.catalogNumber.placeholder = subject?.hint ?? "1-10, 15, 1*, 11??";
    this.renderCatalogValues();
  }

  renderCatalogValues() {
    const values = searchCatalog(this.catalogValues ?? [], this.catalogSearch.value);
    this.catalogRows.clear();
    const fragment = document.createDocumentFragment();
    for (const entry of values) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "graviss-catalog-value";
      button.dataset.catalogKey = entry.key;
      button.disabled = !entry.selectable;
      button.title = `${entry.key}${entry.title ? ` · ${entry.title}` : ""}\n${entry.error ?? `${entry.count} matching elements`}`;
      const id = document.createElement("span");
      id.className = "graviss-catalog-value-id";
      id.textContent = entry.key;
      const title = document.createElement("span");
      title.className = "graviss-catalog-value-title";
      title.textContent = entry.title;
      const count = document.createElement("span");
      count.className = "graviss-catalog-value-count";
      count.textContent = String(entry.count);
      button.append(id, title, count);
      item.append(button);
      fragment.append(item);
      this.catalogRows.set(entry.key, button);
    }
    this.catalogList.replaceChildren(fragment);
    this.catalogEmpty.hidden = this.catalogSubject?.type === "@number" || values.length > 0;
    this.updateCatalogSelection();
  }

  catalogExpression() {
    if (this.catalogSubject?.type === "@number") {
      const text = this.catalogNumber.value.trim();
      // Commas and whitespace alone are the parser's all-values expression,
      // not a selection somebody can add from the number picker.
      try {
        return parseNumberFilter(text) ? text : "";
      } catch {
        return text;
      }
    }
    return expressionForValues(
      (this.catalogValues ?? []).filter((entry) => this.selectedValues.has(entry.key)),
      this.catalogSubject,
    );
  }

  updateCatalogSelection() {
    for (const [key, button] of this.catalogRows) {
      const selected = this.selectedValues.has(key);
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    }
    const numbers = this.catalogSubject?.type === "@number";
    const expression = this.catalogExpression();
    const error = expressionError(expression, this.catalogSubject);
    this.catalogError.textContent = error ?? "";
    this.catalogError.hidden = !error;
    this.catalogNumber.classList.toggle("graviss-invalid", Boolean(error));
    this.catalogNumber.setAttribute("aria-invalid", String(Boolean(error)));
    this.catalogStatus.textContent = numbers
      ? "Enter element numbers, ranges or digit patterns."
      : this.selectedValues.size
        ? `${this.selectedValues.size} selected`
        : "Nothing selected";
    this.catalogClear.disabled = numbers ? !this.catalogNumber.value : !this.selectedValues.size;
    for (const button of this.catalogButtons)
      button.disabled = !this.catalogSubject || !expression || Boolean(error);
  }

  appendCatalogRule(sign) {
    const subject = this.catalogSubject;
    const text = this.catalogExpression();
    // An empty picker must never become the all-values expression.
    if (!this.viewer || !subject || !text || expressionError(text, subject)) return null;
    const id = this.viewer.addRule({
      sign: sign === "-" ? "-" : "+",
      type: subject.type,
      ...subjectScope(subject, this.catalogSubjects),
      text,
    });
    this.selectedValues.clear();
    this.catalogNumber.value = "";
    this.updateCatalogSelection();
    return id;
  }

  resetCatalog() {
    this.catalog.clear();
    this.catalogSubject = null;
    this.catalogSubjects = null;
    this.catalogValues = [];
    this.selectedValues.clear();
    this.catalogRows.clear();
    this.catalogList.replaceChildren();
    this.catalogSearch.value = "";
    this.catalogNumber.value = "";
    this.updateCatalogSelection();
  }

  // The row above the first rule, which is where the fold actually begins. It
  // is the only thing on screen saying whether the list builds up from nothing
  // or cuts down from the whole model, and a reader who cannot see that cannot
  // read the list at all.
  renderSeed(rules) {
    const counting = rules.filter((rule) => rule.type);
    if (!counting.length) {
      this.seed.textContent = "Showing the whole model.";
      return;
    }
    this.seed.textContent = startsWhole(counting)
      ? "Starting from the whole model:"
      : "Starting from nothing:";
  }

  // Rows are created, destroyed and MOVED - never rebuilt. A reorder that
  // detached a row would blur whatever was being typed in it, and
  // `did-change-filter` fires for every toolbar toggle as well, so a full
  // rebuild would take the caret away on a keystroke that had nothing to do
  // with this panel.
  reconcile(rules) {
    const wanted = new Set(rules.map((rule) => rule.id));
    for (const [id, row] of this.rows) {
      if (wanted.has(id)) continue;
      row.destroy();
      this.rows.delete(id);
    }
    let previous = this.seed;
    for (const rule of rules) {
      let row = this.rows.get(rule.id);
      if (!row) {
        row = new FilterRuleRow(this, rule.id);
        this.rows.set(rule.id, row);
      }
      if (previous.nextElementSibling !== row.element) {
        // A node not yet in the list is inserted; one already there is MOVED -
        // `moveBefore`, not `insertBefore`, because inserting a connected node
        // is a detach and Chromium blurs a focused subtree before removing it.
        if (row.element.parentNode !== this.list || !this.list.moveBefore) {
          this.list.insertBefore(row.element, previous.nextElementSibling);
        } else {
          this.list.moveBefore(row.element, previous.nextElementSibling);
        }
      }
      previous = row.element;
    }
  }

  // --- reordering by drag ----------------------------------------------------

  bindDragging() {
    this.list.addEventListener("dragstart", (event) => {
      const grip = event.target.closest?.(".graviss-rule-grip");
      const row = grip && event.target.closest(".graviss-rule-row");
      if (!row) return;
      this.dragging = row.dataset.ruleId;
      row.classList.add("graviss-dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData(RULE_DRAG_TYPE, row.dataset.ruleId);
    });
    this.list.addEventListener("dragover", (event) => {
      if (!this.carriesRule(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      this.markDropTarget(event);
    });
    this.list.addEventListener("dragleave", (event) => {
      if (!this.list.contains(event.relatedTarget)) this.clearDropMarks();
    });
    this.list.addEventListener("drop", (event) => {
      if (!this.carriesRule(event)) return;
      event.preventDefault();
      const id = event.dataTransfer.getData(RULE_DRAG_TYPE) || this.dragging;
      const to = this.dropIndex(event);
      this.finishDrag();
      if (id && to != null) this.viewer?.moveRule(id, to);
    });
    this.list.addEventListener("dragend", () => this.finishDrag());
  }

  // Read from `items` rather than `types`, because that is the half of a
  // DataTransfer a synthetic drag event can carry.
  carriesRule(event) {
    const items = event.dataTransfer?.items;
    if (!items) return false;
    for (const item of items) if (item.type === RULE_DRAG_TYPE) return true;
    return false;
  }

  rowsInOrder() {
    return [...this.list.querySelectorAll(".graviss-rule-row")];
  }

  dropIndex(event) {
    const rows = this.rowsInOrder();
    if (!rows.length) return 0;
    const from = rows.findIndex((row) => row.dataset.ruleId === this.dragging);
    let to = rows.length;
    for (let index = 0; index < rows.length; index += 1) {
      const rect = rows[index].getBoundingClientRect();
      if (event.clientY < rect.top + rect.height / 2) {
        to = index;
        break;
      }
    }
    // Taking the row out first shifts everything after it up by one.
    if (from >= 0 && from < to) to -= 1;
    return Math.max(0, Math.min(rows.length - 1, to));
  }

  markDropTarget(event) {
    this.clearDropMarks();
    const rows = this.rowsInOrder();
    if (!rows.length) return;
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (event.clientY < rect.top + rect.height / 2) {
        row.classList.add("graviss-drop-above");
        return;
      }
    }
    rows[rows.length - 1].classList.add("graviss-drop-below");
  }

  clearDropMarks() {
    for (const row of this.rowsInOrder()) {
      row.classList.remove("graviss-drop-above", "graviss-drop-below", "graviss-dragging");
    }
  }

  finishDrag() {
    this.clearDropMarks();
    this.dragging = null;
  }

  didChangeViewer() {
    this.finishDrag();
    // Rule ids are local to a viewer. Reusing a row with the same id would also
    // reuse its focused input and cached select options, leaving the previous
    // model's text and vocabulary wired to the new one.
    for (const row of this.rows.values()) row.destroy();
    this.rows.clear();
    this.resetCatalog();
    this.graphicIndex = this.viewer?.activeGraphicIndex ?? null;
    this.graphicCount = this.viewer?.graphics?.length ?? 0;
  }

  didChangeGraphic() {
    const index = this.viewer?.activeGraphicIndex ?? null;
    const count = this.viewer?.graphics?.length ?? 0;
    // Renaming a graphic refreshes the shared header too, but it remains the
    // same editing context. Switching or replacing one discards unfinished
    // drafts and selections, even if its stored rule IDs and text are equal.
    if (index === this.graphicIndex && count === this.graphicCount) return;
    this.graphicIndex = index;
    this.graphicCount = count;
    this.finishDrag();
    this.selectedValues.clear();
    this.catalogNumber.value = "";
    this.updateCatalogSelection();
    for (const row of this.rows.values()) row.ruleText = undefined;
  }

  destroy() {
    for (const row of this.rows.values()) row.destroy();
    this.rows.clear();
    this.dimensionSelect.destroy();
    super.destroy();
  }
}

// One rule on screen. It owns its elements for its whole life, so that a
// reorder moves it rather than rebuilding it and whatever is being typed in it
// survives.
class FilterRuleRow {
  constructor(panel, id) {
    this.panel = panel;
    this.id = id;
    this.signature = null;
    this.subscriptions = new CompositeDisposable();

    const element = document.createElement("li");
    element.className = "graviss-rule-row";
    element.dataset.ruleId = id;
    element.setAttribute("role", "group");
    element.innerHTML = `
      <div class="graviss-rule-main">
        <span class="graviss-rule-grip" draggable="true" aria-hidden="true">⠿</span>
        <button type="button" class="btn btn-xs graviss-rule-sign" data-rule-action="sign" aria-pressed="true" aria-label="This rule adds elements">Add</button>
        <span class="graviss-rule-swatch" hidden></span>
        <span class="graviss-rule-type-host"></span>
        <span class="graviss-rule-actions">
          <button type="button" class="btn btn-xs graviss-rule-up" data-rule-action="up" aria-label="Move this rule up">↑</button>
          <button type="button" class="btn btn-xs graviss-rule-down" data-rule-action="down" aria-label="Move this rule down">↓</button>
          <button type="button" class="btn btn-xs graviss-rule-remove" data-rule-action="remove" aria-label="Remove this rule">×</button>
        </span>
      </div>
      <div class="graviss-rule-detail"><input type="text" class="input-text native-key-bindings graviss-rule-text" aria-label="Values"><span class="graviss-rule-matches">Matches <span class="graviss-rule-count"></span></span></div>
      <p class="graviss-rule-error" role="status" hidden></p>
    `;
    this.element = element;
    this.sign = element.querySelector(".graviss-rule-sign");
    this.swatch = element.querySelector(".graviss-rule-swatch");
    this.select = lumine.menu.createSelectBox({
      items: [],
      ariaLabel: "Dimension",
      className: "graviss-rule-type",
    });
    element.querySelector(".graviss-rule-type-host").replaceWith(this.select.element);
    this.field = element.querySelector(".graviss-rule-text");
    this.count = element.querySelector(".graviss-rule-count");
    this.up = element.querySelector(".graviss-rule-up");
    this.down = element.querySelector(".graviss-rule-down");
    this.error = element.querySelector(".graviss-rule-error");
    this.error.id = `graviss-rule-error-${id}`;
    this.field.setAttribute("aria-describedby", this.error.id);

    this.select.onDidChange(() => this.chooseSubject());
    this.field.addEventListener("input", () => this.typeExpression());
  }

  get viewer() {
    return this.panel.viewer;
  }

  chooseSubject() {
    const subjects = this.viewer?.getFilterSubjects() ?? [];
    const subject = subjects[Number(this.select.value)];
    if (!subject) return;
    const rule = this.viewer.getFilterState().rules.find((entry) => entry.id === this.id);
    this.viewer.updateRule(this.id, {
      type: subject.type,
      kinds: subjectScope(subject, subjects).kinds,
      text: isReadableExpression(rule?.text, subject) ? rule?.text : "",
    });
  }

  typeExpression() {
    const rule = this.viewer?.getFilterState().rules.find((entry) => entry.id === this.id);
    const subject = rule ? this.viewer.subjectForRule(rule) : null;
    // Said while it is being typed rather than after it is submitted, and the
    // model is left where it was until the expression is one - narrowing to
    // nothing mid-word would be answering before the question was asked, and a
    // typo in one row must not move the rows above it.
    const readable = isReadableExpression(this.field.value, subject);
    this.renderValidation(subject, rule);
    if (readable) this.viewer.updateRule(this.id, { text: this.field.value });
  }

  update(rule, named) {
    const subjects = this.viewer?.getFilterSubjects() ?? [];
    const subject = this.viewer?.subjectForRule(rule) ?? null;
    this.renderOptions(subjects, rule, subject);

    const adds = rule.sign !== "-";
    this.sign.textContent = adds ? "Add" : "Subtract";
    this.sign.setAttribute("aria-pressed", String(adds));
    this.sign.setAttribute(
      "aria-label",
      adds ? "This rule adds elements" : "This rule removes elements",
    );
    this.element.classList.toggle("graviss-rule-subtracts", !adds);

    // A colour only where the row is about exactly one kind, and taken from the
    // renderer's own resolved colour rather than from the stylesheet, so a
    // swatch cannot disagree with what is on screen.
    const color = subject?.color ? this.viewer?.renderer?.colors?.[subject.color] : null;
    this.swatch.hidden = !color;
    if (color) this.swatch.style.background = `#${color.getHexString()}`;

    this.field.placeholder = subject?.hint ?? "all";
    if (rule.text !== this.ruleText || subject !== this.ruleSubject) {
      this.field.value = rule.text;
    }
    this.ruleText = rule.text;
    this.ruleSubject = subject;
    this.renderValidation(subject, rule);

    this.element.classList.toggle("graviss-rule-unresolved", Boolean(rule.type) && !subject);
    this.count.textContent = named == null ? "" : String(named);
    this.count.parentElement.hidden = named == null;
    this.count.classList.toggle("graviss-rule-count-empty", named === 0);
    this.count.title = named == null ? "" : `This rule names ${named} elements`;
  }

  renderValidation(subject, rule) {
    const error = expressionError(this.field.value, subject);
    this.field.classList.toggle("graviss-invalid", Boolean(error));
    this.field.setAttribute("aria-invalid", String(Boolean(error)));
    const message =
      error ??
      (rule?.type && !subject ? "This dimension is not available in the current model." : null);
    this.error.textContent = message ?? "";
    this.error.hidden = !message;
  }

  // Rebuilt only when the choices or the selection actually differ, so that a
  // repaint from elsewhere does not close a dropdown somebody has open.
  renderOptions(subjects, rule, subject) {
    const chosen = subject ? String(subjects.indexOf(subject)) : "";
    const signature = `${subjects.length}:${chosen}:${rule.type}`;
    if (this.signature === signature && this.optionSubjects === subjects) return;
    this.signature = signature;
    this.optionSubjects = subjects;

    const items = [{ value: null, label: "Choose…", disabled: true }];
    let value = chosen;
    // A rule naming a dimension this model has not got keeps its own id on
    // screen. Without this the dropdown would quietly rewrite the user's rule
    // to whatever else happened to be selected.
    if (rule.type && !subject) {
      value = `missing:${rule.type}`;
      items.push({
        value,
        label: `${rule.type} (not in this model)`,
        disabled: true,
      });
    }
    subjects.forEach((entry, index) => {
      // The subject's INDEX, never a composite key: a key in a DOM attribute
      // invites someone to parse it back into vocabulary, and an index cannot
      // be parsed into anything.
      items.push({ value: String(index), label: entry.title });
    });
    this.select.setItems(items, { value: value || null });
  }

  destroy() {
    this.subscriptions.dispose();
    this.select.destroy();
    this.element.remove();
  }
}

// The first subject of a type is the source's own domain. Only a generated
// narrowed variant adds a kind restriction to the stored rule.
function subjectScope(subject, subjects) {
  const base = subjects.find((entry) => entry.type === subject.type);
  return base !== subject && subject.kinds?.length ? { kinds: [...subject.kinds] } : {};
}

module.exports = { FILTER_PANEL_URI, FilterPanel, FilterRuleRow, RULE_DRAG_TYPE };
