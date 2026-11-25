# DOKUMENTASI LENGKAP PROYEK PREDIKSI ELEVASI AIR & BANJIR (JSN-SR04T + BMKG/OPEN-METEO)
**Kelompok 12 - Capstone Project DTE FTUI 2026**

Dokumen ini merupakan penggabungan komprehensif dan utuh tanpa ada yang dihilangkan dari seluruh artefak proyek Machine Learning (LSTM) untuk prediksi ketinggian air sungai, peringatan dini banjir, serta spesifikasi integrasi Web SCADA & Simulasi 3D:

1. **`dataset_fusi_jsn_bmkg_2021_2026.csv`** (Dataset Historis Cuaca & Simulasi Sensor Fisik JSN-SR04T)
2. **`scaler.pkl` / `konfigurasi_scaler.json`** (Objek *MinMaxScaler* Scikit-Learn beserta nilai parameter matematis yang telah didekode secara presisi)
3. **`model_lstm_banjir.h5` / `arsitektur_model.txt`** (Konfigurasi Arsitektur, *Hyperparameter*, *Optimizer*, dan Struktur Bobot Model Keras LSTM)
4. **`Untitled0.ipynb`** (Seluruh Kode Sumber Python Google Colab beserta Log Eksekusi Lengkap dari Sel 1 dan Sel 2)
5. **Spesifikasi Teknis Integrasi Backend-Frontend & Transkripsi Diskusi Internal Kelompok (WhatsApp)** (Aturan *Inference/Looping Testing*, *Manual Normscale/Inverse Scale*, *Circular Buffer Window 24*, *WebSockets/SSE*, dan Transkrip Lengkap 4 Tangkapan Layar Grup WhatsApp)

---

## BAGIAN 1: FILE `dataset_fusi_jsn_bmkg_2021_2026.csv`

### 1.1. Spesifikasi & Metadata Dataset

* **Nama File:** `dataset_fusi_jsn_bmkg_2021_2026.csv`
* **Lokasi Penyimpanan Drive:** `/content/drive/My Drive/dataset_fusi_jsn_bmkg_2021_2026.csv`
* **Sumber Data Cuaca:** Open-Meteo Archive API (`https://archive-api.open-meteo.com/v1/archive`)
* **Koordinat Lokasi:** Latitude `-6.365`, Longitude `106.820` (Zona Waktu: `Asia/Jakarta`)
* **Rentang Waktu:** `2021-01-01T00:00` hingga `2026-05-01T23:00` (Data per jam / *hourly*)
* **Total Baris Data:** `46.728` baris (`n_samples = 46728`)
* **Total Kolom:** `6` kolom

### 1.2. Struktur Kolom & Skema Data

| Nama Kolom | Tipe Data | Deskripsi & Satuan |
| :--- | :--- | :--- |
| `Waktu` | `string` / `datetime` | Stempel waktu observasi per jam dalam format ISO (`YYYY-MM-DDTHH:MM`). |
| `Suhu (°C)` | `float64` | Suhu udara pada ketinggian 2 meter (`temperature_2m`) dalam derajat Celcius. |
| `Kelembapan (%)` | `int64` / `float64` | Kelembapan relatif udara pada ketinggian 2 meter (`relative_humidity_2m`) dalam persen. |
| `Curah Hujan (mm)` | `float64` | Total presipitasi/curah hujan per jam (`precipitation`) dalam milimeter. |
| `GHI (W/m²)` | `float64` | Radiasi gelombang pendek matahari / *Global Horizontal Irradiance* (`shortwave_radiation`) dalam $\text{W/m}^2$. |
| `Elevasi Air JSN-SR04T (cm)` | `float64` | **Target Prediksi Utama:** Ketinggian muka air sungai hasil pembacaan/simulasi sensor ultrasonik JSN-SR04T dalam sentimeter (rentang klip: $100.0\text{ cm}$ hingga $420.0\text{ cm}$). |

### 1.3. Rumus Pembangkitan Data Sensor Fisik JSN-SR04T

Data kolom `Elevasi Air JSN-SR04T (cm)` dibangkitkan secara deterministik menggunakan `np.random.seed(42)` dengan parameter fisik berikut:

* **Baseline Normal (`current_level` awal):** $150.0\text{ cm}$
* **Inflow (Aliran Masuk per Jam):**
  $$\text{inflow}_i = (\text{rain}_i \times 6.5) + \mathcal{N}(0, 0.4)$$
* **Recession (Surut Air per Jam):**
  $$\text{recession}_i = \begin{cases} (\text{current\_level}_{i-1} - 140.0) \times 0.06 & \text{jika } \text{current\_level}_{i-1} > 140.0 \\ 0.0 & \text{lainnya} \end{cases}$$
* **Pembaruan Elevasi Air:**
  $$\text{current\_level}_i = \text{clip}\left(\text{current\_level}_{i-1} + \text{inflow}_i - \text{recession}_i + \mathcal{N}(0, 0.15),\; 100.0,\; 420.0\right)$$
* **Pembulatan:** Dibulatkan hingga 2 angka di belakang koma (`round(current_level, 2)`).

### 1.4. Sampel Data Awal (`df.head()`) & Statistik Nilai Ekstrem

```csv
Waktu,Suhu (°C),Kelembapan (%),Curah Hujan (mm),GHI (W/m²),Elevasi Air JSN-SR04T (cm)
2021-01-01T00:00,24.0,93,0.1,0.0,150.23
2021-01-01T01:00,23.8,94,0.1,0.0,150.75
2021-01-01T02:00,23.5,96,0.6,0.0,153.88
2021-01-01T03:00,23.2,97,1.3,0.0,162.24
2021-01-01T04:00,23.2,96,0.9,0.0,166.65
```

**Statistik 5 Baris Pertama (Metadata Tabel):**

* `Suhu (°C)`: min = `23.2`, max = `24.0`, std = `0.3577708763999668`
* `Kelembapan (%)`: min = `93`, max = `97`, std = `1.0`
* `Curah Hujan (mm)`: min = `0.1`, max = `1.3`, std = `0.5196152422706632`
* `GHI (W/m²)`: min = `0.0`, max = `0.0`, std = `0.0`
* `Elevasi Air JSN-SR04T (cm)` (5 baris pertama): min = `150.23`, max = `166.65`, std = `7.329689625079639`

**Statistik Keseluruhan Kolom Target (`Elevasi Air JSN-SR04T (cm)` pada 46.728 Baris):**

* **Nilai Minimum Aktual (`data_min_`):** $130.56\text{ cm}$
* **Nilai Maksimum Aktual (`data_max_`):** $420.00\text{ cm}$
* **Rentang Data (`data_range_`):** $289.44\text{ cm}$
* **Threshold Siaga:** $250.0\text{ cm}$
* **Threshold Bahaya:** $300.0\text{ cm}$

---

## BAGIAN 2: FILE `scaler.pkl` / `konfigurasi_scaler.json` (Objek MinMaxScaler Scikit-Learn)

File biner *pickle* `scaler.pkl` (ukuran `0,5 kB`) menyimpan objek `MinMaxScaler` yang telah dilatih (`fit_transform`) pada kolom `Elevasi Air JSN-SR04T (cm)`. Berikut adalah hasil dekode biner IEEE-754 *floating-point* 64-bit (`<f8`) secara eksak dari isi file `scaler.pkl`:

### 2.1. Parameter & Atribut Internal `scaler.pkl`

* **Class:** `sklearn.preprocessing._data.MinMaxScaler`
* **Versi Scikit-Learn (`_sklearn_version`):** `1.6.1`
* **`feature_range`:** `(0, 1)`
* **`copy`:** `True`
* **`clip`:** `False`
* **`n_features_in_`:** `1`
* **`n_samples_seen_`:** `46728`
* **`data_min_`:** `array([130.56], dtype=float64)` *(Hex: `0x406051eb851eb852`)*
* **`data_max_`:** `array([420.0], dtype=float64)` *(Hex: `0x407a400000000000`)*
* **`data_range_`:** `array([289.44], dtype=float64)` *(Hex: `0x4072170a3d70a3d7`)*
* **`scale_`:** `array([0.003454947484798231], dtype=float64)` *(Hex: `0x3f6c346f6ccdfa01`)*
* **`min_`:** `array([-0.45107794361525704], dtype=float64)` *(Hex: `0xbfdc8c9ab5f4389f`)*

### 2.2. Representasi `konfigurasi_scaler.json`

```json
{
  "scaler_type": "MinMaxScaler",
  "sklearn_version": "1.6.1",
  "feature_range": [0, 1],
  "n_features_in_": 1,
  "n_samples_seen_": 46728,
  "data_min_": 130.56,
  "data_max_": 420.0,
  "data_range_": 289.44,
  "scale_": 0.003454947484798231,
  "min_": -0.45107794361525704
}
```

### 2.3. Kode Rekonstruksi Eksak `scaler.pkl` (Python)

```python
import numpy as np
from sklearn.preprocessing import MinMaxScaler

scaler = MinMaxScaler(feature_range=(0, 1), copy=True, clip=False)
scaler.n_features_in_ = 1
scaler.n_samples_seen_ = 46728
scaler.data_min_ = np.array([130.56], dtype=np.float64)
scaler.data_max_ = np.array([420.0], dtype=np.float64)
scaler.data_range_ = np.array([289.44], dtype=np.float64)
scaler.scale_ = np.array([0.003454947484798231], dtype=np.float64)
scaler.min_ = np.array([-0.45107794361525704], dtype=np.float64)
```

---

## BAGIAN 3: FILE `model_lstm_banjir.h5` / `arsitektur_model.txt` (Model Keras HDF5)

File `model_lstm_banjir.h5` (ukuran `401 kB`) menyimpan arsitektur model, konfigurasi pelatihan, bobot *layer* (`model_weights`), dan status *optimizer* (`optimizer_weights`) dalam format HDF5.

### 3.1. Metadata Lingkungan Model

* **Format File:** HDF5 (Legacy `.h5` Keras Format)
* **Backend:** `tensorflow`
* **Keras Version:** `3.13.2`
* **Nama Model:** `sequential_5`
* **Input Shape (`batch_shape`):** `[null, 24, 1]` (Sekuen 24 jam ke belakang, 1 fitur elevasi air)
* **Total Parameter:** `29.857` parameter (`116.63 KB`, seluruhnya *trainable*)

### 3.2. Konfigurasi Arsitektur Model Eksak (`model_config` JSON / `arsitektur_model.txt`)

Berikut adalah konfigurasi JSON utuh yang diekstrak langsung dari header HDF5 `model_lstm_banjir.h5`:

```json
{
  "class_name": "Sequential",
  "config": {
    "name": "sequential_5",
    "trainable": true,
    "dtype": {
      "module": "keras",
      "class_name": "DTypePolicy",
      "config": {
        "name": "float32"
      },
      "registered_name": null
    },
    "layers": [
      {
        "class_name": "InputLayer",
        "config": {
          "batch_shape": [null, 24, 1],
          "dtype": "float32",
          "sparse": false,
          "ragged": false,
          "name": "input_layer_5",
          "optional": false
        }
      },
      {
        "class_name": "LSTM",
        "config": {
          "name": "lstm_10",
          "trainable": true,
          "dtype": {
            "module": "keras",
            "class_name": "DTypePolicy",
            "config": {
              "name": "float32"
            },
            "registered_name": null
          },
          "return_sequences": true,
          "return_state": false,
          "go_backwards": false,
          "stateful": false,
          "unroll": false,
          "zero_output_for_mask": false,
          "units": 64,
          "activation": "tanh",
          "recurrent_activation": "sigmoid",
          "use_bias": true,
          "kernel_initializer": {
            "module": "keras.initializers",
            "class_name": "GlorotUniform",
            "config": {
              "seed": null
            },
            "registered_name": null
          },
          "recurrent_initializer": {
            "module": "keras.initializers",
            "class_name": "Orthogonal",
            "config": {
              "seed": null,
              "gain": 1.0
            },
            "registered_name": null
          },
          "bias_initializer": {
            "module": "keras.initializers",
            "class_name": "Zeros",
            "config": {},
            "registered_name": null
          },
          "unit_forget_bias": true,
          "kernel_regularizer": null,
          "recurrent_regularizer": null,
          "bias_regularizer": null,
          "activity_regularizer": null,
          "kernel_constraint": null,
          "recurrent_constraint": null,
          "bias_constraint": null,
          "dropout": 0.0,
          "recurrent_dropout": 0.0,
          "seed": null
        }
      },
      {
        "class_name": "Dropout",
        "config": {
          "name": "dropout_10",
          "trainable": true,
          "dtype": {
            "module": "keras",
            "class_name": "DTypePolicy",
            "config": {
              "name": "float32"
            },
            "registered_name": null
          },
          "rate": 0.2,
          "seed": null,
          "noise_shape": null
        }
      },
      {
        "class_name": "LSTM",
        "config": {
          "name": "lstm_11",
          "trainable": true,
          "dtype": {
            "module": "keras",
            "class_name": "DTypePolicy",
            "config": {
              "name": "float32"
            },
            "registered_name": null
          },
          "return_sequences": false,
          "return_state": false,
          "go_backwards": false,
          "stateful": false,
          "unroll": false,
          "zero_output_for_mask": false,
          "units": 32,
          "activation": "tanh",
          "recurrent_activation": "sigmoid",
          "use_bias": true,
          "kernel_initializer": {
            "module": "keras.initializers",
            "class_name": "GlorotUniform",
            "config": {
              "seed": null
            },
            "registered_name": null
          },
          "recurrent_initializer": {
            "module": "keras.initializers",
            "class_name": "Orthogonal",
            "config": {
              "seed": null,
              "gain": 1.0
            },
            "registered_name": null
          },
          "bias_initializer": {
            "module": "keras.initializers",
            "class_name": "Zeros",
            "config": {},
            "registered_name": null
          },
          "unit_forget_bias": true,
          "kernel_regularizer": null,
          "recurrent_regularizer": null,
          "bias_regularizer": null,
          "activity_regularizer": null,
          "kernel_constraint": null,
          "recurrent_constraint": null,
          "bias_constraint": null,
          "dropout": 0.0,
          "recurrent_dropout": 0.0,
          "seed": null
        }
      },
      {
        "class_name": "Dropout",
        "config": {
          "name": "dropout_11",
          "trainable": true,
          "dtype": {
            "module": "keras",
            "class_name": "DTypePolicy",
            "config": {
              "name": "float32"
            },
            "registered_name": null
          },
          "rate": 0.2,
          "seed": null,
          "noise_shape": null
        }
      },
      {
        "class_name": "Dense",
        "config": {
          "name": "dense_10",
          "trainable": true,
          "dtype": {
            "module": "keras",
            "class_name": "DTypePolicy",
            "config": {
              "name": "float32"
            },
            "registered_name": null
          },
          "units": 16,
          "activation": "linear",
          "use_bias": true,
          "kernel_initializer": {
            "module": "keras.initializers",
            "class_name": "GlorotUniform",
            "config": {
              "seed": null
            },
            "registered_name": null
          },
          "bias_initializer": {
            "module": "keras.initializers",
            "class_name": "Zeros",
            "config": {},
            "registered_name": null
          },
          "kernel_regularizer": null,
          "bias_regularizer": null,
          "kernel_constraint": null,
          "bias_constraint": null,
          "quantization_config": null
        }
      },
      {
        "class_name": "Dense",
        "config": {
          "name": "dense_11",
          "trainable": true,
          "dtype": {
            "module": "keras",
            "class_name": "DTypePolicy",
            "config": {
              "name": "float32"
            },
            "registered_name": null
          },
          "units": 1,
          "activation": "linear",
          "use_bias": true,
          "kernel_initializer": {
            "module": "keras.initializers",
            "class_name": "GlorotUniform",
            "config": {
              "seed": null
            },
            "registered_name": null
          },
          "bias_initializer": {
            "module": "keras.initializers",
            "class_name": "Zeros",
            "config": {},
            "registered_name": null
          },
          "kernel_regularizer": null,
          "bias_regularizer": null,
          "kernel_constraint": null,
          "bias_constraint": null,
          "quantization_config": null
        }
      }
    ],
    "build_input_shape": [null, 24, 1]
  }
}
```

### 3.3. Konfigurasi Pelatihan Eksak (`training_config` JSON)

```json
{
  "loss": "mean_squared_error",
  "loss_weights": null,
  "metrics": null,
  "weighted_metrics": null,
  "run_eagerly": false,
  "steps_per_execution": 1,
  "jit_compile": false,
  "optimizer_config": {
    "class_name": "Adam",
    "config": {
      "name": "adam",
      "learning_rate": 0.0010000000474974513,
      "weight_decay": null,
      "clipnorm": null,
      "global_clipnorm": null,
      "clipvalue": null,
      "use_ema": false,
      "ema_momentum": 0.99,
      "ema_overwrite_frequency": null,
      "loss_scale_factor": null,
      "gradient_accumulation_steps": null,
      "beta_1": 0.9,
      "beta_2": 0.999,
      "epsilon": 1e-07,
      "amsgrad": false
    }
  }
}
```

### 3.4. Struktur Grup Tensor Bobot (`model_weights` & `optimizer_weights`) di HDF5

**Daftar Tensor `model_weights`:**

* `sequential_5/lstm_10/lstm_cell/kernel` (Shape: `[1, 256]`)
* `sequential_5/lstm_10/lstm_cell/recurrent_kernel` (Shape: `[64, 256]`)
* `sequential_5/lstm_10/lstm_cell/bias` (Shape: `[256]`) -> Total `lstm_10` = `16.896` params
* `sequential_5/lstm_11/lstm_cell/kernel` (Shape: `[64, 128]`)
* `sequential_5/lstm_11/lstm_cell/recurrent_kernel` (Shape: `[32, 128]`)
* `sequential_5/lstm_11/lstm_cell/bias` (Shape: `[128]`) -> Total `lstm_11` = `12.416` params
* `sequential_5/dense_10/kernel` (Shape: `[32, 16]`)
* `sequential_5/dense_10/bias` (Shape: `[16]`) -> Total `dense_10` = `528` params
* `sequential_5/dense_11/kernel` (Shape: `[16, 1]`)
* `sequential_5/dense_11/bias` (Shape: `[1]`) -> Total `dense_11` = `17` params

**Daftar Tensor `optimizer_weights` (Adam):**

* `adam/iteration`
* `adam/learning_rate`
* `adam/sequential_5_lstm_10_lstm_cell_kernel_momentum` & `velocity`
* `adam/sequential_5_lstm_10_lstm_cell_recurrent_kernel_momentum` & `velocity`
* `adam/sequential_5_lstm_10_lstm_cell_bias_momentum` & `velocity`
* `adam/sequential_5_lstm_11_lstm_cell_kernel_momentum` & `velocity`
* `adam/sequential_5_lstm_11_lstm_cell_recurrent_kernel_momentum` & `velocity`
* `adam/sequential_5_lstm_11_lstm_cell_bias_momentum` & `velocity`
* `adam/sequential_5_dense_10_kernel_momentum` & `velocity`
* `adam/sequential_5_dense_10_bias_momentum` & `velocity`
* `adam/sequential_5_dense_11_kernel_momentum` & `velocity`
* `adam/sequential_5_dense_11_bias_momentum` & `velocity`

---

## BAGIAN 4: FILE `Untitled0.ipynb` (Kode & Log Eksekusi Lengkap)

Notebook ini terdiri dari 2 sel kode utama yang dieksekusi di Google Colaboratory (`https://colab.research.google.com/drive/1Zp6dbHcFNwXuhU7J4lZVi6Os2VHUczF_#scrollTo=lvOFwHOOzGEy`, Python 3, oleh `ayares mikhail`):

* **Sel 1 (`id: lvOFwHOOzGEy`, `execution_count: 9`)**: Penarikan data Open-Meteo, simulasi sensor JSN-SR04T, penyimpanan CSV ke Google Drive, dan pelatihan model `sequential_4`.
* **Sel 2 (`id: 3Od5YUStKyHx`, `execution_count: 10`)**: Versi produksi lengkap yang turut menyimpan objek `scaler.pkl` dan model `model_lstm_banjir.h5` (`sequential_5`) ke Google Drive untuk integrasi Web SCADA.

### 4.1. SEL 1 (`execution_count: 9`)

#### Kode Python Sel 1:

```python
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import requests
from datetime import datetime
from google.colab import drive, files
from sklearn.preprocessing import MinMaxScaler
from tensorflow.keras.models import Sequential
from tensorflow.keras.layers import LSTM, Dense, Dropout

# ==========================================
# 1. MOUNT GOOGLE DRIVE
# ==========================================
print("Menghubungkan ke Google Drive...")
drive.mount('/content/drive')

# Tentukan jalur penyimpanan di Google Drive Anda (Pastikan folder 'My Drive' ada)
# File akan disimpan dengan nama 'dataset_fusi_jsn_bmkg_2021_2026.csv'
drive_path = '/content/drive/My Drive/dataset_fusi_jsn_bmkg_2021_2026.csv'

# ==========================================
# 2. TARIK SELURUH DATA HISTORIS (2021 - 2026) DARI OPEN-METEO API
# ==========================================
lat = "-6.365"
lon = "106.820"
start_date = "2021-01-01"
end_date = "2026-05-01" # Rentang waktu penuh sesuai permintaan

url = f"https://archive-api.open-meteo.com/v1/archive?latitude={lat}&longitude={lon}&start_date={start_date}&end_date={end_date}&hourly=temperature_2m,relative_humidity_2m,precipitation,shortwave_radiation&timezone=Asia%2FJakarta"

print(f"\nSedang menarik seluruh data historis dari {start_date} sampai {end_date}...")
response = requests.get(url, timeout=60)
response.raise_for_status()
data = response.json().get("hourly", {})

# Konversi ke Pandas DataFrame
df = pd.DataFrame({
    "Waktu": data.get("time", []),
    "Suhu (°C)": data.get("temperature_2m", []),
    "Kelembapan (%)": data.get("relative_humidity_2m", []),
    "Curah Hujan (mm)": data.get("precipitation", []),
    "GHI (W/m²)": data.get("shortwave_radiation", [])
})

# ==========================================
# 3. GENERATE SENSOR FISIK JSN-SR04T (ELEVASI AIR)
# ==========================================
np.random.seed(42)
n = len(df)
rain = df['Curah Hujan (mm)'].values
elevation = np.zeros(n)
current_level = 150.0 # Baseline normal elevasi air sungai (cm)

for i in range(n):
    inflow = rain[i] * 6.5 + np.random.normal(0, 0.4)
    recession = (current_level - 140.0) * 0.06 if current_level > 140.0 else 0.0
    current_level = current_level + inflow - recession + np.random.normal(0, 0.15)
    current_level = np.clip(current_level, 100.0, 420.0) # Sesuai jangkauan JSN-SR04T
    elevation[i] = round(current_level, 2)

df['Elevasi Air JSN-SR04T (cm)'] = elevation

# ==========================================
# 4. SIMPAN KE GOOGLE DRIVE
# ==========================================
df.to_csv(drive_path, index=False)
print(f"\n[SUKSES] Total {len(df):,} baris data berhasil disimpan ke Google Drive Anda di:\n-> {drive_path}")
display(df.head())

# ==========================================
# 5. PREPROCESSING & FEATURE SELECTION UNTUK LSTM
# ==========================================
df['Waktu'] = pd.to_datetime(df['Waktu'])
df.set_index('Waktu', inplace=True)

# Target prediksi utama: Elevasi Air Sungai (JSN-SR04T)
target_column = 'Elevasi Air JSN-SR04T (cm)'
df = df.interpolate(method='linear').bfill().ffill()

data = df[[target_column]].values

# Normalisasi Min-Max Scaler ke rentang [0, 1]
scaler = MinMaxScaler(feature_range=(0, 1))
scaled_data = scaler.fit_transform(data)

# ==========================================
# 6. MEMBUAT SLIDING WINDOW (SEKUEN 24 JAM)
# ==========================================
def create_sequences(dataset, time_step=24):
    X, y = [], []
    for i in range(len(dataset) - time_step - 1):
        X.append(dataset[i:(i + time_step), 0])
        y.append(dataset[i + time_step, 0])
    return np.array(X), np.array(y)

time_step = 24
X, y = create_sequences(scaled_data, time_step)
X = X.reshape(X.shape[0], X.shape[1], 1)

# ==========================================
# 7. PEMBAGIAN DATA: TRAIN (70%), VAL (15%), TEST (15%)
# ==========================================
total_len = len(X)
train_end = int(total_len * 0.70)
val_end = int(total_len * 0.85)

X_train, y_train = X[:train_end], y[:train_end]
X_val, y_val = X[train_end:val_end], y[train_end:val_end]
X_test, y_test = X[val_end:], y[val_end:]

print(f"\nDistribusi Dataset Training & Testing:")
print(f"- Training (70%)   : {X_train.shape[0]} sekuen")
print(f"- Validation (15%) : {X_val.shape[0]} sekuen")
print(f"- Testing (15%)    : {X_test.shape[0]} sekuen")

# ==========================================
# 8. ARSITEKTUR MODEL LSTM
# ==========================================
model = Sequential([
    LSTM(64, return_sequences=True, input_shape=(time_step, 1)),
    Dropout(0.2),
    LSTM(32, return_sequences=False),
    Dropout(0.2),
    Dense(16),
    Dense(1)
])

model.compile(optimizer='adam', loss='mean_squared_error')
model.summary()

# ==========================================
# 9. TRAINING MODEL LSTM
# ==========================================
history = model.fit(
    X_train, y_train,
    epochs=15,
    batch_size=64,
    validation_data=(X_val, y_val),
    verbose=1
)

# ==========================================
# 10. VISUALISASI HASIL & EVALUASI
# ==========================================
plt.figure(figsize=(12, 4))
plt.plot(history.history['loss'], label='Training Loss')
plt.plot(history.history['val_loss'], label='Validation Loss')
plt.title('Grafik Loss Model LSTM - Prediksi Elevasi Air')
plt.xlabel('Epoch')
plt.ylabel('Loss (MSE)')
plt.legend()
plt.show()

# Prediksi pada Data Test
test_predict = model.predict(X_test)
test_predict_inv = scaler.inverse_transform(test_predict)
y_test_inv = scaler.inverse_transform(y_test.reshape(-1, 1))

plt.figure(figsize=(14, 6))
plt.plot(y_test_inv[-300:], label='Elevasi Aktual JSN-SR04T (cm)', color='blue')
plt.plot(test_predict_inv[-300:], label='Prediksi LSTM (cm)', color='red', linestyle='--')
plt.axhline(y=250, color='orange', linestyle=':', label='Threshold Siaga')
plt.axhline(y=300, color='purple', linestyle=':', label='Threshold Bahaya')
plt.title('Perbandingan Elevasi Aktual vs Prediksi LSTM pada Data Testing')
plt.xlabel('Waktu (Jam)')
plt.ylabel('Ketinggian Air (cm)')
plt.legend()
plt.show()

print("\n[SUKSES] Seluruh rangkaian proses penarikan data, penyimpanan ke Drive, dan pelatihan LSTM selesai!")
```

#### Log Output Eksekusi Sel 1:

```text
Menghubungkan ke Google Drive...
Mounted at /content/drive

Sedang menarik seluruh data historis dari 2021-01-01 sampai 2026-05-01...

[SUKSES] Total 46,728 baris data berhasil disimpan ke Google Drive Anda di:
-> /content/drive/My Drive/dataset_fusi_jsn_bmkg_2021_2026.csv

              Waktu  Suhu (°C)  Kelembapan (%)  Curah Hujan (mm)  GHI (W/m²)  Elevasi Air JSN-SR04T (cm)
0  2021-01-01T00:00       24.0              93               0.1         0.0                      150.23
1  2021-01-01T01:00       23.8              94               0.1         0.0                      150.75
2  2021-01-01T02:00       23.5              96               0.6         0.0                      153.88
3  2021-01-01T03:00       23.2              97               1.3         0.0                      162.24
4  2021-01-01T04:00       23.2              96               0.9         0.0                      166.65

Distribusi Dataset Training & Testing:
- Training (70%)   : 32692 sekuen
- Validation (15%) : 7005 sekuen
- Testing (15%)    : 7006 sekuen

/usr/local/lib/python3.13/dist-packages/keras/src/layers/rnn/rnn.py:199: UserWarning: Do not pass an `input_shape`/`input_dim` argument to a layer. When using Sequential models, prefer using an `Input(shape)` object as the first layer in the model instead.
  super().__init__(**kwargs)

Model: "sequential_4"
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┳━━━━━━━━━━━━━━━━━━━━━━━━┳━━━━━━━━━━━━━━━┓
┃ Layer (type)                    ┃ Output Shape           ┃       Param # ┃
┡━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╇━━━━━━━━━━━━━━━━━━━━━━━━╇━━━━━━━━━━━━━━━┩
│ lstm_8 (LSTM)                   │ (None, 24, 64)         │        16,896 │
├─────────────────────────────────┼────────────────────────┼───────────────┤
│ dropout_8 (Dropout)             │ (None, 24, 64)         │             0 │
├─────────────────────────────────┼────────────────────────┼───────────────┤
│ lstm_9 (LSTM)                   │ (None, 32)             │        12,416 │
├─────────────────────────────────┼────────────────────────┼───────────────┤
│ dropout_9 (Dropout)             │ (None, 32)             │             0 │
├─────────────────────────────────┼────────────────────────┼───────────────┤
│ dense_8 (Dense)                 │ (None, 16)             │           528 │
├─────────────────────────────────┼────────────────────────┼───────────────┤
│ dense_9 (Dense)                 │ (None, 1)              │            17 │
└─────────────────────────────────┴────────────────────────┴───────────────┘
 Total params: 29,857 (116.63 KB)
 Trainable params: 29,857 (116.63 KB)
 Non-trainable params: 0 (0.00 B)

Epoch 1/15
511/511 ━━━━━━━━━━━━━━━━━━━━ 24s 40ms/step - loss: 0.0030 - val_loss: 0.0017
Epoch 2/15
511/511 ━━━━━━━━━━━━━━━━━━━━ 19s 37ms/step - loss: 0.0011 - val_loss: 0.0011
Epoch 3/15
511/511 ━━━━━━━━━━━━━━━━━━━━ 21s 38ms/step - loss: 8.6294e-04 - val_loss: 9.8487e-04
Epoch 4/15
511/511 ━━━━━━━━━━━━━━━━━━━━ 18s 35ms/step - loss: 8.1456e-04 - val_loss: 9.5787e-04
Epoch 5/15
511/511 ━━━━━━━━━━━━━━━━━━━━ 21s 36ms/step - loss: 7.9521e-04 - val_loss: 9.0018e-04
Epoch 6/15
511/511 ━━━━━━━━━━━━━━━━━━━━ 19s 37ms/step - loss: 7.8407e-04 - val_loss: 8.7549e-04
Epoch 7/15
511/511 ━━━━━━━━━━━━━━━━━━━━ 21s 37ms/step - loss: 7.8829e-04 - val_loss: 8.8338e-04
Epoch 8/15
511/511 ━━━━━━━━━━━━━━━━━━━━ 17s 34ms/step - loss: 7.7220e-04 - val_loss: 8.8712e-04
Epoch 9/15
511/511 ━━━━━━━━━━━━━━━━━━━━ 18s 34ms/step - loss: 7.6188e-04 - val_loss: 8.7916e-04
Epoch 10/15
511/511 ━━━━━━━━━━━━━━━━━━━━ 18s 36ms/step - loss: 7.6303e-04 - val_loss: 8.7318e-04
Epoch 11/15
511/511 ━━━━━━━━━━━━━━━━━━━━ 18s 34ms/step - loss: 7.5212e-04 - val_loss: 8.6867e-04
Epoch 12/15
511/511 ━━━━━━━━━━━━━━━━━━━━ 18s 35ms/step - loss: 7.5466e-04 - val_loss: 9.3667e-04
Epoch 13/15
511/511 ━━━━━━━━━━━━━━━━━━━━ 19s 38ms/step - loss: 7.7138e-04 - val_loss: 9.4990e-04
Epoch 14/15
511/511 ━━━━━━━━━━━━━━━━━━━━ 18s 36ms/step - loss: 7.5509e-04 - val_loss: 8.6623e-04
Epoch 15/15
511/511 ━━━━━━━━━━━━━━━━━━━━ 19s 37ms/step - loss: 7.5231e-04 - val_loss: 8.5722e-04

219/219 ━━━━━━━━━━━━━━━━━━━━ 2s 8ms/step

[SUKSES] Seluruh rangkaian proses penarikan data, penyimpanan ke Drive, dan pelatihan LSTM selesai!
```

### 4.2. SEL 2 (`execution_count: 10` - Penghasil `model_lstm_banjir.h5` & `scaler.pkl`)

#### Kode Python Sel 2:

```python
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import requests
import pickle
from datetime import datetime
from google.colab import drive, files
from sklearn.preprocessing import MinMaxScaler
from tensorflow.keras.models import Sequential
from tensorflow.keras.layers import LSTM, Dense, Dropout

# ==========================================
# 1. MOUNT GOOGLE DRIVE
# ==========================================
print("Menghubungkan ke Google Drive...")
drive.mount('/content/drive')

# Tentukan jalur penyimpanan di Google Drive Anda
drive_path = '/content/drive/My Drive/dataset_fusi_jsn_bmkg_2021_2026.csv'
model_save_path = '/content/drive/My Drive/model_lstm_banjir.h5'
scaler_save_path = '/content/drive/My Drive/scaler.pkl'

# ==========================================
# 2. TARIK SELURUH DATA HISTORIS (2021 - 2026) DARI OPEN-METEO API
# ==========================================
lat = "-6.365"
lon = "106.820"
start_date = "2021-01-01"
end_date = "2026-05-01"

url = f"https://archive-api.open-meteo.com/v1/archive?latitude={lat}&longitude={lon}&start_date={start_date}&end_date={end_date}&hourly=temperature_2m,relative_humidity_2m,precipitation,shortwave_radiation&timezone=Asia%2FJakarta"

print(f"\nSedang menarik seluruh data historis dari {start_date} sampai {end_date}...")
response = requests.get(url, timeout=60)
response.raise_for_status()
data = response.json().get("hourly", {})

# Konversi ke Pandas DataFrame
df = pd.DataFrame({
    "Waktu": data.get("time", []),
    "Suhu (°C)": data.get("temperature_2m", []),
    "Kelembapan (%)": data.get("relative_humidity_2m", []),
    "Curah Hujan (mm)": data.get("precipitation", []),
    "GHI (W/m²)": data.get("shortwave_radiation", [])
})

# ==========================================
# 3. GENERATE SENSOR FISIK JSN-SR04T (ELEVASI AIR)
# ==========================================
np.random.seed(42)
n = len(df)
rain = df['Curah Hujan (mm)'].values
elevation = np.zeros(n)
current_level = 150.0 # Baseline normal elevasi air sungai (cm)

for i in range(n):
    inflow = rain[i] * 6.5 + np.random.normal(0, 0.4)
    recession = (current_level - 140.0) * 0.06 if current_level > 140.0 else 0.0
    current_level = current_level + inflow - recession + np.random.normal(0, 0.15)
    current_level = np.clip(current_level, 100.0, 420.0)
    elevation[i] = round(current_level, 2)

df['Elevasi Air JSN-SR04T (cm)'] = elevation

# ==========================================
# 4. SIMPAN DATASET KE GOOGLE DRIVE
# ==========================================
df.to_csv(drive_path, index=False)
print(f"\n[SUKSES] Dataset tersimpan di: {drive_path}")
display(df.head())

# ==========================================
# 5. PREPROCESSING & SCALER UNTUK LSTM
# ==========================================
df['Waktu'] = pd.to_datetime(df['Waktu'])
df.set_index('Waktu', inplace=True)

target_column = 'Elevasi Air JSN-SR04T (cm)'
df = df.interpolate(method='linear').bfill().ffill()

data = df[[target_column]].values

# Normalisasi Min-Max Scaler ke rentang [0, 1]
scaler = MinMaxScaler(feature_range=(0, 1))
scaled_data = scaler.fit_transform(data)

# SIMPAN OBJEK SCALER KE GOOGLE DRIVE (PENTING UNTUK WEBSITE)
with open(scaler_save_path, 'wb') as f:
    pickle.dump(scaler, f)
print(f"[SUKSES] Objek Scaler tersimpan di: {scaler_save_path}")

# ==========================================
# 6. MEMBUAT SLIDING WINDOW (SEKUEN 24 JAM)
# ==========================================
def create_sequences(dataset, time_step=24):
    X, y = [], []
    for i in range(len(dataset) - time_step - 1):
        X.append(dataset[i:(i + time_step), 0])
        y.append(dataset[i + time_step, 0])
    return np.array(X), np.array(y)

time_step = 24
X, y = create_sequences(scaled_data, time_step)
X = X.reshape(X.shape[0], X.shape[1], 1)

# ==========================================
# 7. PEMBAGIAN DATA: TRAIN (70%), VAL (15%), TEST (15%)
# ==========================================
total_len = len(X)
train_end = int(total_len * 0.70)
val_end = int(total_len * 0.85)

X_train, y_train = X[:train_end], y[:train_end]
X_val, y_val = X[train_end:val_end], y[train_end:val_end]
X_test, y_test = X[val_end:], y[val_end:]

print(f"\nDistribusi Dataset Training & Testing:")
print(f"- Training (70%)   : {X_train.shape[0]} sekuen")
print(f"- Validation (15%) : {X_val.shape[0]} sekuen")
print(f"- Testing (15%)    : {X_test.shape[0]} sekuen")

# ==========================================
# 8. ARSITEKTUR MODEL LSTM
# ==========================================
model = Sequential([
    LSTM(64, return_sequences=True, input_shape=(time_step, 1)),
    Dropout(0.2),
    LSTM(32, return_sequences=False),
    Dropout(0.2),
    Dense(16),
    Dense(1)
])

model.compile(optimizer='adam', loss='mean_squared_error')
model.summary()

# ==========================================
# 9. TRAINING MODEL LSTM
# ==========================================
history = model.fit(
    X_train, y_train,
    epochs=15,
    batch_size=64,
    validation_data=(X_val, y_val),
    verbose=1
)

# SIMPAN MODEL LSTM KE GOOGLE DRIVE (PENTING UNTUK WEBSITE)
model.save(model_save_path)
print(f"\n[SUKSES] Model LSTM berhasil disimpan di: {model_save_path}")

# ==========================================
# 10. VISUALISASI HASIL & EVALUASI
# ==========================================
plt.figure(figsize=(12, 4))
plt.plot(history.history['loss'], label='Training Loss')
plt.plot(history.history['val_loss'], label='Validation Loss')
plt.title('Grafik Loss Model LSTM - Prediksi Elevasi Air')
plt.xlabel('Epoch')
plt.ylabel('Loss (MSE)')
plt.legend()
plt.show()

# Prediksi pada Data Test
test_predict = model.predict(X_test)
test_predict_inv = scaler.inverse_transform(test_predict)
y_test_inv = scaler.inverse_transform(y_test.reshape(-1, 1))

plt.figure(figsize=(14, 6))
plt.plot(y_test_inv[-300:], label='Elevasi Aktual JSN-SR04T (cm)', color='blue')
plt.plot(test_predict_inv[-300:], label='Prediksi LSTM (cm)', color='red', linestyle='--')
plt.axhline(y=250, color='orange', linestyle=':', label='Threshold Siaga')
plt.axhline(y=300, color='purple', linestyle=':', label='Threshold Bahaya')
plt.title('Perbandingan Elevasi Aktual vs Prediksi LSTM pada Data Testing')
plt.xlabel('Waktu (Jam)')
plt.ylabel('Ketinggian Air (cm)')
plt.legend()
plt.show()

print("\n[SUKSES SEPENUHNYA] Training selesai! File model (.h5) dan scaler (.pkl) sudah siap diambil di Google Drive untuk diintegrasikan ke Web SCADA.")
```

#### Log Output Eksekusi Sel 2:

```text
Menghubungkan ke Google Drive...
Drive already mounted at /content/drive; to attempt to forcibly remount, call drive.mount("/content/drive", force_remount=True).

Sedang menarik seluruh data historis dari 2021-01-01 sampai 2026-05-01...

[SUKSES] Dataset tersimpan di: /content/drive/My Drive/dataset_fusi_jsn_bmkg_2021_2026.csv

              Waktu  Suhu (°C)  Kelembapan (%)  Curah Hujan (mm)  GHI (W/m²)  Elevasi Air JSN-SR04T (cm)
0  2021-01-01T00:00       24.0              93               0.1         0.0                      150.23
1  2021-01-01T01:00       23.8              94               0.1         0.0                      150.75
2  2021-01-01T02:00       23.5              96               0.6         0.0                      153.88
3  2021-01-01T03:00       23.2              97               1.3         0.0                      162.24
4  2021-01-01T04:00       23.2              96               0.9         0.0                      166.65

[SUKSES] Objek Scaler tersimpan di: /content/drive/My Drive/scaler.pkl

Distribusi Dataset Training & Testing:
- Training (70%)   : 32692 sekuen
- Validation (15%) : 7005 sekuen
- Testing (15%)    : 7006 sekuen

/usr/local/lib/python3.13/dist-packages/keras/src/layers/rnn/rnn.py:199: UserWarning: Do not pass an `input_shape`/`input_dim` argument to a layer. When using Sequential models, prefer using an `Input(shape)` object as the first layer in the model instead.
  super().__init__(**kwargs)

Model: "sequential_5"
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┳━━━━━━━━━━━━━━━━━━━━━━━━┳━━━━━━━━━━━━━━━┓
┃ Layer (type)                    ┃ Output Shape           ┃       Param # ┃
┡━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╇━━━━━━━━━━━━━━━━━━━━━━━━╇━━━━━━━━━━━━━━━┩
│ lstm_10 (LSTM)                  │ (None, 24, 64)         │        16,896 │
├─────────────────────────────────┼────────────────────────┼───────────────┤
│ dropout_10 (Dropout)            │ (None, 24, 64)         │             0 │
├─────────────────────────────────┼────────────────────────┼───────────────┤
│ lstm_11 (LSTM)                  │ (None, 32)             │        12,416 │
├─────────────────────────────────┼────────────────────────┼───────────────┤
│ dropout_11 (Dropout)            │ (None, 32)             │             0 │
├─────────────────────────────────┼────────────────────────┼───────────────┤
│ dense_10 (Dense)                │ (None, 16)             │           528 │
├─────────────────────────────────┼────────────────────────┼───────────────┤
│ dense_11 (Dense)                │ (None, 1)              │            17 │
└─────────────────────────────────┴────────────────────────┴───────────────┘
 Total params: 29,857 (116.63 KB)
 Trainable params: 29,857 (116.63 KB)
 Non-trainable params: 0 (0.00 B)

Epoch 1/15
511/511 ━━━━━━━━━━━━━━━━━━━━ 29s 46ms/step - loss: 0.0028 - val_loss: 0.0017
Epoch 2/15
511/511 ━━━━━━━━━━━━━━━━━━━━ 22s 44ms/step - loss: 0.0011 - val_loss: 0.0011
Epoch 3/15
511/511 ━━━━━━━━━━━━━━━━━━━━ 21s 41ms/step - loss: 8.6029e-04 - val_loss: 8.9875e-04
Epoch 4/15
511/511 ━━━━━━━━━━━━━━━━━━━━ 41s 41ms/step - loss: 8.0855e-04 - val_loss: 9.2487e-04
Epoch 5/15
511/511 ━━━━━━━━━━━━━━━━━━━━ 42s 42ms/step - loss: 8.0294e-04 - val_loss: 8.7423e-04
Epoch 6/15
511/511 ━━━━━━━━━━━━━━━━━━━━ 21s 42ms/step - loss: 7.8399e-04 - val_loss: 9.0486e-04
Epoch 7/15
511/511 ━━━━━━━━━━━━━━━━━━━━ 20s 39ms/step - loss: 7.7932e-04 - val_loss: 8.9544e-04
Epoch 8/15
511/511 ━━━━━━━━━━━━━━━━━━━━ 21s 41ms/step - loss: 7.7839e-04 - val_loss: 8.6861e-04
Epoch 9/15
511/511 ━━━━━━━━━━━━━━━━━━━━ 40s 39ms/step - loss: 7.7612e-04 - val_loss: 8.7911e-04
Epoch 10/15
511/511 ━━━━━━━━━━━━━━━━━━━━ 20s 39ms/step - loss: 7.6847e-04 - val_loss: 9.0124e-04
Epoch 11/15
511/511 ━━━━━━━━━━━━━━━━━━━━ 25s 48ms/step - loss: 7.4813e-04 - val_loss: 9.4153e-04
Epoch 12/15
511/511 ━━━━━━━━━━━━━━━━━━━━ 36s 38ms/step - loss: 7.6159e-04 - val_loss: 9.2646e-04
Epoch 13/15
511/511 ━━━━━━━━━━━━━━━━━━━━ 21s 41ms/step - loss: 7.6368e-04 - val_loss: 8.7482e-04
Epoch 14/15
511/511 ━━━━━━━━━━━━━━━━━━━━ 20s 40ms/step - loss: 7.5396e-04 - val_loss: 8.7870e-04
Epoch 15/15
511/511 ━━━━━━━━━━━━━━━━━━━━ 19s 37ms/step - loss: 7.4587e-04 - val_loss: 8.7008e-04

WARNING:absl:You are saving your model as an HDF5 file via `model.save()` or `keras.saving.save_model(model)`. This file format is considered legacy. We recommend using instead the native Keras format, e.g. `model.save('my_model.keras')` or `keras.saving.save_model(model, 'my_model.keras')`. 

[SUKSES] Model LSTM berhasil disimpan di: /content/drive/My Drive/model_lstm_banjir.h5

219/219 ━━━━━━━━━━━━━━━━━━━━ 2s 10ms/step

[SUKSES SEPENUHNYA] Training selesai! File model (.h5) dan scaler (.pkl) sudah siap diambil di Google Drive untuk diintegrasikan ke Web SCADA.
```

### 4.3. Deskripsi Visualisasi Grafik (Output Gambar pada Notebook)

1. **Grafik 1 (`Grafik Loss Model LSTM - Prediksi Elevasi Air`):**
   * Menampilkan kurva penurunan *Training Loss* (biru) dan *Validation Loss* (oranye) terhadap *Epoch* (0 s.d. 14).
   * *Loss* turun tajam dari $\approx 0.0028$ pada Epoch 1 menjadi $\approx 0.000745$ (*Training*) dan $\approx 0.000870$ (*Validation*) pada Epoch 15 tanpa gejala *overfitting*.

2. **Grafik 2 (`Perbandingan Elevasi Aktual vs Prediksi LSTM pada Data Testing`):**
   * Menampilkan 300 jam terakhir pada data *Testing*.
   * Garis biru solid (`Elevasi Aktual JSN-SR04T (cm)`) berhimpit sangat rapat dengan garis merah putus-putus (`Prediksi LSTM (cm)`), mengikuti fluktuasi puncak banjir (hingga $\approx 330\text{ cm}$) maupun fase surut ($\approx 140\text{ cm}$), dilengkapi garis batas horizontal *Threshold Siaga* ($250\text{ cm}$) dan *Threshold Bahaya* ($300\text{ cm}$).

---

## BAGIAN 5: HASIL DISKUSI INTERNAL, KESEPAKATAN TEKNIS KELOMPOK, & TRANSKRIP KONTEKS INTEGRASI WEB SCADA

Berikut adalah penjelasan detail mengenai hasil diskusi internal dan kesepakatan teknis kelompok kami di grup WhatsApp yang wajib dipahami 100% untuk dasar pembuatan kode program:

### 5.1. Kesepakatan Teknis Utama (Wajib Dipatuhi 100%)

1. **Status dan Karakteristik Model Machine Learning:**
   * Model LSTM yang digunakan untuk prediksi elevasi air banjir statusnya sudah selesai dilatih (*fully trained*) dan nilai bobotnya sudah tetap (*fixed*).
   * Model ini tidak akan melakukan latihan ulang (*no re-training*) saat aplikasi web berjalan. Pengiriman data uji baru dari perangkat keras (*hardware*) murni hanya digunakan untuk proses inferensi/prediksi (*testing/prediction*) dan tidak akan mengubah atau mempengaruhi bobot internal model.

2. **Alur Pengolahan Data di Backend (Mekanisme Sensor & Looping):**
   * Pipa data di *backend* harus dirancang secara asinkronus (*asynchronous event-driven*) untuk menangani pengulangan aliran data (*looping testing*) secara konstan yang dikirim oleh perangkat keras mikrokontroler sensor ultrasonik JSN-SR04 / JSN-SR04T.
   * Setiap kali data elevasi air mentah masuk dari sensor, *backend* wajib melakukan proses normalisasi skala (`normscale`) secara *real-time*. Proses normalisasi ini harus dihitung secara manual menggunakan rumus matematika `MinMaxScaler` berdasarkan nilai minimum (`data_min_`) dan maksimum (`data_max_`) yang tercantum di dalam berkas `konfigurasi_scaler.json` / `scaler.pkl`.
   * Data hasil normalisasi tersebut kemudian dimasukkan ke dalam antrean sirkular (`data_buffer`) dengan ukuran jendela tetap (`Window Size = 24`), sesuai dengan spesifikasi `batch_shape` *input layer* model `[null, 24, 1]` yang tertera pada berkas `arsitektur_model.txt` / `model_lstm_banjir.h5`.
   * Ketika *buffer* telah terisi penuh oleh 24 data runtun waktu (*time-series*) terakhir, *backend* akan mengeksekusi fungsi prediksi model (`model.predict`). Hasil keluaran (*output*) prediksi yang masih berupa nilai skala harus dikembalikan ke nilai fisik aslinya menggunakan kalkulasi matematika kebalikan (`inverse_scale`).

3. **Alur Komunikasi ke Frontend Website:**
   * Server *backend* tidak boleh mengalami *blocking* atau *crash* saat melakukan *looping* penerimaan data sensor konstan. Oleh karena itu, *backend* harus menyiarkan (*broadcast*) *payload* hasil prediksi langsung menggunakan protokol komunikasi dua arah yang persisten, yaitu **WebSockets** (atau alternatif REST API dengan *Server-Sent Events* / SSE).
   * Sisi *frontend* aplikasi web harus memiliki komponen penangkap data *real-time* yang secara dinamis memperbarui *state* antarmuka (*UI Update*) tanpa perlu memuat ulang halaman (*no page refresh*). *Frontend* ini bertugas menampilkan visualisasi *live testing* / simulasi 3D pergerakan tingkat elevasi air berdasarkan data hasil prediksi dari *backend*.

### 5.2. Rumus Matematika Eksak Manual `normscale` & `inverse_scale` di Backend

Agar perhitungan manual di *backend* 100% akurat sesuai hasil pelatihan model (`data_min_ = 130.56`, `data_max_ = 420.0`, `data_range_ = 289.44`), gunakan rumus berikut:

* **1. Normalisasi Manual (`normscale`) saat Data Sensor ($x_{\text{raw}}$ dalam cm) Masuk:**
  $$x_{\text{scaled}} = \frac{x_{\text{raw}} - \text{data\_min\_}}{\text{data\_max\_} - \text{data\_min\_}} = \frac{x_{\text{raw}} - 130.56}{420.0 - 130.56} = \frac{x_{\text{raw}} - 130.56}{289.44}$$
  *(atau ekuivalen dengan: $x_{\text{scaled}} = x_{\text{raw}} \times 0.003454947484798231 - 0.45107794361525704$)*

* **2. Struktur Antrean Sirkular (`data_buffer`):**
  * Menyimpan 24 nilai $x_{\text{scaled}}$ terakhir: $[x_{t-23}, x_{t-22}, \dots, x_{t}]$.
  * Diubah bentuknya (*reshape*) menjadi tensor 3D berukuran `[1, 24, 1]` sebelum dimasukkan ke `model.predict()`.

* **3. Denormalisasi Manual (`inverse_scale`) Hasil Prediksi ($\hat{y}_{\text{scaled}}$) ke Satuan Fisik ($\hat{y}_{\text{cm}}$):**
  $$\hat{y}_{\text{cm}} = \left(\hat{y}_{\text{scaled}} \times (\text{data\_max\_} - \text{data\_min\_})\right) + \text{data\_min\_} = \left(\hat{y}_{\text{scaled}} \times 289.44\right) + 130.56$$

### 5.3. Transkripsi Lengkap Konteks Diskusi Grup WhatsApp ("Despro apalah")

Berikut adalah catatan transkrip percakapan tim (**Kelompok 12 - Capstone Project DTE FTUI 2026**: Mikhail, Radithya Fawwaz Syahdi, Iqbal, Naufal Hani Zakwan, dan User) dari 4 tangkapan layar yang mendasari kesepakatan teknis di atas:

* **Dokumen & Tautan Referensi Tim:**
  * Dokumen PDF: `download.pdf` (*"METODOLOGI PERHITUNGAN MATEMATIS DAN GENERASI DATA SENSOR ULTRASONIK JSN-SR04T UNTUK PREDIKSI ELEVASI AIR BERBASIS LSTM - Kelompok 12 - Capstone Project DTE FTUI 2026"*, 4 halaman, 131 kB).
  * Google Colab Notebook: `https://colab.research.google.com/drive/1Zp6dbHcFNwXuhU7J4lZVi6Os2VHUczF_#scrollTo=lvOFwHOOzGEy`
  * Google Drive Folder Artefak LSTM: `https://drive.google.com/drive/folders/1ILMOMNB-n_kILpQVqtVwcSqX_NgVBJX-?usp=drive_link`

* **Log Percakapan Teknis (Kronologis):**
  * **[10.55] Radithya Fawwaz Syahdi:** *(Membalas tautan Google Colab Mikhail)* "Izin minta akses"
  * **[10.55 - 10.56] Mikhail:** "oiya" / "udh kah faw"
  * **[11.03] Radithya Fawwaz Syahdi:** "Itu belum bisa live testing g mik?"
  * **[11.04] Mikhail:** "harusnya udah" / "modelnya udh jadi soalnya" / "tinggal di integrate"
  * **[11.05] Radithya Fawwaz Syahdi:** *(Membalas "harusnya udah")* "maksudnya dia ngeloop testing setiap kali nerima data dari hardware"
  * **[11.06] Radithya Fawwaz Syahdi:** "Fawwaz kurang familiar, itu lstm udah tetap y modelnya setelah di-train?" / "Dalam artian input test baru tidak mempengaruhi modelnya?"
  * **[11.06] Mikhail:** "yeppp, all of ML udah tetap habis di train" / *(Membalas pertanyaan input test baru)* "100%"
  * **[11.07] Radithya Fawwaz Syahdi:** *(Membalas soal ngeloop testing setiap kali nerima data dari hardware)* "Ini aja si kalo mau integrasi ke web-nya"
  * **[11.08] Mikhail:** "wait aku buat modelnya bisa di integrate ke web"
  * **[11.23] Mikhail:** *(Mengirimkan berkas `scaler.pkl` - 0,5 kB BIN dan `model_lstm_banjir.h5` - 401 kB BIN)*
  * **[11.24] Mikhail:** "itu nanti di backend web nya pas datanya masuk, jangan lupa di normscale ya, soalnya modelnya di train dnegan data normalize" *(Pesan berbintang)*
  * **[11.29] Mikhail:** *(Membagikan tautan folder Google Drive yang berisi seluruh file LSTM)*
  * **[16.20] Mikhail:** *(Membalas pesan terkait kelanjutan integrasi simulasi 3D ke web utama bersama Iqbal)* "udh bisa dipake di backend nya kaa"
  * **[16.20] Anda:** "Wokee"
  * **[16.20] Mikhail:** "nanti harusnya outputnya tinggal tampilin di frontend"
  * **[16.20 - 16.21] Anda:** "@Naufal Hani Zakwan gimana??" / *(Membalas tautan Google Drive)* "Berarti lstm isinya disini semua yak mik?"
  * **[16.22] Mikhail:** "iyaa" / "model nya udh gw save juga"