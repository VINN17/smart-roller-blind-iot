#include "Arduino.h"
#include <WiFi.h>
#include <WebServer.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include "DHTesp.h"
#include "time.h"

// ==================== KONFIGURASI WiFi ====================
const char* ssid = "NotYOURSv2";
const char* password = "hahahahaha";
const char* mqtt_server = "broker.hivemq.com";
const int mqtt_port = 1883;

// Konfigurasi NTP
const char* ntpServer = "id.pool.ntp.org";
const long gmtOffset_sec = 7 * 3600;
const int daylightOffset_sec = 0;

// Client ID
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
int jam = 0;
int menit = 0;

// Motor position counter
int motorCounter = 0;  // Counter untuk posisi motor
const int MAX_COUNTER = 16900;  // Batas bawah (posisi turun penuh)
bool flag_m = 0;  // Flag untuk kontrol motor

// Status sistem
enum Mode { AUTO, MANUAL };
Mode currentMode = AUTO;

enum MotorCommand { CMD_NAIK, CMD_TURUN, CMD_STOP };
MotorCommand motorCommand = CMD_STOP;
MotorCommand targetCommand = CMD_STOP;  // Target untuk auto mode

bool isRaining = false;
String weatherStatus = "Cerah";
bool motorLocked = false;

// ==================== WEB SERVER ====================
WebServer server(80);

// ==================== MQTT TOPICS ====================
const char* topic_status = "jemuran/status";
const char* topic_control = "jemuran/control";
const char* topic_mode = "jemuran/mode";

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
    } else if (message == "manual") {
      currentMode = MANUAL;
      motorLocked = false;
      motorCommand = CMD_STOP;
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

// ==================== FUNGSI KONTROL MOTOR ====================
void processMotorControl() {
  // Selalu cek dan update posisi berdasarkan limit switch atas
  // Ini memastikan posisi selalu akurat di semua mode
  if (digitalRead(LIMIT_SWITCH_ATAS) == 0) {
    // Limit atas tertekan, pastikan counter = 0
    if (motorCounter != 0) {
      motorCounter = 0;
      Serial.println("Position corrected: Counter reset to 0 (at top)");
    }
  }

  MotorCommand activeCommand = (currentMode == AUTO) ? targetCommand : motorCommand;

  // Mode AUTO: cek apakah sudah di posisi target
  if (currentMode == AUTO) {
    // Sudah di atas dan target NAIK
    if (activeCommand == CMD_NAIK && motorCounter == 0 && digitalRead(LIMIT_SWITCH_ATAS) == 0) {
      if (!motorLocked) {
        digitalWrite(MOTOR_IN1, LOW);
        digitalWrite(MOTOR_IN2, LOW);
        analogWrite(MOTOR_EN, 0);
        motorLocked = true;
        flag_m = 1;
        Serial.println("AUTO: Reached TOP - Motor LOCKED");
      }
      return;
    }
    
    // Sudah di bawah dan target TURUN
    if (activeCommand == CMD_TURUN && motorCounter >= MAX_COUNTER) {
      if (!motorLocked) {
        digitalWrite(MOTOR_IN1, LOW);
        digitalWrite(MOTOR_IN2, LOW);
        analogWrite(MOTOR_EN, 0);
        motorLocked = true;
        Serial.println("AUTO: Reached BOTTOM - Motor LOCKED");
      }
      return;
    }
  }

  // ========== NAIK ==========
  if (activeCommand == CMD_NAIK) {
    // Cek limit switch atas
    if (digitalRead(LIMIT_SWITCH_ATAS) != 0) {
      // Belum kena limit atas, motor boleh jalan
      if (flag_m == 0) {
        digitalWrite(MOTOR_IN1, HIGH);
        digitalWrite(MOTOR_IN2, LOW);
        analogWrite(MOTOR_EN, 255);
        
        // Decrement counter (naik = kurangi counter)
        if (motorCounter > 0) {
          motorCounter--;
        } else {
          // Safety: counter sudah 0 tapi limit belum tertekan
          // Tetap jalankan motor sampai limit tertekan
        }
      }
    } else {
      // Limit atas tertekan (nilai 0)
      flag_m = 1;
      motorCounter = 0;  // Pastikan counter = 0
      
      // Stop motor
      digitalWrite(MOTOR_IN1, LOW);
      digitalWrite(MOTOR_IN2, LOW);
      analogWrite(MOTOR_EN, 0);
      
      if (currentMode == MANUAL && !motorLocked) {
        motorLocked = true;
        Serial.println("MANUAL: Limit ATAS tercapai - Motor LOCKED");
      }
    }
  }
  // ========== TURUN ==========
  else if (activeCommand == CMD_TURUN) {
    flag_m = 0;  // Reset flag saat mulai turun
    
    // Cek apakah sudah mencapai batas bawah
    if (motorCounter < MAX_COUNTER) {
      // Belum mencapai batas, motor jalan
      digitalWrite(MOTOR_IN1, LOW);
      digitalWrite(MOTOR_IN2, HIGH);
      analogWrite(MOTOR_EN, 255);
      
      // Increment counter (turun = tambah counter)
      motorCounter++;
      
    } else {
      // Sudah mencapai batas bawah (counter >= 3580)
      digitalWrite(MOTOR_IN1, LOW);
      digitalWrite(MOTOR_IN2, LOW);
      analogWrite(MOTOR_EN, 0);
      
      if (currentMode == MANUAL && !motorLocked) {
        motorLocked = true;
        Serial.println("MANUAL: Batas BAWAH tercapai - Motor LOCKED");
      }
    }
  }
  // ========== STOP ==========
  else {
    digitalWrite(MOTOR_IN1, LOW);
    digitalWrite(MOTOR_IN2, LOW);
    analogWrite(MOTOR_EN, 0);
    
    if (currentMode == MANUAL && !motorLocked) {
      motorLocked = true;
      Serial.println("Manual STOP - Motor LOCKED");
    }
  }
}

// ==================== WEB SERVER HANDLERS ====================
void handleRoot() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.send(200, "text/plain", "Smart Jemuran API Ready");
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
    motorCommand = CMD_STOP;
    server.send(200, "application/json", "{\"status\":\"ok\",\"mode\":\"auto\"}");
  } else if (mode == "manual") {
    currentMode = MANUAL;
    motorLocked = false;
    motorCommand = CMD_STOP;
    server.send(200, "application/json", "{\"status\":\"ok\",\"mode\":\"manual\"}");
  } else {
    server.send(400, "application/json", "{\"status\":\"error\",\"message\":\"Invalid mode\"}");
  }
}

void handleOptions() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
  server.send(204);
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
  Serial.println("Use this IP in the web interface: http://" + WiFi.localIP().toString());
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

  // Baca sensor setiap 2 detik
  if (Tdata - lastTdata >= 2000) {
    lastTdata = Tdata;

    if (!isnan(data.temperature) && !isnan(data.humidity)) {
      temp = data.temperature;
      hum = data.humidity;
    }

    r1 = map(analogRead(adc33), 4095, 0, 0, 100);
    r2 = map(analogRead(adc25), 4095, 0, 0, 100);
  }

  // Logika AUTO mode
  if (currentMode == AUTO) {
    if (Tdata - lastTdata1 >= 1000) {
      lastTdata1 = Tdata;

      float r_score = (r1 + r2) / 2.0;
      float decision_score = 0;

      // Hitung decision score
      if (jam >= 7 && jam <= 18) {
        if (r_score > 45 || hum > 85) {
          decision_score = 1;
        } else if (r_score > 37 && hum > 60) {
          decision_score = 0.9;
        } else if (temp > 28 && hum > 90) {
          decision_score = 0.8;
        } else {
          decision_score = 0;
        }
      } else {
        if (r_score > 45 || hum > 90) {
          decision_score = 1;
        } else if (r_score > 20 && hum > 90) {
          decision_score = 0.9;
        } else {
          decision_score = 0;
        }
      }

      // Tentukan target command
      MotorCommand newTargetCommand;
      if (decision_score >= 0.5) {
        isRaining = true;
        weatherStatus = "Hujan";
        newTargetCommand = CMD_TURUN;
      } else {
        isRaining = false;
        weatherStatus = "Cerah";
        newTargetCommand = CMD_NAIK;
      }

      // Cek apakah target berubah
      if (newTargetCommand != targetCommand) {
        Serial.print("Target berubah dari ");
        Serial.print(targetCommand == CMD_NAIK ? "NAIK" : (targetCommand == CMD_TURUN ? "TURUN" : "STOP"));
        Serial.print(" ke ");
        Serial.println(newTargetCommand == CMD_NAIK ? "NAIK" : "TURUN");
        
        targetCommand = newTargetCommand;
        motorLocked = false;  // Unlock saat target berubah
      }

      // Debug output - Tampilkan posisi real-time
      Serial.print("AUTO || Pos: ");
      Serial.print(motorCounter);
      Serial.print("/");
      Serial.print(MAX_COUNTER);
      Serial.print(" || Temp: ");
      Serial.print(temp);
      Serial.print("°C || Hum: ");
      Serial.print(hum);
      Serial.print("% || R_score: ");
      Serial.print(r_score);
      Serial.print(" || Decision: ");
      Serial.print(decision_score);
      Serial.print(" || Weather: ");
      Serial.print(weatherStatus);
      Serial.print(" || Target: ");
      Serial.print(targetCommand == CMD_NAIK ? "NAIK" : "TURUN");
      Serial.print(" || Locked: ");
      Serial.print(motorLocked ? "YES" : "NO");
      Serial.print(" || LimitTop: ");
      Serial.println(digitalRead(LIMIT_SWITCH_ATAS) == 0 ? "PRESSED" : "FREE");
    }
  }
  // Logika MANUAL mode
  else {
    if (Tdata - lastTdata1 >= 1000) {
      lastTdata1 = Tdata;
      
      float r_score = (r1 + r2) / 2.0;
      if (r_score > 45 || hum > 85) {
        isRaining = true;
        weatherStatus = "Hujan";
      } else {
        isRaining = false;
        weatherStatus = "Cerah";
      }

      // Debug output - Tampilkan posisi real-time
      Serial.print("MANUAL || Pos: ");
      Serial.print(motorCounter);
      Serial.print("/");
      Serial.print(MAX_COUNTER);
      Serial.print(" || Command: ");
      Serial.print(motorCommand == CMD_NAIK ? "NAIK" : (motorCommand == CMD_TURUN ? "TURUN" : "STOP"));
      Serial.print(" || Locked: ");
      Serial.print(motorLocked ? "YES" : "NO");
      Serial.print(" || LimitTop: ");
      Serial.println(digitalRead(LIMIT_SWITCH_ATAS) == 0 ? "PRESSED" : "FREE");
    }
  }

  // Proses kontrol motor
  processMotorControl();

  // Publish MQTT setiap 5 detik
  if (Tdata - lastMqttPublish >= 5000) {
    lastMqttPublish = Tdata;

    StaticJsonDocument<500> doc;
    doc["temp"] = temp;
    doc["hum"] = hum;
    doc["rain1"] = r1;
    doc["rain2"] = r2;
    doc["isRaining"] = isRaining;
    doc["position"] = motorCounter;
    doc["maxPosition"] = MAX_COUNTER;
    doc["atTop"] = (motorCounter == 0);
    doc["atBottom"] = (motorCounter >= MAX_COUNTER);
    doc["motorLocked"] = motorLocked;
    doc["mode"] = (currentMode == AUTO) ? "auto" : "manual";

    String output;
    serializeJson(doc, output);
    client.publish(topic_status, output.c_str());
  }
}
