/**
 * Proof of concept Serial Port scanner.
 *
 * Continuously scans for serial ports, opens new ones and hands
 * them off to whoever needs them.
 */

import debug from "debug";
import { promises as pfs } from "fs";
import { SerialPort, SerialPortOpenOptions } from "serialport";
import { InterruptibleSleep } from "./util";

const log = debug("bridge:scanner");

export interface SerialPortOptions
    extends Omit<SerialPortOpenOptions<any>, "path"> {}

export interface SerialPortScannerOptions<
    PortOptions extends SerialPortOptions = SerialPortOptions
> {
    /**
     * List of full serial port paths.
     *
     * These can be symlinks to actual serial devices.
     * It is advised to use udev rules to create a stable symlink
     * for the port, then use that symlink to uniquely identify it.
     *
     * @example `{ "/dev/serial/by-id/usb-0658_0200-if00": { baudRate: 115200 } }`.
     */
    ports: { [path: string]: PortOptions };

    /**
     * Expected number of connected serial ports.
     */
    expectedPorts?: number;

    /**
     * Scan interval in milliseconds.
     *
     * Used when the expected number of devices is lower than the actual
     * number of connected devices.
     */
    scanInterval?: number;

    /**
     * Idle scan interval in milliseconds.
     *
     * Used when the expected number of devices is connected.
     * Typically (much) higher than the `scanInterval`.
     */
    idleScanInterval?: number;
}

export const DEFAULT_SERIAL_PORT_SCANNER_OPTIONS: Required<SerialPortScannerOptions> =
    {
        ports: {},
        scanInterval: 1000,
        idleScanInterval: 60 * 1000,
        expectedPorts: 1,
    };

export type SerialPortOnOpenCallback<PortOptions> = (
    duplex: SerialPort,
    options: PortOptions,
    portName: string
) => void | Promise<void>;

export const defaultSerialPortOptions: SerialPortOptions = {
    baudRate: 115200,
    parity: "none",
    dataBits: 8,
    stopBits: 1,
};

/**
 * Continuously scan for possibly useable serial ports and try to open them.
 */
export class SerialPortScanner<PortOptions extends SerialPortOptions> {
    private _options: Required<SerialPortScannerOptions<PortOptions>>;
    private _onOpen: SerialPortOnOpenCallback<PortOptions>;
    private _ports = new Map<string, PortOptions>();
    private _paused = false;
    private _sleeper: InterruptibleSleep | undefined;

    /**
     * Create serial port scanner.
     * @param options Scanner options. At least one matcher and/or one explicit port need to be given.
     * @param onOpen  Callback called whenever a new device is found and successfully opened.
     *     Receives the opened duplex stream. If callback returns an error, the port is actively
     *     closed again, but will be retried on the next scan.
     */
    constructor(
        options: SerialPortScannerOptions<PortOptions>,
        onOpen: SerialPortOnOpenCallback<PortOptions>
    ) {
        this._options = { ...DEFAULT_SERIAL_PORT_SCANNER_OPTIONS, ...options };
        if (Object.keys(this._options.ports).length === 0) {
            throw new Error("invalid options: minimum one port must be given");
        }
        this._onOpen = onOpen;
    }

    public pause(): void {
        log("pause");
        this._paused = true;
    }

    public resume(): void {
        log("resume");
        this._paused = false;
        this._sleeper?.interrupt();
    }

    public async run(): Promise<never> {
        if (this._sleeper) {
            throw new Error("scanner already running");
        }

        log(
            `serial port scanner running, scanning for ports=[${Object.keys(
                this._options.ports
            )}]`
        );

        this._sleeper = new InterruptibleSleep();
        try {
            while (true) {
                if (!this._paused) {
                    await this._tick();
                }

                // Switch to lower scanning interval (just in case) when
                // expected number of ports is found, but keep responsive
                // if something happens (i.e. existing port closes).
                const interval =
                    this._ports.size < this._options.expectedPorts &&
                    !this._paused
                        ? this._options.scanInterval
                        : this._options.idleScanInterval;
                await this._sleeper.sleep(interval);
            }
        } finally {
            this._sleeper = undefined;
        }
    }

    private async _tick(): Promise<void> {
        const newPorts = await this._scan();

        for (const [comName, portOptions] of newPorts) {
            try {
                log(
                    `found new serial port ${comName} with options`,
                    portOptions
                );
                let openSuccessful: boolean = false;
                const port = await this._open(comName, portOptions);
                log(`serial port ${comName} opened`);
                this._ports.set(comName, portOptions);
                port.once("close", () => {
                    log(`serial port ${comName} closed`);
                    this._ports.delete(comName);
                    if (openSuccessful) {
                        this._sleeper?.interrupt();
                    }
                });
                try {
                    await this._onOpen(port, portOptions, comName);
                    openSuccessful = true;
                } catch (err) {
                    log(`error initializing serial port ${comName}:`, err);
                    this._ports.delete(comName);
                    // Apparently, calling destroy() isn't properly implemented
                    // in node-serialport: it says it closes, but actually doesn't.
                    // So use 'normal' close instead for now.
                    //port.destroy();
                    port.close();
                }
            } catch (err) {
                log(`error opening serial port ${comName}:`, err);
            }
        }
    }

    private async _scan(): Promise<Map<string, PortOptions>> {
        // Convert explicitly given port names to actual device names,
        // to prevent the same port from being listed twice under
        // different names. Especially happens if an explicit port is
        // given as a /dev/serial/by-id/* name
        const foundPorts = new Map<string, PortOptions>();
        for (const [linkPath, portOptions] of Object.entries(
            this._options.ports
        )) {
            try {
                foundPorts.set(await pfs.realpath(linkPath), portOptions);
            } catch {}
        }

        // Remove ports that no longer exist, just in case
        for (const realPath of Object.keys(this._ports)) {
            if (!foundPorts.has(realPath)) {
                this._ports.delete(realPath);
            }
        }

        // Filter out entries that are already open
        const newPorts = new Map(
            [...foundPorts.entries()].filter(
                ([realPath]) => !this._ports.has(realPath)
            )
        );
        return newPorts;
    }

    private async _open(
        comName: string,
        portOptions: PortOptions
    ): Promise<SerialPort> {
        return new Promise<SerialPort>((resolve, reject) => {
            const options: SerialPortOpenOptions<any> = {
                ...defaultSerialPortOptions,
                ...portOptions,
                path: comName,
            };
            const port: SerialPort = new SerialPort(options, (err) =>
                err ? reject(err) : resolve(port)
            );
        });
    }
}
