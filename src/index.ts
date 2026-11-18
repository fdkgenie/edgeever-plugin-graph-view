import type { EdgeEverPlugin } from "./plugin-api-types";
import { GraphWorkspaceIndexer } from "./graph-indexer";
import { getGraphCopy } from "./i18n";
import { mountGraphViewPanel } from "./panel-ui";

declare const __GRAPH_VIEW_STYLES_CSS__: string | undefined;

const PLUGIN_ID = "io.github.fdkgenie.graph-view";
const PANEL_ID = "graph-view";

const plugin: EdgeEverPlugin = {
  activate(context) {
    const copy = getGraphCopy();
    const indexer = new GraphWorkspaceIndexer(context);
    const disposeEvents = indexer.subscribeWorkspaceEvents();

    // Ensure styles are present even if the host installed directly via manifest without package CSS injection.
    let fallbackStyleEl: HTMLStyleElement | null = null;
    if (
      typeof document !== "undefined"
      && document.head
      && !document.querySelector(`style[data-edgeever-plugin-style="${PLUGIN_ID}"]`)
      && typeof __GRAPH_VIEW_STYLES_CSS__ === "string"
      && __GRAPH_VIEW_STYLES_CSS__
    ) {
      fallbackStyleEl = document.createElement("style");
      fallbackStyleEl.dataset.edgeeverPluginStyle = PLUGIN_ID;
      fallbackStyleEl.textContent = __GRAPH_VIEW_STYLES_CSS__;
      document.head.appendChild(fallbackStyleEl);
    }

    const disposePanel = context.ui.panels.register({
      id: PANEL_ID,
      title: copy.panelTitle,
      purpose: "dashboard",
      presentation: "fullscreen",
      mount(container, mountContext) {
        return mountGraphViewPanel({
          context,
          indexer,
          mountContext,
          container,
        });
      },
    });

    const disposeOpenGlobal = context.commands.register({
      id: "open-graph-view",
      title: copy.commandOpenGlobal,
      listed: true,
      menu: false,
      async run() {
        await context.ui.panels.open(PANEL_ID, {
          state: { mode: "global" },
        });
      },
    });

    const disposeOpenLocal = context.commands.register({
      id: "open-local-graph",
      title: copy.commandOpenLocal,
      listed: true,
      menu: true,
      async run() {
        const focusNoteId = await indexer.resolveActiveNoteId();
        if (!focusNoteId) {
          context.ui.showNotice(copy.noticeNoActiveNote);
        }
        await context.ui.panels.open(PANEL_ID, {
          state: { mode: "local", ...(focusNoteId ? { focusNoteId } : {}) },
        });
      },
    });

    return () => {
      disposeOpenLocal();
      disposeOpenGlobal();
      disposePanel();
      disposeEvents();
      fallbackStyleEl?.remove();
    };
  },
};

export default plugin;
