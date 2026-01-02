
#include "Arduino.h"
#include <WiFi.h>
#include <WebServer.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include "DHTesp.h"
#include "time.h"

// ==================== KONFIGURASI WiFi ====================
const char* ssid = "realme C55";
const char* password = "polkanopski";
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
const int LIMIT_SWITCH_ATAS = 23;
const int LIMIT_SWITCH_BAWAH = 22;

DHTesp dhtSensor;

// ==================== VARIABEL GLOBAL ====================
unsigned long lastTdata = 0, lastTdata1 = 0, lastMqttPublish = 0;

float temp = 0;
float hum = 0;
int r1 = 0;
int r2 = 0;
int jam = 0;
int menit = 0;

// Status sistem
enum Mode { AUTO,
            MANUAL };
Mode currentMode = AUTO;

enum BlindStatus { NAIK,
                   TURUN,
                   BERHENTI };
BlindStatus blindStatus = BERHENTI;
BlindStatus targetStatus = BERHENTI;  // Target status untuk auto mode
BlindStatus lastCommandedStatus = BERHENTI;  // Status terakhir yang diperintahkan

bool isRaining = false;
String weatherStatus = "Cerah";
bool motorLocked = false;  // Flag untuk interlock
bool limitReached = false;  // Flag untuk menandai limit tercapai

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

  if (String(topic) == topic_control) {
    if (message == "naik") {
      requestMotorControl(NAIK);
    } else if (message == "turun") {
      requestMotorControl(TURUN);
    } else if (message == "stop") {
      requestMotorControl(BERHENTI);
    }
  }

  if (String(topic) == topic_mode) {
    if (message == "auto") {
      currentMode = AUTO;
      motorLocked = false;
      limitReached = false;
    } else if (message == "manual") {
      currentMode = MANUAL;
      motorLocked = false;
      limitReached = false;
    }
  }
}

// ==================== FUNGSI REQUEST KONTROL MOTOR ====================
void requestMotorControl(BlindStatus requestedStatus) {
  // Jika motor terkunci, cek apakah perintah berbeda dengan status sebelumnya
  if (motorLocked) {
    // Jika perintah berbeda dengan perintah sebelumnya, unlock motor
    if (requestedStatus != lastCommandedStatus) {
      Serial.println("Perintah berbeda terdeteksi - Unlocking motor");
      motorLocked = false;
      limitReached = false;
    } else {
      Serial.println("Motor masih terkunci - perintah diabaikan");
      return;
    }
  }

  // Simpan perintah terakhir
  lastCommandedStatus = requestedStatus;
  
  // Eksekusi kontrol motor
  controlMotor(requestedStatus);
}

// ==================== FUNGSI KONTROL MOTOR ====================
void controlMotor(BlindStatus status) {
  blindStatus = status;

  bool limitAtas = digitalRead(LIMIT_SWITCH_ATAS) == LOW;  // Tertekan = LOW (0)
  bool limitBawah = digitalRead(LIMIT_SWITCH_BAWAH) == HIGH;  // Tertekan = HIGH (1)

  if (status == NAIK) {
    if (!limitAtas) {  // Jika limit atas BELUM tertekan (masih HIGH)
      digitalWrite(MOTOR_IN1, HIGH);
      digitalWrite(MOTOR_IN2, LOW);
      analogWrite(MOTOR_EN, 255);
      Serial.println("Motor NAIK");
    } else {
      // Limit atas tercapai (tertekan = LOW)
      digitalWrite(MOTOR_IN1, LOW);
      digitalWrite(MOTOR_IN2, LOW);
      analogWrite(MOTOR_EN, 0);
      blindStatus = BERHENTI;
      motorLocked = true;  // Lock motor
      limitReached = true;
      Serial.println("Limit ATAS tercapai - Motor LOCKED");
    }
  } else if (status == TURUN) {
    if (!limitBawah) {  // Jika limit bawah BELUM tertekan (masih LOW)
      digitalWrite(MOTOR_IN1, LOW);
      digitalWrite(MOTOR_IN2, HIGH);
      analogWrite(MOTOR_EN, 255);
      Serial.println("Motor TURUN");
    } else {
      // Limit bawah tercapai (tertekan = HIGH)
      digitalWrite(MOTOR_IN1, LOW);
      digitalWrite(MOTOR_IN2, LOW);
      analogWrite(MOTOR_EN, 0);
      blindStatus = BERHENTI;
      motorLocked = true;  // Lock motor
      limitReached = true;
      Serial.println("Limit BAWAH tercapai - Motor LOCKED");
    }
  } else {  // BERHENTI
    digitalWrite(MOTOR_IN1, LOW);
    digitalWrite(MOTOR_IN2, LOW);
    analogWrite(MOTOR_EN, 0);
    Serial.println("Motor BERHENTI");
    
    // Jika mode manual dan stop diperintahkan, lock motor
    if (currentMode == MANUAL) {
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

  StaticJsonDocument<400> doc;
  doc["temp"] = temp;
  doc["hum"] = hum;
  doc["rain1"] = r1;
  doc["rain2"] = r2;
  doc["hour"] = jam;
  doc["minute"] = menit;
  doc["isRaining"] = isRaining;
  doc["blindStatus"] = (blindStatus == TURUN) ? "closed" : (blindStatus == NAIK ? "opening" : "open");
  doc["mode"] = (currentMode == AUTO) ? "auto" : "manual";
  doc["motorLocked"] = motorLocked;
  doc["limitReached"] = limitReached;

  String output;
  serializeJson(doc, output);
  server.send(200, "application/json", output);
}

void handleControl() {
  server.sendHeader("Access-Control-Allow-Origin", "*");

  if (currentMode == MANUAL) {
    String action = server.arg("action");
    if (action == "naik") {
      requestMotorControl(NAIK);
      server.send(200, "application/json", "{\"status\":\"ok\",\"action\":\"naik\"}");
    } else if (action == "turun") {
      requestMotorControl(TURUN);
      server.send(200, "application/json", "{\"status\":\"ok\",\"action\":\"turun\"}");
    } else if (action == "stop") {
      requestMotorControl(BERHENTI);
      server.send(200, "application/json", "{\"status\":\"ok\",\"action\":\"stop\"}");
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
    limitReached = false;
    controlMotor(BERHENTI);
    server.send(200, "application/json", "{\"status\":\"ok\",\"mode\":\"auto\"}");
  } else if (mode == "manual") {
    currentMode = MANUAL;
    motorLocked = false;
    limitReached = false;
    controlMotor(BERHENTI);
    server.send(200, "application/json", "{\"status\":\"ok\",\"mode\":\"manual\"}");
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

  if (Tdata - lastTdata >= 2000) {
    lastTdata = Tdata;

    if (!isnan(data.temperature) && !isnan(data.humidity)) {
      temp = data.temperature;
      hum = data.humidity;
    }

    r1 = map(analogRead(adc33), 4095, 0, 0, 100);
    r2 = map(analogRead(adc25), 4095, 0, 0, 100);
  }

  if (currentMode == AUTO) {
    if (Tdata - lastTdata1 >= 1000) {
      lastTdata1 = Tdata;

      float r_score = (r1 + r2) / 2.0;
      float decision_score = 0;

      // Hitung target status berdasarkan kondisi
      BlindStatus newTargetStatus;

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

      // Tentukan target status
      if (decision_score >= 0.5) {
        isRaining = true;
        weatherStatus = "Hujan";
        newTargetStatus = TURUN;
      } else {
        isRaining = false;
        weatherStatus = "Cerah";
        newTargetStatus = NAIK;
      }

      // Cek apakah target berubah
      if (newTargetStatus != targetStatus) {
        Serial.print("Target berubah dari ");
        Serial.print(targetStatus == NAIK ? "NAIK" : "TURUN");
        Serial.print(" ke ");
        Serial.println(newTargetStatus == NAIK ? "NAIK" : "TURUN");
        
        targetStatus = newTargetStatus;
        motorLocked = false;  // Unlock motor saat target berubah
        limitReached = false;
      }

      // Eksekusi kontrol hanya jika motor tidak terkunci
      if (!motorLocked) {
        if (targetStatus == TURUN && blindStatus != TURUN) {
          controlMotor(TURUN);
        } else if (targetStatus == NAIK && blindStatus != NAIK) {
          controlMotor(NAIK);
        }
      }

      Serial.print(analogRead(33));
      Serial.print(" || ");
      Serial.print(analogRead(32));
      Serial.print(" || ");
      Serial.print(data.temperature);
      Serial.print(" || ");
      Serial.println(data.humidity);
      Serial.print("Mode: AUTO || r_score: ");
      Serial.print(r_score);
      Serial.print(" || decision: ");
      Serial.print(decision_score);
      Serial.print(" || Status: ");
      Serial.print(weatherStatus);
      Serial.print(" || Target: ");
      Serial.print(targetStatus == NAIK ? "NAIK" : "TURUN");
      Serial.print(" || Locked: ");
      Serial.println(motorLocked ? "YES" : "NO");
    }
  } else {
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

      Serial.print("Mode: MANUAL || Blind Status: ");
      Serial.print(blindStatus == NAIK ? "NAIK" : (blindStatus == TURUN ? "TURUN" : "BERHENTI"));
      Serial.print(" || Locked: ");
      Serial.println(motorLocked ? "YES" : "NO");
    }
  }

  if (Tdata - lastMqttPublish >= 5000) {
    lastMqttPublish = Tdata;

    StaticJsonDocument<400> doc;
    doc["temp"] = temp;
    doc["hum"] = hum;
    doc["rain1"] = r1;
    doc["rain2"] = r2;
    doc["isRaining"] = isRaining;
    doc["blindStatus"] = (blindStatus == TURUN) ? "closed" : "open";
    doc["motorLocked"] = motorLocked;

    String output;
    serializeJson(doc, output);
    client.publish(topic_status, output.c_str());
  }

  // Cek limit switch saat motor bergerak
  if (blindStatus == NAIK && digitalRead(LIMIT_SWITCH_ATAS) == LOW) {  // Tertekan = LOW
    digitalWrite(MOTOR_IN1, LOW);
    digitalWrite(MOTOR_IN2, LOW);
    analogWrite(MOTOR_EN, 0);
    blindStatus = BERHENTI;
    motorLocked = true;
    limitReached = true;
    Serial.println("Limit ATAS tercapai - Motor LOCKED");
  }
  
  if (blindStatus == TURUN && digitalRead(LIMIT_SWITCH_BAWAH) == HIGH) {  // Tertekan = HIGH
    digitalWrite(MOTOR_IN1, LOW);
    digitalWrite(MOTOR_IN2, LOW);
    analogWrite(MOTOR_EN, 0);
    blindStatus = BERHENTI;
    motorLocked = true;
    limitReached = true;
    Serial.println("Limit BAWAH tercapai - Motor LOCKED");
  }
}
