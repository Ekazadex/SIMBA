import { NODE_REGISTRY } from './simulation-engine.mjs';

const FORECAST_PORTS = Object.fromEntries(NODE_REGISTRY.map(({ id, controlPort }) => [id, controlPort]));
const FLOOD_THRESHOLDS = Object.fromEntries(NODE_REGISTRY.map(({ id, thresholds }) =>
  [id, Number.isFinite(thresholds.banjir) ? thresholds.banjir : null]));

/** Independent forecast datagram: never uses the current TMA `node_update` command. */
export function sendForecastCupCarbon(socket, command) {
  const port = FORECAST_PORTS[command?.nodeId];
  if (!port || command?.type !== 'forecast_update') throw new RangeError('Unsupported forecast UDP command or station');
  let payload;
  if (command.status === 'unavailable') {
    payload = { type: 'forecast_update', runId: null, nodeId: command.nodeId, status: 'unavailable' };
  } else if (command.status === 'available' && typeof command.runId === 'string' && command.runId &&
             typeof command.issuedAt === 'string' && Number.isFinite(Date.parse(command.issuedAt)) &&
             Object.hasOwn(FLOOD_THRESHOLDS, command.nodeId) &&
             command.thresholdBanjirCm === FLOOD_THRESHOLDS[command.nodeId] &&
             [30, 60].every((minutes) => Number.isFinite(command.predictedTmaCm?.[minutes]) && command.predictedTmaCm[minutes] >= 0 &&
               (command.thresholdBanjirCm === null ? command.crossingWithin?.[minutes] === null
                 : typeof command.crossingWithin?.[minutes] === 'boolean')) &&
             command.quality === 'experimental_synthetic_only') {
    payload = {
      type: 'forecast_update', runId: command.runId, nodeId: command.nodeId,
      issuedAt: command.issuedAt,
      predictedTmaCm: { '30': command.predictedTmaCm['30'], '60': command.predictedTmaCm['60'] },
      crossingWithin: { '30': command.crossingWithin['30'], '60': command.crossingWithin['60'] },
      thresholdBanjirCm: command.thresholdBanjirCm,
      status: 'available', quality: 'experimental_synthetic_only',
    };
  } else {
    throw new RangeError('Unsupported forecast UDP payload');
  }
  socket.send(Buffer.from(JSON.stringify(payload)), port, '127.0.0.1');
}
