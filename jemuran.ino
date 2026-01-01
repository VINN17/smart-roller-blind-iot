
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

// Status sistem
enum Mode { AUTO,
            MANUAL };
Mode currentMode = AUTO;

enum BlindStatus { NAIK,
                   TURUN,
                   BERHENTI };
BlindStatus blindStatus = BERHENTI;

bool isRaining = false;
String weatherStatus = "Cerah";

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
      controlMotor(NAIK);
    } else if (message == "turun") {
      controlMotor(TURUN);
    } else if (message == "stop") {
      controlMotor(BERHENTI);
    }
  }

  if (String(topic) == topic_mode) {
    if (message == "auto") {
      currentMode = AUTO;
    } else if (message == "manual") {
      currentMode = MANUAL;
    }
  }
}

// ==================== FUNGSI KONTROL MOTOR ====================
void controlMotor(BlindStatus status) {
  blindStatus = status;

  bool limitAtas = digitalRead(LIMIT_SWITCH_ATAS) == LOW;
  bool limitBawah = digitalRead(LIMIT_SWITCH_BAWAH) == LOW;

  if (status == NAIK) {
    if (!limitAtas) {
      digitalWrite(MOTOR_IN1, HIGH);
      digitalWrite(MOTOR_IN2, LOW);
      analogWrite(MOTOR_EN, 255);
    } else {
      controlMotor(BERHENTI);
    }
  } else if (status == TURUN) {
    if (!limitBawah) {
      digitalWrite(MOTOR_IN1, LOW);
      digitalWrite(MOTOR_IN2, HIGH);
      analogWrite(MOTOR_EN, 255);
    } else {
      controlMotor(BERHENTI);
    }
  } else {
    digitalWrite(MOTOR_IN1, LOW);
    digitalWrite(MOTOR_IN2, LOW);
    analogWrite(MOTOR_EN, 0);
  }
}

// ==================== WEB SERVER HANDLERS ====================
void handleRoot() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.send(200, "text/plain", "Smart Jemuran API Ready");
}

void handleData() {
  server.sendHeader("Access-Control-Allow-Origin", "*");

  StaticJsonDocument<300> doc;
  doc["temp"] = temp;
  doc["hum"] = hum;
  doc["rain1"] = r1;
  doc["rain2"] = r2;
  doc["hour"] = jam;
  doc["minute"] = menit;
  doc["isRaining"] = isRaining;
  doc["blindStatus"] = (blindStatus == TURUN) ? "closed" : "open";
  doc["mode"] = (currentMode == AUTO) ? "auto" : "manual";

  String output;
  serializeJson(doc, output);
  server.send(200, "application/json", output);
}

void handleControl() {
  server.sendHeader("Access-Control-Allow-Origin", "*");

  if (currentMode == MANUAL) {
    String action = server.arg("action");
    if (action == "naik") {
      controlMotor(NAIK);
      server.send(200, "application/json", "{\"status\":\"ok\",\"action\":\"naik\"}");
    } else if (action == "turun") {
      controlMotor(TURUN);
      server.send(200, "application/json", "{\"status\":\"ok\",\"action\":\"turun\"}");
    } else if (action == "stop") {
      controlMotor(BERHENTI);
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
    server.send(200, "application/json", "{\"status\":\"ok\",\"mode\":\"auto\"}");
  } else if (mode == "manual") {
    currentMode = MANUAL;
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

      if (decision_score >= 0.5) {
        isRaining = true;
        weatherStatus = "Hujan";
        if (blindStatus != TURUN) {
          controlMotor(TURUN);
        }
      } else {
        isRaining = false;
        weatherStatus = "Cerah";
        if (blindStatus != NAIK) {
          controlMotor(NAIK);
        }
      }

      // Serial.print("a33: ");
      Serial.print(analogRead(33));
      Serial.print(" || ");
      // Serial.print("a25: ");
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
      Serial.println(weatherStatus);
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
      Serial.println(blindStatus == NAIK ? "NAIK" : (blindStatus == TURUN ? "TURUN" : "BERHENTI"));
    }
  }

  if (Tdata - lastMqttPublish >= 5000) {
    lastMqttPublish = Tdata;

    StaticJsonDocument<300> doc;
    doc["temp"] = temp;
    doc["hum"] = hum;
    doc["rain1"] = r1;
    doc["rain2"] = r2;
    doc["isRaining"] = isRaining;
    doc["blindStatus"] = (blindStatus == TURUN) ? "closed" : "open";

    String output;
    serializeJson(doc, output);
    client.publish(topic_status, output.c_str());
  }

  if (digitalRead(LIMIT_SWITCH_ATAS) == LOW && blindStatus == NAIK) {
    controlMotor(BERHENTI);
    Serial.println("Limit atas tercapai - motor stop");
  }
  if (digitalRead(LIMIT_SWITCH_BAWAH) == LOW && blindStatus == TURUN) {
    controlMotor(BERHENTI);
    Serial.println("Limit bawah tercapai - motor stop");
  }
}
