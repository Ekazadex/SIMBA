/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface SensorReading {
  id?: string;
  timestamp: number; // epoch milliseconds
  water_level: number; // in cm (Tinggi Muka Air dari dasar sungai)
  local_rain: number; // 0: None, 1: Light, 2: Medium, 3: Heavy
  temperature: number; // in Celsius
  humidity: number; // in %
  node_id: string;
  distance?: number; // raw ultrasonic distance in cm (jarak sensor ke air)
  source?: 'Hardware-ESP32' | 'Hardware-ESP32-Batch' | 'Simulator-Engine' | 'Manual-Peil-Schaal' | string;
  samples_count?: number; // count of raw ultrasonic samples in batch
  notes?: string; // Catatan lapangan khusus (misal jika sensor error atau observasi visual)
  operator?: string; // Nama petugas penginput data manual
}

export interface PredictionResult {
  id?: string;
  timestamp: number;
  prediction_30m: number;
  prediction_1h: number;
  prediction_3h: number;
  prediction_6h: number;
  confidence_score: number;
  status: 'Normal' | 'Siaga' | 'Bahaya';
  reasoning?: string;
  groundingUrls?: Array<{ uri: string; title: string }>;
  node_id: string;
}

export interface BMKGForecast {
  id?: string;
  timestamp: number;
  curah_hujan: number; // mm/hour
  cuaca: string; // Sunny, Cloudy, Rainy, Storm
  suhu: number; // °C
  kelembapan: number; // %
  node_id: string;
}

export interface SystemConfig {
  node_id: string;
  threshold_siaga: number; // in cm
  threshold_bahaya: number; // in cm
  status_alat: 'Online' | 'Offline' | 'Calibrating';
  auto_simulation: boolean;
  simulation_mode: 'dry' | 'light_rain' | 'storm' | 'flood';
  sampling_rate_seconds: number;
  reference_height: number; // distance probe to zero (cm)
}

export interface SystemLog {
  id: string;
  timestamp: number;
  source: 'Sensor' | 'Server' | 'LSTM' | 'System';
  level: 'info' | 'warn' | 'error';
  message: string;
}
