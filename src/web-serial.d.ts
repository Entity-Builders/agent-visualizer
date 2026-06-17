export {};

declare global {
  interface SerialPortInfo {
    usbVendorId?: number;
    usbProductId?: number;
  }

  interface SerialPort {
    readonly readable: ReadableStream<Uint8Array> | null;
    readonly writable: WritableStream<Uint8Array> | null;
    close(): Promise<void>;
    getInfo(): SerialPortInfo;
    open(options: SerialOptions): Promise<void>;
  }

  interface SerialOptions {
    baudRate: number;
    bufferSize?: number;
    dataBits?: 7 | 8;
    flowControl?: 'none' | 'hardware';
    parity?: 'none' | 'even' | 'odd';
    stopBits?: 1 | 2;
  }

  interface Serial {
    getPorts(): Promise<SerialPort[]>;
    requestPort(): Promise<SerialPort>;
  }

  interface Navigator {
    readonly serial?: Serial;
  }
}
