# 🌤️ Smart Roller Blind IoT (Jemuran Pintar)

Sistem jemuran otomatis berbasis **ESP32** dan **Web Dashboard IoT Real-time** menggunakan komunikasi **Dual Cloud (MQTT Broker + Firebase Realtime Database)**. Sistem ini mendeteksi cuaca panas dan hujan secara otomatis untuk membuka dan menutup roller blind jemuran, serta dilengkapi mode kontrol manual melalui web.

🌐 **Live Dashboard (GitHub Pages):** [https://vinn17.github.io/smart-roller-blind-iot/](https://vinn17.github.io/smart-roller-blind-iot/)

---

## 📁 Struktur Proyek

```text
smart-roller-blind-iot/
├── css/
│   └── style.css            # Desain antarmuka & styling responsive
├── js/
│   └── app.js               # Logika Web, Firebase Cloud Sync, MQTT HiveMQ, Chart.js & Animasi Cuaca
├── firmware/
│   └── jemuran.ino          # Kode program ESP32 / Arduino (Dual publish MQTT & Firebase)
├── index.html               # Halaman utama web dashboard
├── .gitignore               # Konfigurasi ignore file git
└── README.md                # Dokumentasi proyek & panduan setup
```

---

## 🚀 Fitur Utama

- 🔥 **Firebase Cloud Sync**: Riwayat sensor, statistik, dan log tersimpan di cloud gratis dan **sinkron otomatis di semua perangkat/user secara real-time**.
- 📊 **Monitoring Real-time**: Pembacaan suhu (°C), kelembaban (%), dan dua sensor hujan (%).
- 🌦️ **Animasi Cuaca Dinamis**: Canvas animasi interaktif yang merefleksikan kondisi siang/malam, hujan, dan posisi tirai jemuran.
- 📈 **Grafik Riwayat Data**: Visualisasi grafik interaktif untuk suhu, kelembaban, level hujan, dan status motor menggunakan Chart.js.
- 🎛️ **Kontrol Fleksibel**:
  - **Mode AUTO**: Roller blind membuka/menutup otomatis berdasarkan deteksi sensor hujan.
  - **Mode MANUAL**: Tombol kontrol NAIK, TURUN, dan STOP dari dashboard.
- 🎨 **Personalisasi & Tema**: Penggantian nama dashboard dan beberapa pilihan palet warna tema.
- 💾 **Export Data**: Simpan log aktivitas dan histori data sensor dalam format JSON.

---

## ☁️ Konfigurasi Cloud (Firebase & MQTT)

### 1. Firebase Realtime Database
* **Database URL**: `https://jemuran-iot-56180-default-rtdb.asia-southeast1.firebasedatabase.app`
* **Node Real-time**:
  * `/jemuran/status`: Menyimpan status sensor terakhir.
  * `/jemuran/history`: Menyimpan titik data grafik riwayat sensor.
  * `/jemuran/control`: Menerima perintah motor (*naik / turun / stop*).
  * `/jemuran/mode`: Menerima perintah mode (*auto / manual*).

### 2. MQTT HiveMQ Broker
| Parameter | Konfigurasi Web Dashboard | Konfigurasi ESP32 |
| :--- | :--- | :--- |
| **Broker URL** | `wss://broker.hivemq.com:8884/mqtt` | `broker.hivemq.com` |
| **Port** | `8884` (Secure WebSockets) | `1883` (TCP) |
| **Topic Status** | `jemuran/status` (Subscribe) | `jemuran/status` (Publish) |
| **Topic Control** | `jemuran/control` (Publish) | `jemuran/control` (Subscribe) |
| **Topic Mode** | `jemuran/mode` (Publish) | `jemuran/mode` (Subscribe) |

### Format Payload Data (`jemuran/status` JSON):
```json
{
  "temp": 30.5,
  "hum": 70.2,
  "rain1": 85,
  "rain2": 90,
  "blindStatus": "closed",
  "isRaining": true,
  "mode": "auto"
}
```

---

## 🔌 Pinout ESP32 (Hardware Wiring)

| Komponen / Sensor | Pin ESP32 | Keterangan |
| :--- | :--- | :--- |
| **Sensor Hujan 1 (ADC)** | `GPIO 33` | Input Analog |
| **Sensor Hujan 2 (ADC)** | `GPIO 32` | Input Analog |
| **DHT22 / DHT11 Sensor** | `GPIO 26` | Data Pin |
| **Motor Driver IN1** | `GPIO 27` | Kontrol Arah Motor |
| **Motor Driver IN2** | `GPIO 14` | Kontrol Arah Motor |
| **Motor Driver EN (PWM)** | `GPIO 5` | Enable / Kecepatan Motor |
| **Limit Switch Atas** | `GPIO 22` | Deteksi posisi paling atas |
| **Limit Switch Bawah** | `GPIO 23` | Deteksi posisi paling bawah |

---

## 🌐 Cara Setup & Menjalankan di GitHub Pages

Agar web dashboard kamu dapat diakses secara publik di internet melalui GitHub Pages:

1. **Push semua file terbaru ke GitHub:**
   ```bash
   git add .
   git commit -m "Integrate Firebase Realtime Database cloud sync"
   git push origin main
   ```
2. Buka repository kamu di browser: **[VINN17/smart-roller-blind-iot](https://github.com/VINN17/smart-roller-blind-iot)**
3. Klik menu **Settings** > **Pages** (di sidebar kiri).
4. Pada bagian **Build and deployment**:
   - **Source**: `Deploy from a branch`
   - **Branch**: Pilih `main` dan folder `/(root)`
   - Klik **Save**.
5. Live website kamu aktif di: 👉 **`https://vinn17.github.io/smart-roller-blind-iot/`**

---

## 💻 Cara Menjalankan Secara Lokal

Cukup buka file [index.html](file:///c:/Users/VINNN17/OneDrive/Documents/joki/iot/index.html) menggunakan browser (Google Chrome, Edge, Firefox, dll) atau gunakan extension **Live Server** di VS Code.