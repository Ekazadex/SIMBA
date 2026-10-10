/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { SensorReading } from '../types';

/**
 * Extracts a numeric timestamp (milliseconds) from various Firestore field formats
 * (e.g. number, Timestamp object, ISO date string) checking timestamp, updated_at, or created_at,
 * or the last sample in a batch readings array.
 */
export function extractReadingTimestamp(data: any): number | null {
  if (!data) return null;

  // If the document has a batch readings array from ESP32, the last sample timestamp is the freshest
  if (Array.isArray(data.readings) && data.readings.length > 0) {
    const last = data.readings[data.readings.length - 1];
    if (last && typeof last.timestamp === 'number') {
      return last.timestamp < 10000000000 ? last.timestamp * 1000 : last.timestamp;
    }
  }

  const raw = data.timestamp ?? data.updated_at ?? data.created_at;
  if (raw === undefined || raw === null) return null;

  if (typeof raw === 'number') {
    return raw < 10000000000 ? raw * 1000 : raw;
  }
  if (typeof raw?.toMillis === 'function') {
    return raw.toMillis();
  }
  if (typeof raw?.toDate === 'function') {
    return raw.toDate().getTime();
  }
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    if (!isNaN(parsed)) return parsed;
  }
  return null;
}

/**
 * Normalizes raw Firestore document data into a typed and complete SensorReading.
 * Automatically computes water_level from ultrasonic distance if water_level is not pre-computed,
 * extracts raw distance from batch samples if needed, and ensures consistent physical units.
 */
export function normalizeSensorReading(
  docId: string,
  data: any,
  refHeight: number = 300
): SensorReading {
  const ts = extractReadingTimestamp(data) ?? Date.now();

  // 1. Extract raw ultrasonic distance (cm)
  let distance: number | undefined = undefined;
  if (typeof data.distance === 'number' && !isNaN(data.distance)) {
    distance = data.distance;
  } else if (typeof data.distance_cm === 'number' && !isNaN(data.distance_cm)) {
    distance = data.distance_cm;
  } else if (typeof data.raw_distance === 'number' && !isNaN(data.raw_distance)) {
    distance = data.raw_distance;
  } else if (Array.isArray(data.readings) && data.readings.length > 0) {
    // Extract distance from the latest sample in the batch
    const lastItem = data.readings[data.readings.length - 1];
    if (lastItem && typeof lastItem.distance === 'number' && !isNaN(lastItem.distance)) {
      distance = lastItem.distance;
    }
  } else if (Array.isArray(data.batch_data) && data.batch_data.length > 0) {
    const lastItem = data.batch_data[data.batch_data.length - 1];
    if (lastItem && typeof lastItem === 'object' && typeof (lastItem as any).distance === 'number') {
      distance = (lastItem as any).distance;
    }
  }

  // 2. Extract or compute water level (TMA dari dasar sungai dalam cm)
  let waterLevel: number = 0;
  if (typeof data.water_level === 'number' && !isNaN(data.water_level)) {
    waterLevel = Math.round(data.water_level * 10) / 10;
  } else if (typeof distance === 'number') {
    // Water elevation = Reference Height (Tinggi bibir sungai/sensor) - Jarak pantul sensor ke air
    waterLevel = Math.max(0, Math.round((refHeight - distance) * 10) / 10);
  } else {
    waterLevel = 0;
  }

  const roundedDistance = typeof distance === 'number' ? Math.round(distance * 10) / 10 : undefined;

  // 3. Extract or compute soil moisture (%) from Soil Moisture Sensor (menggantikan FC-37)
  let soilMoisture: number = 42;
  if (typeof data.soil_moisture === 'number' && !isNaN(data.soil_moisture)) {
    soilMoisture = Math.round(data.soil_moisture);
  } else if (typeof data.soil === 'number' && !isNaN(data.soil)) {
    soilMoisture = Math.round(data.soil);
  } else if (typeof data.kelembapan_tanah === 'number' && !isNaN(data.kelembapan_tanah)) {
    soilMoisture = Math.round(data.kelembapan_tanah);
  } else if (typeof data.soil_raw === 'number' && !isNaN(data.soil_raw)) {
    // ADC 0-4095 ESP32 mapping: 4095 is dry, 1500 is wet
    soilMoisture = Math.min(100, Math.max(0, Math.round(((4095 - data.soil_raw) / (4095 - 1500)) * 100)));
  } else if (typeof data.local_rain === 'number') {
    soilMoisture = data.local_rain === 0 ? 38 : data.local_rain === 1 ? 55 : data.local_rain === 2 ? 78 : 94;
  } else {
    // Physically realistic soil moisture based on current water level
    // River embankment soil gets saturated as water level rises
    soilMoisture = Math.min(96, Math.max(30, Math.round(35 + (waterLevel / (refHeight || 300)) * 55)));
  }

  let soilStatus = 'Lembap Normal';
  if (soilMoisture >= 85) soilStatus = 'Jenuh Air (Risiko Luapan)';
  else if (soilMoisture >= 65) soilStatus = 'Basah (Infiltrasi Tinggi)';
  else if (soilMoisture >= 35) soilStatus = 'Lembap Normal';
  else soilStatus = 'Kering';

  // 4. Fallbacks for temperature & humidity (BMKG weather estimation)
  const temperature = typeof data.temperature === 'number' && !isNaN(data.temperature)
    ? Math.round(data.temperature * 10) / 10
    : 28.5;

  const humidity = typeof data.humidity === 'number' && !isNaN(data.humidity)
    ? Math.round(data.humidity * 10) / 10
    : 70;

  const localRain = typeof data.local_rain === 'number' && !isNaN(data.local_rain)
    ? data.local_rain
    : (soilMoisture >= 85 ? 3 : soilMoisture >= 65 ? 2 : soilMoisture >= 50 ? 1 : 0);

  const samplesCount = typeof data.samples_count === 'number'
    ? data.samples_count
    : (Array.isArray(data.readings) ? data.readings.length : (Array.isArray(data.batch_data) ? data.batch_data.length : 0));

  return {
    id: docId,
    timestamp: ts,
    water_level: waterLevel,
    distance: roundedDistance,
    soil_moisture: soilMoisture,
    soil_status: soilStatus,
    temperature,
    humidity,
    local_rain: localRain,
    source: data.source || 'Hardware-ESP32-SoilWake',
    node_id: data.node_id || 'node-kukusan-01',
    readings: data.readings,
    batch_data: data.batch_data,
    samples_count: samplesCount,
    notes: data.notes,
    operator: data.operator
  };
}
