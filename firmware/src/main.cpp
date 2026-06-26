#include <Arduino.h>
#include <FS.h>
#include <LovyanGFX.hpp>
#include <SPIFFS.h>
#include <Wire.h>
#include <mbedtls/base64.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

#include "public_lottie_frames.h"

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
constexpr uint16_t COLOR_SOFT_GRAY = 0xE73C;

constexpr uint32_t UPLOADED_ANIM_MAGIC = 0x31465641; // AVF1 little-endian.
constexpr uint16_t UPLOADED_ANIM_MAX_WIDTH = 180;
constexpr uint16_t UPLOADED_ANIM_MAX_HEIGHT = 180;
constexpr uint16_t UPLOADED_ANIM_MAX_FRAMES = 32;
constexpr uint32_t UPLOADED_ANIM_MAX_BYTES = 760000;
constexpr uint32_t TOUCH_ANIMATION_DURATION_MS = 4500;
constexpr size_t UPLOAD_CHUNK_MAX_BYTES = 420;
constexpr uint32_t SERIAL_BAUD_RATE = 921600;
constexpr size_t UPLOAD_BINARY_CHUNK_MAX_BYTES = 2048;
constexpr uint32_t UPLOAD_BINARY_CHUNK_TIMEOUT_MS = 5000;
constexpr size_t BLE_COMMAND_MAX_LENGTH = 160;
const char *BLE_DEVICE_NAME = "AgentVis-C3";
const char *BLE_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const char *BLE_RX_CHARACTERISTIC_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
const char *BLE_TX_CHARACTERISTIC_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";
const char *UPLOADED_ANIM_PATH = "/current.anim";
const char *UPLOADED_ANIM_TMP_PATH = "/current.anim.tmp";
const char *BOOT_STATE_PATH = "/boot.state";

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
bool publicLottiePlaying = false;
bool uploadedAnimationPlaying = false;
bool spiffsReady = false;
uint16_t publicLottieFrame = 0;
unsigned long lastTouchAlertAt = 0;
unsigned long lastPublicLottieFrameAt = 0;
unsigned long lastUploadedFrameAt = 0;
unsigned long uploadedAnimationStopAt = 0;
uint16_t uploadedFrameIndex = 0;
uint16_t uploadedFrameWidth = 0;
uint16_t uploadedFrameHeight = 0;
uint16_t uploadedFrameCount = 0;
uint16_t uploadedFrameFps = 0;
uint32_t uploadedDataSize = 0;
uint32_t uploadedDataStart = 0;
uint32_t uploadedFrameOffsets[UPLOADED_ANIM_MAX_FRAMES + 1];
uint16_t uploadedFrameBuffer[UPLOADED_ANIM_MAX_WIDTH * UPLOADED_ANIM_MAX_HEIGHT];

bool uploadActive = false;
bool uploadedAnimationTimed = false;
bool binaryUploadChunkActive = false;
bool bleDeviceConnected = false;
bool bleOldDeviceConnected = false;
File uploadFile;
BLEServer *bleServer = nullptr;
BLECharacteristic *bleTxCharacteristic = nullptr;
BLECharacteristic *bleRxCharacteristic = nullptr;
QueueHandle_t bleCommandQueue = nullptr;
uint32_t uploadExpectedBytes = 0;
uint32_t uploadReceivedBytes = 0;
uint32_t uploadExpectedCrc = 0;
uint32_t uploadCrc = 0xFFFFFFFF;
unsigned long binaryUploadChunkStartedAt = 0;
size_t binaryUploadChunkExpected = 0;
size_t binaryUploadChunkReceived = 0;
uint8_t binaryUploadChunkBuffer[UPLOAD_BINARY_CHUNK_MAX_BYTES];

struct BleCommandMessage {
  char line[BLE_COMMAND_MAX_LENGTH];
};

struct TouchSample {
  bool pressed = false;
  uint16_t x = 0;
  uint16_t y = 0;
  uint8_t gesture = 0;
};

struct UploadedAnimationHeader {
  uint32_t magic;
  uint16_t width;
  uint16_t height;
  uint16_t frameCount;
  uint16_t fps;
  uint32_t dataSize;
};

void notifyBleLine(const String &line) {
  if (!bleDeviceConnected || bleTxCharacteristic == nullptr) {
    return;
  }

  const String payload = line + "\n";
  bleTxCharacteristic->setValue(
      reinterpret_cast<uint8_t *>(const_cast<char *>(payload.c_str())),
      payload.length());
  bleTxCharacteristic->notify();
  delay(3);
}

void emitLine(const String &line) {
  Serial.println(line);
  notifyBleLine(line);
}

void emitLine(const char *line) {
  emitLine(String(line));
}

void enqueueBleCommand(const std::string &value) {
  if (bleCommandQueue == nullptr || value.length() == 0) {
    return;
  }

  BleCommandMessage message{};
  size_t outputIndex = 0;
  for (size_t inputIndex = 0; inputIndex < value.length() && outputIndex < BLE_COMMAND_MAX_LENGTH - 1;
       inputIndex += 1) {
    const char next = value[inputIndex];
    if (next == '\n') {
      break;
    }
    if (next != '\r') {
      message.line[outputIndex] = next;
      outputIndex += 1;
    }
  }

  if (outputIndex == 0) {
    return;
  }

  message.line[outputIndex] = '\0';
  xQueueSend(bleCommandQueue, &message, 0);
}

class AgentBleServerCallbacks : public BLEServerCallbacks {
 public:
  void onConnect(BLEServer *server) override {
    bleDeviceConnected = true;
  }

  void onDisconnect(BLEServer *server) override {
    bleDeviceConnected = false;
  }
};

class AgentBleRxCallbacks : public BLECharacteristicCallbacks {
 public:
  void onWrite(BLECharacteristic *characteristic) override {
    enqueueBleCommand(characteristic->getValue());
  }
};

void initBle() {
  bleCommandQueue = xQueueCreate(8, sizeof(BleCommandMessage));
  if (bleCommandQueue == nullptr) {
    emitLine("WARN:BLE_QUEUE_FAILED");
    return;
  }

  BLEDevice::init(BLE_DEVICE_NAME);
  BLEDevice::setMTU(185);

  bleServer = BLEDevice::createServer();
  bleServer->setCallbacks(new AgentBleServerCallbacks());

  BLEService *service = bleServer->createService(BLE_SERVICE_UUID);
  bleTxCharacteristic = service->createCharacteristic(
      BLE_TX_CHARACTERISTIC_UUID,
      BLECharacteristic::PROPERTY_NOTIFY);
  bleTxCharacteristic->addDescriptor(new BLE2902());

  bleRxCharacteristic = service->createCharacteristic(
      BLE_RX_CHARACTERISTIC_UUID,
      BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  bleRxCharacteristic->setCallbacks(new AgentBleRxCallbacks());

  service->start();

  BLEAdvertising *advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(BLE_SERVICE_UUID);
  advertising->setScanResponse(true);
  advertising->setMinPreferred(0x06);
  advertising->setMinPreferred(0x12);
  BLEDevice::startAdvertising();
  emitLine("INFO:BLE:ready");
}

void printCentered(const String &text, int32_t y, float size, uint16_t color) {
  display.setTextSize(size);
  display.setTextColor(color, COLOR_BLACK);
  const int32_t width = display.textWidth(text);
  display.setCursor((SCREEN_WIDTH - width) / 2, y);
  display.print(text);
}

void stopAnimations() {
  publicLottiePlaying = false;
  uploadedAnimationPlaying = false;
  uploadedAnimationTimed = false;
  uploadedAnimationStopAt = 0;
}

void drawUploadStatus() {
  if (!displayReady) {
    return;
  }

  display.startWrite();
  display.fillScreen(COLOR_WHITE);
  display.drawCircle(SCREEN_CENTER_X, SCREEN_CENTER_Y, 116, COLOR_AMBER);
  display.drawCircle(SCREEN_CENTER_X, SCREEN_CENTER_Y, 110, COLOR_SOFT_GRAY);
  display.endWrite();
  printCentered("UPLOAD", 96, 3, COLOR_BLACK);
  printCentered("RECIBIENDO ASSET", 134, 1, COLOR_PANEL);
}

uint32_t updateCrc32(uint32_t crc, const uint8_t *data, size_t length) {
  for (size_t i = 0; i < length; i += 1) {
    crc ^= data[i];
    for (uint8_t bit = 0; bit < 8; bit += 1) {
      crc = (crc >> 1) ^ (0xEDB88320UL & (0UL - (crc & 1UL)));
    }
  }
  return crc;
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

void drawStandbyVisual() {
  drawBase(COLOR_PANEL, COLOR_MUTED);
  drawFace(COLOR_MUTED, false, false);
  if (displayReady) {
    printCentered("Zzz", 174, 3, COLOR_WHITE);
    printCentered("STANDBY", 204, 1, COLOR_MUTED);
  }
}

void enterTapUploadedMode() {
  stopAnimations();
  drawStandbyVisual();
  currentState = "tap-uploaded-animation";
}

void drawState(const String &state) {
  stopAnimations();
  currentState = state;

  if (state == "working") {
    drawBase(0x09E9, COLOR_BLUE);
    drawFace(COLOR_BLUE, false, false);
    if (displayReady) {
      display.fillRect(62, 48, 116, 6, COLOR_BLUE);
      printCentered("SCAN", 174, 3, COLOR_WHITE);
      printCentered("READING FILES", 204, 1, COLOR_MUTED);
    }
    emitLine("ACK:STATE:working");
    return;
  }

  if (state == "error") {
    drawBase(0x5000, COLOR_RED);
    drawFace(COLOR_RED, true, false);
    if (displayReady) {
      printCentered("ERR", 174, 3, COLOR_WHITE);
      printCentered("TIMEOUT ERROR", 204, 1, COLOR_AMBER);
    }
    emitLine("ACK:STATE:error");
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
    emitLine("ACK:STATE:done");
    return;
  }

  drawStandbyVisual();
  currentState = "standby";
  emitLine("ACK:STATE:standby");
}

void drawTextMessage(const String &message) {
  stopAnimations();
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

  emitLine("ACK:TEXT:" + line);
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
  stopAnimations();
  drawBase(0x0A86, COLOR_GREEN);
  drawFace(COLOR_GREEN, false, true);
  if (displayReady) {
    printCentered("HELLO", 174, 3, COLOR_WHITE);
    printCentered("AGENT VISUALIZER", 204, 1, COLOR_MUTED);
  }
  emitLine("ACK:HELLO:agent-visualizer");
}

void drawPublicLottieFrame() {
  if (!displayReady) {
    return;
  }

  const uint16_t *frame =
      PUBLIC_LOTTIE_FRAMES + (publicLottieFrame * PUBLIC_LOTTIE_FRAME_PIXELS);
  const int16_t x = (SCREEN_WIDTH - PUBLIC_LOTTIE_FRAME_WIDTH) / 2;
  const int16_t y = (SCREEN_HEIGHT - PUBLIC_LOTTIE_FRAME_HEIGHT) / 2;
  display.startWrite();
  display.pushImage(x, y, PUBLIC_LOTTIE_FRAME_WIDTH, PUBLIC_LOTTIE_FRAME_HEIGHT, frame);
  display.endWrite();
}

void startPublicLottie() {
  currentState = "public-lottie";
  publicLottiePlaying = true;
  uploadedAnimationPlaying = false;
  publicLottieFrame = 0;
  lastPublicLottieFrameAt = 0;

  if (displayReady) {
    display.startWrite();
    display.fillScreen(COLOR_WHITE);
    display.drawCircle(SCREEN_CENTER_X, SCREEN_CENTER_Y, 116, COLOR_AMBER);
    display.drawCircle(SCREEN_CENTER_X, SCREEN_CENTER_Y, 110, 0xE73C);
    display.endWrite();
    drawPublicLottieFrame();
  }

  emitLine("ACK:ANIM:PUBLIC_LOTTIE");
}

bool loadUploadedAnimationMetadata() {
  if (!spiffsReady || !SPIFFS.exists(UPLOADED_ANIM_PATH)) {
    return false;
  }

  File file = SPIFFS.open(UPLOADED_ANIM_PATH, FILE_READ);
  if (!file) {
    return false;
  }

  UploadedAnimationHeader header{};
  if (file.readBytes(reinterpret_cast<char *>(&header), sizeof(header)) != sizeof(header)) {
    file.close();
    return false;
  }

  if (header.magic != UPLOADED_ANIM_MAGIC || header.width == 0 || header.height == 0 ||
      header.width > UPLOADED_ANIM_MAX_WIDTH || header.height > UPLOADED_ANIM_MAX_HEIGHT ||
      header.frameCount == 0 || header.frameCount > UPLOADED_ANIM_MAX_FRAMES ||
      header.fps == 0 || header.fps > 30) {
    file.close();
    return false;
  }

  const size_t offsetsBytes = static_cast<size_t>(header.frameCount + 1) * sizeof(uint32_t);
  if (file.readBytes(reinterpret_cast<char *>(uploadedFrameOffsets), offsetsBytes) != offsetsBytes) {
    file.close();
    return false;
  }

  uploadedFrameWidth = header.width;
  uploadedFrameHeight = header.height;
  uploadedFrameCount = header.frameCount;
  uploadedFrameFps = header.fps;
  uploadedDataSize = header.dataSize;
  uploadedDataStart = sizeof(UploadedAnimationHeader) + offsetsBytes;

  file.close();
  return true;
}

bool drawUploadedAnimationFrame() {
  if (!displayReady || !spiffsReady || uploadedFrameCount == 0) {
    return false;
  }

  const uint32_t frameStart = uploadedFrameOffsets[uploadedFrameIndex];
  const uint32_t frameEnd = uploadedFrameOffsets[uploadedFrameIndex + 1];
  const uint32_t expectedPixels =
      static_cast<uint32_t>(uploadedFrameWidth) * static_cast<uint32_t>(uploadedFrameHeight);

  if (frameEnd < frameStart || frameEnd > uploadedDataSize ||
      expectedPixels > UPLOADED_ANIM_MAX_WIDTH * UPLOADED_ANIM_MAX_HEIGHT) {
    return false;
  }

  File file = SPIFFS.open(UPLOADED_ANIM_PATH, FILE_READ);
  if (!file || !file.seek(uploadedDataStart + frameStart, SeekSet)) {
    if (file) {
      file.close();
    }
    return false;
  }

  uint32_t writtenPixels = 0;
  while (file.position() < uploadedDataStart + frameEnd && writtenPixels < expectedPixels) {
    uint8_t run[4];
    if (file.read(run, sizeof(run)) != sizeof(run)) {
      file.close();
      return false;
    }

    const uint16_t count = static_cast<uint16_t>(run[0] | (run[1] << 8));
    const uint16_t color = static_cast<uint16_t>(run[2] | (run[3] << 8));
    if (count == 0 || writtenPixels + count > expectedPixels) {
      file.close();
      return false;
    }

    for (uint16_t i = 0; i < count; i += 1) {
      uploadedFrameBuffer[writtenPixels + i] = color;
    }
    writtenPixels += count;
  }
  file.close();

  if (writtenPixels != expectedPixels) {
    return false;
  }

  const int16_t x = (SCREEN_WIDTH - uploadedFrameWidth) / 2;
  const int16_t y = (SCREEN_HEIGHT - uploadedFrameHeight) / 2;
  display.startWrite();
  display.pushImage(x, y, uploadedFrameWidth, uploadedFrameHeight, uploadedFrameBuffer);
  display.endWrite();
  return true;
}

void startUploadedAnimation(uint32_t durationMs = 0) {
  if (!loadUploadedAnimationMetadata()) {
    emitLine("ERR:ANIM:NO_UPLOADED_ASSET");
    return;
  }

  currentState = "uploaded-animation";
  publicLottiePlaying = false;
  uploadedAnimationPlaying = true;
  uploadedAnimationTimed = durationMs > 0;
  uploadedAnimationStopAt = uploadedAnimationTimed ? millis() + durationMs : 0;
  uploadedFrameIndex = 0;
  lastUploadedFrameAt = 0;

  if (displayReady) {
    display.startWrite();
    display.fillScreen(COLOR_WHITE);
    display.endWrite();
  }

  if (!drawUploadedAnimationFrame()) {
    uploadedAnimationPlaying = false;
    uploadedAnimationTimed = false;
    uploadedAnimationStopAt = 0;
    emitLine("ERR:ANIM:BAD_UPLOADED_ASSET");
    return;
  }

  emitLine("ACK:ANIM:PLAY:UPLOADED");
}

bool parseUploadBegin(const String &line, uint32_t &totalBytes, uint32_t &crc) {
  const int last = line.lastIndexOf(':');
  const int previous = line.lastIndexOf(':', last - 1);
  if (last < 0 || previous < 0) {
    return false;
  }

  totalBytes = static_cast<uint32_t>(strtoul(line.substring(previous + 1, last).c_str(), nullptr, 10));
  crc = static_cast<uint32_t>(strtoul(line.substring(last + 1).c_str(), nullptr, 16));
  return totalBytes > 0 && totalBytes <= UPLOADED_ANIM_MAX_BYTES;
}

void closeUploadFile() {
  if (uploadFile) {
    uploadFile.close();
  }
  uploadActive = false;
  binaryUploadChunkActive = false;
  binaryUploadChunkStartedAt = 0;
  binaryUploadChunkExpected = 0;
  binaryUploadChunkReceived = 0;
}

void beginUpload(const String &line) {
  if (!spiffsReady) {
    Serial.println("ERR:UPLOAD:SPIFFS_NOT_READY");
    return;
  }

  uint32_t totalBytes = 0;
  uint32_t expectedCrc = 0;
  if (!parseUploadBegin(line, totalBytes, expectedCrc)) {
    Serial.println("ERR:UPLOAD:BAD_BEGIN");
    return;
  }

  closeUploadFile();
  SPIFFS.remove(UPLOADED_ANIM_TMP_PATH);
  uploadFile = SPIFFS.open(UPLOADED_ANIM_TMP_PATH, FILE_WRITE);
  if (!uploadFile) {
    Serial.println("ERR:UPLOAD:OPEN_FAILED");
    return;
  }

  uploadActive = true;
  uploadExpectedBytes = totalBytes;
  uploadReceivedBytes = 0;
  uploadExpectedCrc = expectedCrc;
  uploadCrc = 0xFFFFFFFF;
  stopAnimations();
  currentState = "uploading";
  drawUploadStatus();
  Serial.println("ACK:UPLOAD:BEGIN");
}

void receiveUploadChunk(const String &line) {
  if (!uploadActive || !uploadFile) {
    Serial.println("ERR:UPLOAD:NO_ACTIVE_UPLOAD");
    return;
  }

  const String payload = line.substring(String("UPLOAD:CHUNK:").length());
  if (payload.length() == 0 || payload.length() > 560) {
    Serial.println("ERR:UPLOAD:BAD_CHUNK");
    return;
  }

  uint8_t decoded[UPLOAD_CHUNK_MAX_BYTES];
  size_t decodedLength = 0;
  const int decodeResult = mbedtls_base64_decode(
      decoded, sizeof(decoded), &decodedLength,
      reinterpret_cast<const uint8_t *>(payload.c_str()), payload.length());

  if (decodeResult != 0 || decodedLength == 0 ||
      uploadReceivedBytes + decodedLength > uploadExpectedBytes) {
    closeUploadFile();
    SPIFFS.remove(UPLOADED_ANIM_TMP_PATH);
    Serial.print("ERR:UPLOAD:CHUNK_DECODE_FAILED:");
    Serial.print(payload.length());
    Serial.print(":");
    Serial.print(decodedLength);
    Serial.print(":");
    Serial.print(decodeResult);
    Serial.print(":");
    Serial.println(uploadReceivedBytes);
    return;
  }

  if (uploadFile.write(decoded, decodedLength) != decodedLength) {
    closeUploadFile();
    SPIFFS.remove(UPLOADED_ANIM_TMP_PATH);
    Serial.println("ERR:UPLOAD:WRITE_FAILED");
    return;
  }

  uploadReceivedBytes += decodedLength;
  uploadCrc = updateCrc32(uploadCrc, decoded, decodedLength);
  Serial.print("ACK:UPLOAD:CHUNK:");
  Serial.println(uploadReceivedBytes);
}

int8_t hexNibble(char value) {
  if (value >= '0' && value <= '9') {
    return value - '0';
  }
  if (value >= 'a' && value <= 'f') {
    return value - 'a' + 10;
  }
  if (value >= 'A' && value <= 'F') {
    return value - 'A' + 10;
  }
  return -1;
}

void receiveUploadHexChunk(const String &line) {
  if (!uploadActive || !uploadFile) {
    Serial.println("ERR:UPLOAD:NO_ACTIVE_UPLOAD");
    return;
  }

  const String payload = line.substring(String("UPLOAD:HEX:").length());
  if (payload.length() == 0 || payload.length() % 2 != 0 ||
      payload.length() > static_cast<int>(UPLOAD_CHUNK_MAX_BYTES * 2)) {
    closeUploadFile();
    SPIFFS.remove(UPLOADED_ANIM_TMP_PATH);
    Serial.print("ERR:UPLOAD:BAD_HEX_SIZE:");
    Serial.print(payload.length());
    Serial.print(":");
    Serial.println(uploadReceivedBytes);
    return;
  }

  uint8_t decoded[UPLOAD_CHUNK_MAX_BYTES];
  const size_t decodedLength = payload.length() / 2;
  for (size_t index = 0; index < decodedLength; index += 1) {
    const int8_t high = hexNibble(payload.charAt(index * 2));
    const int8_t low = hexNibble(payload.charAt(index * 2 + 1));
    if (high < 0 || low < 0) {
      closeUploadFile();
      SPIFFS.remove(UPLOADED_ANIM_TMP_PATH);
      Serial.print("ERR:UPLOAD:BAD_HEX_CHAR:");
      Serial.print(payload.length());
      Serial.print(":");
      Serial.println(uploadReceivedBytes);
      return;
    }
    decoded[index] = static_cast<uint8_t>((high << 4) | low);
  }

  if (decodedLength == 0 || uploadReceivedBytes + decodedLength > uploadExpectedBytes) {
    closeUploadFile();
    SPIFFS.remove(UPLOADED_ANIM_TMP_PATH);
    Serial.print("ERR:UPLOAD:HEX_OVERFLOW:");
    Serial.print(decodedLength);
    Serial.print(":");
    Serial.println(uploadReceivedBytes);
    return;
  }

  if (uploadFile.write(decoded, decodedLength) != decodedLength) {
    closeUploadFile();
    SPIFFS.remove(UPLOADED_ANIM_TMP_PATH);
    Serial.println("ERR:UPLOAD:WRITE_FAILED");
    return;
  }

  uploadReceivedBytes += decodedLength;
  uploadCrc = updateCrc32(uploadCrc, decoded, decodedLength);
  Serial.print("ACK:UPLOAD:CHUNK:");
  Serial.println(uploadReceivedBytes);
}

void beginBinaryUploadChunk(const String &line) {
  if (!uploadActive || !uploadFile) {
    Serial.println("ERR:UPLOAD:NO_ACTIVE_UPLOAD");
    return;
  }

  const int last = line.lastIndexOf(':');
  if (last < 0) {
    Serial.println("ERR:UPLOAD:BINARY_BAD_CHUNK");
    return;
  }

  const size_t expectedLength = static_cast<size_t>(strtoul(line.substring(last + 1).c_str(), nullptr, 10));
  if (expectedLength == 0 || expectedLength > UPLOAD_BINARY_CHUNK_MAX_BYTES ||
      uploadReceivedBytes + expectedLength > uploadExpectedBytes) {
    closeUploadFile();
    SPIFFS.remove(UPLOADED_ANIM_TMP_PATH);
    Serial.print("ERR:UPLOAD:BINARY_BAD_SIZE:");
    Serial.print(expectedLength);
    Serial.print(":");
    Serial.println(uploadReceivedBytes);
    return;
  }

  binaryUploadChunkActive = true;
  binaryUploadChunkStartedAt = millis();
  binaryUploadChunkExpected = expectedLength;
  binaryUploadChunkReceived = 0;
  Serial.print("ACK:UPLOAD:BINARY:READY:");
  Serial.println(expectedLength);
}

void abortBinaryUploadChunk(const char *reason) {
  const size_t received = binaryUploadChunkReceived;
  const size_t expected = binaryUploadChunkExpected;
  closeUploadFile();
  SPIFFS.remove(UPLOADED_ANIM_TMP_PATH);
  Serial.print("ERR:UPLOAD:BINARY_");
  Serial.print(reason);
  Serial.print(":");
  Serial.print(received);
  Serial.print("/");
  Serial.println(expected);
}

void commitBinaryUploadChunk() {
  if (!uploadActive || !uploadFile || binaryUploadChunkReceived != binaryUploadChunkExpected) {
    closeUploadFile();
    SPIFFS.remove(UPLOADED_ANIM_TMP_PATH);
    Serial.println("ERR:UPLOAD:BINARY_STATE");
    return;
  }

  if (uploadFile.write(binaryUploadChunkBuffer, binaryUploadChunkExpected) != binaryUploadChunkExpected) {
    closeUploadFile();
    SPIFFS.remove(UPLOADED_ANIM_TMP_PATH);
    Serial.println("ERR:UPLOAD:WRITE_FAILED");
    return;
  }

  uploadReceivedBytes += binaryUploadChunkExpected;
  uploadCrc = updateCrc32(uploadCrc, binaryUploadChunkBuffer, binaryUploadChunkExpected);
  binaryUploadChunkActive = false;
  binaryUploadChunkStartedAt = 0;
  binaryUploadChunkExpected = 0;
  binaryUploadChunkReceived = 0;
  Serial.print("ACK:UPLOAD:CHUNK:");
  Serial.println(uploadReceivedBytes);
}

void pollBinaryUploadChunk() {
  if (binaryUploadChunkActive &&
      millis() - binaryUploadChunkStartedAt > UPLOAD_BINARY_CHUNK_TIMEOUT_MS) {
    abortBinaryUploadChunk("TIMEOUT");
    return;
  }

  while (binaryUploadChunkActive && Serial.available() > 0) {
    binaryUploadChunkBuffer[binaryUploadChunkReceived] = static_cast<uint8_t>(Serial.read());
    binaryUploadChunkReceived += 1;
    if (binaryUploadChunkReceived >= binaryUploadChunkExpected) {
      commitBinaryUploadChunk();
      return;
    }
  }
}

void finishUpload() {
  if (!uploadActive || !uploadFile) {
    Serial.println("ERR:UPLOAD:NO_ACTIVE_UPLOAD");
    return;
  }

  uploadFile.flush();
  closeUploadFile();

  const uint32_t finalCrc = uploadCrc ^ 0xFFFFFFFF;
  if (uploadReceivedBytes != uploadExpectedBytes || finalCrc != uploadExpectedCrc) {
    SPIFFS.remove(UPLOADED_ANIM_TMP_PATH);
    Serial.print("ERR:UPLOAD:VALIDATION_FAILED:");
    Serial.print(uploadReceivedBytes);
    Serial.print(":");
    Serial.println(finalCrc, HEX);
    return;
  }

  SPIFFS.remove(UPLOADED_ANIM_PATH);
  if (!SPIFFS.rename(UPLOADED_ANIM_TMP_PATH, UPLOADED_ANIM_PATH)) {
    SPIFFS.remove(UPLOADED_ANIM_TMP_PATH);
    Serial.println("ERR:UPLOAD:RENAME_FAILED");
    return;
  }

  Serial.print("ACK:UPLOAD:END:");
  Serial.println(uploadReceivedBytes);
}

bool isRestorableBootState(const String &state) {
  return state == "standby" || state == "working" || state == "error" || state == "done" ||
         state == "public-lottie" || state == "uploaded-animation" ||
         state == "tap-uploaded-animation";
}

String readBootState() {
  if (!spiffsReady || !SPIFFS.exists(BOOT_STATE_PATH)) {
    return "";
  }

  File file = SPIFFS.open(BOOT_STATE_PATH, FILE_READ);
  if (!file) {
    return "";
  }

  String state = file.readStringUntil('\n');
  state.trim();
  file.close();
  return isRestorableBootState(state) ? state : "";
}

bool writeBootState(const String &state) {
  if (!spiffsReady || !isRestorableBootState(state)) {
    return false;
  }

  File file = SPIFFS.open(BOOT_STATE_PATH, FILE_WRITE);
  if (!file) {
    return false;
  }

  file.println(state);
  file.close();
  return true;
}

void saveCurrentBootState() {
  if (!spiffsReady) {
    emitLine("ERR:BOOT:SPIFFS_NOT_READY");
    return;
  }

  String bootState = currentState == "uploaded-animation" ? "tap-uploaded-animation" : currentState;
  if (!isRestorableBootState(bootState)) {
    emitLine("ERR:BOOT:UNSUPPORTED_STATE:" + currentState);
    return;
  }

  if (!writeBootState(bootState)) {
    emitLine("ERR:BOOT:SAVE_FAILED");
    return;
  }

  emitLine("ACK:BOOT:SAVE:" + bootState);
}

void clearBootState() {
  if (!spiffsReady) {
    emitLine("ERR:BOOT:SPIFFS_NOT_READY");
    return;
  }

  SPIFFS.remove(BOOT_STATE_PATH);
  emitLine("ACK:BOOT:CLEAR");
}

void printBootStateInfo() {
  const String state = readBootState();
  emitLine("INFO:BOOT:" + String(state.length() > 0 ? state : "none"));
}

void restoreBootState() {
  const String state = readBootState();
  if (state.length() == 0) {
    drawState("standby");
    return;
  }

  emitLine("INFO:BOOT_RESTORE:" + state);

  if (state == "tap-uploaded-animation") {
    if (spiffsReady && SPIFFS.exists(UPLOADED_ANIM_PATH)) {
      enterTapUploadedMode();
    } else {
      drawState("standby");
    }
    return;
  }

  if (state == "uploaded-animation") {
    if (spiffsReady && SPIFFS.exists(UPLOADED_ANIM_PATH)) {
      enterTapUploadedMode();
    } else {
      drawState("standby");
    }
    return;
  }

  if (state == "public-lottie") {
    startPublicLottie();
    return;
  }

  drawState(state);
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
  emitLine(touchReady ? "INFO:TOUCH:CST816D" : "WARN:TOUCH_INIT_FAILED");
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
  emitLine(
      "ALERT:TOUCH_PRESS:" + String(sample.x) + ":" + String(sample.y) + ":" +
      String(sample.gesture));
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
    emitLine("ACK:PONG");
    return;
  }

  if (line == "ANIM:PUBLIC_LOTTIE") {
    startPublicLottie();
    return;
  }

  if (line == "ANIM:PLAY:UPLOADED") {
    startUploadedAnimation();
    return;
  }

  if (line == "BOOT:SAVE") {
    saveCurrentBootState();
    return;
  }

  if (line == "BOOT:CLEAR") {
    clearBootState();
    return;
  }

  if (line.startsWith("UPLOAD:BEGIN:")) {
    beginUpload(line);
    return;
  }

  if (line.startsWith("UPLOAD:BINARY:BEGIN:")) {
    beginUpload(line);
    return;
  }

  if (line.startsWith("UPLOAD:BINARY:CHUNK:")) {
    beginBinaryUploadChunk(line);
    return;
  }

  if (line.startsWith("UPLOAD:CHUNK:")) {
    receiveUploadChunk(line);
    return;
  }

  if (line.startsWith("UPLOAD:HEX:")) {
    receiveUploadHexChunk(line);
    return;
  }

  if (line == "UPLOAD:END") {
    finishUpload();
    return;
  }

  if (line == "INFO") {
    emitLine("INFO:BOARD:esp32-c3-round-gc9a01");
    emitLine(displayReady ? "INFO:DISPLAY:ready" : "INFO:DISPLAY:not-ready");
    emitLine(touchReady ? "INFO:TOUCH:ready" : "INFO:TOUCH:not-ready");
    emitLine(spiffsReady ? "INFO:SPIFFS:ready" : "INFO:SPIFFS:not-ready");
    if (spiffsReady) {
      emitLine("INFO:SPIFFS_BYTES:" + String(SPIFFS.usedBytes()) + "/" + String(SPIFFS.totalBytes()));
    }
    emitLine((spiffsReady && SPIFFS.exists(UPLOADED_ANIM_PATH)) ? "INFO:ASSET:uploaded" : "INFO:ASSET:none");
    printBootStateInfo();
    emitLine(bleDeviceConnected ? "INFO:BLE:connected" : "INFO:BLE:advertising");
    emitLine("INFO:FLASH:4MB");
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

    emitLine("ERR:UNKNOWN_STATE:" + state);
    return;
  }

  if (line.startsWith("TEXT:")) {
    drawTextMessage(line.substring(5));
    return;
  }

  emitLine("ERR:UNKNOWN_COMMAND:" + line);
}

void pollSerial() {
  if (binaryUploadChunkActive) {
    pollBinaryUploadChunk();
    return;
  }

  while (Serial.available() > 0) {
    if (binaryUploadChunkActive) {
      pollBinaryUploadChunk();
      continue;
    }

    const char nextChar = static_cast<char>(Serial.read());
    if (nextChar == '\n') {
      handleCommand(serialBuffer);
      serialBuffer = "";
      continue;
    }

    if (nextChar != '\r') {
      serialBuffer += nextChar;
    }

    if (serialBuffer.length() > 900) {
      serialBuffer = "";
      emitLine("ERR:LINE_TOO_LONG");
    }
  }
}

void pollBleState() {
  if (bleServer == nullptr) {
    return;
  }

  if (!bleDeviceConnected && bleOldDeviceConnected) {
    delay(40);
    bleServer->startAdvertising();
    emitLine("INFO:BLE:advertising");
    bleOldDeviceConnected = bleDeviceConnected;
    return;
  }

  if (bleDeviceConnected && !bleOldDeviceConnected) {
    emitLine("INFO:BLE:connected");
    notifyBleLine("READY:agent-visualizer:v0");
    bleOldDeviceConnected = bleDeviceConnected;
  }
}

void pollBleCommands() {
  if (bleCommandQueue == nullptr) {
    return;
  }

  BleCommandMessage message{};
  while (xQueueReceive(bleCommandQueue, &message, 0) == pdTRUE) {
    String line = String(message.line);
    line.trim();
    if (line.length() > 0) {
      handleCommand(line);
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
    if (currentState == "tap-uploaded-animation") {
      startUploadedAnimation(TOUCH_ANIMATION_DURATION_MS);
      return;
    }
    drawTouchPress(sample);
    return;
  }

  touchPressed = true;
}

void pollPublicLottie() {
  if (!publicLottiePlaying || !displayReady || millis() - lastPublicLottieFrameAt < 95) {
    return;
  }

  lastPublicLottieFrameAt = millis();
  publicLottieFrame = (publicLottieFrame + 1) % PUBLIC_LOTTIE_FRAME_COUNT;
  drawPublicLottieFrame();
}

void pollUploadedAnimation() {
  if (!uploadedAnimationPlaying || !displayReady || uploadedFrameCount == 0 || uploadedFrameFps == 0) {
    return;
  }

  if (uploadedAnimationTimed && static_cast<int32_t>(millis() - uploadedAnimationStopAt) >= 0) {
    enterTapUploadedMode();
    emitLine("ACK:ANIM:STOP:UPLOADED");
    return;
  }

  const uint32_t requestedIntervalMs = 1000UL / uploadedFrameFps;
  const uint32_t intervalMs = requestedIntervalMs < 33 ? 33 : requestedIntervalMs;
  if (millis() - lastUploadedFrameAt < intervalMs) {
    return;
  }

  lastUploadedFrameAt = millis();
  uploadedFrameIndex = (uploadedFrameIndex + 1) % uploadedFrameCount;
  if (!drawUploadedAnimationFrame()) {
    uploadedAnimationPlaying = false;
    emitLine("ERR:ANIM:UPLOAD_PLAYBACK_FAILED");
  }
}
} // namespace

void setup() {
  delay(900);
  Serial.begin(SERIAL_BAUD_RATE);
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

  emitLine("READY:agent-visualizer:v0");
  emitLine("INFO:MCU:ESP32-C3");
  emitLine(displayReady ? "INFO:DISPLAY:GC9A01" : "WARN:DISPLAY_INIT_FAILED");
  spiffsReady = SPIFFS.begin(true);
  emitLine(spiffsReady ? "INFO:SPIFFS:ready" : "WARN:SPIFFS_INIT_FAILED");
  initTouch();
  initBle();

  restoreBootState();
}

void loop() {
  pollSerial();
  pollBleState();

  if (uploadActive) {
    return;
  }

  pollBleCommands();
  pollTouch();
  pollPublicLottie();
  pollUploadedAnimation();

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
