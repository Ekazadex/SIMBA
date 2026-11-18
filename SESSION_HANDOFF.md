# SIMBA session handoff

Prepared on 14 November 2026 for a new Codex session. Treat the repository and current user instructions as the source of truth; check `git status` and inspect the relevant code before making changes.

## Project and current checkout

- Project: SIMBA SCADA / Ciliwung river monitoring dashboard, with ESP32 sensor readings, maps, a hardware graph, and a separate simulation.
- Workspace: `D:\Documents\Semester7\Despro2\Website\SIMBA`.
- At handoff, branch `naufal_revamp_final` was at commit `8b416b6` (`Removed the old graph`); the working tree was clean before this handoff file was created.
- The UI uses React, TypeScript, Vite, and Tailwind; the server uses Express. The user often writes in Indonesian and prefers direct, practical changes with verification.
- Key files: `src/components/SCADADashboard.tsx` for the monitoring overview, `src/components/CiliwungHardwareLiveView.tsx` for the hardware map and graph, and `src/components/CiliwungSimulationPage.tsx` for the simulation.

## Latest completed request

- Removed the expandable “Lihat detail sensor, grafik, dan analisis” section, including its old charts and analysis panels, from `SCADADashboard.tsx`.
- The separate main hardware view above it remains. The removed section's prediction and BMKG Firestore subscriptions and its separate live-weather request were stopped; sensor readings and the overview weather context remain.
- After that change, `npm test` passed 84/84 and `npm run build` passed. No live ESP32 or Firestore testing was performed. The build emitted an existing large-chunk warning.

## Important discrepancy: prior graph work versus this checkout

Earlier in this conversation the user requested and was shown a more developed graph, including selected-point timestamps and a vertical guide, detailed time ticks, export, sensor-distance mode, range controls, and a collapsible location panel. Those features were reported as implemented and tested at the time. **The graph in the current checkout does not contain those features**: its `GraphView` is currently a simpler history chart. The earlier graph modernization planning folder is also absent here. Do not assume the earlier work exists in this branch, silently recreate it, or claim it is currently available. If it becomes relevant, inspect the current branch and history and discuss the discrepancy with the user before choosing how to recover or reimplement it.

Other user preferences from those discussions, when relevant: keep the location panel open by default if a hide option is added; show accurate selected-point time and a vertical guide during interaction; keep the graph readable on mobile; retain graph behavior while improving appearance; distinguish real ESP32 data, estimates, downstream visual presets, and simulations; avoid inventing measurements; and use Indonesian labels such as “Ekspor Data”. The user also wanted no extra raw-batch button or legacy dropdown.

## Environment and verification

- `.gitignore` already ignores `.env` and `.env.*` throughout the repository, while allowing the `.env.example` template. Do not print or commit actual environment file contents. Git ignore does not remove files already tracked.
- Commands: `npm test` for the test suite, `npm run build` for TypeScript and production build, and `npm run verify:ciliwung` for the project's integration contract scripts. Run checks appropriate to the next change.
- Inspect the current state before relying on the commit, test count, or paths above; the user may make changes between sessions.
