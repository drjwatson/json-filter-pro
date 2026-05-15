(() => {
  const vscode = acquireVsCodeApi();

  const OPERATOR_OPTIONS = [
    { value: "eq", label: "==" },
    { value: "ne", label: "!=" },
    { value: "gt", label: ">" },
    { value: "gte", label: ">=" },
    { value: "lt", label: "<" },
    { value: "lte", label: "<=" },
    { value: "in", label: "in" },
    { value: "not in", label: "not in" },
    { value: "contains", label: "contains" },
    { value: "not contains", label: "not contains" },
    { value: "exists", label: "exists" },
    { value: "regex", label: "regex" },
    { value: "match", label: "match" },
    { value: "matchAll", label: "matchAll" }
  ];

  const PIPELINE_FUNCTIONS = [
    "filter",
    "sort",
    "reverse",
    "pick",
    "map",
    "mapObject",
    "mapKeys",
    "mapValues",
    "groupBy",
    "keyBy",
    "keys",
    "values",
    "flatten",
    "join",
    "split",
    "substring",
    "uniq",
    "uniqBy",
    "limit",
    "size",
    "sum",
    "min",
    "max",
    "prod",
    "average",
    "if",
    "not",
    "exists",
    "regex",
    "match",
    "matchAll",
    "abs",
    "round",
    "number",
    "string"
  ];

  const MAX_TREE_NODES = 2500;

  const activeFile = document.getElementById("activeFile");
  const activeFileField = document.getElementById("activeFileField");
  const pickFileBtn = document.getElementById("pickFileBtn");
  const entryPathSelect = document.getElementById("entryPath");
  const groupMode = document.getElementById("groupMode");
  const negateGroup = document.getElementById("negateGroup");
  const rulesList = document.getElementById("rulesList");
  const addRuleBtn = document.getElementById("addRuleBtn");
  const clearRulesBtn = document.getElementById("clearRulesBtn");

  const pipelineRows = document.getElementById("pipelineRows");
  const addPipelineStepBtn = document.getElementById("addPipelineStepBtn");
  const clearStepsBtn = document.getElementById("clearStepsBtn");

  const queryEditor = document.getElementById("queryEditor");
  const regenerateBtn = document.getElementById("regenerateBtn");
  const queryState = document.getElementById("queryState");
  const runQueryBtn = document.getElementById("runQueryBtn");
  const resultsMeta = document.getElementById("resultsMeta");
  const resultsTree = document.getElementById("resultsTree");

  if (
    !(activeFile instanceof HTMLElement) ||
    !(activeFileField instanceof HTMLInputElement) ||
    !(pickFileBtn instanceof HTMLButtonElement) ||
    !(entryPathSelect instanceof HTMLSelectElement) ||
    !(groupMode instanceof HTMLSelectElement) ||
    !(negateGroup instanceof HTMLInputElement) ||
    !(rulesList instanceof HTMLElement) ||
    !(addRuleBtn instanceof HTMLButtonElement) ||
    !(clearRulesBtn instanceof HTMLButtonElement) ||
    !(pipelineRows instanceof HTMLElement) ||
    !(addPipelineStepBtn instanceof HTMLButtonElement) ||
    !(clearStepsBtn instanceof HTMLButtonElement) ||
    !(queryEditor instanceof HTMLTextAreaElement) ||
    !(regenerateBtn instanceof HTMLButtonElement) ||
    !(queryState instanceof HTMLElement) ||
    !(runQueryBtn instanceof HTMLButtonElement) ||
    !(resultsMeta instanceof HTMLElement) ||
    !(resultsTree instanceof HTMLElement)
  ) {
    document.body.innerHTML = "<div style=\"padding:12px\">JSON Filter Pro failed to initialize the UI.</div>";
    return;
  }

  const state = {
    activeFile: null,
    availableKeys: [],
    entryPath: "",
    rules: [],
    pipelineSteps: [],
    generatedQuery: "",
    queryDirty: false,
    isRunning: false,
    resultNodeValues: new Map(),
    selectedResultNodeId: null
  };

  function makeId(prefix) {
    return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function normalizeEntryPath(rawPath) {
    const trimmed = (rawPath || "").trim();
    if (!trimmed || trimmed === "get()") {
      return "";
    }

    if (trimmed.startsWith("get()")) {
      const suffix = trimmed.slice("get()".length).trim();
      return suffix.replace(/^\./, "");
    }

    return trimmed.replace(/^\./, "");
  }

  function getScopedAvailableKeys() {
    const keys = state.availableKeys || [];
    const scopedPath = normalizeEntryPath(state.entryPath);

    if (!scopedPath) {
      return keys;
    }

    const prefix = `${scopedPath}.`;
    const scoped = [];
    const dedupe = new Set();

    for (const keyPath of keys) {
      if (!keyPath.startsWith(prefix)) {
        continue;
      }

      const relative = keyPath.slice(prefix.length);
      if (!relative || dedupe.has(relative)) {
        continue;
      }

      dedupe.add(relative);
      scoped.push(relative);
    }

    return scoped;
  }

  function normalizeSelectionsForEntryPath() {
    const scopedKeys = getScopedAvailableKeys();
    const keySet = new Set(scopedKeys);
    const fallbackPath = scopedKeys[0] || "";

    for (const rule of state.rules) {
      if (!keySet.has(rule.path)) {
        rule.path = fallbackPath;
      }
    }

    for (const step of state.pipelineSteps) {
      if (step.mode !== "includeKeys") {
        continue;
      }

      step.keys = Array.isArray(step.keys) ? step.keys.filter((key) => keySet.has(key)) : [];

      if (!keySet.has(step.keyToAdd)) {
        step.keyToAdd = "";
      }
    }
  }

  function createDefaultRule() {
    const scopedKeys = getScopedAvailableKeys();
    return {
      id: makeId("rule"),
      path: scopedKeys[0] || "",
      operator: "eq",
      value: "",
      flags: ""
    };
  }

  function createDefaultPipelineStep() {
    return {
      id: makeId("step"),
      mode: "includeKeys",
      keyToAdd: "",
      keys: [],
      functionName: "map",
      args: ""
    };
  }

  function resetInteractiveState() {
    state.entryPath = "";
    groupMode.value = "and";
    negateGroup.checked = false;
    state.rules = [createDefaultRule()];
    state.pipelineSteps = [createDefaultPipelineStep()];
    state.queryDirty = false;
    state.generatedQuery = "";
    setQueryState("Synced with rules", false);
    setRunning(false);

    state.resultNodeValues = new Map();
    state.selectedResultNodeId = null;
    resultsMeta.textContent = "No execution yet.";
    resultsTree.innerHTML = '<div class="tree-leaf">No execution yet.</div>';
  }

  function toAbsolutePathExpression(rawPath) {
    const trimmed = rawPath.trim();
    if (!trimmed) {
      return "get()";
    }

    if (trimmed.startsWith("get(")) {
      return trimmed;
    }

    if (trimmed.startsWith(".")) {
      return `get()${trimmed}`;
    }

    return `get()${toPathExpression(trimmed)}`;
  }

  function formatBytes(value) {
    if (!Number.isFinite(value) || value < 0) {
      return "n/a";
    }
    if (value < 1024) {
      return `${value} B`;
    }
    if (value < 1024 * 1024) {
      return `${(value / 1024).toFixed(1)} KB`;
    }
    if (value < 1024 * 1024 * 1024) {
      return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    }
    return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function setQueryState(text, dirty = false) {
    queryState.textContent = text;
    queryState.classList.toggle("dirty", dirty);
  }

  function setRunning(isRunning) {
    state.isRunning = isRunning;
    runQueryBtn.disabled = isRunning;
    runQueryBtn.textContent = isRunning ? "Running..." : "Run Query";
  }

  function toPathExpression(rawPath) {
    const trimmed = rawPath.trim();
    if (!trimmed || trimmed === "." || trimmed === "get()") {
      return "get()";
    }

    if (trimmed.startsWith(".") || trimmed.startsWith("get(")) {
      return trimmed;
    }

    const segments = trimmed.split(".").filter(Boolean);
    if (segments.length === 0) {
      return "get()";
    }

    return segments.reduce((acc, segment) => {
      if (/^[0-9]+$/.test(segment)) {
        return `${acc}.${segment}`;
      }
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)) {
        return `${acc}.${segment}`;
      }
      const escaped = segment.replace(/\\/g, "\\\\").replace(/\"/g, '\\\"');
      return `${acc}.\"${escaped}\"`;
    }, "");
  }

  function inferTokenValue(rawToken) {
    const token = rawToken.trim();
    if (!token) {
      return "";
    }

    if (token === "null") {
      return null;
    }
    if (token === "true") {
      return true;
    }
    if (token === "false") {
      return false;
    }

    if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token)) {
      return Number(token);
    }

    if (
      (token.startsWith("{") && token.endsWith("}")) ||
      (token.startsWith("[") && token.endsWith("]")) ||
      (token.startsWith('"') && token.endsWith('"'))
    ) {
      try {
        return JSON.parse(token);
      } catch {
        return token;
      }
    }

    return token;
  }

  function toImplicitLiteral(rawValue, preferNumeric = false) {
    const trimmed = rawValue.trim();
    if (!trimmed) {
      return JSON.stringify("");
    }

    if (trimmed === "null") {
      return "null";
    }
    if (trimmed === "true" || trimmed === "false") {
      return trimmed;
    }

    if (preferNumeric && /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)) {
      return trimmed;
    }

    if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)) {
      return trimmed;
    }

    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        const parsed = JSON.parse(trimmed);
        return JSON.stringify(parsed);
      } catch {
        return JSON.stringify(rawValue);
      }
    }

    return JSON.stringify(rawValue);
  }

  function toInArrayLiteral(rawValue) {
    const trimmed = rawValue.trim();
    if (!trimmed) {
      return "[]";
    }

    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return JSON.stringify(parsed);
        }
      } catch {
        // Fallback to split parsing.
      }
    }

    const values = rawValue
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .map((part) => inferTokenValue(part));

    return JSON.stringify(values);
  }

  function escapeRegexLiteral(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function buildRuleExpression(rule) {
    const pathExpr = toPathExpression(rule.path);

    if (rule.operator === "exists") {
      return `exists(${pathExpr})`;
    }

    if (rule.operator === "contains") {
      const searchTerm = escapeRegexLiteral(rule.value || "");
      return `regex(${pathExpr}, ${JSON.stringify(searchTerm)}, "i")`;
    }

    if (rule.operator === "not contains") {
      const searchTerm = escapeRegexLiteral(rule.value || "");
      const pattern = `^(?!.*${searchTerm}).+$`;
      return `regex(${pathExpr}, ${JSON.stringify(pattern)}, "i")`;
    }

    if (rule.operator === "regex") {
      const pattern = JSON.stringify(rule.value || "");
      const flags = rule.flags && rule.flags.trim() ? `, ${JSON.stringify(rule.flags.trim())}` : "";
      return `regex(${pathExpr}, ${pattern}${flags})`;
    }

    if (rule.operator === "match") {
      const pattern = JSON.stringify(rule.value || "");
      const flags = rule.flags && rule.flags.trim() ? `, ${JSON.stringify(rule.flags.trim())}` : "";
      return `match(${pathExpr}, ${pattern}${flags}) != null`;
    }

    if (rule.operator === "matchAll") {
      const pattern = JSON.stringify(rule.value || "");
      const flags = rule.flags && rule.flags.trim() ? `, ${JSON.stringify(rule.flags.trim())}` : "";
      return `size(matchAll(${pathExpr}, ${pattern}${flags})) > 0`;
    }

    if (rule.operator === "in") {
      return `${pathExpr} in ${toInArrayLiteral(rule.value)}`;
    }

    if (rule.operator === "not in") {
      return `${pathExpr} not in ${toInArrayLiteral(rule.value)}`;
    }

    const numericOperator =
      rule.operator === "gt" ||
      rule.operator === "gte" ||
      rule.operator === "lt" ||
      rule.operator === "lte";
    const valueExpr = toImplicitLiteral(rule.value, numericOperator);

    if (rule.operator === "eq") {
      return `${pathExpr} == ${valueExpr}`;
    }
    if (rule.operator === "ne") {
      return `${pathExpr} != ${valueExpr}`;
    }
    if (rule.operator === "gt") {
      return `${pathExpr} > ${valueExpr}`;
    }
    if (rule.operator === "gte") {
      return `${pathExpr} >= ${valueExpr}`;
    }
    if (rule.operator === "lt") {
      return `${pathExpr} < ${valueExpr}`;
    }
    return `${pathExpr} <= ${valueExpr}`;
  }

  function toProjectionEntry(keyPath) {
    const valuePath = toPathExpression(keyPath);
    const keyToken = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(keyPath) ? keyPath : JSON.stringify(keyPath);
    return `${keyToken}: ${valuePath}`;
  }

  function buildProjectionMapArgs(keyPaths) {
    const entries = keyPaths
      .map((keyPath) => keyPath.trim())
      .filter((keyPath) => keyPath.length > 0)
      .map((keyPath) => toProjectionEntry(keyPath));

    return `{${entries.join(", ")}}`;
  }

  function toPipelineStepExpression(step) {
    if (step.mode === "includeKeys") {
      if (!Array.isArray(step.keys) || step.keys.length === 0) {
        return "";
      }
      return `map(${buildProjectionMapArgs(step.keys)})`;
    }

    const fn = step.functionName?.trim();
    if (!fn) {
      return "";
    }

    const args = step.args.trim();
    return args ? `${fn}(${args})` : `${fn}()`;
  }

  function buildQueryFromRules() {
    const expressions = state.rules
      .filter((rule) => Boolean(rule.path))
      .map((rule) => buildRuleExpression(rule))
      .filter(Boolean);

    let query = toAbsolutePathExpression(state.entryPath);

    if (expressions.length > 0) {
      const glue = groupMode.value === "or" ? " or " : " and ";
      let predicate = expressions.join(glue);
      if (expressions.length > 1) {
        predicate = `(${predicate})`;
      }
      if (negateGroup.checked) {
        predicate = `not(${predicate})`;
      }
      query += ` | filter(${predicate})`;
    }

    for (const step of state.pipelineSteps) {
      const expression = toPipelineStepExpression(step);
      if (!expression) {
        continue;
      }
      query += ` | ${expression}`;
    }

    return query;
  }

  function syncQueryFromRules(force = false) {
    const query = buildQueryFromRules();
    state.generatedQuery = query;

    if (!state.queryDirty || force) {
      queryEditor.value = query;
      state.queryDirty = false;
      setQueryState("Synced with rules", false);
      return;
    }

    setQueryState("Manual query edits", true);
  }

  function buildPathOptions(currentPath) {
    const keys = getScopedAvailableKeys();
    if (keys.length === 0) {
      return '<option value="" selected disabled>No keys detected</option>';
    }

    const options = [];
    const selectedPath = currentPath && keys.includes(currentPath) ? currentPath : keys[0];
    for (const keyPath of keys) {
      const selected = selectedPath === keyPath ? "selected" : "";
      options.push(`<option value=\"${escapeHtml(keyPath)}\" ${selected}>${escapeHtml(keyPath)}</option>`);
    }

    return options.join("");
  }

  function buildPipelineModeOptions(mode) {
    return `
      <option value="includeKeys" ${mode === "includeKeys" ? "selected" : ""}>Include Keys</option>
      <option value="custom" ${mode === "custom" ? "selected" : ""}>Custom Function</option>
    `;
  }

  function buildPipelineFunctionOptions(currentFn) {
    return PIPELINE_FUNCTIONS.map((name) => {
      const selected = name === currentFn ? "selected" : "";
      return `<option value=\"${name}\" ${selected}>${name}</option>`;
    }).join("");
  }

  function buildStepKeyOptions(step) {
    const keys = getScopedAvailableKeys();
    if (keys.length === 0) {
      return '<option value="" selected disabled>No keys detected</option>';
    }

    const selectedPath = step.keyToAdd && keys.includes(step.keyToAdd) ? step.keyToAdd : "";
    const options = [`<option value="" ${selectedPath ? "" : "selected"}>Select key...</option>`];

    for (const keyPath of keys) {
      const selected = selectedPath === keyPath ? "selected" : "";
      options.push(`<option value=\"${escapeHtml(keyPath)}\" ${selected}>${escapeHtml(keyPath)}</option>`);
    }

    return options.join("");
  }

  function renderEntryPathOptions() {
    const keys = state.availableKeys || [];
    if (state.entryPath && !keys.includes(state.entryPath)) {
      state.entryPath = "";
    }

    const selectedPath = state.entryPath;
    const options = [`<option value="" ${selectedPath ? "" : "selected"}>Root (get())</option>`];

    for (const keyPath of keys) {
      const selected = selectedPath === keyPath ? "selected" : "";
      options.push(`<option value="${escapeHtml(keyPath)}" ${selected}>${escapeHtml(keyPath)}</option>`);
    }

    entryPathSelect.innerHTML = options.join("");
  }

  function renderStepChips(step) {
    if (!Array.isArray(step.keys) || step.keys.length === 0) {
      return '<span class="step-chip-empty">No keys</span>';
    }

    return step.keys
      .map((keyPath) => {
        return `
          <span class="step-chip" title="${escapeHtml(keyPath)}">
            <span class="step-chip-label">${escapeHtml(keyPath)}</span>
            <button type="button" class="icon-only mini danger" data-action="removeStepKey" data-key="${escapeHtml(keyPath)}" title="Remove key">x</button>
          </span>
        `;
      })
      .join("");
  }

  function addIncludeKeyToStep(step, keyPath) {
    const normalized = (keyPath || "").trim();
    step.keyToAdd = "";

    if (!normalized) {
      return false;
    }

    if (step.keys.includes(normalized)) {
      return false;
    }

    step.keys.push(normalized);
    return true;
  }

  function applyRuleVisibility(ruleRow, operator) {
    const valueInput = ruleRow.querySelector(".rule-value");
    const flagsInput = ruleRow.querySelector(".rule-flags");

    const hideValue = operator === "exists";
    const regexMode = operator === "regex" || operator === "match" || operator === "matchAll";

    if (valueInput instanceof HTMLElement) {
      valueInput.classList.toggle("hidden", hideValue);
    }
    if (flagsInput instanceof HTMLElement) {
      flagsInput.classList.toggle("hidden", !regexMode);
    }
  }

  function renderRules() {
    if (state.rules.length === 0) {
      rulesList.innerHTML = '<div class="hint-empty">No rules yet. Add one to generate filter(...).</div>';
      return;
    }

    const scopedKeys = getScopedAvailableKeys();

    rulesList.innerHTML = state.rules
      .map((rule) => {
        if (!rule.path && scopedKeys.length > 0) {
          rule.path = scopedKeys[0];
        }

        const operatorOptions = OPERATOR_OPTIONS.map((option) => {
          const selected = option.value === rule.operator ? "selected" : "";
          return `<option value=\"${option.value}\" ${selected}>${option.label}</option>`;
        }).join("");

        const hideValue = rule.operator === "exists";
        const regexMode = rule.operator === "regex" || rule.operator === "match" || rule.operator === "matchAll";

        return `
          <article class="rule-row" data-rule-id="${rule.id}">
            <select class="rule-path" data-field="path" title="Key path">${buildPathOptions(rule.path)}</select>
            <select class="rule-operator" data-field="operator" title="Operator">${operatorOptions}</select>
            <input class="rule-value ${hideValue ? "hidden" : ""}" data-field="value" type="text" placeholder="value" value="${escapeHtml(rule.value)}" spellcheck="false" />
            <input class="rule-flags ${regexMode ? "" : "hidden"}" data-field="flags" type="text" placeholder="flags" value="${escapeHtml(rule.flags || "")}" spellcheck="false" />
            <button type="button" data-action="removeRule" class="ghost icon-only danger" title="Remove rule">x</button>
          </article>
        `;
      })
      .join("");
  }

  function renderPipelineRows() {
    if (state.pipelineSteps.length === 0) {
      pipelineRows.innerHTML = '<div class="hint-empty">No pipeline steps. Click + Step.</div>';
      return;
    }

    pipelineRows.innerHTML = state.pipelineSteps
      .map((step) => {
        const includeMode = step.mode === "includeKeys";
        const mainMarkup = includeMode
          ? `
            <div class="pipeline-main pipeline-main-include">
              <select class="pipeline-key-select" data-field="keyToAdd" title="Key selector">${buildStepKeyOptions(step)}</select>
              <div class="step-chip-list">${renderStepChips(step)}</div>
            </div>
          `
          : `
            <div class="pipeline-main pipeline-main-custom">
              <select class="pipeline-function" data-field="functionName" title="Function">${buildPipelineFunctionOptions(step.functionName)}</select>
              <input class="pipeline-args" data-field="args" type="text" value="${escapeHtml(step.args)}" placeholder="arguments" spellcheck="false" />
            </div>
          `;

        return `
          <article class="pipeline-row" data-step-id="${step.id}">
            <select class="pipeline-mode" data-field="mode" title="Step mode">${buildPipelineModeOptions(step.mode)}</select>
            ${mainMarkup}
            <button type="button" data-action="removeStep" class="ghost icon-only danger" title="Remove step">x</button>
          </article>
        `;
      })
      .join("");
  }

  function toRawJson(value) {
    try {
      const formatted = JSON.stringify(value, null, 2);
      return formatted === undefined ? "null" : formatted;
    } catch {
      return String(value);
    }
  }

  function clearResultSelection() {
    state.selectedResultNodeId = null;
    const selected = resultsTree.querySelectorAll(".selected-node");
    for (const element of selected) {
      element.classList.remove("selected-node");
    }
  }

  function selectResultNode(nodeId) {
    if (!state.resultNodeValues.has(nodeId)) {
      return;
    }

    clearResultSelection();
    state.selectedResultNodeId = nodeId;

    const selectedElement = resultsTree.querySelector(`[data-node-id=\"${nodeId}\"]`);
    if (selectedElement instanceof HTMLElement) {
      selectedElement.classList.add("selected-node");
    }
  }

  function formatValueToken(value) {
    if (typeof value === "string") {
      return { text: JSON.stringify(value), className: "json-string" };
    }
    if (typeof value === "number") {
      return { text: String(value), className: "json-number" };
    }
    if (typeof value === "boolean") {
      return { text: String(value), className: "json-boolean" };
    }
    if (value === null) {
      return { text: "null", className: "json-null" };
    }
    return { text: String(value), className: "json-value" };
  }

  function createSummaryNode(label, isArray, size) {
    const summary = document.createElement("summary");
    summary.className = "tree-summary";
    summary.addEventListener("click", (event) => {
      event.preventDefault();
    });

    const toggle = document.createElement("span");
    toggle.className = "tree-toggle";
    toggle.textContent = "▾";
    toggle.dataset.role = "toggle";
    summary.appendChild(toggle);

    if (label !== "result") {
      const keySpan = document.createElement("span");
      keySpan.className = "json-key";
      keySpan.textContent = `\"${label}\"`;
      summary.appendChild(keySpan);

      const colon = document.createElement("span");
      colon.className = "json-punct";
      colon.textContent = ": ";
      summary.appendChild(colon);
    }

    const openToken = document.createElement("span");
    openToken.className = "json-punct";
    openToken.textContent = isArray ? "[" : "{";
    summary.appendChild(openToken);

    const hint = document.createElement("span");
    hint.className = "json-hint";
    hint.textContent = ` ${size}`;
    summary.appendChild(hint);

    return { summary, toggle };
  }

  function buildTreeNode(label, value, depth, counters) {
    if (counters.count >= MAX_TREE_NODES) {
      const cap = document.createElement("div");
      cap.className = "tree-leaf";
      cap.textContent = "... tree render limit reached";
      return cap;
    }

    counters.count += 1;
    const nodeId = makeId("node");
    state.resultNodeValues.set(nodeId, value);

    const isObject = value !== null && typeof value === "object";
    if (!isObject) {
      const leaf = document.createElement("div");
      leaf.className = "tree-leaf";
      leaf.dataset.nodeId = nodeId;

      if (label !== "result") {
        const keySpan = document.createElement("span");
        keySpan.className = "json-key";
        keySpan.textContent = `\"${label}\"`;
        leaf.appendChild(keySpan);

        const colon = document.createElement("span");
        colon.className = "json-punct";
        colon.textContent = ": ";
        leaf.appendChild(colon);
      }

      const token = formatValueToken(value);
      const valueSpan = document.createElement("span");
      valueSpan.className = token.className;
      valueSpan.textContent = token.text;
      leaf.appendChild(valueSpan);
      return leaf;
    }

    const details = document.createElement("details");
    details.className = "tree-node";
    details.dataset.nodeId = nodeId;
    details.open = depth < 2;

    const isArray = Array.isArray(value);
    const size = isArray ? value.length : Object.keys(value).length;
    const { summary, toggle } = createSummaryNode(label, isArray, size);
    details.appendChild(summary);

    const children = document.createElement("div");
    children.className = "tree-children";

    const entries = isArray
      ? value.map((item, index) => [String(index), item])
      : Object.entries(value);

    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "tree-leaf";
      empty.textContent = "(empty)";
      children.appendChild(empty);
    } else {
      for (const [key, childValue] of entries) {
        children.appendChild(buildTreeNode(key, childValue, depth + 1, counters));
      }
    }

    const closing = document.createElement("div");
    closing.className = "tree-closing json-punct";
    closing.textContent = isArray ? "]" : "}";
    children.appendChild(closing);

    details.appendChild(children);

    const syncToggle = () => {
      toggle.textContent = details.open ? "▾" : "▸";
    };
    details.addEventListener("toggle", syncToggle);
    syncToggle();

    return details;
  }

  function renderResults(result) {
    resultsTree.innerHTML = "";
    state.resultNodeValues = new Map();
    clearResultSelection();

    const counters = { count: 0 };
    resultsTree.appendChild(buildTreeNode("result", result, 0, counters));
  }

  function updateActiveFile(message) {
    state.activeFile = message;
    state.availableKeys = Array.isArray(message.keyPaths) ? message.keyPaths : [];

    resetInteractiveState();

    activeFileField.value = message.fileName;
    activeFile.textContent = `Loaded ${formatBytes(message.fileSizeBytes)} • ${state.availableKeys.length} keys detected`;

    renderEntryPathOptions();
    renderRules();
    renderPipelineRows();
    syncQueryFromRules(true);
  }

  function clearActiveFile(reason) {
    state.activeFile = null;
    state.availableKeys = [];

    resetInteractiveState();

    activeFileField.value = "";
    activeFile.textContent = reason || "No file loaded.";

    renderEntryPathOptions();
    renderRules();
    renderPipelineRows();
    syncQueryFromRules(true);
  }

  function onRuleFieldChange(target) {
    const row = target.closest(".rule-row");
    if (!row) {
      return;
    }

    const ruleId = row.getAttribute("data-rule-id");
    if (!ruleId) {
      return;
    }

    const field = target.getAttribute("data-field");
    if (!field) {
      return;
    }

    const rule = state.rules.find((item) => item.id === ruleId);
    if (!rule) {
      return;
    }

    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) {
      return;
    }

    rule[field] = target.value;
    if (field === "operator") {
      applyRuleVisibility(row, target.value);
    }
    syncQueryFromRules();
  }

  function copySelectedResultNode() {
    if (!state.selectedResultNodeId) {
      return;
    }

    const value = state.resultNodeValues.get(state.selectedResultNodeId);
    const text = toRawJson(value);
    vscode.postMessage({
      type: "copyToClipboard",
      payload: {
        text
      }
    });

    resultsMeta.textContent = "Copied selected node JSON.";
  }

  function findPipelineStepFromTarget(target) {
    const row = target.closest(".pipeline-row");
    if (!(row instanceof HTMLElement)) {
      return null;
    }

    const stepId = row.getAttribute("data-step-id");
    if (!stepId) {
      return null;
    }

    return state.pipelineSteps.find((step) => step.id === stepId) || null;
  }

  pickFileBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "pickFile" });
  });

  addRuleBtn.addEventListener("click", () => {
    state.rules.push(createDefaultRule());
    renderRules();
    syncQueryFromRules();
  });

  clearRulesBtn.addEventListener("click", () => {
    state.rules = [];
    renderRules();
    syncQueryFromRules();
  });

  addPipelineStepBtn.addEventListener("click", () => {
    state.pipelineSteps.push(createDefaultPipelineStep());
    renderPipelineRows();
    syncQueryFromRules();
  });

  clearStepsBtn.addEventListener("click", () => {
    state.pipelineSteps = [];
    renderPipelineRows();
    syncQueryFromRules();
  });

  groupMode.addEventListener("change", () => syncQueryFromRules());
  negateGroup.addEventListener("change", () => syncQueryFromRules());
  entryPathSelect.addEventListener("change", () => {
    state.entryPath = normalizeEntryPath(entryPathSelect.value);
    normalizeSelectionsForEntryPath();
    renderRules();
    renderPipelineRows();
    syncQueryFromRules();
  });

  rulesList.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    onRuleFieldChange(target);
  });

  rulesList.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    onRuleFieldChange(target);
  });

  rulesList.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const actionElement = target.closest("[data-action]");
    if (!(actionElement instanceof HTMLElement)) {
      return;
    }

    if (actionElement.getAttribute("data-action") !== "removeRule") {
      return;
    }

    const row = actionElement.closest(".rule-row");
    if (!row) {
      return;
    }

    const ruleId = row.getAttribute("data-rule-id");
    if (!ruleId) {
      return;
    }

    state.rules = state.rules.filter((rule) => rule.id !== ruleId);
    renderRules();
    syncQueryFromRules();
  });

  pipelineRows.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const step = findPipelineStepFromTarget(target);
    if (!step) {
      return;
    }

    const field = target.getAttribute("data-field");
    if (!field) {
      return;
    }

    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) {
      return;
    }

    if (field === "mode") {
      step.mode = target.value === "custom" ? "custom" : "includeKeys";
      renderPipelineRows();
      syncQueryFromRules();
      return;
    }

    if (field === "keyToAdd") {
      step.keyToAdd = target.value;

      if (step.mode === "includeKeys" && target.value) {
        addIncludeKeyToStep(step, target.value);
        renderPipelineRows();
        syncQueryFromRules();
      }

      return;
    }

    if (field === "functionName") {
      step.functionName = target.value;
      syncQueryFromRules();
    }
  });

  pipelineRows.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const step = findPipelineStepFromTarget(target);
    if (!step) {
      return;
    }

    const field = target.getAttribute("data-field");
    if (!field || !(target instanceof HTMLInputElement)) {
      return;
    }

    if (field === "args") {
      step.args = target.value;
      syncQueryFromRules();
    }
  });

  pipelineRows.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const actionElement = target.closest("[data-action]");
    if (!(actionElement instanceof HTMLElement)) {
      return;
    }

    const action = actionElement.getAttribute("data-action");
    if (!action) {
      return;
    }

    const step = findPipelineStepFromTarget(actionElement);
    if (!step) {
      return;
    }

    if (action === "removeStep") {
      state.pipelineSteps = state.pipelineSteps.filter((item) => item.id !== step.id);
      renderPipelineRows();
      syncQueryFromRules();
      return;
    }

    if (action === "removeStepKey") {
      const keyPath = actionElement.getAttribute("data-key");
      if (!keyPath) {
        return;
      }
      step.keys = step.keys.filter((item) => item !== keyPath);
      renderPipelineRows();
      syncQueryFromRules();
    }
  });

  pipelineRows.addEventListener("keydown", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) {
      return;
    }

    if (target.getAttribute("data-field") !== "keyToAdd" || event.key !== "Enter") {
      return;
    }

    const step = findPipelineStepFromTarget(target);
    if (!step || step.mode !== "includeKeys" || !target.value) {
      return;
    }

    event.preventDefault();
    addIncludeKeyToStep(step, target.value);
    renderPipelineRows();
    syncQueryFromRules();
  });

  queryEditor.addEventListener("input", () => {
    state.queryDirty = queryEditor.value.trim() !== state.generatedQuery.trim();
    setQueryState(state.queryDirty ? "Manual query edits" : "Synced with rules", state.queryDirty);
  });

  regenerateBtn.addEventListener("click", () => {
    syncQueryFromRules(true);
  });

  runQueryBtn.addEventListener("click", () => {
    if (state.isRunning) {
      return;
    }

    const query = queryEditor.value.trim();
    if (!query) {
      resultsMeta.textContent = "Query is empty.";
      return;
    }

    setRunning(true);
    resultsMeta.textContent = "Running query...";

    vscode.postMessage({
      type: "executeQuery",
      payload: {
        query
      }
    });
  });

  resultsTree.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const toggle = target.closest(".tree-toggle");
    if (toggle instanceof HTMLElement) {
      const details = toggle.closest("details");
      if (details instanceof HTMLDetailsElement) {
        details.open = !details.open;
      }
      return;
    }

    const leaf = target.closest(".tree-leaf");
    if (leaf instanceof HTMLElement && leaf.dataset.nodeId) {
      selectResultNode(leaf.dataset.nodeId);
      return;
    }

    const node = target.closest(".tree-node");
    if (node instanceof HTMLElement && node.dataset.nodeId) {
      selectResultNode(node.dataset.nodeId);
    }
  });

  resultsTree.addEventListener(
    "wheel",
    (event) => {
      const container = resultsTree.closest(".results-card");
      if (!(container instanceof HTMLElement)) {
        return;
      }

      if (container.scrollHeight <= container.clientHeight) {
        return;
      }

      container.scrollTop += event.deltaY;
      event.preventDefault();
    },
    { passive: false }
  );

  window.addEventListener("keydown", (event) => {
    const isCopy = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c";
    if (!isCopy || !state.selectedResultNodeId) {
      return;
    }

    const activeElement = document.activeElement;
    if (
      activeElement instanceof HTMLInputElement ||
      activeElement instanceof HTMLTextAreaElement ||
      activeElement instanceof HTMLSelectElement
    ) {
      return;
    }

    event.preventDefault();
    copySelectedResultNode();
  });

  window.addEventListener("message", (event) => {
    const message = event.data;

    if (message?.type === "setActiveFile") {
      updateActiveFile(message.payload);
      return;
    }

    if (message?.type === "clearActiveFile") {
      clearActiveFile(message.payload.reason);
      return;
    }

    if (message?.type === "executionStarted") {
      setRunning(true);
      resultsMeta.textContent = "Running query...";
      return;
    }

    if (message?.type === "executionCompleted") {
      setRunning(false);
      const payload = message.payload;
      resultsMeta.textContent = `Mode: ${payload.mode} | Time: ${payload.elapsedMs}ms | Scanned: ${payload.scannedItems} | Matched: ${payload.matchedItems}${payload.truncated ? " | Truncated" : ""}`;
      renderResults(payload.result);
      return;
    }

    if (message?.type === "executionFailed") {
      setRunning(false);
      resultsMeta.textContent = "Execution failed.";
      resultsTree.innerHTML = `<div class="tree-leaf">Execution failed: ${escapeHtml(message.payload.message || "Unknown error")}</div>`;
      clearResultSelection();
    }
  });

  resetInteractiveState();
  renderEntryPathOptions();

  renderRules();
  renderPipelineRows();
  syncQueryFromRules(true);

  vscode.postMessage({ type: "ready" });
})();
