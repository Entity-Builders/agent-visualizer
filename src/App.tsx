import { useCallback, useMemo, useRef, useState } from 'react';

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

export default function App(): JSX.Element {
  const portRef = useRef<SerialPort | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const writerRef = useRef<WritableStreamDefaultWriter<Uint8Array> | null>(null);
  const logIdRef = useRef(0);

  const [connectedPort, setConnectedPort] = useState<SerialPort | null>(null);
  const [deviceState, setDeviceState] = useState<DeviceState>('standby');
  const [customText, setCustomText] = useState('Hola Agent Visualizer');
  const [isBusy, setIsBusy] = useState(false);
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
  const isConnected = connectedPort !== null;

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

  const handleReceivedLine = useCallback(
    (line: string) => {
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
    [appendLog],
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
      appendLog('system', 'Puerto desconectado.');
    } finally {
      setIsBusy(false);
    }
  }, [appendLog]);

  const connect = useCallback(async () => {
    if (!navigator.serial) {
      appendLog('system', 'Este navegador no soporta Web Serial.');
      return;
    }

    setIsBusy(true);
    try {
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: 115200 });

      const writer = port.writable?.getWriter();
      if (!writer) {
        await port.close();
        appendLog('system', 'El puerto no expuso canal de escritura.');
        return;
      }

      portRef.current = port;
      writerRef.current = writer;
      setConnectedPort(port);
      appendLog('system', `Conectado a ${formatUsbInfo(port)}.`);
      void readFromPort(port);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'No se pudo conectar el puerto.';
      appendLog('system', message);
    } finally {
      setIsBusy(false);
    }
  }, [appendLog, readFromPort]);

  const sendLine = useCallback(
    async (line: string) => {
      if (!writerRef.current) {
        appendLog('system', 'Conecta el ESP32 antes de enviar comandos.');
        return;
      }

      try {
        const encoder = new TextEncoder();
        await writerRef.current.write(encoder.encode(`${line}\n`));
        appendLog('sent', line);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'No se pudo enviar el comando.';
        appendLog('system', message);
      }
    },
    [appendLog],
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

  const currentState = stateCopy[deviceState];
  const connectionLabel = isConnected ? 'Conectado' : 'Desconectado';
  const previewClassName = useMemo(() => `device-preview device-preview--${deviceState}`, [deviceState]);

  return (
    <main className="app-shell">
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
            <span>{formatUsbInfo(connectedPort)}</span>
          </div>
        </div>
      </section>

      <section className="workspace-grid">
        <div className="device-stage" aria-label="Vista previa del dispositivo">
          <div className={previewClassName}>
            <div className="screen-face">
              <span className="screen-brow" />
              <span className="screen-eye" />
              <span className="screen-eye screen-eye--right" />
              <span className="screen-mouth" />
            </div>
            <div className="screen-text">
              <strong>{currentState.title}</strong>
              <span>{currentState.detail}</span>
            </div>
            {touchAlert ? <span className="touch-ripple" key={touchAlert.id} /> : null}
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

          {touchAlert ? (
            <div className="touch-alert" role="alert">
              <div>
                <strong>Press detectado</strong>
                <span>
                  {touchAlert.at} | x {touchAlert.x ?? '-'} | y {touchAlert.y ?? '-'} | gesture{' '}
                  {touchAlert.gesture ?? '-'}
                </span>
              </div>
              <button type="button" onClick={() => setTouchAlert(null)}>
                Cerrar
              </button>
            </div>
          ) : null}

          <div className="button-row">
            <button type="button" onClick={connect} disabled={!isSerialSupported || isConnected || isBusy}>
              Conectar
            </button>
            <button type="button" onClick={disconnect} disabled={!isConnected || isBusy}>
              Desconectar
            </button>
            <button type="button" onClick={() => void sendLine('HELLO')} disabled={!isConnected || isBusy}>
              Hello
            </button>
            <button type="button" onClick={() => void sendLine('PING')} disabled={!isConnected || isBusy}>
              Ping
            </button>
            <button type="button" onClick={() => void sendLine('INFO')} disabled={!isConnected || isBusy}>
              Info
            </button>
          </div>

          <div className="state-grid" aria-label="Estados de agente">
            {AGENT_STATES.map((state) => (
              <button
                className={`state-button state-button--${state.id}`}
                disabled={!isConnected || isBusy}
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
              <button type="submit" disabled={!isConnected || isBusy}>
                Enviar
              </button>
            </div>
          </form>

          <div className="protocol-panel">
            <strong>Protocolo v0</strong>
            <code>HELLO</code>
            <code>PING</code>
            <code>INFO</code>
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
