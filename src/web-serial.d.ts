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
    readonly bluetooth?: Bluetooth;
    readonly serial?: Serial;
  }

  interface Bluetooth {
    requestDevice(options: BluetoothRequestDeviceOptions): Promise<BluetoothDevice>;
  }

  interface BluetoothRequestDeviceOptions {
    acceptAllDevices?: boolean;
    filters?: BluetoothLEScanFilter[];
    optionalServices?: BluetoothServiceUUID[];
  }

  interface BluetoothLEScanFilter {
    name?: string;
    namePrefix?: string;
    services?: BluetoothServiceUUID[];
  }

  type BluetoothServiceUUID = number | string;
  type BluetoothCharacteristicUUID = number | string;

  interface BluetoothDevice extends EventTarget {
    readonly gatt?: BluetoothRemoteGATTServer;
    readonly id: string;
    readonly name?: string;
  }

  interface BluetoothRemoteGATTServer {
    readonly connected: boolean;
    connect(): Promise<BluetoothRemoteGATTServer>;
    disconnect(): void;
    getPrimaryService(service: BluetoothServiceUUID): Promise<BluetoothRemoteGATTService>;
  }

  interface BluetoothRemoteGATTService {
    getCharacteristic(characteristic: BluetoothCharacteristicUUID): Promise<BluetoothRemoteGATTCharacteristic>;
  }

  interface BluetoothRemoteGATTCharacteristic extends EventTarget {
    readonly value?: DataView;
    startNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
    stopNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
    writeValue(value: BufferSource): Promise<void>;
    writeValueWithResponse?(value: BufferSource): Promise<void>;
    writeValueWithoutResponse?(value: BufferSource): Promise<void>;
  }
}
