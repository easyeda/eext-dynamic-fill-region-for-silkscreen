# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

EasyEDA Pro extension (`.eext`) that generates polygon fill regions on PCB silkscreen layers with automatic obstacle avoidance. Users draw a region and the extension auto-cuts holes around pads, vias, text, components, tracks, and other obstacles.

Two workflows: **draw new fill** (interactive polygon) and **avoid existing fill** (select a region, one-click obstacle avoidance).

## Build & Development

```bash
npm install
npm run compile   # esbuild bundle → dist/index.js
npm run build     # compile + package → build/dist/*.eext
```

No test framework is configured. No lint-on-build — run `npx eslint` manually if needed.

## Architecture

### Pipeline (the core idea)

`processObstaclePipeline` in `src/index.ts` orchestrates:

1. **Collect** (`core/obstacleCollector.ts`) — parallel `Promise.all` gathering 11+ obstacle types
2. **Offset** (`core/polygonOffset.ts`) — expand obstacles by user-specified gap using vertex normals
3. **AABB filter** — bounding-box rejection of irrelevant holes
4. **Clip** (`core/polygonBoolean.ts`) — intersection of obstacles with user region via `polyclip-ts`
5. **Union holes** — merge overlapping holes (sweep-line + union-find + polyclip union)
6. **Create fill** (`core/booleanOperation.ts`) — assemble complex polygon (outer CW + holes CCW) → `eda.pcb_PrimitiveFill.create()`

### Entry Point (`src/index.ts`)

- `drawDynamicFill()` — exported as `registerFn` in `extension.json`
- Opens IFrame panel (`iframe/index.html`) for user config
- Polling at 300ms via `window.parent.__df_cmd` / `window.parent.__df_status` for IFrame ↔ main communication

### UI (`iframe/index.html`)

Plain HTML/CSS/JS, no framework. Controls: gap (mil), layer (top/bottom silkscreen), 9 obstacle type checkboxes.

### Key Modules

| File | Purpose |
|------|---------|
| `core/obstacleCollector.ts` | Largest file (~31KB). Collects all obstacle geometries from the PCB |
| `core/polygonBoolean.ts` | `polyclip-ts` wrappers for clip/union operations |
| `core/polygonOffset.ts` | Polygon expansion by offset distance |
| `utils/polygonUtils.ts` | Polygon math utilities (~18KB) |
| `utils/constants.ts` | Layer IDs (TOP silkscreen=3, BOTTOM=4), unit conversions |

### Data Types

- `Point` = `{ x: number, y: number }`
- `ObstacleWithRotation` = polygon + rotation angle + `negateBisector` + `extraGap`
- Source arrays use EasyEDA's `TPCB_PolygonSourceArray` format (L/ARC/CARC/R/CIRCLE primitives)

## EasyEDA API

The `eda` global object provides the API. Type definitions come from `@jlceda/pro-api-types`.

Key API namespaces used: `pcb_PrimitiveFill`, `pcb_PrimitiveComponent`, `pcb_PrimitivePad`, `pcb_PrimitiveVia`, `pcb_PrimitiveString`, `pcb_PrimitiveRegion`, `pcb_SelectControl`, `pcb_Event`, `pcb_MathPolygon`, `sys_IFrame`, `sys_Timer`, `sys_Message`, `sys_Dialog`.

## Packaging & Distribution

- `build/packaged.ts` creates `.eext` (ZIP archive, respects `.edaignore`)
- CI (`.github/workflows/build.yml`): Node 22, auto-tags `v{version}`, creates GitHub Release with `.eext`
- Version managed in `extension.json`

## i18n

Locales in `locales/` — `en.json` and `zh-Hans.json`.

## Documentation Files

- `PRD.md` — product requirements
- `IMPLEMENTATION.md` — detailed architecture docs
- `CHANGELOG.md` — version history
