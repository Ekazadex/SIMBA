// The original conceptual rainfall cascade has only N1–N5. The four upstream
// markers are geographical stations, not invented upstream catchment physics.
export function standaloneStageRises(readingNodes, stationIds) {
  const byId = new Map(readingNodes.map((node) => [node.id, node.stageRiseM]));
  return stationIds.map((id) => {
    const value = byId.get(id);
    return id.startsWith('UP') ? 0 : Number.isFinite(value) ? Math.max(0, value) : 0;
  });
}
