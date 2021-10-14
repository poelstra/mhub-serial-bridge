import debug from "debug";
import MHubClient, { Headers, Message } from "mhub";
import SerialPort from "serialport";
import { EventEmitter } from "stream";
import { Hub } from "./hub";
import { PickOptionals } from "./util";

export interface BridgePortOptions {
    /**
     * MHub node.
     */
    node: string;

    /**
     * Prefix to use for specific device.
     * Will be suffixed with `/rx` for any received data,
     * `/tx` for data to be transmitted, and `/state`
     * for open/close messages.
     */
    topicPrefix: string;

    /**
     * Line delimiter.
     *
     * When set to a string (e.g. "\r\n"), it will emit
     * any complete lines (without the delimiter), and will
     * automatically append the delimiter on transmission.
     * Empty lines will be emitted as an empty string.
     *
     * When `undefined`, no parsing will be done, and any
     * received data will be emitted as an array of byte
     * values, and no delimiter will be appended to tx.
     *
     * Independent of the setting of delimiter, values
     * can be written to tx as a string, or an array of
     * byte values.
     */
    delimiter?: string;

    /**
     * Encoding to use for strings, defaults to UTF-8.
     */
    encoding?: BufferEncoding;
}

const defaultOptions: PickOptionals<BridgePortOptions> = {
    delimiter: undefined,
    encoding: "utf-8",
};

class Connection extends EventEmitter {
    public options: BridgePortOptions;
    private _port: SerialPort;
    private _log: debug.Debugger;

    constructor(port: SerialPort, options: BridgePortOptions) {
        super();
        this.options = options;
        this._port = port;
        this._log = debug(
            `bridge:connection:${options.topicPrefix}@${options.node}`
        );

        const parsed = options.delimiter
            ? port.pipe(
                  new SerialPort.parsers.Readline({
                      encoding: options.encoding,
                      delimiter: options.delimiter,
                      // Need to set objectMode in order to pass through
                      // any empty lines as-is.
                      objectMode: true,
                  } as ConstructorParameters<typeof SerialPort.parsers.Readline>[0])
              )
            : port;

        parsed.on("data", (line: Buffer | string) => {
            this._log(`rx`, line);
            this.emit(
                "publish",
                options.node,
                `${options.topicPrefix}/rx`,
                Buffer.isBuffer(line) ? line.toJSON().data : line
            );
        });
        port.once("error", (err: Error) => {
            this._log(`error`, `${err.message}`);
            this.emit(
                "publish",
                options.node,
                `${options.topicPrefix}/state`,
                `error ${err.name} ${err.message}`
            );
        });
        port.once("close", () => {
            this._log(`close`);
            this.emit(
                "publish",
                options.node,
                `${options.topicPrefix}/state`,
                "close"
            );
            this.emit("close");
        });
    }

    public start(): void {
        this._log(`start`);
        this.emit(
            "publish",
            this.options.node,
            `${this.options.topicPrefix}/state`,
            "open"
        );
    }

    public dispatch(message: unknown): void {
        if (typeof message !== "string" && !Array.isArray(message)) {
            this._log(
                "warning",
                `invalid line received, expected string or array, got ${typeof message}`
            );
            return;
        }
        if (
            Array.isArray(message) &&
            message.some(
                (byte) =>
                    typeof byte !== "number" || !(byte >= 0 && byte <= 255)
            )
        ) {
            this._log(
                "warning",
                `invalid line received, array must only contain numbers in range [0..255]`
            );
            return;
        }
        let buffer =
            typeof message === "string"
                ? Buffer.from(message, this.options.encoding)
                : Buffer.from(message);
        if (this.options.delimiter !== undefined) {
            buffer = Buffer.concat([
                buffer,
                Buffer.from(this.options.delimiter, this.options.encoding),
            ]);
        }
        this._log(
            `tx`,
            Array.isArray(message) || this.options.delimiter === undefined
                ? buffer
                : message
        );
        this._port.write(buffer);
    }

    public destroy(_err?: Error): void {
        // This would be something like:
        // entry.port.destroy(err);
        // but SerialPort's destroy() is broken because it doesn't
        // actually close the port (although it does emit a close event...).
        this._port.close();
    }
}

export class Bridge {
    private _hub: Hub;
    private _client: MHubClient | undefined;
    private _connections = new Map<string, Connection>();

    constructor(hub: Hub) {
        this._hub = hub;
        this._hub.on("connect", (client) => this._handleConnect(client));
        this._hub.on("disconnect", () => this._handleDisconnect());
        this._hub.on("message", (message, subscriptionId) =>
            this._handleMessage(message, subscriptionId)
        );
    }

    public async attach(
        port: SerialPort,
        options: BridgePortOptions
    ): Promise<void> {
        if (this._connections.has(options.topicPrefix)) {
            throw new Error(
                `a port with topic prefix '${options.topicPrefix}' is already connected`
            );
        }

        const fullOptions = { ...defaultOptions, ...options };

        const conn = new Connection(port, fullOptions);

        if (!this._client) {
            throw new Error("no MHub connection");
        }
        await this._client.subscribe(
            fullOptions.node,
            `${fullOptions.topicPrefix}/tx`,
            fullOptions.topicPrefix
        );

        conn.once("close", () => {
            this._connections.delete(options.topicPrefix);
            this._safeUnsubscribe(
                conn,
                fullOptions.node,
                fullOptions.topicPrefix
            );
        });
        conn.on("publish", (node, topic, data, headers) =>
            this._safePublish(conn, node, topic, data, headers)
        );
        this._connections.set(options.topicPrefix, conn);

        conn.start();
    }

    public async shutdown(): Promise<void> {
        const oldClient = this._client;
        const oldConnections = [...this._connections.values()];

        this._handleDisconnect();

        if (oldClient) {
            // We manually emit the state events here, because the
            // event emitters of Connection don't allow waiting until
            // the (async) publish is completed...
            for (const conn of oldConnections) {
                await oldClient.publish(
                    conn.options.node,
                    `${conn.options.topicPrefix}/state`,
                    "close"
                );
            }
        }
    }

    private _handleConnect(client: MHubClient): void {
        this._client = client;
    }

    private _handleDisconnect(): void {
        this._client = undefined;
        for (const [_prefix, entry] of this._connections) {
            entry.destroy(new Error("MHub connection closed"));
        }
    }

    private _handleMessage(message: Message, subscriptionId: string): void {
        const entry = this._connections.get(subscriptionId);
        if (!entry) {
            return;
        }
        entry.dispatch(message.data);
    }

    private _safePublish(
        conn: Connection,
        node: string,
        topic: string,
        data: any,
        headers?: Headers
    ): void {
        if (!this._client) {
            return;
        }
        this._client
            .publish(node, topic, data, headers)
            .catch((err) => conn.destroy(err));
    }

    private _safeUnsubscribe(conn: Connection, node: string, id: string): void {
        if (!this._client) {
            return;
        }
        this._client
            .unsubscribe(node, undefined, id)
            .catch((err) => conn.destroy(err));
    }
}
