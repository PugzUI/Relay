import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import * as uiState from "../../../ui/state.mjs";

class Element extends EventTarget {
  dataset = {};
  children = [];
  textContent = "";
  value = "";
  disabled = false;
  isConnected = false;
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
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
    ...uiState, clearPrivateUiState: uiState.clearPrivateState,
    document, window: new EventTarget(), location: { origin: "http://127.0.0.1" },
    fetch, URL, AbortController, DOMException, TextDecoder, TextEncoder, Uint8Array, JSON,
    setTimeout, clearTimeout,
  });
  runInContext(source.replace(imports, "").replace('import "/assets/console.mjs";', ""), context);
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
