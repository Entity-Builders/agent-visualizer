# Agent Visualizer

Desk-toy prototype for making autonomous coding-agent status visible on a tiny
physical display.

## What This Is

This app is the first hello-world loop for the project note:

- A host web app connects to an ESP32 over USB Serial.
- The host sends short commands like `HELLO`, `STATE:working`, and `TEXT:Hola`.
- The ESP32 renders a simple state screen and writes an acknowledgement back.
- Touch presses on the ESP32 display are sent back to the browser as alert
  events.

The current hardware target is the Starware round ESP32-C3 display that is
already available. The product note's 0.96 inch ST7735 80x160 display remains
the future mini/keychain target.

## Hardware Assumption

The connected board reports itself as:

```txt
Chip: ESP32-C3 QFN32 rev 0.4
Flash: 4MB embedded XMC flash
USB: USB-Serial/JTAG
MAC: 58:8c:81:00:9a:04
```

The factory backup looks like an Arduino/LVGL demo for an ESP32-C3 round
GC9A01 board. The firmware uses the common `ESP32-2424S012` style pin mapping:

```txt
TFT_BL   = GPIO 3
TFT_DC   = GPIO 2
TFT_CS   = GPIO 10
TFT_SCLK = GPIO 6
TFT_MOSI = GPIO 7
TFT_RST  = -1
```

The touch-enabled Starware/ESP32-2424S012 variant uses a CST816D-compatible
controller on I2C:

```txt
TOUCH_SDA = GPIO 4
TOUCH_SCL = GPIO 5
TOUCH_INT = GPIO 0
TOUCH_RST = GPIO 1
I2C_ADDR  = 0x15
```

If the serial connection works but the screen stays dark, update only the pin
block at the top of `firmware/src/main.cpp`. The first backup showed these
partitions: `nvs` empty, `otadata`, `app0`, `spiffs` empty, and `coredump`
empty.

Useful references:

- Starware product: https://www.mercadolibre.com.ar/pantalla-redonda-display-tactil-esp32-wifi-bt-starware/up/MLAU3157467711
- ESP32-C3 round board notes: https://homeding.github.io/boards/esp32c3/jczn-esp32-2424s012.htm
- Arduino/LovyanGFX example pinout: https://github.com/BojanJurca/Getting-started-with-ESP32-LVGL-for-Arduino-with-1.28-Inch-round-Display-with-Touch/blob/main/gettingStarted.ino

## Factory Backup

Before flashing, a full factory backup was captured outside the repo:

```txt
~/esp32-backups/starware-round/full-flash.bin
```

Expected size:

```txt
4194304 bytes
```

SHA256:

```txt
bdd56596e2d981345939de138c43462fe056c3144ae3e7e5d69094226087aba8
```

Restore command, only if needed:

```bash
/tmp/esp32-backup-tools/bin/python -m esptool --chip esp32c3 --port /dev/cu.usbmodem1201 write-flash 0x0 ~/esp32-backups/starware-round/full-flash.bin
```

## Run The Host App

From the repo root:

```bash
yarn start:agent-visualizer
```

Then open:

```txt
http://localhost:3018
```

Use Chrome or Edge desktop. Safari and Firefox do not expose Web Serial for this
prototype.

## Flash The Firmware

Install PlatformIO if needed:

```bash
python3 -m pip install platformio
```

Build:

```bash
cd apps/agent-visualizer/firmware
pio run
```

Upload:

```bash
pio run -t upload
```

Open serial monitor:

```bash
pio device monitor -b 115200
```

If upload fails, hold `BOOT`, tap `RESET`, then release `BOOT` and retry.

## Serial Protocol v0

Commands are line-delimited UTF-8:

```txt
HELLO
PING
INFO
STATE:standby
STATE:working
STATE:error
STATE:done
TEXT:Hola Agent Visualizer
```

Firmware acknowledgement examples:

```txt
READY:agent-visualizer:v0
ACK:HELLO:agent-visualizer
ACK:PONG
INFO:MCU:ESP32-C3
INFO:DISPLAY:GC9A01
ACK:STATE:working
ACK:TEXT:Hola Agent Visualizer
ALERT:TOUCH_PRESS:120:96:0
ERR:UNKNOWN_COMMAND:<line>
```

`ALERT:TOUCH_PRESS:<x>:<y>:<gesture>` is emitted by the firmware when the
touch controller reports a new press. The web app shows this as an in-browser
alert and keeps the raw serial line in the log.

## Next Product Steps

- Add a local CLI that maps agent terminal output to this serial protocol.
- Replace primitive drawings with animation frames or a small runtime experiment.
- Add a second firmware profile for the ST7735 80x160 mini/keychain target.
- Decide whether sound belongs in firmware v1 or a later hardware revision.
