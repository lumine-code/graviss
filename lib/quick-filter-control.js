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
      <button type="button" class="graviss-quick-filter-action graviss-quick-filter-clear" data-action="clear-quick-filter" aria-label="Clear quick filter" hidden>×</button>
      <button type="button" class="graviss-quick-filter-action graviss-quick-filter-help" aria-label="Quick filter syntax" aria-haspopup="dialog" aria-expanded="false">?</button>
        <div class="graviss-quick-filter-guide" role="dialog" aria-label="Quick filter syntax" hidden>
          <p>Separate clauses with <code>;</code>. A leading <code>+</code> adds, <code>-</code> subtracts. The last matching clause decides. An initial minus starts from the whole model; otherwise start from nothing.</p>
          <p>Use ranges or digit patterns: <code class="graviss-quick-filter-example">N12-15;-Q1??1*</code>. For names, put <code>:</code> after the code. All whitespace is removed.</p>
          <p>Enter applies; Escape restores the applied text. The quick filter and panel filter both restrict the view.</p>
          <dl class="graviss-quick-filter-codes"></dl>
        </div>
      <span class="graviss-quick-filter-error" role="alert" hidden></span>
    `;
    this.editor = lumine.workspace.buildTextEditor({
      mini: true,
      softWrapped: false,
      autoHeight: false,
      placeholderText: "N12-15;-Q1??1*",
    });
    const editorElement = this.editor.element;
    editorElement.classList.add("graviss-quick-filter-editor");
    editorElement.setAttribute("aria-label", "Quick element filter");
    this.element.insertBefore(editorElement, this.element.querySelector("button"));
    this.error = this.element.querySelector(".graviss-quick-filter-error");
    this.error.id = `graviss-quick-filter-error-${this.editor.id}`;
    editorElement.setAttribute("aria-describedby", this.error.id);
    this.clear = this.element.querySelector(".graviss-quick-filter-clear");
    this.help = this.element.querySelector(".graviss-quick-filter-help");
    this.guide = this.element.querySelector(".graviss-quick-filter-guide");
    this.guide.id = `graviss-quick-filter-guide-${this.editor.id}`;
    this.help.setAttribute("aria-controls", this.guide.id);
    this.example = this.guide.querySelector(".graviss-quick-filter-example");
    this.codes = this.element.querySelector(".graviss-quick-filter-codes");
    this.onFocus = () => viewer.element.classList.add("graviss-editing-quick-filter");
    this.onBlur = (event) => {
      if (!editorElement.contains(event.relatedTarget)) {
        viewer.element.classList.remove("graviss-editing-quick-filter");
      }
    };
    editorElement.addEventListener("focusin", this.onFocus);
    editorElement.addEventListener("focusout", this.onBlur);
    const keepEditorFocus = (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
    };
    this.clear.addEventListener("mousedown", keepEditorFocus);
    this.help.addEventListener("mousedown", keepEditorFocus);
    this.help.addEventListener("click", () => this.toggleHelp());
    this.clear.addEventListener("click", () => {
      if (viewer.applyQuickFilter("")) viewer.element.focus();
    });
    this.subscriptions.add(
      lumine.tooltips.add(this.clear, { title: "Clear only the quick filter" }),
      lumine.tooltips.add(this.help, { title: "Quick filter syntax" }),
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
          if (viewer.applyQuickFilter(this.editor.getText())) {
            this.helpView?.close();
            viewer.element.focus();
          }
        },
        "core:cancel": (event) => {
          event.stopPropagation();
          if (this.helpView) {
            this.helpView.close();
            return;
          }
          viewer.quickFilterIssue = viewer.quickFilterAppliedIssue;
          this.sync({ resetText: true });
          viewer.element.focus();
        },
      }),
      new Disposable(() => {
        editorElement.removeEventListener("focusin", this.onFocus);
        editorElement.removeEventListener("focusout", this.onBlur);
        this.clear.removeEventListener("mousedown", keepEditorFocus);
        this.help.removeEventListener("mousedown", keepEditorFocus);
      }),
    );
    this.sync({ resetText: true });
  }

  updateDraft() {
    const draft = this.editor.getText() !== this.viewer.quickFilterText;
    this.element.classList.toggle("is-draft", draft);
    const hasText = Boolean(this.editor.getText() || this.viewer.quickFilterText);
    this.clear.hidden = !hasText;
    this.clear.disabled = !hasText;
    this.element.classList.toggle("has-clear-action", hasText);
    if (draft) {
      this.error.hidden = true;
      this.editor.element.setAttribute("aria-invalid", "false");
    }
  }

  toggleHelp() {
    if (this.helpView) {
      this.helpView.close();
      return;
    }
    this.help.setAttribute("aria-expanded", "true");
    this.helpView = lumine.menu.contextViewManager.show({
      anchor: this.editor.element,
      placement: "below",
      alignment: "end",
      dismissBoundary: this.element,
      className: "graviss-quick-filter-help-view",
      render: (surface) => {
        this.guide.hidden = false;
        surface.append(this.guide);
        const cancel = lumine.commands.add(surface, {
          "core:cancel": (event) => {
            event.stopPropagation();
            this.helpView?.close();
          },
        });
        return new Disposable(() => {
          cancel.dispose();
          this.guide.hidden = true;
          this.element.append(this.guide);
        });
      },
      onHide: () => {
        this.helpView = null;
        this.help.setAttribute("aria-expanded", "false");
      },
    });
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
    this.editor.setPlaceholderText(example);
    this.example.textContent = example;
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
    this.helpView?.close({ restoreFocus: false });
    this.subscriptions.dispose();
    this.viewer.element.classList.remove("graviss-editing-quick-filter");
    this.editor.destroy();
    this.element.remove();
  }
}

module.exports = { QuickFilterControl };
