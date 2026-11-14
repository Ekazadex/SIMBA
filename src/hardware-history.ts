import { collection, getDocs, limit, orderBy, query, startAfter, Timestamp, where, type Firestore, type QueryDocumentSnapshot } from 'firebase/firestore';
import { normalizeReading } from './normalize-reading.mjs';
import { sensorDistance } from './hardware-graph.mjs';

// Queries supported timestamp encodings independently: Firestore comparisons are type-sensitive.
// The caller must show the returned coverage warning because unknown formats cannot be discovered by a range query.
export async function loadHardwareHistory24h(db: Firestore, referenceHeight: number) {
  const end = Date.now(), start = end - 24 * 60 * 60_000;
  const ranges = [
    [start, end], [start / 1000, end / 1000],
    [Timestamp.fromMillis(start), Timestamp.fromMillis(end)],
    [new Date(start).toISOString(), new Date(end).toISOString()],
  ];
  const maxPerFormat = 6000;
  const results = await Promise.allSettled(ranges.map(async ([from, to]) => {
    const docs: QueryDocumentSnapshot[] = [];
    let cursor: QueryDocumentSnapshot | undefined;
    let truncated = false;
    while (docs.length < maxPerFormat) {
      const count = Math.min(500, maxPerFormat - docs.length);
      const clauses = [where('timestamp', '>=', from), where('timestamp', '<=', to), orderBy('timestamp', 'desc'), limit(count)];
      const page = await getDocs(query(collection(db, 'sensor_readings'), ...clauses, ...(cursor ? [startAfter(cursor)] : [])));
      docs.push(...page.docs);
      if (page.size < count) break;
      cursor = page.docs[page.docs.length - 1];
      if (docs.length === maxPerFormat) truncated = true;
    }
    return { docs, truncated };
  }));
  const records = new Map<string, { timestamp: number; water_level: number; source: string; distance?: number }>();
  let failed = false, truncated = false;
  for (const result of results) {
    if (result.status === 'rejected') { failed = true; continue; }
    truncated ||= result.value.truncated;
    for (const doc of result.value.docs) {
      const raw = doc.data();
      const ts = raw.timestamp;
      const time = typeof ts === 'number' ? (ts < 10_000_000_000 ? ts * 1000 : ts) : typeof ts?.toMillis === 'function' ? ts.toMillis() : typeof ts === 'string' ? Date.parse(ts) : NaN;
      const normalized = normalizeReading(raw, referenceHeight);
      if (Number.isFinite(time) && time >= start && time <= end && typeof normalized?.water_level === 'number' && Number.isFinite(normalized.water_level) && /^Hardware-ESP32(?:-|$)/i.test(normalized.source ?? '')) {
        const reportedDistance = sensorDistance(normalized, undefined);
        records.set(doc.id, { timestamp: time, water_level: normalized.water_level, source: normalized.source, ...(reportedDistance ? { distance: reportedDistance.value } : {}) });
      }
    }
  }
  return { readings: [...records.values()].sort((a, b) => a.timestamp - b.timestamp), failed, truncated, start, end };
}
