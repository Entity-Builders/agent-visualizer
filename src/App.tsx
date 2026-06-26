import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Lottie from 'lottie-react';
import lottieWeb, { type AnimationItem } from 'lottie-web';

import agentOrbAnimation from './animations/agent-orb.lottie.json';

type DeviceState = 'standby' | 'working' | 'error' | 'done';
type LogDirection = 'sent' | 'received' | 'system';

interface LogEntry {
  id: number;
  at: string;
  direction: LogDirection;
  message: string;
}

interface TouchAlert {
  id: number;
  at: string;
  x: number | null;
  y: number | null;
  gesture: number | null;
}

interface ConvertedAnimationAsset {
  bytes: Uint8Array;
  crcHex: string;
  fileName: string;
  frameCount: number;
  fps: number;
  height: number;
  rleBytes: number;
  width: number;
}

interface StoredAnimationAsset extends ConvertedAnimationAsset {
  id: string;
  savedAt: string;
}

interface LineWaiter {
  predicate: (line: string) => boolean;
  reject: (error: Error) => void;
  resolve: (line: string) => void;
  timeoutId: number;
}

const AGENT_STATES: Array<{ id: DeviceState; label: string; command: string }> = [
  { id: 'standby', label: 'Standby', command: 'STATE:standby' },
  { id: 'working', label: 'Trabajando', command: 'STATE:working' },
  { id: 'error', label: 'Error 500', command: 'STATE:error' },
  { id: 'done', label: 'Task done', command: 'STATE:done' },
];

const stateCopy: Record<DeviceState, { title: string; detail: string }> = {
  standby: { title: 'Zzz', detail: 'Esperando agente' },
  working: { title: 'SCAN', detail: 'Reading files' },
  error: { title: 'ERR', detail: 'Timeout error' },
  done: { title: 'DONE', detail: 'Campana lista' },
};

const ADMIN_ASSET_SIZE = 180;
const ADMIN_ASSET_FRAMES = 16;
const ADMIN_ASSET_FPS = 12;
const ADMIN_RENDER_SIZE = 480;
const ADMIN_UPLOAD_LIMIT_BYTES = 760000;
const ASSET_GALLERY_DB_NAME = 'agent-visualizer-assets';
const ASSET_GALLERY_DB_VERSION = 1;
const ASSET_GALLERY_STORE_NAME = 'converted-assets';
const BLE_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const BLE_RX_CHARACTERISTIC_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const BLE_TX_CHARACTERISTIC_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
const SERIAL_BAUD_RATE = 921600;
const SERIAL_UPLOAD_CHUNK_BYTES = 2048;
const SERIAL_UPLOAD_ACK_TIMEOUT_MS = 20000;
const WHITE_BACKGROUND = { r: 255, g: 255, b: 255 };

const timeLabel = (): string =>
  new Intl.DateTimeFormat('es-AR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date());

const formatUsbInfo = (port: SerialPort | null): string => {
  if (!port) {
    return 'Sin puerto';
  }

  const info = port.getInfo();
  const vendor = info.usbVendorId?.toString(16).padStart(4, '0') ?? '----';
  const product = info.usbProductId?.toString(16).padStart(4, '0') ?? '----';

  return `USB ${vendor}:${product}`;
};

const formatBleInfo = (device: BluetoothDevice | null): string => {
  if (!device) {
    return 'Sin BLE';
  }

  return `BLE ${device.name ?? device.id}`;
};

const waitForAnimationLoaded = (animation: AnimationItem): Promise<void> =>
  new Promise((resolve) => {
    animation.addEventListener('DOMLoaded', () => resolve());
  });

const waitForPaint = (): Promise<void> =>
  new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });

const getNumberProperty = (source: unknown, key: string, fallback: number): number => {
  if (!source || typeof source !== 'object') {
    return fallback;
  }

  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
};

const getContentBox = (imageData: ImageData): DOMRectReadOnly | null => {
  const { data, width, height } = imageData;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const alpha = data[offset + 3];
      const colorDelta =
        Math.abs(data[offset] - WHITE_BACKGROUND.r) +
        Math.abs(data[offset + 1] - WHITE_BACKGROUND.g) +
        Math.abs(data[offset + 2] - WHITE_BACKGROUND.b);

      if (alpha > 12 && colorDelta > 18) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    return null;
  }

  return new DOMRectReadOnly(minX, minY, maxX - minX + 1, maxY - minY + 1);
};

const mergeBoxes = (boxes: DOMRectReadOnly[]): DOMRectReadOnly => {
  const minX = Math.min(...boxes.map((box) => box.x));
  const minY = Math.min(...boxes.map((box) => box.y));
  const maxX = Math.max(...boxes.map((box) => box.x + box.width));
  const maxY = Math.max(...boxes.map((box) => box.y + box.height));
  return new DOMRectReadOnly(minX, minY, maxX - minX, maxY - minY);
};

const toSquareCrop = (box: DOMRectReadOnly): DOMRectReadOnly => {
  const size = Math.min(ADMIN_RENDER_SIZE, Math.ceil(Math.max(box.width, box.height) * 1.28));
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  const x = Math.max(0, Math.min(Math.round(centerX - size / 2), ADMIN_RENDER_SIZE - size));
  const y = Math.max(0, Math.min(Math.round(centerY - size / 2), ADMIN_RENDER_SIZE - size));
  return new DOMRectReadOnly(x, y, size, size);
};

const toRgb565Swapped = (red: number, green: number, blue: number): number => {
  const rgb565 = (((red & 0xf8) << 8) | ((green & 0xfc) << 3) | (blue >> 3)) & 0xffff;
  return ((rgb565 & 0xff) << 8) | (rgb565 >> 8);
};

const appendUint16 = (target: number[], value: number): void => {
  target.push(value & 0xff, (value >> 8) & 0xff);
};

const appendUint32 = (target: number[], value: number): void => {
  target.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff);
};

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const formatBytes = (bytes: number): string => new Intl.NumberFormat('es-AR').format(bytes);

const formatSavedAt = (savedAt: string): string =>
  new Intl.DateTimeFormat('es-AR', {
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    month: '2-digit',
  }).format(new Date(savedAt));

const requestToPromise = <T,>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });

const transactionDone = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
  });

const openAssetGalleryDatabase = (): Promise<IDBDatabase> => {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('La galeria local no esta disponible en este navegador.'));
  }

  const request = indexedDB.open(ASSET_GALLERY_DB_NAME, ASSET_GALLERY_DB_VERSION);
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(ASSET_GALLERY_STORE_NAME)) {
      database.createObjectStore(ASSET_GALLERY_STORE_NAME, { keyPath: 'id' });
    }
  };

  return requestToPromise(request);
};

const toStoredAssetId = (asset: ConvertedAnimationAsset): string =>
  `${asset.crcHex}-${asset.bytes.length}-${asset.fileName}`;

const cloneConvertedAsset = (asset: ConvertedAnimationAsset): ConvertedAnimationAsset => ({
  ...asset,
  bytes: new Uint8Array(asset.bytes),
});

const toConvertedAnimationAsset = (asset: StoredAnimationAsset): ConvertedAnimationAsset =>
  cloneConvertedAsset(asset);

const loadAssetGallery = async (): Promise<StoredAnimationAsset[]> => {
  let database: IDBDatabase | null = null;
  try {
    database = await openAssetGalleryDatabase();
    const transaction = database.transaction(ASSET_GALLERY_STORE_NAME, 'readonly');
    const done = transactionDone(transaction);
    const request = transaction.objectStore(ASSET_GALLERY_STORE_NAME).getAll();
    const assets = await requestToPromise(request as IDBRequest<StoredAnimationAsset[]>);
    await done;

    return assets
      .map((asset) => ({
        ...asset,
        bytes: new Uint8Array(asset.bytes),
      }))
      .sort((left, right) => right.savedAt.localeCompare(left.savedAt));
  } finally {
    database?.close();
  }
};

const saveAssetToGallery = async (asset: ConvertedAnimationAsset): Promise<StoredAnimationAsset> => {
  const storedAsset: StoredAnimationAsset = {
    ...cloneConvertedAsset(asset),
    id: toStoredAssetId(asset),
    savedAt: new Date().toISOString(),
  };

  let database: IDBDatabase | null = null;
  try {
    database = await openAssetGalleryDatabase();
    const transaction = database.transaction(ASSET_GALLERY_STORE_NAME, 'readwrite');
    const done = transactionDone(transaction);
    const request = transaction.objectStore(ASSET_GALLERY_STORE_NAME).put(storedAsset);
    await requestToPromise(request);
    await done;
    return storedAsset;
  } finally {
    database?.close();
  }
};

const deleteAssetFromGallery = async (assetId: string): Promise<void> => {
  let database: IDBDatabase | null = null;
  try {
    database = await openAssetGalleryDatabase();
    const transaction = database.transaction(ASSET_GALLERY_STORE_NAME, 'readwrite');
    const done = transactionDone(transaction);
    const request = transaction.objectStore(ASSET_GALLERY_STORE_NAME).delete(assetId);
    await requestToPromise(request);
    await done;
  } finally {
    database?.close();
  }
};

const summarizeSerialLine = (line: string): string => {
  if (
    !line.startsWith('UPLOAD:CHUNK:') &&
    !line.startsWith('UPLOAD:HEX:') &&
    !line.startsWith('UPLOAD:BINARY:CHUNK:')
  ) {
    return line;
  }

  const prefix = line.startsWith('UPLOAD:BINARY:CHUNK:')
    ? 'UPLOAD:BINARY:CHUNK:'
    : line.startsWith('UPLOAD:HEX:')
      ? 'UPLOAD:HEX:'
      : 'UPLOAD:CHUNK:';
  return `${prefix}<${line.length - prefix.length} chars>`;
};

const encodeFrameRle = (imageData: ImageData): number[] => {
  const { data } = imageData;
  const output: number[] = [];
  let runColor = -1;
  let runLength = 0;

  const flush = (): void => {
    if (runLength === 0) {
      return;
    }
    appendUint16(output, runLength);
    appendUint16(output, runColor);
    runLength = 0;
  };

  for (let offset = 0; offset < data.length; offset += 4) {
    const alpha = data[offset + 3] / 255;
    const red = Math.round(data[offset] * alpha + WHITE_BACKGROUND.r * (1 - alpha));
    const green = Math.round(data[offset + 1] * alpha + WHITE_BACKGROUND.g * (1 - alpha));
    const blue = Math.round(data[offset + 2] * alpha + WHITE_BACKGROUND.b * (1 - alpha));
    const color = toRgb565Swapped(red, green, blue);

    if (color === runColor && runLength < 65535) {
      runLength += 1;
      continue;
    }

    flush();
    runColor = color;
    runLength = 1;
  }

  flush();
  return output;
};

const convertLottieToHardwareAsset = async (
  animationData: unknown,
  fileName: string,
): Promise<ConvertedAnimationAsset> => {
  const host = document.createElement('div');
  host.style.position = 'fixed';
  host.style.left = '-10000px';
  host.style.top = '0';
  host.style.width = `${ADMIN_RENDER_SIZE}px`;
  host.style.height = `${ADMIN_RENDER_SIZE}px`;
  host.style.overflow = 'hidden';
  document.body.appendChild(host);

  const animation = lottieWeb.loadAnimation({
    animationData: animationData as never,
    autoplay: false,
    container: host,
    loop: false,
    renderer: 'canvas',
    rendererSettings: {
      clearCanvas: true,
      preserveAspectRatio: 'xMidYMid meet',
    },
  });

  try {
    await waitForAnimationLoaded(animation);
    const canvas = host.querySelector('canvas');
    if (!canvas) {
      throw new Error('No se pudo renderizar el canvas Lottie.');
    }

    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = ADMIN_RENDER_SIZE;
    sourceCanvas.height = ADMIN_RENDER_SIZE;
    const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true });
    if (!sourceContext) {
      throw new Error('No se pudo crear el canvas de conversion.');
    }

    const targetCanvas = document.createElement('canvas');
    targetCanvas.width = ADMIN_ASSET_SIZE;
    targetCanvas.height = ADMIN_ASSET_SIZE;
    const targetContext = targetCanvas.getContext('2d', { willReadFrequently: true });
    if (!targetContext) {
      throw new Error('No se pudo crear el canvas de salida.');
    }

    const firstFrame = getNumberProperty(animationData, 'ip', 0);
    const lastFrame = getNumberProperty(animationData, 'op', firstFrame + animation.totalFrames);
    const frameSpan = Math.max(1, lastFrame - firstFrame - 1);
    const renderedFrames: ImageData[] = [];
    const boxes: DOMRectReadOnly[] = [];

    for (let index = 0; index < ADMIN_ASSET_FRAMES; index += 1) {
      const progress = index / (ADMIN_ASSET_FRAMES - 1);
      const frame = firstFrame + Math.round(frameSpan * progress);
      animation.goToAndStop(frame, true);
      await waitForPaint();

      sourceContext.clearRect(0, 0, ADMIN_RENDER_SIZE, ADMIN_RENDER_SIZE);
      sourceContext.fillStyle = '#ffffff';
      sourceContext.fillRect(0, 0, ADMIN_RENDER_SIZE, ADMIN_RENDER_SIZE);
      sourceContext.drawImage(canvas, 0, 0, ADMIN_RENDER_SIZE, ADMIN_RENDER_SIZE);

      const imageData = sourceContext.getImageData(0, 0, ADMIN_RENDER_SIZE, ADMIN_RENDER_SIZE);
      renderedFrames.push(imageData);
      const box = getContentBox(imageData);
      if (box && box.width * box.height > 64) {
        boxes.push(box);
      }
    }

    const crop = boxes.length > 0
      ? toSquareCrop(mergeBoxes(boxes))
      : new DOMRectReadOnly(0, 0, ADMIN_RENDER_SIZE, ADMIN_RENDER_SIZE);

    const frameOffsets: number[] = [0];
    const rleData: number[] = [];
    for (const imageData of renderedFrames) {
      sourceContext.putImageData(imageData, 0, 0);
      targetContext.clearRect(0, 0, ADMIN_ASSET_SIZE, ADMIN_ASSET_SIZE);
      targetContext.fillStyle = '#ffffff';
      targetContext.fillRect(0, 0, ADMIN_ASSET_SIZE, ADMIN_ASSET_SIZE);
      targetContext.drawImage(
        sourceCanvas,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        0,
        0,
        ADMIN_ASSET_SIZE,
        ADMIN_ASSET_SIZE,
      );

      rleData.push(...encodeFrameRle(targetContext.getImageData(0, 0, ADMIN_ASSET_SIZE, ADMIN_ASSET_SIZE)));
      frameOffsets.push(rleData.length);
    }

    const header: number[] = [];
    header.push(0x41, 0x56, 0x46, 0x31);
    appendUint16(header, ADMIN_ASSET_SIZE);
    appendUint16(header, ADMIN_ASSET_SIZE);
    appendUint16(header, ADMIN_ASSET_FRAMES);
    appendUint16(header, ADMIN_ASSET_FPS);
    appendUint32(header, rleData.length);
    for (const offset of frameOffsets) {
      appendUint32(header, offset);
    }

    const bytes = new Uint8Array(header.length + rleData.length);
    bytes.set(header, 0);
    bytes.set(rleData, header.length);

    if (bytes.length > ADMIN_UPLOAD_LIMIT_BYTES) {
      throw new Error(`Asset demasiado grande (${bytes.length} bytes).`);
    }

    const checksum = crc32(bytes);
    return {
      bytes,
      crcHex: checksum.toString(16).padStart(8, '0'),
      fileName,
      frameCount: ADMIN_ASSET_FRAMES,
      fps: ADMIN_ASSET_FPS,
      height: ADMIN_ASSET_SIZE,
      rleBytes: rleData.length,
      width: ADMIN_ASSET_SIZE,
    };
  } finally {
    animation.destroy();
    host.remove();
  }
};

export default function App(): JSX.Element {
  const portRef = useRef<SerialPort | null>(null);
  const bleDeviceRef = useRef<BluetoothDevice | null>(null);
  const bleRxCharacteristicRef = useRef<BluetoothRemoteGATTCharacteristic | null>(null);
  const bleTxCharacteristicRef = useRef<BluetoothRemoteGATTCharacteristic | null>(null);
  const bleLineBufferRef = useRef('');
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const writerRef = useRef<WritableStreamDefaultWriter<Uint8Array> | null>(null);
  const lineWaitersRef = useRef<LineWaiter[]>([]);
  const logIdRef = useRef(0);

  const [connectedPort, setConnectedPort] = useState<SerialPort | null>(null);
  const [connectedBleDevice, setConnectedBleDevice] = useState<BluetoothDevice | null>(null);
  const [deviceState, setDeviceState] = useState<DeviceState>('standby');
  const [customText, setCustomText] = useState('Hola Agent Visualizer');
  const [isBusy, setIsBusy] = useState(false);
  const [isBleBusy, setIsBleBusy] = useState(false);
  const [selectedLottieFile, setSelectedLottieFile] = useState<File | null>(null);
  const [convertedAsset, setConvertedAsset] = useState<ConvertedAnimationAsset | null>(null);
  const [storedAssets, setStoredAssets] = useState<StoredAnimationAsset[]>([]);
  const [selectedStoredAssetId, setSelectedStoredAssetId] = useState<string | null>(null);
  const [assetStatus, setAssetStatus] = useState('Sin asset convertido.');
  const [isGalleryBusy, setIsGalleryBusy] = useState(false);
  const [isConvertingAsset, setIsConvertingAsset] = useState(false);
  const [isUploadingAsset, setIsUploadingAsset] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [touchAlert, setTouchAlert] = useState<TouchAlert | null>(null);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([
    {
      id: 0,
      at: timeLabel(),
      direction: 'system',
      message: 'Listo para conectar el ESP32 por USB-C.',
    },
  ]);

  const isSerialSupported = typeof navigator !== 'undefined' && Boolean(navigator.serial);
  const isBleSupported = typeof navigator !== 'undefined' && Boolean(navigator.bluetooth);
  const isSerialConnected = connectedPort !== null;
  const isBleConnected = connectedBleDevice !== null;
  const isConnected = isSerialConnected || isBleConnected;
  const serialActionBusy = isBusy || isBleBusy || isUploadingAsset;

  const appendLog = useCallback((direction: LogDirection, message: string) => {
    logIdRef.current += 1;
    setLogEntries((current) => [
      {
        id: logIdRef.current,
        at: timeLabel(),
        direction,
        message,
      },
      ...current,
    ].slice(0, 36));
  }, []);

  const refreshStoredAssets = useCallback(async (): Promise<StoredAnimationAsset[]> => {
    const assets = await loadAssetGallery();
    setStoredAssets(assets);
    return assets;
  }, []);

  useEffect(() => {
    let isMounted = true;

    void loadAssetGallery()
      .then((assets) => {
        if (isMounted) {
          setStoredAssets(assets);
        }
      })
      .catch(() => {
        if (isMounted) {
          appendLog('system', 'La galeria local no esta disponible en este navegador.');
        }
      });

    return () => {
      isMounted = false;
    };
  }, [appendLog]);

  const resolveLineWaiters = useCallback((line: string) => {
    if (lineWaitersRef.current.length === 0) {
      return;
    }

    const remaining: LineWaiter[] = [];
    for (const waiter of lineWaitersRef.current) {
      if (waiter.predicate(line)) {
        window.clearTimeout(waiter.timeoutId);
        waiter.resolve(line);
      } else {
        remaining.push(waiter);
      }
    }
    lineWaitersRef.current = remaining;
  }, []);

  const waitForLine = useCallback(
    (predicate: (line: string) => boolean, timeoutMs = 5000): Promise<string> =>
      new Promise((resolve, reject) => {
        const timeoutId = window.setTimeout(() => {
          lineWaitersRef.current = lineWaitersRef.current.filter(
            (waiter) => waiter.timeoutId !== timeoutId,
          );
          reject(new Error('Timeout esperando respuesta del ESP32.'));
        }, timeoutMs);

        lineWaitersRef.current = [
          ...lineWaitersRef.current,
          {
            predicate,
            reject,
            resolve,
            timeoutId,
          },
        ];
      }),
    [],
  );

  const rejectLineWaiters = useCallback((message: string) => {
    for (const waiter of lineWaitersRef.current) {
      window.clearTimeout(waiter.timeoutId);
      waiter.reject(new Error(message));
    }
    lineWaitersRef.current = [];
  }, []);

  const handleReceivedLine = useCallback(
    (line: string) => {
      resolveLineWaiters(line);
      appendLog('received', line);

      if (!line.startsWith('ALERT:TOUCH_PRESS:')) {
        return;
      }

      const [, , xRaw, yRaw, gestureRaw] = line.split(':');
      const x = Number.parseInt(xRaw ?? '', 10);
      const y = Number.parseInt(yRaw ?? '', 10);
      const gesture = Number.parseInt(gestureRaw ?? '', 10);

      setTouchAlert({
        id: Date.now(),
        at: timeLabel(),
        x: Number.isFinite(x) ? x : null,
        y: Number.isFinite(y) ? y : null,
        gesture: Number.isFinite(gesture) ? gesture : null,
      });
    },
    [appendLog, resolveLineWaiters],
  );

  const handleBleCharacteristicValueChanged = useCallback(
    (event: Event) => {
      const characteristic = event.target as BluetoothRemoteGATTCharacteristic | null;
      if (!characteristic?.value) {
        return;
      }

      bleLineBufferRef.current += new TextDecoder().decode(characteristic.value);
      const lines = bleLineBufferRef.current.split(/\r?\n/);
      bleLineBufferRef.current = lines.pop() ?? '';

      for (const line of lines) {
        const cleanLine = line.trim();
        if (cleanLine.length > 0) {
          handleReceivedLine(cleanLine);
        }
      }
    },
    [handleReceivedLine],
  );

  const readFromPort = useCallback(
    async (port: SerialPort) => {
      const reader = port.readable?.getReader();
      if (!reader) {
        appendLog('system', 'El puerto no expuso canal de lectura.');
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';
      readerRef.current = reader;

      try {
        while (true) {
          const result = await reader.read();
          if (result.done) {
            break;
          }

          if (!result.value) {
            continue;
          }

          buffer += decoder.decode(result.value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const cleanLine = line.trim();
            if (cleanLine.length > 0) {
              handleReceivedLine(cleanLine);
            }
          }
        }
      } catch (error) {
        if (portRef.current === port) {
          const message = error instanceof Error ? error.message : 'Lectura serial interrumpida.';
          appendLog('system', message);
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // Reader may already be released after disconnect.
        }
        if (readerRef.current === reader) {
          readerRef.current = null;
        }
      }
    },
    [appendLog, handleReceivedLine],
  );

  const clearBleConnection = useCallback(
    (message: string) => {
      if (bleTxCharacteristicRef.current) {
        bleTxCharacteristicRef.current.removeEventListener(
          'characteristicvaluechanged',
          handleBleCharacteristicValueChanged,
        );
      }

      bleRxCharacteristicRef.current = null;
      bleTxCharacteristicRef.current = null;
      bleDeviceRef.current = null;
      bleLineBufferRef.current = '';
      setConnectedBleDevice(null);
      appendLog('system', message);
    },
    [appendLog, handleBleCharacteristicValueChanged],
  );

  const handleBleDisconnected = useCallback(() => {
    clearBleConnection('BLE desconectado.');
  }, [clearBleConnection]);

  const connectBle = useCallback(async () => {
    if (!navigator.bluetooth) {
      appendLog('system', 'Este navegador no soporta Web Bluetooth.');
      return;
    }

    setIsBleBusy(true);
    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'AgentVis' }],
        optionalServices: [BLE_SERVICE_UUID],
      });

      const server = await device.gatt?.connect();
      if (!server) {
        appendLog('system', 'El dispositivo BLE no expuso GATT.');
        return;
      }

      const service = await server.getPrimaryService(BLE_SERVICE_UUID);
      const rxCharacteristic = await service.getCharacteristic(BLE_RX_CHARACTERISTIC_UUID);
      const txCharacteristic = await service.getCharacteristic(BLE_TX_CHARACTERISTIC_UUID);
      await txCharacteristic.startNotifications();
      txCharacteristic.addEventListener('characteristicvaluechanged', handleBleCharacteristicValueChanged);
      device.addEventListener('gattserverdisconnected', handleBleDisconnected);

      bleDeviceRef.current = device;
      bleRxCharacteristicRef.current = rxCharacteristic;
      bleTxCharacteristicRef.current = txCharacteristic;
      setConnectedBleDevice(device);
      appendLog('system', `BLE conectado a ${device.name ?? device.id}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'No se pudo conectar BLE.';
      appendLog('system', message);
    } finally {
      setIsBleBusy(false);
    }
  }, [appendLog, handleBleCharacteristicValueChanged, handleBleDisconnected]);

  const disconnectBle = useCallback(async () => {
    setIsBleBusy(true);
    try {
      if (bleTxCharacteristicRef.current) {
        await bleTxCharacteristicRef.current.stopNotifications().catch(() => undefined);
        bleTxCharacteristicRef.current.removeEventListener(
          'characteristicvaluechanged',
          handleBleCharacteristicValueChanged,
        );
      }

      if (bleDeviceRef.current) {
        bleDeviceRef.current.removeEventListener('gattserverdisconnected', handleBleDisconnected);
        bleDeviceRef.current.gatt?.disconnect();
      }

      bleRxCharacteristicRef.current = null;
      bleTxCharacteristicRef.current = null;
      bleDeviceRef.current = null;
      bleLineBufferRef.current = '';
      setConnectedBleDevice(null);
      appendLog('system', 'BLE desconectado.');
    } finally {
      setIsBleBusy(false);
    }
  }, [appendLog, handleBleCharacteristicValueChanged, handleBleDisconnected]);

  const disconnect = useCallback(async () => {
    setIsBusy(true);
    try {
      if (readerRef.current) {
        await readerRef.current.cancel().catch(() => undefined);
      }

      if (writerRef.current) {
        try {
          writerRef.current.releaseLock();
        } catch {
          // Writer may already be released after a device unplug.
        }
        writerRef.current = null;
      }

      if (portRef.current) {
        await portRef.current.close().catch(() => undefined);
      }

      portRef.current = null;
      setConnectedPort(null);
      setTouchAlert(null);
      rejectLineWaiters('Puerto desconectado.');
      appendLog('system', 'Puerto desconectado.');
    } finally {
      setIsBusy(false);
    }
  }, [appendLog, rejectLineWaiters]);

  const connect = useCallback(async () => {
    if (!navigator.serial) {
      appendLog('system', 'Este navegador no soporta Web Serial.');
      return;
    }

    setIsBusy(true);
    try {
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: SERIAL_BAUD_RATE });

      const writer = port.writable?.getWriter();
      if (!writer) {
        await port.close();
        appendLog('system', 'El puerto no expuso canal de escritura.');
        return;
      }

      portRef.current = port;
      writerRef.current = writer;
      setConnectedPort(port);
      appendLog('system', `Conectado a ${formatUsbInfo(port)} @ ${formatBytes(SERIAL_BAUD_RATE)} baud.`);
      void readFromPort(port);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'No se pudo conectar el puerto.';
      appendLog('system', message);
    } finally {
      setIsBusy(false);
    }
  }, [appendLog, readFromPort]);

  const writeSerialLine = useCallback(
    async (line: string) => {
      if (!writerRef.current) {
        throw new Error('Conecta el ESP32 antes de enviar comandos.');
      }

      const encoder = new TextEncoder();
      const writer = writerRef.current;
      await writer.write(encoder.encode(`${line}\n`));
      await writer.ready;
      appendLog('sent', summarizeSerialLine(line));
    },
    [appendLog],
  );

  const writeSerialBytes = useCallback(async (bytes: Uint8Array) => {
    if (!writerRef.current) {
      throw new Error('Conecta el ESP32 antes de enviar datos.');
    }

    const writer = writerRef.current;
    await writer.write(bytes);
    await writer.ready;
  }, []);

  const writeBleLine = useCallback(
    async (line: string) => {
      const characteristic = bleRxCharacteristicRef.current;
      if (!characteristic) {
        throw new Error('Conecta el ESP32 por BLE antes de enviar comandos.');
      }

      const payload = new TextEncoder().encode(`${line}\n`);
      if (characteristic.writeValueWithResponse) {
        await characteristic.writeValueWithResponse(payload);
      } else {
        await characteristic.writeValue(payload);
      }
      appendLog('sent', `BLE:${summarizeSerialLine(line)}`);
    },
    [appendLog],
  );

  const sendLine = useCallback(
    async (line: string) => {
      try {
        if (bleRxCharacteristicRef.current) {
          await writeBleLine(line);
          return;
        }

        await writeSerialLine(line);
      } catch {
        appendLog('system', 'No se pudo enviar el comando.');
      }
    },
    [appendLog, writeBleLine, writeSerialLine],
  );

  const sendState = useCallback(
    async (nextState: DeviceState, command: string) => {
      setDeviceState(nextState);
      await sendLine(command);
    },
    [sendLine],
  );

  const sendCustomText = useCallback(async () => {
    const trimmed = customText.trim();
    if (trimmed.length === 0) {
      appendLog('system', 'El texto custom esta vacio.');
      return;
    }

    await sendLine(`TEXT:${trimmed.slice(0, 72)}`);
  }, [appendLog, customText, sendLine]);

  const convertSelectedLottieAsset = useCallback(async () => {
    if (!selectedLottieFile) {
      setAssetStatus('Selecciona un JSON Lottie primero.');
      return;
    }

    setIsConvertingAsset(true);
    setConvertedAsset(null);
    setSelectedStoredAssetId(null);
    setUploadProgress(0);
    setAssetStatus('Convirtiendo Lottie...');

    try {
      const animationData = JSON.parse(await selectedLottieFile.text()) as unknown;
      const asset = await convertLottieToHardwareAsset(animationData, selectedLottieFile.name);
      setConvertedAsset(asset);
      setAssetStatus('Asset listo para enviar.');
      appendLog(
        'system',
        `Asset listo: ${asset.frameCount} frames, ${formatBytes(asset.bytes.length)} bytes, CRC ${asset.crcHex}.`,
      );
    } catch (error) {
      const message =
        error instanceof Error && error.message.startsWith('Asset demasiado grande')
          ? 'Asset demasiado grande. Usa menos frames, menor tamano o mejor compresion.'
          : 'No se pudo convertir ese Lottie.';
      setAssetStatus(message);
      appendLog('system', message);
    } finally {
      setIsConvertingAsset(false);
    }
  }, [appendLog, selectedLottieFile]);

  const saveConvertedAssetToGallery = useCallback(async () => {
    if (!convertedAsset) {
      setAssetStatus('Convierte un Lottie antes de guardarlo.');
      return;
    }

    setIsGalleryBusy(true);
    try {
      const storedAsset = await saveAssetToGallery(convertedAsset);
      await refreshStoredAssets();
      setSelectedStoredAssetId(storedAsset.id);
      setAssetStatus(`${storedAsset.fileName} guardado en la galeria local.`);
      appendLog('system', `Asset guardado en galeria: ${storedAsset.fileName}.`);
    } catch {
      setAssetStatus('No se pudo guardar en la galeria local.');
      appendLog('system', 'No se pudo guardar el asset en IndexedDB.');
    } finally {
      setIsGalleryBusy(false);
    }
  }, [appendLog, convertedAsset, refreshStoredAssets]);

  const selectStoredAsset = useCallback(
    (asset: StoredAnimationAsset) => {
      setConvertedAsset(toConvertedAnimationAsset(asset));
      setSelectedStoredAssetId(asset.id);
      setSelectedLottieFile(null);
      setUploadProgress(0);
      setAssetStatus(`${asset.fileName} cargado desde la galeria.`);
      appendLog('system', `Asset cargado desde galeria: ${asset.fileName}.`);
    },
    [appendLog],
  );

  const removeStoredAsset = useCallback(
    async (asset: StoredAnimationAsset) => {
      setIsGalleryBusy(true);
      try {
        await deleteAssetFromGallery(asset.id);
        await refreshStoredAssets();
        if (selectedStoredAssetId === asset.id) {
          setSelectedStoredAssetId(null);
        }
        setAssetStatus(`${asset.fileName} borrado de la galeria.`);
        appendLog('system', `Asset borrado de galeria: ${asset.fileName}.`);
      } catch {
        setAssetStatus('No se pudo borrar ese asset de la galeria.');
        appendLog('system', 'No se pudo borrar el asset de IndexedDB.');
      } finally {
        setIsGalleryBusy(false);
      }
    },
    [appendLog, refreshStoredAssets, selectedStoredAssetId],
  );

  const expectUploadLine = useCallback(
    async (predicate: (line: string) => boolean, timeoutMs: number, phase: string): Promise<string> => {
      let line: string;
      try {
        line = await waitForLine(
          (receivedLine) => predicate(receivedLine) || receivedLine.startsWith('ERR:UPLOAD:'),
          timeoutMs,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Timeout esperando respuesta del ESP32.';
        throw new Error(`${phase}: ${message}`);
      }

      if (line.startsWith('ERR:UPLOAD:')) {
        throw new Error(`${phase}: ${line}`);
      }

      return line;
    },
    [waitForLine],
  );

  const sendUploadedAsset = useCallback(async (assetOverride?: ConvertedAnimationAsset): Promise<boolean> => {
    const asset = assetOverride ?? convertedAsset;

    if (!asset) {
      setAssetStatus('Convierte un Lottie antes de enviar.');
      return false;
    }

    if (!writerRef.current) {
      setAssetStatus('Conecta el ESP32 antes de enviar.');
      return false;
    }

    setIsUploadingAsset(true);
    setUploadProgress(0);
    setAssetStatus('Enviando asset binario...');

    try {
      const beginAck = expectUploadLine(
        (line) => line === 'ACK:UPLOAD:BEGIN',
        8000,
        'begin binary upload',
      );
      await writeSerialLine(`UPLOAD:BINARY:BEGIN:${asset.bytes.length}:${asset.crcHex}`);
      await beginAck;

      for (let offset = 0; offset < asset.bytes.length; offset += SERIAL_UPLOAD_CHUNK_BYTES) {
        const chunk = asset.bytes.slice(offset, offset + SERIAL_UPLOAD_CHUNK_BYTES);
        const expectedReceivedBytes = offset + chunk.length;
        const readyAck = expectUploadLine(
          (line) => line === `ACK:UPLOAD:BINARY:READY:${chunk.length}`,
          SERIAL_UPLOAD_ACK_TIMEOUT_MS,
          `ready chunk ${offset}-${expectedReceivedBytes}`,
        );
        await writeSerialLine(`UPLOAD:BINARY:CHUNK:${chunk.length}`);
        await readyAck;

        const chunkAck = expectUploadLine((line) => {
          if (!line.startsWith('ACK:UPLOAD:CHUNK:')) {
            return false;
          }

          const receivedBytes = Number.parseInt(line.substring('ACK:UPLOAD:CHUNK:'.length), 10);
          return receivedBytes === expectedReceivedBytes;
        }, SERIAL_UPLOAD_ACK_TIMEOUT_MS, `ack chunk ${offset}-${expectedReceivedBytes}`);
        await writeSerialBytes(chunk);
        await chunkAck;
        setUploadProgress(Math.round(((offset + chunk.length) / asset.bytes.length) * 100));
      }

      const endAck = expectUploadLine(
        (line) => line === `ACK:UPLOAD:END:${asset.bytes.length}`,
        SERIAL_UPLOAD_ACK_TIMEOUT_MS,
        'finish binary upload',
      );
      await writeSerialLine('UPLOAD:END');
      await endAck;

      setAssetStatus('Asset guardado. Listo para Play uploaded.');
      appendLog('system', `Upload completo: ${formatBytes(asset.bytes.length)} bytes.`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error de transferencia.';
      setAssetStatus(`No se pudo completar el upload: ${message}`);
      appendLog('system', `Upload cancelado: ${message}`);
      return false;
    } finally {
      setIsUploadingAsset(false);
    }
  }, [appendLog, convertedAsset, expectUploadLine, writeSerialBytes, writeSerialLine]);

  const uploadStoredAsset = useCallback(
    async (asset: StoredAnimationAsset) => {
      selectStoredAsset(asset);
      const uploaded = await sendUploadedAsset(toConvertedAnimationAsset(asset));
      if (uploaded) {
        setAssetStatus('Asset subido. Reproduciendo uploaded.');
        await sendLine('ANIM:PLAY:UPLOADED');
      }
    },
    [selectStoredAsset, sendLine, sendUploadedAsset],
  );

  const currentState = stateCopy[deviceState];
  const connectionLabel =
    isSerialConnected && isBleConnected
      ? 'USB + BLE'
      : isSerialConnected
        ? 'USB conectado'
        : isBleConnected
          ? 'BLE conectado'
          : 'Desconectado';
  const connectionDetail = [isSerialConnected ? formatUsbInfo(connectedPort) : null, isBleConnected ? formatBleInfo(connectedBleDevice) : null]
    .filter(Boolean)
    .join(' | ') || 'Sin conexion';
  const previewClassName = useMemo(() => `device-preview device-preview--${deviceState}`, [deviceState]);
  const touchMeta = touchAlert
    ? `x ${touchAlert.x ?? '-'} | y ${touchAlert.y ?? '-'} | gesture ${touchAlert.gesture ?? '-'}`
    : '';
  const galleryCountLabel = storedAssets.length === 1 ? '1 asset' : `${storedAssets.length} assets`;

  return (
    <main className="app-shell">
      {touchAlert ? (
        <div className="touch-signal-banner" role="alert">
          <div>
            <strong>TOUCH RECIBIDO</strong>
            <span>
              {touchAlert.at} | {touchMeta}
            </span>
          </div>
          <button type="button" onClick={() => setTouchAlert(null)}>
            Cerrar
          </button>
        </div>
      ) : null}

      <section className="hero-band">
        <div className="hero-copy">
          <p className="eyebrow">Agent Visualizer</p>
          <h1>Desk toy para ver trabajar a tus agentes.</h1>
          <p className="intro">
            Primer loop: app web por USB Serial, ESP32 con pantalla, comandos cortos y feedback
            visual inmediato.
          </p>
        </div>
        <div className="connection-strip" aria-live="polite">
          <span className={`status-dot ${isConnected ? 'status-dot--on' : ''}`} />
          <div>
            <strong>{connectionLabel}</strong>
            <span>{connectionDetail}</span>
          </div>
        </div>
      </section>

      <section className="workspace-grid">
        <div
          className={`device-stage ${touchAlert ? 'device-stage--touch' : ''}`}
          aria-label="Vista previa del dispositivo"
        >
          <div className={previewClassName}>
            <Lottie
              animationData={agentOrbAnimation}
              autoplay
              className="lottie-robot"
              loop
              rendererSettings={{ preserveAspectRatio: 'xMidYMid meet' }}
            />
            <div className="screen-face screen-face--fallback" aria-hidden="true">
              <span className="screen-brow" />
              <span className="screen-eye" />
              <span className="screen-eye screen-eye--right" />
              <span className="screen-mouth" />
            </div>
            <div className="screen-text">
              <strong>{currentState.title}</strong>
              <span>{currentState.detail}</span>
            </div>
            {touchAlert ? (
              <div className="touch-screen-alert" key={`screen-${touchAlert.id}`}>
                <span>TOUCH</span>
                <strong>PRESS</strong>
                <small>{touchMeta}</small>
              </div>
            ) : null}
            {touchAlert ? <span className="touch-ripple" key={`ripple-${touchAlert.id}`} /> : null}
          </div>
          <div className="hardware-note">
            <span>Target actual</span>
            <strong>ESP32-C3 round GC9A01 1.28&quot;</strong>
          </div>
        </div>

        <div className="control-surface">
          {!isSerialSupported ? (
            <div className="unsupported-panel">
              <strong>Web Serial no esta disponible en este navegador.</strong>
              <span>Usa Chrome o Edge desktop para hablar con el ESP32 por USB.</span>
            </div>
          ) : null}
          {!isBleSupported ? (
            <div className="unsupported-panel">
              <strong>Web Bluetooth no esta disponible en este navegador.</strong>
              <span>Usa Chrome o Edge desktop para probar el canal BLE.</span>
            </div>
          ) : null}

          {touchAlert ? (
            <div className="touch-alert" role="alert">
              <div>
                <strong>Senal touch activa</strong>
                <span>
                  {touchAlert.at} | {touchMeta}
                </span>
              </div>
              <button type="button" onClick={() => setTouchAlert(null)}>
                Cerrar
              </button>
            </div>
          ) : null}

          <div className="button-row">
            <button type="button" onClick={connect} disabled={!isSerialSupported || isSerialConnected || isBusy}>
              USB
            </button>
            <button type="button" onClick={disconnect} disabled={!isSerialConnected || isBusy}>
              USB off
            </button>
            <button type="button" onClick={() => void connectBle()} disabled={!isBleSupported || isBleConnected || isBleBusy}>
              BLE
            </button>
            <button type="button" onClick={() => void disconnectBle()} disabled={!isBleConnected || isBleBusy}>
              BLE off
            </button>
            <button type="button" onClick={() => void sendLine('HELLO')} disabled={!isConnected || serialActionBusy}>
              Hello
            </button>
            <button type="button" onClick={() => void sendLine('PING')} disabled={!isConnected || serialActionBusy}>
              Ping
            </button>
            <button type="button" onClick={() => void sendLine('INFO')} disabled={!isConnected || serialActionBusy}>
              Info
            </button>
            <button
              type="button"
              onClick={() => void sendLine('ANIM:PUBLIC_LOTTIE')}
              disabled={!isConnected || serialActionBusy}
            >
              Lottie
            </button>
          </div>

          <div className="state-grid" aria-label="Estados de agente">
            {AGENT_STATES.map((state) => (
              <button
                className={`state-button state-button--${state.id}`}
                disabled={!isConnected || serialActionBusy}
                key={state.id}
                onClick={() => void sendState(state.id, state.command)}
                type="button"
              >
                <span />
                {state.label}
              </button>
            ))}
          </div>

          <form
            className="text-command"
            onSubmit={(event) => {
              event.preventDefault();
              void sendCustomText();
            }}
          >
            <label htmlFor="device-text">Texto para la pantalla</label>
            <div>
              <input
                id="device-text"
                maxLength={72}
                onChange={(event) => setCustomText(event.target.value)}
                placeholder="Hola agente"
                value={customText}
              />
              <button type="submit" disabled={!isConnected || serialActionBusy}>
                Enviar
              </button>
            </div>
          </form>

          <div className="asset-admin-panel">
            <div className="section-heading asset-admin-heading">
              <strong>Admin asset</strong>
              <span>{convertedAsset ? `${convertedAsset.frameCount} frames` : selectedLottieFile?.name ?? 'JSON'}</span>
            </div>

            <label className="file-picker" htmlFor="lottie-upload">
              <span>Lottie JSON</span>
              <input
                accept=".json,application/json"
                disabled={isConvertingAsset || isUploadingAsset || isGalleryBusy}
                id="lottie-upload"
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  setSelectedLottieFile(file);
                  setConvertedAsset(null);
                  setSelectedStoredAssetId(null);
                  setUploadProgress(0);
                  setAssetStatus(file ? `${file.name} seleccionado.` : 'Sin asset convertido.');
                }}
                type="file"
              />
            </label>

            <div className="button-row asset-admin-actions">
              <button
                disabled={!selectedLottieFile || isConvertingAsset || isUploadingAsset || isGalleryBusy}
                onClick={() => void convertSelectedLottieAsset()}
                type="button"
              >
                {isConvertingAsset ? 'Convirtiendo' : 'Convertir'}
              </button>
              <button
                disabled={!convertedAsset || isConvertingAsset || isUploadingAsset || isGalleryBusy}
                onClick={() => void saveConvertedAssetToGallery()}
                type="button"
              >
                {isGalleryBusy ? 'Guardando' : 'Guardar'}
              </button>
              <button
                disabled={!isSerialConnected || !convertedAsset || isConvertingAsset || isUploadingAsset || isGalleryBusy}
                onClick={() => void sendUploadedAsset()}
                type="button"
              >
                {isUploadingAsset ? 'Enviando' : 'Subir'}
              </button>
              <button
                disabled={!isConnected || serialActionBusy}
                onClick={() => void sendLine('ANIM:PLAY:UPLOADED')}
                type="button"
              >
                Play uploaded
              </button>
              <button
                disabled={!isConnected || serialActionBusy}
                onClick={() => {
                  setAssetStatus('Boot guardado. Si es uploaded, queda en modo tap.');
                  void sendLine('BOOT:SAVE');
                }}
                type="button"
              >
                Perpetuar
              </button>
              <button
                disabled={!isConnected || serialActionBusy}
                onClick={() => {
                  setAssetStatus('Boot persistente limpiado.');
                  void sendLine('BOOT:CLEAR');
                }}
                type="button"
              >
                Reset boot
              </button>
            </div>

            {convertedAsset ? (
              <dl className="asset-metrics">
                <div>
                  <dt>Size</dt>
                  <dd>
                    {convertedAsset.width}x{convertedAsset.height}
                  </dd>
                </div>
                <div>
                  <dt>Bytes</dt>
                  <dd>{formatBytes(convertedAsset.bytes.length)}</dd>
                </div>
                <div>
                  <dt>FPS</dt>
                  <dd>{convertedAsset.fps}</dd>
                </div>
                <div>
                  <dt>CRC</dt>
                  <dd>{convertedAsset.crcHex}</dd>
                </div>
              </dl>
            ) : null}

            <div className="asset-progress" aria-label="Progreso de upload">
              <span style={{ width: `${uploadProgress}%` }} />
            </div>
            <p className="asset-status" aria-live="polite">
              {assetStatus}
            </p>

            <div className="asset-gallery">
              <div className="section-heading asset-gallery-heading">
                <strong>Galeria local</strong>
                <span>{galleryCountLabel}</span>
              </div>

              {storedAssets.length === 0 ? (
                <div className="asset-gallery-empty">
                  <span className="asset-gallery-empty-mark">AVF1</span>
                  <div>
                    <strong>Sin assets guardados</strong>
                    <span>Convierte un JSON y guardalo para repetir uploads sin reconvertir.</span>
                  </div>
                </div>
              ) : (
                <div className="asset-gallery-list" role="list">
                  {storedAssets.map((asset) => (
                    <div
                      className={`asset-gallery-item ${
                        selectedStoredAssetId === asset.id ? 'asset-gallery-item--selected' : ''
                      }`}
                      key={asset.id}
                      role="listitem"
                    >
                      <div className="asset-gallery-main">
                        <strong>{asset.fileName}</strong>
                        <span>
                          {asset.width}x{asset.height} / {asset.frameCount} frames /{' '}
                          {formatBytes(asset.bytes.length)} bytes / {formatSavedAt(asset.savedAt)}
                        </span>
                        <code>{asset.crcHex}</code>
                      </div>
                      <div className="asset-gallery-actions">
                        <button
                          aria-label={`Usar ${asset.fileName}`}
                          disabled={!isSerialConnected || isConvertingAsset || isUploadingAsset || isGalleryBusy}
                          onClick={() => void uploadStoredAsset(asset)}
                          type="button"
                        >
                          Usar
                        </button>
                        <button
                          aria-label={`Cargar ${asset.fileName}`}
                          disabled={isConvertingAsset || isUploadingAsset || isGalleryBusy}
                          onClick={() => selectStoredAsset(asset)}
                          type="button"
                        >
                          Cargar
                        </button>
                        <button
                          aria-label={`Borrar ${asset.fileName}`}
                          disabled={isConvertingAsset || isUploadingAsset || isGalleryBusy}
                          onClick={() => void removeStoredAsset(asset)}
                          type="button"
                        >
                          Borrar
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="protocol-panel">
            <strong>Protocolo v0</strong>
            <code>HELLO</code>
            <code>PING</code>
            <code>INFO</code>
            <code>ANIM:PUBLIC_LOTTIE</code>
            <code>ANIM:PLAY:UPLOADED</code>
            <code>BOOT:SAVE</code>
            <code>BOOT:CLEAR</code>
            <code>BLE:GATT</code>
            <code>UPLOAD:BINARY</code>
            <code>UPLOAD:HEX</code>
            <code>STATE:working</code>
            <code>TEXT:Hola</code>
            <code>ALERT:TOUCH_PRESS:x:y:g</code>
          </div>
        </div>

        <section className="log-panel" aria-label="Log serial">
          <div className="section-heading">
            <strong>Serial log</strong>
            <span>{logEntries.length} eventos</span>
          </div>
          <ol>
            {logEntries.map((entry) => (
              <li className={`log-entry log-entry--${entry.direction}`} key={entry.id}>
                <span>{entry.at}</span>
                <code>{entry.message}</code>
              </li>
            ))}
          </ol>
        </section>
      </section>
    </main>
  );
}
