# Gates: Ciliwung multi-simulator scenario integration

OWNS: backend/ciliwung/**, scripts/**, tests/**, src/components/CiliwungSimulationPage.tsx, src/components/CiliwungSimulationPage.test.tsx, src/ciliwungSimulation.ts, src/App.tsx, server.ts, GATES.md, package.json, tsconfig.json

Scope: Add a low-I/O Ciliwung simulation mode that coordinates the SIMBA Website, the five-node 3D view, and nine CupCarbon nodes without changing the existing hardware telemetry mode.

- [x] G1: deterministic nine-node engine resets, advances all nodes, classifies statuses, and auto-completes at the configured target
  CHECK: node --test tests/ciliwung-simulation-engine.test.mjs
  EXPECT: pass 6
  EVIDENCE: exit=0; shell=C:\Windows\system32\cmd.exe; cwd=D:\Documents\Semester7\Despro2\Website\SIMBA; path=f0dd3275de53/82 entries; output=ℹ todo 0 | ℹ duration_ms 109.4159

- [x] G2: scenario API contract exposes start, state, stop, reset, and stream behavior without Firestore writes per tick
  CHECK: node scripts/verify-ciliwung-api-contract.mjs
  EXPECT: Ciliwung API contract verification passed
  EVIDENCE: exit=0; shell=C:\Windows\system32\cmd.exe; cwd=D:\Documents\Semester7\Despro2\Website\SIMBA; path=f0dd3275de53/82 entries; output=Ciliwung API contract verification passed

- [x] G3: frontend simulation page has scenario selection, start/reset/exit controls, View Simulation and View Graph views, and backend stream cleanup
  CHECK: node scripts/verify-ciliwung-frontend-contract.mjs
  EXPECT: Ciliwung frontend contract verification passed
  EVIDENCE: exit=0; shell=C:\Windows\system32\cmd.exe; cwd=D:\Documents\Semester7\Despro2\Website\SIMBA; path=f0dd3275de53/82 entries; output=Ciliwung frontend contract verification passed

- [x] G4: 3D adapter maps backend N1-N5 stage values into the existing renderer contract and leaves local mode available
  CHECK: node --test ../../flood_3d_visual_map/tests/ciliwung-backend-simulation.test.mjs
  EXPECT: pass 4
  EVIDENCE: exit=0; shell=C:\Windows\system32\cmd.exe; cwd=D:\Documents\Semester7\Despro2\Website\SIMBA; path=f0dd3275de53/82 entries; output=ℹ todo 0 | ℹ duration_ms 99.8354

- [x] G5: all nine active CupCarbon scripts contain control-input handling, preserve telemetry output, and pass Python syntax checks
  CHECK: node scripts/verify-cupcarbon-integration.mjs
  EXPECT: CupCarbon integration verification passed
  EVIDENCE: exit=0; shell=C:\Windows\system32\cmd.exe; cwd=D:\Documents\Semester7\Despro2\Website\SIMBA; path=f0dd3275de53/82 entries; output=CupCarbon integration verification passed

- [x] G6: existing project behavior remains intact and the branch contains the complete implementation
  CHECK: node scripts/verify-ciliwung-regression.mjs
  EXPECT: Ciliwung regression verification passed
  EVIDENCE: exit=0; shell=C:\Windows\system32\cmd.exe; cwd=D:\Documents\Semester7\Despro2\Website\SIMBA; path=f0dd3275de53/82 entries; output=Ciliwung regression verification passed

- [x] G7: CupCarbon telemetry parsing, active/stale connection state, UDP listener, and no-echo behavior are covered by tests
  CHECK: node --test tests/ciliwung-api.test.mjs tests/ciliwung-simulation-engine.test.mjs tests/cupcarbon-telemetry.test.mjs
  EXPECT: pass 17
  EVIDENCE: exit=0; output=pass 17

- [x] G8: API, frontend, CupCarbon script, and regression verification include the telemetry listener integration
  CHECK: npm run verify:ciliwung
  EXPECT: Ciliwung regression verification passed
  EVIDENCE: exit=0; output=Ciliwung API contract verification passed | Ciliwung frontend contract verification passed | CupCarbon integration verification passed | Ciliwung regression verification passed

- [x] G9: Website TypeScript and Vite production build remain valid after adding the local telemetry listener and connection status UI
  CHECK: npm run build
  EXPECT: built in
  EVIDENCE: exit=0; output=✓ built in 1.08s; existing large-bundle warning only
