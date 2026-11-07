# Task Plan: Live 2D map redesign

## Goal
Replace the reused 3D overview image with an interactive real geographic basemap, live sensor markers, and a clearly labelled illustrative area heat overlay without connecting lines.

## Next Step
Inspect the map in a browser with real and unavailable tiles, then validate physical telemetry when available.

## Current Phase
Phase 4 - Testing & Verification

## Phases

### Phase 1: Requirements & Discovery
- [x] Trace current map image, marker locations, live state, and existing work.
- [x] Establish data and visualization limits.
- **Status:** complete

### Phase 2: Planning & Structure
- [x] Choose a provider-neutral approach and outline delivery and verification.
- [x] Record provider terms and unresolved product decisions in findings.
- **Status:** complete

### Phase 3: Implementation
- [x] Keep existing Leaflet integration; replace static image with configurable road-map tiles and visible attribution. Use OSM standard tiles for a low-traffic prototype subject to its usage policy; configure a suitable provider before production. If a satellite basemap is desired, choose a licensed imagery provider separately.
- [x] Remove the straight station-to-station polyline and image overlay; preserve navigation, zoom, fit-to-stations and responsive sizing.
- [x] Display N1-N5 geographic markers with names, status, TMA, timestamp/freshness and explicit actual-versus-preset labels; N1 is actual only when a real reading exists. Confirm coordinates and note precision.
- [x] Implement a smooth area-style indicative heat overlay around available node values; use explicit demo radius/intensity/gradient, do not interpolate fictitious flood extent or depth, and label legend as indicative/unvalidated. Hide or mark stale and missing readings; expose opacity or toggle. No automatic flood claim from a visual gradient.
- [x] Preserve existing hardware snapshot, SSE updates, stale handling, graph/3D tabs, mode reset and CupCarbon integration. Keep N2-N5 marked derived and avoid modifying telemetry.
- [x] Provide loading/tile-failure and offline messages without falling back to the old image; retain attribution and consider accessibility and mobile layout.
- [x] Update relevant docs and configuration; avoid exposing credentials or hardcoding secrets.
- **Status:** complete

### Phase 4: Testing & Verification
- [ ] Add targeted tests for sensor provenance, stale/missing data, overlay behavior and no old image/corridor references; run project build and relevant tests.
- [ ] Inspect running map with browser at desktop/mobile sizes: real tiles, pan/zoom, markers, map overlay, attribution, state changes, reset and provider failure.
- [ ] Test live ESP32/Firebase when available; otherwise record explicit limitation and use simulated events only for software verification.
- **Status:** in_progress

### Phase 5: Delivery
- [ ] Document provider, online requirement, configuration and visual assumptions; summarize test results and outstanding physical validation.
- **Status:** pending

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| Leaflet and configurable tiles | Existing application already uses Leaflet; avoids provider lock-in and reuse of the 3D image. |
| Indicative heat areas | Existing point readings and presets cannot establish real flood extent; display their limitations clearly. |
| Road map initially | Google Maps-like experience does not require Google tiles; satellite imagery requires a separate provider and terms. |
| Preserve existing working tree | Existing uncommitted changes predate this task. |

## Errors Encountered
| Error | Resolution |
|-------|------------|
| Initial UI contract test expected old attribution text | Updated assertion for linked OpenStreetMap attribution; test passes. |
