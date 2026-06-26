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

## BLE Control Prototype

The firmware also advertises a BLE control service named:

```txt
AgentVis-C3
```

The dashboard can connect to it through Web Bluetooth from Chrome or Edge. BLE
is for short control commands and notifications only: `INFO`, `PING`,
`STATE:*`, `TEXT:*`, `ANIM:PUBLIC_LOTTIE`, `ANIM:PLAY:UPLOADED`, `BOOT:SAVE`,
`BOOT:CLEAR`, and touch alerts.

BLE uses a Nordic UART-style GATT shape:

```txt
Service: 6e400001-b5a3-f393-e0a9-e50e24dcca9e
RX write: 6e400002-b5a3-f393-e0a9-e50e24dcca9e
TX notify: 6e400003-b5a3-f393-e0a9-e50e24dcca9e
```

Converted animation asset upload still uses USB Serial. BLE is intentionally
not used for AVF1 uploads because the current assets are too large for a good
GATT-write experience.

## Lottie Animation Preview

The host app renders a browser-side Lottie animation inside the circular device
preview. The prototype asset lives at:

```txt
apps/agent-visualizer/src/animations/agent-orb.lottie.json
```

To test a different Lottie file, replace that JSON file and keep the import in
`src/App.tsx`. The browser can render raw Lottie through `lottie-react`, but the
ESP32-C3 firmware should not render arbitrary Lottie JSON directly. For device
playback, convert selected animations into small frame sequences, sprite sheets,
or compact firmware drawing commands in a later iteration.

## Public Lottie Firmware Test

The first firmware animation test uses the public MIT sample bundled with
`lottie-web`:

```txt
node_modules/lottie-web/test/animations/starfish.json
```

Generate the firmware frames from the repo root:

```bash
node apps/agent-visualizer/firmware/tools/render-public-lottie.mjs
```

The generator renders public Lottie frames through Chrome headless, crops the
visible animation area, and writes 16 frames at 180x180:

```txt
apps/agent-visualizer/firmware/src/public_lottie_frames.h
```

The ESP32 does not parse the Lottie JSON at runtime. It plays the converted
RGB565 frames embedded in firmware. Trigger it from the browser with the Lottie
button or over serial:

```txt
ANIM:PUBLIC_LOTTIE
```

## Admin Lottie Upload

The host app can now load a Lottie JSON file from the Admin asset panel and
convert it locally into the firmware playback format. The browser renders the
animation off-screen, crops the visible content, encodes 16 frames at 180x180
and 12 fps, then uploads the binary asset to the ESP32 over Web Serial at
921600 baud.

Current prototype limits:

```txt
Format: AVF1 RGB565 RLE
Size: 180x180
Frames: 16
FPS: 12
Max upload: 760000 bytes
Storage: /current.anim in SPIFFS
```

After conversion, use `Subir` to send the asset. The browser sends 2048-byte
binary chunks
and waits for a ready/received ACK around every chunk so the ESP32 serial parser
is not overrun. Use `Play uploaded` or send the serial command directly:

```txt
ANIM:PLAY:UPLOADED
```

This is still a conversion pipeline, not a runtime Lottie or Rive player on the
ESP32. The device stores and plays compact RGB565 frame data.

Use `Guardar` to keep a converted asset in the dashboard's local gallery. The
gallery is stored in the browser through IndexedDB and keeps the converted AVF1
bytes plus metadata, so saved animations can be selected and uploaded again
without reconverting the source JSON. The ESP32 still has one active uploaded
animation slot: choosing `Usar` from the gallery uploads that asset immediately,
replaces the current `/current.anim` on the device, and starts playback with
`ANIM:PLAY:UPLOADED`. Use `Cargar` when you only want to select the asset in the
panel before uploading.

To make the current visual state survive power loss, start the desired state
from the dashboard and then press `Perpetuar`. For an uploaded animation, the
saved boot mode is interactive: the device boots to standby, waits for touch,
plays the uploaded animation for a few seconds, and then returns to standby.
The dashboard flow is:

```txt
Play uploaded
Perpetuar
```

The firmware stores the boot state in SPIFFS as `/boot.state` and restores it on
the next boot. Use `Reset boot` to clear the saved boot state and return to the
default standby startup.

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
pio device monitor -b 921600
```

If upload fails, hold `BOOT`, tap `RESET`, then release `BOOT` and retry.

## Serial Protocol v0

Commands are line-delimited UTF-8:

```txt
HELLO
PING
INFO
ANIM:PUBLIC_LOTTIE
ANIM:PLAY:UPLOADED
BOOT:SAVE
BOOT:CLEAR
UPLOAD:BINARY:BEGIN:<totalBytes>:<crc32hex>
UPLOAD:BINARY:CHUNK:<byteLength>
<byteLength raw bytes>
UPLOAD:END
UPLOAD:HEX:<hex>
STATE:standby
STATE:working
STATE:error
STATE:done
TEXT:Hola Agent Visualizer
```

The same short command lines can be sent through BLE RX. Binary upload commands
remain USB Serial only.

Firmware acknowledgement examples:

```txt
READY:agent-visualizer:v0
ACK:HELLO:agent-visualizer
ACK:PONG
INFO:MCU:ESP32-C3
INFO:DISPLAY:GC9A01
INFO:SPIFFS:ready
INFO:SPIFFS_BYTES:<used>/<total>
INFO:ASSET:uploaded
INFO:BOOT:tap-uploaded-animation
INFO:BLE:advertising
INFO:BLE:connected
ACK:ANIM:PUBLIC_LOTTIE
ACK:BOOT:SAVE:<state>
ACK:ANIM:STOP:UPLOADED
ACK:BOOT:CLEAR
ACK:UPLOAD:BEGIN
ACK:UPLOAD:BINARY:READY:<byteLength>
ACK:UPLOAD:CHUNK:<receivedBytes>
ACK:UPLOAD:END:<totalBytes>
ACK:ANIM:PLAY:UPLOADED
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
