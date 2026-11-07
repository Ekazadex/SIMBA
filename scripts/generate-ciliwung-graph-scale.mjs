import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createCiliwungEngine, NODE_REGISTRY, SCENARIO_PROFILES } from '../backend/ciliwung/simulation-engine.mjs';

// Isolated engines provide a display reference without affecting a live run.
export function calculateGraphScaleReference() {
  const maxima = Object.fromEntries(NODE_REGISTRY.map((node) => [node.id, node.baselineTmaCm]));
  for (const scenario of Object.keys(SCENARIO_PROFILES)) {
    const engine = createCiliwungEngine({ autoStart: false });
    let state = engine.start(scenario, 50);
    while (state.status === 'running' && state.simTimeSeconds < 48 * 3600) {
      state = engine.advance(0.5);
      for (const node of state.cupNodes) maxima[node.id] = Math.max(maxima[node.id], node.tmaCm);
    }
    engine.stop();
    if (state.status !== 'completed') throw new Error(`Scenario ${scenario} did not complete`);
  }
  return { source: 'legacy_scenarios', maxTmaCmByNode: maxima };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const output = new URL('../src/components/ciliwung-graph-scale.json', import.meta.url);
  await writeFile(output, `${JSON.stringify(calculateGraphScaleReference(), null, 2)}\n`);
  console.log('Updated Ciliwung graph scale reference.');
}
