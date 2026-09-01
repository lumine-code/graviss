const { CompositeDisposable } = require("lumine");
const { GravissPanel } = require("./graviss-panel");
const { isReadableExpression, startsWhole } = require("./filter-rules");

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
      title: "Model Filter",
      iconName: "filter",
      className: "graviss-filter-panel",
      deserializerName: "GravissFilterPanel",
    });
    // One row object per rule, kept by the rule's own id. Rebuilding the list
    // from scratch on every change would take the caret out of whatever is
    // being typed, and `did-change-filter` fires for a toolbar toggle too.
    this.rows = new Map();
    this.dragging = null;
    this.build();
    this.initialize();
  }

  build() {
    this.body.innerHTML = `
      <section class="graviss-panel-section" data-section="rules">
        <ol class="graviss-rule-list" aria-label="Filter rules">
          <li class="graviss-rule-seed"></li>
        </ol>
        <p class="graviss-panel-hint">Applied in order; the last rule that names an element decides it. Rules add and subtract, so two of them mean "either", never "both".</p>
      </section>
      <footer class="graviss-panel-footer">
        <button type="button" class="btn btn-sm graviss-add-rule">Add rule</button>
        <button type="button" class="btn btn-sm graviss-clear-filter">Show everything</button>
        <span class="graviss-rule-total" title="How many elements the rules keep. Whether a layer is drawn at all is a separate switch on the toolbar."></span>
      </footer>
    `;
    this.list = this.body.querySelector(".graviss-rule-list");
    this.seed = this.body.querySelector(".graviss-rule-seed");
    this.total = this.body.querySelector(".graviss-rule-total");

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
      if (action.dataset.ruleAction === "remove") this.viewer?.removeRule(id);
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

  moveFocusedRule(step) {
    const row = document.activeElement?.closest?.(".graviss-rule-row");
    const id = row?.dataset.ruleId;
    if (!id || !this.viewer) return;
    const rules = this.viewer.getFilterState().rules;
    const from = rules.findIndex((rule) => rule.id === id);
    if (from < 0) return;
    // Whatever had focus keeps it: the row objects survive a reorder, so the
    // moved row is the same element it was a moment ago.
    const focused = document.activeElement;
    const caret = focused?.selectionStart ?? null;
    this.viewer.moveRule(id, from + step);
    focused?.focus?.();
    if (caret != null && focused?.setSelectionRange) focused.setSelectionRange(caret, caret);
  }

  render() {
    const state = this.viewer.getFilterState();
    const counts = this.viewer.getRuleCounts();
    this.reconcile(state.rules);
    let counting = 0;
    for (const rule of state.rules) {
      const named = rule.type ? (counts.named[counting++] ?? null) : null;
      this.rows.get(rule.id)?.update(rule, named);
    }
    this.renderSeed(state.rules);
    this.total.textContent = counts.total ? `${counts.shown} of ${counts.total} elements` : "";
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

  destroy() {
    for (const row of this.rows.values()) row.destroy();
    this.rows.clear();
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
      <span class="graviss-rule-grip" draggable="true" aria-hidden="true">⠿</span>
      <button type="button" class="btn btn-xs graviss-rule-sign" data-rule-action="sign" aria-pressed="true" aria-label="This rule adds elements">+</button>
      <span class="graviss-rule-swatch" hidden></span>
      <span class="graviss-rule-type-host"></span>
      <input type="text" class="input-text native-key-bindings graviss-rule-text" aria-label="Values">
      <span class="graviss-rule-count"></span>
      <button type="button" class="btn btn-xs graviss-rule-remove" data-rule-action="remove" aria-label="Remove this rule">×</button>
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

    this.select.onDidChange(() => this.chooseSubject());
    this.field.addEventListener("input", () => this.typeExpression());
  }

  get viewer() {
    return this.panel.viewer;
  }

  chooseSubject() {
    const subject = this.viewer?.getFilterSubjects()[Number(this.select.value)];
    if (!subject) return;
    this.viewer.updateRule(this.id, {
      type: subject.type,
      kinds: subject.kinds?.length === 1 ? [...subject.kinds] : undefined,
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
    this.field.classList.toggle("graviss-invalid", !readable);
    if (readable) this.viewer.updateRule(this.id, { text: this.field.value });
  }

  update(rule, named) {
    const subjects = this.viewer?.getFilterSubjects() ?? [];
    const subject = this.viewer?.subjectForRule(rule) ?? null;
    this.renderOptions(subjects, rule, subject);

    const adds = rule.sign !== "-";
    this.sign.textContent = adds ? "+" : "−";
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
    if (this.field.value !== rule.text && document.activeElement !== this.field) {
      this.field.value = rule.text;
      this.field.classList.remove("graviss-invalid");
    }

    this.element.classList.toggle("graviss-rule-unresolved", Boolean(rule.type) && !subject);
    this.count.textContent = named == null ? "" : String(named);
    this.count.classList.toggle("graviss-rule-count-empty", named === 0);
    this.count.title = named == null ? "" : `This rule names ${named} elements`;
  }

  // Rebuilt only when the choices or the selection actually differ, so that a
  // repaint from elsewhere does not close a dropdown somebody has open.
  renderOptions(subjects, rule, subject) {
    const chosen = subject ? String(subjects.indexOf(subject)) : "";
    const signature = `${subjects.length}:${chosen}:${rule.type}`;
    if (this.signature === signature) return;
    this.signature = signature;

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

module.exports = { FILTER_PANEL_URI, FilterPanel, FilterRuleRow, RULE_DRAG_TYPE };
