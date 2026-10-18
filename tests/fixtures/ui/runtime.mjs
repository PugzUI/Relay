import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import * as uiState from "../../../ui/state.mjs";
import * as uiFilter from "../../../ui/filter.mjs";

class Element extends EventTarget {
  dataset = {};
  children = [];
  textContent = "";
  value = "";
  query = "";
  disabled = false;
  isConnected = false;
  parentNode = null;
  get firstChild() { return this.children[0] ?? null; }
  get options() { return this.children; }
  get nextSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] ?? null; }
  append(...children) { for (const child of children) this.insertBefore(child, null); }
  insertBefore(child, anchor) {
    if (anchor !== null && !this.children.includes(anchor)) throw new Error("Anchor is not a child");
    if (child === anchor) return child;
    child.remove();
    this.children.splice(anchor === null ? this.children.length : this.children.indexOf(anchor), 0, child);
    child.parentNode = this;
    return child;
  }
  remove() {
    if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode = null;
  }
  replaceChildren(...children) { for (const child of [...this.children]) child.remove(); this.append(...children); }
  setAttribute() {}
  querySelectorAll() { return []; }
}

// Execute the real browser controller; only DOM geometry and transport are supplied by the fixture.
export async function uiRuntime(fetch) {
  const elements = new Map();
  const document = new EventTarget();
  document.hidden = false;
  document.getElementById = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  document.createElement = document.createElementNS = () => new Element();
  const source = await readFile(new URL("../../../ui/main.mjs", import.meta.url), "utf8");
  const imports = /^import \{[\s\S]*?\} from "\/state.mjs";/;
  if (!imports.test(source)) throw new Error("UI controller import seam changed");
  const context = createContext({
    ...uiState, ...uiFilter, clearPrivateUiState: uiState.clearPrivateState,
    document, window: new EventTarget(), location: { origin: "http://127.0.0.1" },
    fetch, URL, AbortController, DOMException, TextDecoder, TextEncoder, Uint8Array, JSON,
    setTimeout, clearTimeout,
  });
  runInContext(source.replace(imports, "").replace('import "/assets/console.mjs";', "").replace('import { filteredTopology, filterSuggestions } from "/filter.mjs";', ""), context);
  const run = (expression) => runInContext(expression, context);
  return {
    run, document, element: (id) => document.getElementById(id),
    async close() {
      const stream = run("streamTask");
      run("clearTimeout(refreshTimer); clearPrivateState()");
      await stream;
    },
  };
}
