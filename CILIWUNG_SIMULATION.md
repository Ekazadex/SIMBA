# Ciliwung Simulation Integration

## Components

- `server.ts` exposes the Ciliwung simulation API and SSE stream on the SIMBA server.
- `backend/ciliwung/simulation-engine.mjs` is the deterministic nine-node source of truth.
- `src/components/CiliwungSimulationPage.tsx` is the isolated Simulation Mode page.
- `flood_3d_visual_map/src/js/backend-simulation.js` adapts backend N1–N5 state to the Three.js renderer.
- CupCarbon's nine active scripts listen on UDP control ports `5101` through `5109` and continue sending telemetry to UDP port `5005`.

## Local run

1. Install Website dependencies:

   ```bash
   npm install
   ```

2. Start SIMBA from `Website/SIMBA`:

   ```bash
   npm run dev
   ```

   The server listens on `http://127.0.0.1:3000`.

3. Start the 3D static server from `flood_3d_visual_map`:

   ```bash
   python -m http.server 8765
   ```

4. Open CupCarbon manually, open the CupVisual project, and start IoT Simulation when CupCarbon output is needed. The Website and 3D scenario still run if CupCarbon is not active, and the page shows a warning.

5. Open the SIMBA Website. When the hardware dashboard is offline, choose **Masuk Mode Simulasi**, select a scenario, and press **Start Simulation**.

## API

```text
GET  /api/ciliwung-simulation/scenarios
GET  /api/ciliwung-simulation/state
GET  /api/ciliwung-simulation/stream
POST /api/ciliwung-simulation/start   {"scenario":"ringan|sedang|lebat"}
POST /api/ciliwung-simulation/stop
POST /api/ciliwung-simulation/reset
```

The active state is kept in backend memory. The simulation does not write Firestore on every timestep. Firestore is optional for this mode. If `firebase-applet-config.json` or the equivalent `VITE_FIREBASE_*` environment values are absent, the hardware persistence features remain disabled while the Ciliwung simulation API still runs.

## Scenario completion targets

| Scenario | Target | Threshold |
|---|---|---:|
| Hujan Ringan | UP1 Puncak | 70 cm |
| Hujan Sedang | N3 Ciliwung Stage 2 | 180 cm |
| Hujan Lebat | N5 Pintu Air Manggarai | 280 cm |

These are demo profiles. They are deterministic conceptual visualisation parameters, not calibrated flood forecasts.

## Verification

From `Website/SIMBA`:

```bash
npm test
npm run build
npm run verify:ciliwung
```

The verification command checks the API contract, Website integration, CupCarbon script syntax/control markers, backend tests, and the 3D adapter regression test.
