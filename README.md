# EdgeEver Graph View Plugin

Interactive force-directed **Global Graph** and **Local Graph** plugin for [EdgeEver](https://github.com/tianma-if/edgeever) (Plugin API v2), inspired by Obsidian's Graph View.

## Installation in EdgeEver

Open **Settings → Plugins** in EdgeEver (Web or Desktop) and install directly from GitHub:

```text
https://github.com/fdkgenie/edgeever-plugin-graph-view
```

Then enable **Graph View** and open **Graph View** or **Open Local Graph** from the plugin toolbar menu.

## Features

- **Global & Local Graph Modes**:
  - **Global Graph**: Visualize all indexed notes, `#memo=...` internal links, `[[WikiLinks]]`, tags, and attachments across your workspace.
  - **Local Graph**: Focus on the currently active (or selected) note with configurable hop depth (`1–5`) and link direction (`All`, `Outgoing`, `Incoming`).
- **Obsidian-Style Search & Filters**:
  - Operators: `tag:`, `#tag`, `path:` / `notebook:`, `file:` / `title:`, `kind:` / `type:`, `is:pinned`, `is:orphan`, `is:unresolved`, `is:tag`, `is:attachment`, `-negation`, `"quoted phrases"`, parentheses `(...)`, and `OR`.
  - Toggles: `Tags`, `Attachments`, `Existing files only`, `Orphans`, and `Excluded patterns`.
- **Color Groups**:
  - Create prioritized color rules using search queries to highlight clusters and note types (topmost matching group wins).
- **Display & Forces**:
  - Directional arrows, zoom-based text fade threshold, degree-scaled node size, link thickness, chronological **Animate** time-lapse mode, and real-time physics controls (`Center force`, `Repel force`, `Link force`, `Link distance`).
- **Read-Budget Friendly Indexing**:
  - Caches extracted note links in `context.storage` keyed by `noteId` + `updatedAt`, overlays unsaved editor buffers in memory, and subscribes to live workspace events to avoid redundant reads.

## Development & Build

Requires [Bun](https://bun.sh/) (`>= 1.3`):

```sh
# Build ./main.js from ./src/index.ts and ./styles.css
bun run build

# Run unit tests
bun run test

# Verify manifest, bundle size limits, and release readiness
bun run verify

# Run full build + test + verify check
bun run check
```

## License

[MIT](LICENSE)
