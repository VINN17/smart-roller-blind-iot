#include "Arduino.h"
#include <WiFi.h>
#include <WebServer.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include "DHTesp.h"
#include "time.h"

// ==================== KONFIGURASI WiFi ====================
const char* ssid = "GRAHA VACALSIA";
const char* password = "kususgv1";
const char* mqtt_server = "broker.hivemq.com";
const int mqtt_port = 1883;

// ==================== KONFIGURASI FIREBASE CLOUD ====================
const char* firebase_host = "https://jemuran-iot-56180-default-rtdb.asia-southeast1.firebasedatabase.app/jemuran/status.json";

// Konfigurasi NTP (Waktu Indonesia Barat UTC+7)
const char* ntpServer = "id.pool.ntp.org";
const long gmtOffset_sec = 7 * 3600;
const int daylightOffset_sec = 0;

// Client ID MQTT
WiFiClient espClient;
PubSubClient client(espClient);
String clientId = "ESP32_Jemuran_" + String(random(0xffff), HEX);

// ==================== PIN DEFINITION ====================
#define adc33 33
#define adc25 32
const int MOTOR_IN1 = 27;
const int MOTOR_IN2 = 14;
const int MOTOR_EN = 5;
const int DHT_PIN = 26;
const int LIMIT_SWITCH_ATAS = 22;
const int LIMIT_SWITCH_BAWAH = 23;

DHTesp dhtSensor;

// ==================== VARIABEL GLOBAL ====================
unsigned long lastTdata = 0, lastTdata1 = 0, lastMqttPublish = 0;

float temp = 0;
float hum = 0;
int r1 = 0;
int r2 = 0;
int rawRain1 = 0;
int rawRain2 = 0;
int jam = 0;
int menit = 0;
float fuzzyScore = 0.0; // Skor defuzzifikasi Z Sugeno (0.0 - 1.0)

// Motor position counter
int motorCounter = 0;          // Counter posisi motor saat ini
const int MAX_COUNTER = 16900; // Batas bawah (posisi turun penuh)
bool flag_m = 0;               // Flag untuk kontrol motor

// Status sistem
enum Mode { AUTO, MANUAL };
Mode currentMode = AUTO;

enum MotorCommand { CMD_NAIK, CMD_TURUN, CMD_STOP };
MotorCommand motorCommand = CMD_STOP;
MotorCommand targetCommand = CMD_STOP; // Target untuk auto mode

bool isRaining = false;
String weatherStatus = "Cerah";
bool motorLocked = false;

// ==================== WEB SERVER ====================
WebServer server(80);

// ==================== MQTT TOPICS ====================
const char* topic_status = "jemuran/status";
const char* topic_control = "jemuran/control";
const char* topic_mode = "jemuran/mode";

// =========================================================================
// SISTEM INFERENSI FUZZY SUGENO (ORDE-0) - JEMURAN PINTAR OTOMATIS
// =========================================================================

// --- 1. Fungsi Keanggotaan (Membership Function) ---
float trapesiumTurun(float x, float a, float b) {
  if (x <= a) return 1.0;
  if (x >= b) return 0.0;
  return (b - x) / (b - a);
}

float trapesiumNaik(float x, float a, float b) {
  if (x <= a) return 0.0;
  if (x >= b) return 1.0;
  return (x - a) / (b - a);
}

float segitiga(float x, float a, float b, float c) {
  if (x <= a || x >= c) return 0.0;
  if (x == b) return 1.0;
  if (x < b) return (x - a) / (b - a);
  return (c - x) / (c - b);
}

// --- 2. Mesin Inferensi & Defuzzifikasi Sugeno ---
float hitungFuzzySugeno(float rain, float hum, float temp, int jam) {
  // A. FUZZIFIKASI SENSOR HUJAN (0 - 100%)
  float u_hujan_kering  = trapesiumTurun(rain, 15.0, 35.0);
  float u_hujan_gerimis = segitiga(rain, 20.0, 40.0, 65.0);
  float u_hujan_deras   = trapesiumNaik(rain, 45.0, 75.0);

  // B. FUZZIFIKASI KELEMBABAN UDARA RH (0 - 100%) - Iklim Tropis Indonesia
  float u_hum_kering = trapesiumTurun(hum, 55.0, 75.0);
  float u_hum_lembab = trapesiumNaik(hum, 65.0, 85.0);

  // C. FUZZIFIKASI SUHU UDARA (°C)
  float u_temp_dingin = trapesiumTurun(temp, 24.0, 28.0);
  float u_temp_panas  = trapesiumNaik(temp, 27.0, 33.0);

  // D. KONDISI WAKTU OPERASIONAL (Siang: 06.00 - 18.00)
  bool isSiang = (jam >= 6 && jam < 18);
  float u_waktu_siang = isSiang ? 1.0 : 0.0;
  float u_waktu_malam = isSiang ? 0.0 : 1.0;

  // BASIS ATURAN (7 RULES SUGENO ORDE-0)
  // Konstanta Output z: 0.0 = BUKA JEMURAN, 1.0 = TUTUP JEMURAN
  const int JUMLAH_RULE = 7;
  float w[JUMLAH_RULE];
  float z[JUMLAH_RULE];

  // R1: IF Hujan Deras THEN TUTUP (z = 1.0)
  w[0] = u_hujan_deras;
  z[0] = 1.0;

  // R2: IF Hujan Gerimis THEN TUTUP (z = 1.0)
  w[1] = u_hujan_gerimis;
  z[1] = 1.0;

  // R3: IF Kering AND Malam THEN TUTUP (z = 1.0) [Lindungi jemuran dari embun malam]
  w[2] = min(u_hujan_kering, u_waktu_malam);
  z[2] = 1.0;

  // R4: IF Kering AND Siang AND Panas AND Hum Kering THEN BUKA (z = 0.0) [Optimal Menjemur]
  w[3] = min(min(u_hujan_kering, u_waktu_siang), min(u_temp_panas, u_hum_kering));
  z[3] = 0.0;

  // R5: IF Kering AND Siang AND Panas AND Hum Lembab THEN BUKA (z = 0.2) [Panas terik]
  w[4] = min(min(u_hujan_kering, u_waktu_siang), min(u_temp_panas, u_hum_lembab));
  z[4] = 0.2;

  // R6: IF Kering AND Siang AND Dingin AND Hum Kering THEN BUKA (z = 0.25) [Sejuk berangin]
  w[5] = min(min(u_hujan_kering, u_waktu_siang), min(u_temp_dingin, u_hum_kering));
  z[5] = 0.25;

  // R7: IF Kering AND Siang AND Dingin AND Hum Lembab THEN BUKA (z = 0.30) [Mendung / Pasca Hujan - Tetap Buka karena tidak ada hujan]
  w[6] = min(min(u_hujan_kering, u_waktu_siang), min(u_temp_dingin, u_hum_lembab));
  z[6] = 0.30;

  // DEFUZZIFIKASI WEIGHTED AVERAGE
  float sum_wz = 0.0;
  float sum_w  = 0.0;

  for (int i = 0; i < JUMLAH_RULE; i++) {
    sum_wz += (w[i] * z[i]);
    sum_w  += w[i];
  }

  if (sum_w <= 0.0001) return 0.0; // Default aman
  return (sum_wz / sum_w);         // Nilai Z kontinu [0.0 - 1.0]
}

// ==================== FUNGSI MQTT ====================
void reconnectMQTT() {
  while (!client.connected()) {
    Serial.print("Connecting to MQTT...");
    if (client.connect(clientId.c_str())) {
      Serial.println("connected");
      client.subscribe(topic_control);
      client.subscribe(topic_mode);
    } else {
      Serial.print("failed, rc=");
      Serial.print(client.state());
      Serial.println(" try again in 5 seconds");
      delay(5000);
    }
  }
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String message = "";
  for (int i = 0; i < length; i++) {
    message += (char)payload[i];
  }

  Serial.print("Message arrived [");
  Serial.print(topic);
  Serial.print("] ");
  Serial.println(message);

  if (String(topic) == topic_control && currentMode == MANUAL) {
    if (message == "naik") {
      requestMotorControl(CMD_NAIK);
    } else if (message == "turun") {
      requestMotorControl(CMD_TURUN);
    } else if (message == "stop") {
      requestMotorControl(CMD_STOP);
    }
  }

  if (String(topic) == topic_mode) {
    if (message == "auto") {
      currentMode = AUTO;
      motorLocked = false;
      flag_m = 0;
      targetCommand = CMD_STOP;
      stopMotorImmediate();
      Serial.println("MODE SWITCH [MQTT]: Berubah ke AUTO - Evaluasi target cuaca");
    } else if (message == "manual") {
      currentMode = MANUAL;
      motorLocked = false;
      motorCommand = CMD_STOP;
      stopMotorImmediate();
      Serial.println("MODE SWITCH [MQTT]: Berubah ke MANUAL - Motor langsung STOP");
    }
  }
}

// ==================== FUNGSI REQUEST KONTROL MOTOR (MANUAL) ====================
void requestMotorControl(MotorCommand cmd) {
  if (currentMode != MANUAL) return;

  // Mode manual: unlock jika perintah berbeda
  if (motorLocked && cmd != motorCommand) {
    Serial.println("Perintah berbeda - Unlocking motor");
    motorLocked = false;
  }

  if (!motorLocked) {
    motorCommand = cmd;
    Serial.print("Manual command: ");
    Serial.println(cmd == CMD_NAIK ? "NAIK" : (cmd == CMD_TURUN ? "TURUN" : "STOP"));
  }
}

// ==================== FUNGSI LOW-LEVEL MOTOR & PROTEKSI DEADTIME ====================
MotorCommand currentPhysicalDirection = CMD_STOP;

void stopMotorImmediate() {
  digitalWrite(MOTOR_IN1, LOW);
  digitalWrite(MOTOR_IN2, LOW);
  analogWrite(MOTOR_EN, 0);
  currentPhysicalDirection = CMD_STOP;
}

void setMotorDrive(int in1, int in2, int speed, MotorCommand newDir) {
  // Proteksi Deadtime: jika motor sedang berputar dan tiba-tiba berganti arah (misal NAIK -> TURUN),
  // matikan arus sejenak (80ms) untuk mencegah lonjakan arus balik (Back-EMF spike) yang bisa merusak driver / restart ESP32
  if (currentPhysicalDirection != CMD_STOP && newDir != CMD_STOP && currentPhysicalDirection != newDir) {
    stopMotorImmediate();
    delay(80);
  }

  digitalWrite(MOTOR_IN1, in1);
  digitalWrite(MOTOR_IN2, in2);
  analogWrite(MOTOR_EN, speed);
  currentPhysicalDirection = newDir;
}

// ==================== FUNGSI KONTROL MOTOR ====================
void processMotorControl() {
  // 1. Cek limit switch fisik atas (Pin 22)
  bool isTopSwitchHit = (digitalRead(LIMIT_SWITCH_ATAS) == 0);
  if (isTopSwitchHit) {
    if (motorCounter != 0) {
      motorCounter = 0;
      Serial.println("Koreksi Posisi: Counter direset ke 0 (Limit Atas Tercapai)");
    }
  }

  // 2. Cek limit switch fisik bawah (Pin 23)
  bool isBottomSwitchHit = (digitalRead(LIMIT_SWITCH_BAWAH) == 0);
  if (isBottomSwitchHit) {
    if (motorCounter != MAX_COUNTER) {
      motorCounter = MAX_COUNTER;
      Serial.println("Koreksi Posisi: Counter diset ke MAX_COUNTER (Limit Bawah Tercapai)");
    }
  }

  MotorCommand activeCommand = (currentMode == AUTO) ? targetCommand : motorCommand;

  // 3. Mode AUTO: cek apakah sudah mencapai posisi target
  if (currentMode == AUTO) {
    // Target NAIK dan sudah di atas
    if (activeCommand == CMD_NAIK && (isTopSwitchHit || motorCounter == 0)) {
      if (!motorLocked) {
        stopMotorImmediate();
        motorLocked = true;
        flag_m = 1;
        Serial.println("AUTO: Posisi ATAS tercapai - Motor STOP & LOCKED");
      }
      return;
    }
    
    // Target TURUN dan sudah di bawah
    if (activeCommand == CMD_TURUN && (isBottomSwitchHit || motorCounter >= MAX_COUNTER)) {
      if (!motorLocked) {
        stopMotorImmediate();
        motorLocked = true;
        Serial.println("AUTO: Posisi BAWAH tercapai - Motor STOP & LOCKED");
      }
      return;
    }
  }

  // 4. Eksekusi NAIK
  if (activeCommand == CMD_NAIK) {
    if (!isTopSwitchHit) {
      setMotorDrive(HIGH, LOW, 255, CMD_NAIK);
      if (motorCounter > 0) {
        motorCounter--;
      }
    } else {
      stopMotorImmediate();
      motorCounter = 0;
      flag_m = 1;
      if (!motorLocked) {
        motorLocked = true;
        Serial.println("Limit ATAS tercapai - Motor STOP & LOCKED");
      }
    }
  }
  // 5. Eksekusi TURUN
  else if (activeCommand == CMD_TURUN) {
    flag_m = 0;
    if (!isBottomSwitchHit && motorCounter < MAX_COUNTER) {
      setMotorDrive(LOW, HIGH, 255, CMD_TURUN);
      motorCounter++;
    } else {
      stopMotorImmediate();
      motorCounter = MAX_COUNTER;
      if (!motorLocked) {
        motorLocked = true;
        Serial.println("Batas BAWAH tercapai - Motor STOP & LOCKED");
      }
    }
  }
  // 6. Eksekusi STOP
  else {
    stopMotorImmediate();
    if (currentMode == MANUAL && !motorLocked) {
      motorLocked = true;
      Serial.println("Manual STOP - Motor LOCKED");
    }
  }
}

// ==================== WEB SERVER HANDLERS ====================
void handleRoot() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.send(200, "text/plain", "Smart Jemuran API Ready (Fuzzy Sugeno)");
}

void handleData() {
  server.sendHeader("Access-Control-Allow-Origin", "*");

  StaticJsonDocument<500> doc;
  doc["temp"] = temp;
  doc["hum"] = hum;
  doc["rain1"] = r1;
  doc["rain2"] = r2;
  doc["hour"] = jam;
  doc["minute"] = menit;
  doc["isRaining"] = isRaining;
  doc["blindStatus"] = (motorCounter >= MAX_COUNTER / 2) ? "closed" : "open";
  doc["fuzzyScore"] = fuzzyScore;
  doc["position"] = motorCounter;
  doc["maxPosition"] = MAX_COUNTER;
  doc["atTop"] = (motorCounter == 0 && digitalRead(LIMIT_SWITCH_ATAS) == 0);
  doc["atBottom"] = (motorCounter >= MAX_COUNTER);
  doc["mode"] = (currentMode == AUTO) ? "auto" : "manual";
  doc["motorLocked"] = motorLocked;
  doc["weatherStatus"] = weatherStatus;

  String output;
  serializeJson(doc, output);
  server.send(200, "application/json", output);
}

void handleControl() {
  server.sendHeader("Access-Control-Allow-Origin", "*");

  if (currentMode == MANUAL) {
    String action = server.arg("action");
    if (action == "naik") {
      requestMotorControl(CMD_NAIK);
      server.send(200, "application/json", "{\"status\":\"ok\",\"action\":\"naik\"}");
    } else if (action == "turun") {
      requestMotorControl(CMD_TURUN);
      server.send(200, "application/json", "{\"status\":\"ok\",\"action\":\"turun\"}");
    } else if (action == "stop") {
      requestMotorControl(CMD_STOP);
      server.send(200, "application/json", "{\"status\":\"ok\",\"action\":\"stop\"}");
    } else {
      server.send(400, "application/json", "{\"status\":\"error\",\"message\":\"Invalid action\"}");
    }
  } else {
    server.send(403, "application/json", "{\"status\":\"error\",\"message\":\"Manual mode not active\"}");
  }
}

void handleSetMode() {
  server.sendHeader("Access-Control-Allow-Origin", "*");

  String mode = server.arg("mode");
  if (mode == "auto") {
    currentMode = AUTO;
    motorLocked = false;
    flag_m = 0;
    targetCommand = CMD_STOP;
    stopMotorImmediate();
    server.send(200, "application/json", "{\"status\":\"ok\",\"mode\":\"auto\"}");
  } else if (mode == "manual") {
    currentMode = MANUAL;
    motorLocked = false;
    motorCommand = CMD_STOP;
    stopMotorImmediate();
    server.send(200, "application/json", "{\"status\":\"ok\",\"mode\":\"manual\"}");
  } else {
    server.send(400, "application/json", "{\"status\":\"error\",\"message\":\"Invalid mode\"}");
  }
}

// ==================== FUNGSI KIRIM KE FIREBASE ====================
void sendToFirebase(String jsonPayload) {
  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    http.begin(firebase_host);
    http.addHeader("Content-Type", "application/json");
    int httpResponseCode = http.PUT(jsonPayload);
    if (httpResponseCode > 0) {
      Serial.print("Firebase updated [Code: ");
      Serial.print(httpResponseCode);
      Serial.println("]");
    } else {
      Serial.print("Firebase Error: ");
      Serial.println(httpResponseCode);
    }
    http.end();
  }
}

// ==================== SETUP ====================
void setup() {
  Serial.begin(115200);
  delay(1000);

  pinMode(MOTOR_IN1, OUTPUT);
  pinMode(MOTOR_IN2, OUTPUT);
  pinMode(MOTOR_EN, OUTPUT);
  pinMode(LIMIT_SWITCH_ATAS, INPUT_PULLUP);
  pinMode(LIMIT_SWITCH_BAWAH, INPUT_PULLUP);

  // Stop motor saat startup
  digitalWrite(MOTOR_IN1, LOW);
  digitalWrite(MOTOR_IN2, LOW);
  analogWrite(MOTOR_EN, 0);

  dhtSensor.setup(DHT_PIN, DHTesp::DHT22);

  Serial.print("Connecting to WiFi: ");
  Serial.println(ssid);
  WiFi.begin(ssid, password);

  int attempt = 0;
  while (WiFi.status() != WL_CONNECTED && attempt < 20) {
    delay(500);
    Serial.print(".");
    attempt++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWiFi Connected!");
    Serial.print("IP Address: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\nWiFi Connection Failed!");
  }

  configTime(gmtOffset_sec, daylightOffset_sec, ntpServer);

  client.setServer(mqtt_server, mqtt_port);
  client.setCallback(mqttCallback);

  server.on("/", handleRoot);
  server.on("/data", handleData);
  server.on("/control", handleControl);
  server.on("/setMode", handleSetMode);
  server.onNotFound([]() {
    server.sendHeader("Access-Control-Allow-Origin", "*");
    server.send(404, "text/plain", "Not Found");
  });

  server.begin();
  Serial.println("HTTP server started");
  Serial.println("Fuzzy Sugeno System Ready");
}

// ==================== LOOP ====================
void loop() {
  if (!client.connected()) {
    reconnectMQTT();
  }
  client.loop();
  server.handleClient();

  struct tm timeinfo;
  if (getLocalTime(&timeinfo)) {
    jam = timeinfo.tm_hour;
    menit = timeinfo.tm_min;
  }

  TempAndHumidity data = dhtSensor.getTempAndHumidity();
  unsigned long Tdata = millis();

  // 1. Baca sensor setiap 2 detik
  if (Tdata - lastTdata >= 2000) {
    lastTdata = Tdata;

    if (!isnan(data.temperature) && !isnan(data.humidity)) {
      temp = data.temperature;
      hum = data.humidity;
    }

    rawRain1 = analogRead(adc33);
    rawRain2 = analogRead(adc25);

    // Pemetaan ADC (Bisa di-tuning sesuai nilai ADC riil saat kering vs basah)
    r1 = map(constrain(rawRain1, 500, 4095), 4095, 500, 0, 100);
    r2 = map(constrain(rawRain2, 500, 4095), 4095, 500, 0, 100);

    // Output Serial untuk observasi dan data penelitian skripsi
    Serial.printf("[SENSOR RAW] R1_ADC: %d (%d%%) | R2_ADC: %d (%d%%) | Temp: %.1f C | Hum: %.1f %% | Jam: %02d:%02d\n",
                  rawRain1, r1, rawRain2, r2, temp, hum, jam, menit);
  }

  // 2. Logika Pengambilan Keputusan AUTO (Fuzzy Sugeno)
  if (currentMode == AUTO) {
    if (Tdata - lastTdata1 >= 1000) {
      lastTdata1 = Tdata;

      float r_score = (r1 + r2) / 2.0;

      // Hitung skor Z Defuzzifikasi Sugeno [0.0 - 1.0]
      fuzzyScore = hitungFuzzySugeno(r_score, hum, temp, jam);

      // Ambang batas keputusan: Z >= 0.5 TUTUP, Z < 0.5 BUKA
      MotorCommand newTargetCommand;
      if (fuzzyScore >= 0.5) {
        isRaining = (r_score > 25);
        if (isRaining) {
          weatherStatus = "Hujan";
        } else if (jam < 6 || jam >= 18) {
          weatherStatus = "Malam Hari";
        } else {
          weatherStatus = "Mendung";
        }
        newTargetCommand = CMD_TURUN; // Tutup tirai jemuran
      } else {
        isRaining = false;
        weatherStatus = "Cerah";
        newTargetCommand = CMD_NAIK;  // Buka tirai jemuran
      }

      // Cek apakah target berubah
      if (newTargetCommand != targetCommand) {
        Serial.print("Target berubah dari ");
        Serial.print(targetCommand == CMD_NAIK ? "NAIK" : (targetCommand == CMD_TURUN ? "TURUN" : "STOP"));
        Serial.print(" ke ");
        Serial.println(newTargetCommand == CMD_NAIK ? "NAIK" : "TURUN");
        
        targetCommand = newTargetCommand;
        motorLocked = false;
      }

      // Debug Serial Skripsi: Output variabel fuzzy lengkap
      Serial.printf("FUZZY AUTO || Z: %.3f | Aksi: %s | Cuaca: %s | Pos: %d/%d | R_score: %.1f%% | Hum: %.1f%% | Temp: %.1f C | TopSwitch: %s\n",
                    fuzzyScore,
                    (targetCommand == CMD_NAIK ? "NAIK" : "TURUN"),
                    weatherStatus.c_str(),
                    motorCounter, MAX_COUNTER,
                    r_score, hum, temp,
                    (digitalRead(LIMIT_SWITCH_ATAS) == 0 ? "PRESSED" : "FREE"));
    }
  }
  // Logika MANUAL mode
  else {
    if (Tdata - lastTdata1 >= 1000) {
      lastTdata1 = Tdata;
      
      float r_score = (r1 + r2) / 2.0;
      if (r_score > 25) {
        isRaining = true;
        weatherStatus = "Hujan";
      } else {
        isRaining = false;
        weatherStatus = "Cerah";
      }

      Serial.printf("MANUAL || Pos: %d/%d | Command: %s | Locked: %s | TopSwitch: %s\n",
                    motorCounter, MAX_COUNTER,
                    (motorCommand == CMD_NAIK ? "NAIK" : (motorCommand == CMD_TURUN ? "TURUN" : "STOP")),
                    (motorLocked ? "YES" : "NO"),
                    (digitalRead(LIMIT_SWITCH_ATAS) == 0 ? "PRESSED" : "FREE"));
    }
  }

  // 3. Proses kontrol motor fisik
  processMotorControl();

  // 4. Publish Telemetri Dual Cloud (MQTT & Firebase) setiap 5 detik
  if (Tdata - lastMqttPublish >= 5000) {
    lastMqttPublish = Tdata;

    StaticJsonDocument<500> doc;
    doc["temp"] = temp;
    doc["hum"] = hum;
    doc["rain1"] = r1;
    doc["rain2"] = r2;
    doc["isRaining"] = isRaining;
    doc["blindStatus"] = (motorCounter >= MAX_COUNTER / 2) ? "closed" : "open";
    doc["fuzzyScore"] = fuzzyScore;
    doc["position"] = motorCounter;
    doc["maxPosition"] = MAX_COUNTER;
    doc["atTop"] = (motorCounter == 0);
    doc["atBottom"] = (motorCounter >= MAX_COUNTER);
    doc["motorLocked"] = motorLocked;
    doc["mode"] = (currentMode == AUTO) ? "auto" : "manual";
    doc["weatherStatus"] = weatherStatus;

    String output;
    serializeJson(doc, output);
    
    // Publish ke MQTT HiveMQ
    client.publish(topic_status, output.c_str());

    // Publish ke Firebase Realtime Database
    sendToFirebase(output);
  }
}
