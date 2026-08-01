import { pageQueryParams } from "./core.mjs";

export function createWorkspaceUi({
  document,
  window,
  app,
  element,
  request,
  onError,
}) {
  let activeModalClose = null;

  function closeActiveModal(options) {
    return activeModalClose?.(options);
  }

  function field(label, input) {
    const labelTarget = input.labelTarget ?? input;
    const id = labelTarget.id || `field-${crypto.randomUUID()}`;
    labelTarget.id = id;
    return element("div", { class: "field" }, [
      element("label", { htmlFor: id, text: label }),
      input,
    ]);
  }

  function simpleInput(
    type,
    value = "",
    { placeholder = "", required = false } = {},
  ) {
    return element("input", {
      type,
      value,
      required,
      ...(placeholder ? { placeholder } : {}),
    });
  }

  function openModal(title, description, form) {
    const titleId = `modal-title-${crypto.randomUUID()}`;
    const descriptionId = `modal-description-${crypto.randomUUID()}`;
    const HTMLElementConstructor = document.defaultView?.HTMLElement;
    const opener = HTMLElementConstructor && document.activeElement instanceof HTMLElementConstructor
      ? document.activeElement
      : null;
    const modal = element("div", {
      class: "modal",
      attrs: {
        role: "dialog",
        "aria-modal": "true",
        "aria-labelledby": titleId,
        "aria-describedby": descriptionId,
      },
    });
    let closed = false;
    const close = ({ restoreFocus = true } = {}) => {
      if (closed) return;
      closed = true;
      modal.removeEventListener("keydown", handleKeydown);
      modal.remove();
      app.inert = false;
      document.body.classList.remove("modal-open");
      if (activeModalClose === close) activeModalClose = null;
      if (restoreFocus) opener?.focus();
    };
    const closeButton = element("button", {
      class: "modal-close",
      type: "button",
      text: "×",
      attrs: { "aria-label": "Close dialog" },
      onClick: close,
    });
    const card = element("section", { class: "modal-card" }, [
      element("header", { class: "modal-header" }, [
        element("div", {}, [
          element("h2", { id: titleId, text: title }),
          element("p", { id: descriptionId, text: description }),
        ]),
        closeButton,
      ]),
      form,
    ]);
    modal.append(card);

    function focusableElements() {
      return [...modal.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')]
        .filter((node) => !node.hidden && node.getAttribute("aria-hidden") !== "true");
    }

    function handleKeydown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements();
      if (!focusable.length) {
        event.preventDefault();
        card.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    modal.addEventListener("keydown", handleKeydown);
    modal.addEventListener("click", (event) => {
      if (event.target === modal) close();
    });
    closeActiveModal({ restoreFocus: false });
    activeModalClose = close;
    app.inert = true;
    document.body.classList.add("modal-open");
    document.body.append(modal);
    (form.querySelector("input, select, textarea, button:not([disabled])") ?? closeButton).focus();
    return { close, modal };
  }

  function formWithSubmit(fields, submitLabel, onSubmit) {
    const form = element("form", { class: "form-grid" });
    fields.forEach(({ label, input, full = false }) => {
      const item = field(label, input);
      if (full) item.classList.add("full");
      form.append(item);
    });
    form.append(element("div", { class: "form-actions full" }, [
      element("button", { class: "button-submit", type: "submit", text: submitLabel }),
    ]));
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = form.querySelector("button[type=submit]");
      button.disabled = true;
      try {
        await onSubmit();
      } catch (error) {
        onError(error);
        button.disabled = false;
      }
    });
    return form;
  }

  function selectInput(items, selected = "", emptyLabel = "Not assigned") {
    const select = element("select");
    select.append(element("option", { value: "", text: emptyLabel }));
    items.forEach(([value, label]) => select.append(element("option", {
      value,
      text: label,
      selected: value === selected,
    })));
    return select;
  }

  function lookupControl(
    resource,
    { initial = null, required = false, placeholder = "Search" } = {},
  ) {
    const search = simpleInput("search", "", { placeholder });
    search.autocomplete = "off";
    const select = element("select", {
      required,
      attrs: { "aria-label": `${placeholder} results` },
    });
    const hint = element("small", {
      class: "lookup-hint",
      text: "Type to refine the active records shown below.",
    });
    const control = element("div", { class: "lookup-control" }, [search, select, hint]);
    control.labelTarget = search;
    Object.defineProperty(control, "value", { get: () => select.value });
    let sequence = 0;
    let timer = null;

    const populate = (items, nextCursor) => {
      const selectedValue = select.value || initial?.id || "";
      const selectedLabel = select.selectedOptions[0]?.textContent
        || initial?.label
        || "Current selection";
      const options = [...items];
      if (selectedValue && !options.some((item) => item.id === selectedValue)) {
        options.unshift({
          id: selectedValue,
          label: selectedLabel,
          secondary: initial?.secondary ?? "",
        });
      }
      select.replaceChildren(element("option", {
        value: "",
        text: required ? "Select a record" : "Not assigned",
      }));
      options.forEach((item) => select.append(element("option", {
        value: item.id,
        text: item.secondary ? `${item.label} · ${item.secondary}` : item.label,
        selected: item.id === selectedValue,
      })));
      if (selectedValue) select.value = selectedValue;
      hint.textContent = nextCursor
        ? "More matches exist. Refine the search to narrow the list."
        : `${items.length} active match${items.length === 1 ? "" : "es"}.`;
    };

    const load = async () => {
      const current = ++sequence;
      search.setAttribute("aria-busy", "true");
      try {
        const result = await request(
          `/lookups/${resource}?${pageQueryParams({ limit: 20, query: search.value.trim() })}`,
        );
        if (current === sequence) {
          hint.classList.remove("error");
          populate(result.items, result.nextCursor);
        }
      } catch (error) {
        if (current === sequence) {
          hint.textContent = error.message;
          hint.classList.add("error");
        }
      } finally {
        if (current === sequence) search.removeAttribute("aria-busy");
      }
    };
    populate(initial ? [initial] : [], null);
    search.addEventListener("input", () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(load, 220);
    });
    window.setTimeout(load, 0);
    return control;
  }

  return {
    closeActiveModal,
    field,
    formWithSubmit,
    lookupControl,
    openModal,
    selectInput,
    simpleInput,
  };
}
