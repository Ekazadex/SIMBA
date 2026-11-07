# Findings & Decisions

## Requirements
- Replace 2D reuse of the 3D viewer map with an actual interactive map resembling Google Maps, retaining sensor indicators and replacing connecting lines with an area heat visualization.
- User requested planning; aerial may refer to an area overlay or aerial imagery, so default to a road basemap plus an area overlay and confirm if satellite imagery is desired.

## Research Findings
- `src/components/CiliwungHardwareLiveView.tsx` loads `/assets/map/area_overview.png` and connects node coordinates with Leaflet polylines. The image is byte-identical to the 3D viewer overview map; its overlay bounds match the 3D metadata.
- Live data model distinguishes `actual_sensor`, `derived_preset`, `reset`, freshness and run IDs. Existing circles are indicative; one point reading is insufficient to determine geographic inundation, water depth, flow, or a safe boundary.
- Week 10 report states ESP32/Firebase end-to-end validation was pending; confirm current availability before asserting live validation.
- Google Maps JavaScript API production setup requires a key and billing; charges depend on usage: https://developers.google.com/maps/documentation/javascript/usage-and-billing . Google also describes a limited prototyping demo key: https://developers.google.com/maps/documentation/javascript/get-api-key .
- OpenStreetMap standard tile usage requires visible attribution and compliance with its policy: https://operations.osmfoundation.org/policies/tiles/ . Review availability and policy for intended production traffic; do not bulk download or presume an offline cache.
- Current SIMBA working tree contains substantial pre-existing modifications and untracked implementation files; preserve them.

## Technical Decisions
| Decision | Rationale |
|----------|-----------|
| Configurable Leaflet tile provider | Supports a real road basemap with zoom and pan, without requiring Google billing for a prototype. |
| Indicative heat visualization | Do not represent a synthetic radial heat layer as actual flood boundaries. |
| No old overview fallback | A provider outage should be clear rather than silently reintroducing the unwanted map. |

## Issues Encountered
| Issue | Resolution |
|-------|------------|
| Basemap preference and imagery uncertain | Road map assumed for planning; imagery can be chosen separately. |

## Resources
- `CILIWUNG_HANDOFF.md` and `src/components/CiliwungHardwareLiveView.tsx`.
