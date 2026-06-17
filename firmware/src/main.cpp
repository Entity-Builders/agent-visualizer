#include <Arduino.h>
#include <LovyanGFX.hpp>
#include <Wire.h>

namespace {
constexpr int16_t SCREEN_WIDTH = 240;
constexpr int16_t SCREEN_HEIGHT = 240;
constexpr int16_t SCREEN_CENTER_X = SCREEN_WIDTH / 2;
constexpr int16_t SCREEN_CENTER_Y = SCREEN_HEIGHT / 2;

// ESP32-C3 1.28" round GC9A01 board class, commonly sold as ESP32-2424S012.
// Verified against the factory backup: chip is ESP32-C3, 4MB flash, LVGL demo.
constexpr int TFT_BL = 3;
constexpr int TFT_SCLK = 6;
constexpr int TFT_MOSI = 7;
constexpr int TFT_DC = 2;
constexpr int TFT_CS = 10;
constexpr int TFT_RST = -1;

// CST816D capacitive touch controller used by the touch-enabled ESP32-2424S012.
constexpr int TOUCH_SDA = 4;
constexpr int TOUCH_SCL = 5;
constexpr int TOUCH_INT = 0;
constexpr int TOUCH_RST = 1;
constexpr uint8_t TOUCH_ADDR = 0x15;

constexpr uint16_t COLOR_BLACK = TFT_BLACK;
constexpr uint16_t COLOR_PANEL = 0x10A4;
constexpr uint16_t COLOR_PANEL_DIM = 0x08A3;
constexpr uint16_t COLOR_WHITE = TFT_WHITE;
constexpr uint16_t COLOR_MUTED = 0xC638;
constexpr uint16_t COLOR_GREEN = 0x7FE8;
constexpr uint16_t COLOR_BLUE = 0x3D9F;
constexpr uint16_t COLOR_RED = 0xEACB;
constexpr uint16_t COLOR_AMBER = 0xFEA0;

class RoundDisplay : public lgfx::LGFX_Device {
 private:
  lgfx::Panel_GC9A01 panel_;
  lgfx::Bus_SPI bus_;

 public:
  RoundDisplay() {
    {
      auto cfg = bus_.config();
      cfg.spi_host = SPI2_HOST;
      cfg.spi_mode = 0;
      cfg.freq_write = 80000000;
      cfg.freq_read = 20000000;
      cfg.spi_3wire = true;
      cfg.use_lock = true;
      cfg.dma_channel = SPI_DMA_CH_AUTO;
      cfg.pin_sclk = TFT_SCLK;
      cfg.pin_mosi = TFT_MOSI;
      cfg.pin_miso = -1;
      cfg.pin_dc = TFT_DC;
      bus_.config(cfg);
      panel_.setBus(&bus_);
    }

    {
      auto cfg = panel_.config();
      cfg.pin_cs = TFT_CS;
      cfg.pin_rst = TFT_RST;
      cfg.pin_busy = -1;
      cfg.memory_width = SCREEN_WIDTH;
      cfg.memory_height = SCREEN_HEIGHT;
      cfg.panel_width = SCREEN_WIDTH;
      cfg.panel_height = SCREEN_HEIGHT;
      cfg.offset_x = 0;
      cfg.offset_y = 0;
      cfg.offset_rotation = 0;
      cfg.dummy_read_pixel = 8;
      cfg.dummy_read_bits = 1;
      cfg.readable = false;
      cfg.invert = true;
      cfg.rgb_order = false;
      cfg.dlen_16bit = false;
      cfg.bus_shared = false;
      panel_.config(cfg);
    }

    setPanel(&panel_);
  }
};

RoundDisplay display;
String serialBuffer;
String currentState = "standby";
bool displayReady = false;
bool touchReady = false;
bool touchPressed = false;
unsigned long lastTouchAlertAt = 0;

struct TouchSample {
  bool pressed = false;
  uint16_t x = 0;
  uint16_t y = 0;
  uint8_t gesture = 0;
};

void printCentered(const String &text, int32_t y, float size, uint16_t color) {
  display.setTextSize(size);
  display.setTextColor(color, COLOR_BLACK);
  const int32_t width = display.textWidth(text);
  display.setCursor((SCREEN_WIDTH - width) / 2, y);
  display.print(text);
}

void drawBase(uint16_t background, uint16_t glow) {
  if (!displayReady) {
    return;
  }

  display.startWrite();
  display.fillScreen(COLOR_BLACK);
  display.fillCircle(SCREEN_CENTER_X, SCREEN_CENTER_Y, 116, background);
  display.drawCircle(SCREEN_CENTER_X, SCREEN_CENTER_Y, 116, glow);
  display.drawCircle(SCREEN_CENTER_X, SCREEN_CENTER_Y, 110, COLOR_PANEL_DIM);
  display.endWrite();
}

void drawFace(uint16_t accent, bool alert, bool happy) {
  if (!displayReady) {
    return;
  }

  display.startWrite();
  const int16_t eyeY = 86;
  const int16_t eyeRadius = alert ? 12 : 10;
  display.fillRoundRect(82, eyeY, 24, 24, 6, accent);
  display.fillRoundRect(134, eyeY, 24, 24, 6, accent);

  if (happy) {
    display.drawLine(92, 142, 108, 154, accent);
    display.drawLine(108, 154, 132, 154, accent);
    display.drawLine(132, 154, 148, 142, accent);
  } else if (alert) {
    display.fillRect(92, 146, 56, 10, accent);
    display.fillCircle(92, 151, 5, accent);
    display.fillCircle(148, 151, 5, accent);
  } else {
    display.fillRoundRect(96, 145, 48, 9, 5, accent);
  }

  display.drawCircle(94, eyeY + 12, eyeRadius, accent);
  display.drawCircle(146, eyeY + 12, eyeRadius, accent);
  display.endWrite();
}

void drawState(const String &state) {
  currentState = state;

  if (state == "working") {
    drawBase(0x09E9, COLOR_BLUE);
    drawFace(COLOR_BLUE, false, false);
    if (displayReady) {
      display.fillRect(62, 48, 116, 6, COLOR_BLUE);
      printCentered("SCAN", 174, 3, COLOR_WHITE);
      printCentered("READING FILES", 204, 1, COLOR_MUTED);
    }
    Serial.println("ACK:STATE:working");
    return;
  }

  if (state == "error") {
    drawBase(0x5000, COLOR_RED);
    drawFace(COLOR_RED, true, false);
    if (displayReady) {
      printCentered("ERR", 174, 3, COLOR_WHITE);
      printCentered("TIMEOUT ERROR", 204, 1, COLOR_AMBER);
    }
    Serial.println("ACK:STATE:error");
    return;
  }

  if (state == "done") {
    drawBase(0x1248, COLOR_GREEN);
    drawFace(COLOR_GREEN, false, true);
    if (displayReady) {
      display.drawCircle(SCREEN_CENTER_X, 52, 15, COLOR_GREEN);
      display.fillRect(116, 64, 8, 13, COLOR_GREEN);
      printCentered("DONE", 174, 3, COLOR_WHITE);
      printCentered("TASK COMPLETE", 204, 1, COLOR_MUTED);
    }
    Serial.println("ACK:STATE:done");
    return;
  }

  drawBase(COLOR_PANEL, COLOR_MUTED);
  drawFace(COLOR_MUTED, false, false);
  if (displayReady) {
    printCentered("Zzz", 174, 3, COLOR_WHITE);
    printCentered("STANDBY", 204, 1, COLOR_MUTED);
  }
  currentState = "standby";
  Serial.println("ACK:STATE:standby");
}

void drawTextMessage(const String &message) {
  String line = message;
  line.trim();
  if (line.length() > 22) {
    line = line.substring(0, 22);
  }

  drawBase(COLOR_PANEL, COLOR_AMBER);
  drawFace(COLOR_AMBER, false, false);
  if (displayReady) {
    printCentered("TEXT", 42, 2, COLOR_AMBER);
    printCentered(line, 174, 2, COLOR_WHITE);
  }

  Serial.print("ACK:TEXT:");
  Serial.println(line);
}

void drawTouchPress(const TouchSample &sample) {
  if (!displayReady) {
    return;
  }

  const int16_t x = constrain(static_cast<int16_t>(sample.x), 16, SCREEN_WIDTH - 16);
  const int16_t y = constrain(static_cast<int16_t>(sample.y), 16, SCREEN_HEIGHT - 16);

  display.startWrite();
  display.fillCircle(x, y, 14, COLOR_AMBER);
  display.drawCircle(x, y, 21, COLOR_WHITE);
  display.drawCircle(x, y, 28, COLOR_AMBER);
  display.endWrite();

  printCentered("PRESS", 32, 2, COLOR_AMBER);
}

void drawHello() {
  drawBase(0x0A86, COLOR_GREEN);
  drawFace(COLOR_GREEN, false, true);
  if (displayReady) {
    printCentered("HELLO", 174, 3, COLOR_WHITE);
    printCentered("AGENT VISUALIZER", 204, 1, COLOR_MUTED);
  }
  Serial.println("ACK:HELLO:agent-visualizer");
}

bool probeTouchController() {
  Wire.beginTransmission(TOUCH_ADDR);
  return Wire.endTransmission() == 0;
}

void initTouch() {
  pinMode(TOUCH_INT, INPUT_PULLUP);
  pinMode(TOUCH_RST, OUTPUT);
  digitalWrite(TOUCH_RST, LOW);
  delay(5);
  digitalWrite(TOUCH_RST, HIGH);
  delay(50);

  Wire.begin(TOUCH_SDA, TOUCH_SCL);
  Wire.setClock(400000);
  touchReady = probeTouchController();
  Serial.println(touchReady ? "INFO:TOUCH:CST816D" : "WARN:TOUCH_INIT_FAILED");
}

bool readTouchSample(TouchSample &sample) {
  sample = TouchSample{};

  if (!touchReady) {
    return false;
  }

  Wire.beginTransmission(TOUCH_ADDR);
  Wire.write(0x01);
  if (Wire.endTransmission(false) != 0) {
    return false;
  }

  const uint8_t bytesRead = Wire.requestFrom(TOUCH_ADDR, static_cast<uint8_t>(6));
  if (bytesRead != 6) {
    while (Wire.available() > 0) {
      Wire.read();
    }
    return false;
  }

  const uint8_t gesture = Wire.read();
  const uint8_t points = Wire.read() & 0x0F;
  const uint8_t xHigh = Wire.read();
  const uint8_t xLow = Wire.read();
  const uint8_t yHigh = Wire.read();
  const uint8_t yLow = Wire.read();

  sample.pressed = points > 0;
  sample.gesture = gesture;
  sample.x = static_cast<uint16_t>(((xHigh & 0x0F) << 8) | xLow);
  sample.y = static_cast<uint16_t>(((yHigh & 0x0F) << 8) | yLow);
  return true;
}

void emitTouchAlert(const TouchSample &sample) {
  Serial.print("ALERT:TOUCH_PRESS:");
  Serial.print(sample.x);
  Serial.print(":");
  Serial.print(sample.y);
  Serial.print(":");
  Serial.println(sample.gesture);
}

void handleCommand(String line) {
  line.trim();
  if (line.length() == 0) {
    return;
  }

  if (line == "HELLO") {
    drawHello();
    return;
  }

  if (line == "PING") {
    Serial.println("ACK:PONG");
    return;
  }

  if (line == "INFO") {
    Serial.println("INFO:BOARD:esp32-c3-round-gc9a01");
    Serial.println(displayReady ? "INFO:DISPLAY:ready" : "INFO:DISPLAY:not-ready");
    Serial.println(touchReady ? "INFO:TOUCH:ready" : "INFO:TOUCH:not-ready");
    Serial.println("INFO:FLASH:4MB");
    return;
  }

  if (line.startsWith("STATE:")) {
    String state = line.substring(6);
    state.trim();
    state.toLowerCase();

    if (state == "standby" || state == "working" || state == "error" || state == "done") {
      drawState(state);
      return;
    }

    Serial.print("ERR:UNKNOWN_STATE:");
    Serial.println(state);
    return;
  }

  if (line.startsWith("TEXT:")) {
    drawTextMessage(line.substring(5));
    return;
  }

  Serial.print("ERR:UNKNOWN_COMMAND:");
  Serial.println(line);
}

void pollSerial() {
  while (Serial.available() > 0) {
    const char nextChar = static_cast<char>(Serial.read());
    if (nextChar == '\n') {
      handleCommand(serialBuffer);
      serialBuffer = "";
      continue;
    }

    if (nextChar != '\r') {
      serialBuffer += nextChar;
    }

    if (serialBuffer.length() > 120) {
      serialBuffer = "";
      Serial.println("ERR:LINE_TOO_LONG");
    }
  }
}

void pollTouch() {
  static unsigned long lastTouchPollAt = 0;

  if (!touchReady || millis() - lastTouchPollAt < 35) {
    return;
  }
  lastTouchPollAt = millis();

  TouchSample sample;
  if (!readTouchSample(sample)) {
    touchPressed = false;
    return;
  }

  if (!sample.pressed) {
    touchPressed = false;
    return;
  }

  if (!touchPressed && millis() - lastTouchAlertAt > 220) {
    lastTouchAlertAt = millis();
    touchPressed = true;
    emitTouchAlert(sample);
    drawTouchPress(sample);
    return;
  }

  touchPressed = true;
}
} // namespace

void setup() {
  delay(900);
  Serial.begin(115200);
  const unsigned long serialStart = millis();
  while (!Serial && millis() - serialStart < 1800) {
    delay(10);
  }

  pinMode(TFT_BL, OUTPUT);
  digitalWrite(TFT_BL, HIGH);

  displayReady = display.init();
  if (displayReady) {
    display.initDMA();
    display.setBrightness(255);
    display.fillScreen(COLOR_BLACK);
  }

  Serial.println("READY:agent-visualizer:v0");
  Serial.println("INFO:MCU:ESP32-C3");
  Serial.println(displayReady ? "INFO:DISPLAY:GC9A01" : "WARN:DISPLAY_INIT_FAILED");
  initTouch();

  drawState("standby");
}

void loop() {
  pollSerial();
  pollTouch();

  if (displayReady && currentState == "working") {
    static unsigned long lastPulse = 0;
    static int16_t scanY = 54;
    if (millis() - lastPulse > 260) {
      lastPulse = millis();
      display.fillRect(62, scanY, 116, 6, 0x09E9);
      scanY += 12;
      if (scanY > 150) {
        scanY = 54;
      }
      display.fillRect(62, scanY, 116, 6, COLOR_BLUE);
    }
  }
}
