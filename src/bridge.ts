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
     * Defaults to `"\n"` if unset.
     * Can be explicitly set to `undefined` to signal
     * no parsing should be done on rx, and no delimiter
     * should be appended on tx.
     */
    delimiter?: string | undefined;
}

const defaultOptions: Required<PickOptionals<BridgePortOptions>> = {
    delimiter: "\n",
};

class Connection extends EventEmitter {
    public options: Required<BridgePortOptions>;
    private _port: SerialPort;
    private _log: debug.Debugger;

    constructor(port: SerialPort, options: Required<BridgePortOptions>) {
        super();
        this.options = options;
        this._port = port;
        this._log = debug(
            `bridge:connection:${options.topicPrefix}@${options.node}`
        );

        const parsed = options.delimiter
            ? port.pipe(
                  new SerialPort.parsers.Readline({
                      delimiter: options.delimiter,
                  })
              )
            : port;

        parsed.on("data", (line: string) => {
            this._log(`rx`, line);
            this.emit(
                "publish",
                options.node,
                `${options.topicPrefix}/rx`,
                line
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
        if (typeof message !== "string") {
            this._log(
                "warning",
                `invalid line received, expected string, got ${typeof message}`
            );
            return;
        }
        this._log(`tx`, `${message}`);
        const line = `${message}${this.options.delimiter}`;
        this._port.write(line);
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
