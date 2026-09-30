const { CompositeDisposable, Disposable } = require("lumine");

// The toolbar owns a draft; the viewer owns the committed predicate and text.
// Enter changes the view once, rather than repeatedly rebuilding it mid-word.
class QuickFilterControl {
  constructor(viewer) {
    this.viewer = viewer;
    this.subscriptions = new CompositeDisposable();
    this.element = document.createElement("div");
    this.element.className = "graviss-quick-filter";
    this.element.setAttribute("data-context-menu-boundary", "");
    this.element.innerHTML = `
      <span class="icon icon-filter graviss-quick-filter-icon" aria-hidden="true"></span>
      <button type="button" class="btn btn-sm graviss-quick-filter-clear" data-action="clear-quick-filter" aria-label="Clear quick filter">×</button>
      <details class="graviss-quick-filter-help">
        <summary aria-label="Quick filter syntax">?</summary>
        <div class="graviss-quick-filter-guide">
          <p>Separate clauses with <code>;</code>. A leading <code>+</code> adds, <code>-</code> subtracts. The last matching clause decides. An initial minus starts from the whole model; otherwise start from nothing.</p>
          <p>Use ranges or digit patterns: <code class="graviss-quick-filter-example">N12-15;-Q1??1*</code>. For names, put <code>:</code> after the code. All whitespace is removed.</p>
          <p>Enter applies; Escape restores the applied text. The quick filter and panel filter both restrict the view.</p>
          <dl class="graviss-quick-filter-codes"></dl>
        </div>
      </details>
      <span class="graviss-quick-filter-error" role="alert" hidden></span>
    `;
    this.editor = lumine.workspace.buildTextEditor({
      mini: true,
      softWrapped: false,
      autoHeight: false,
      placeholderText: "Quick filter: N12-15;-Q1??1*",
    });
    const editorElement = this.editor.element;
    editorElement.classList.add("graviss-quick-filter-editor");
    editorElement.setAttribute("aria-label", "Quick element filter");
    this.element.insertBefore(editorElement, this.element.querySelector("button"));
    this.error = this.element.querySelector(".graviss-quick-filter-error");
    this.error.id = `graviss-quick-filter-error-${this.editor.id}`;
    editorElement.setAttribute("aria-describedby", this.error.id);
    this.clear = this.element.querySelector(".graviss-quick-filter-clear");
    this.codes = this.element.querySelector(".graviss-quick-filter-codes");
    this.onFocus = () => viewer.element.classList.add("graviss-editing-quick-filter");
    this.onBlur = (event) => {
      if (!editorElement.contains(event.relatedTarget)) {
        viewer.element.classList.remove("graviss-editing-quick-filter");
      }
    };
    editorElement.addEventListener("focusin", this.onFocus);
    editorElement.addEventListener("focusout", this.onBlur);
    this.clear.addEventListener("click", () => {
      if (viewer.applyQuickFilter("")) viewer.element.focus();
    });
    this.subscriptions.add(
      lumine.tooltips.add(this.clear, { title: "Clear only the quick filter" }),
      lumine.tooltips.add(this.element.querySelector("summary"), { title: "Quick filter syntax" }),
      lumine.textEditors.add(this.editor, { role: "input" }),
      this.editor.onWillInsertText(({ text, cancel }) => {
        const compact = text.replace(/\s+/g, "");
        if (compact === text) return;
        cancel();
        if (compact) this.editor.insertText(compact);
      }),
      this.editor.onDidChange(() => this.updateDraft()),
      lumine.commands.add(editorElement, {
        "core:confirm": (event) => {
          event.stopPropagation();
          if (viewer.applyQuickFilter(this.editor.getText())) viewer.element.focus();
        },
        "core:cancel": (event) => {
          event.stopPropagation();
          viewer.quickFilterIssue = viewer.quickFilterAppliedIssue;
          this.sync({ resetText: true });
          viewer.element.focus();
        },
      }),
      new Disposable(() => {
        editorElement.removeEventListener("focusin", this.onFocus);
        editorElement.removeEventListener("focusout", this.onBlur);
      }),
    );
    this.sync({ resetText: true });
  }

  updateDraft() {
    const draft = this.editor.getText() !== this.viewer.quickFilterText;
    this.element.classList.toggle("is-draft", draft);
    this.clear.disabled = !this.editor.getText() && !this.viewer.quickFilterText;
    if (draft) {
      this.error.hidden = true;
      this.editor.element.setAttribute("aria-invalid", "false");
    }
  }

  sync({ resetText = false } = {}) {
    const { quickFilterText, quickFilterIssue, quickFilterAliases } = this.viewer;
    if (resetText && this.editor.getText() !== quickFilterText) {
      this.editor.setText(quickFilterText);
      this.editor.getBuffer().clearUndoStack();
    }
    this.element.classList.toggle("is-active", Boolean(quickFilterText));
    this.updateDraft();
    this.error.textContent = quickFilterIssue?.message ?? "";
    this.error.hidden = !quickFilterIssue;
    this.editor.element.setAttribute("aria-invalid", String(Boolean(quickFilterIssue)));
    if (quickFilterAliases === this.aliases) return;
    this.aliases = quickFilterAliases;
    const example = `${quickFilterAliases?.has("G") ? "G" : "N"}12-15;-Q1??1*`;
    this.editor.setPlaceholderText(`Quick filter: ${example}`);
    this.element.querySelector(".graviss-quick-filter-example").textContent = example;
    const fragment = document.createDocumentFragment();
    for (const [code, subject] of quickFilterAliases ?? []) {
      const term = document.createElement("dt");
      term.textContent = code;
      const description = document.createElement("dd");
      description.textContent = subject.title;
      fragment.append(term, description);
    }
    this.codes.replaceChildren(fragment);
  }

  destroy() {
    this.subscriptions.dispose();
    this.viewer.element.classList.remove("graviss-editing-quick-filter");
    this.editor.destroy();
    this.element.remove();
  }
}

module.exports = { QuickFilterControl };
