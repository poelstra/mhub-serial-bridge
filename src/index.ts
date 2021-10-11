import main from "async-main";
import debug from "debug";
import path from "path";
import "source-map-support/register";
import { Bridge, BridgePortOptions } from "./bridge";
import { Hub } from "./hub";
import {
    SerialPortOptions,
    SerialPortScanner,
    SerialPortScannerOptions,
} from "./serialPortScanner";

const log = debug("bridge:main");

interface PortOptions extends SerialPortOptions, BridgePortOptions {}

interface Config extends SerialPortScannerOptions<PortOptions> {
    /**
     * MHub configuration
     */
    mhub: {
        url: string;
        user?: string;
        pass?: string;
    };
}

function prefixTimestamp(console: Console, method: keyof Console): void {
    const origMethod = console[method] as (this: any, ...args: any[]) => void;
    console[method] = function (this: any, ...args: any[]) {
        // Don't use e.g. args.unshift, because only the first argument supports printf-formatting
        args[0] = `${new Date().toISOString()} [${method}] ${args[0]}`;
        return origMethod.apply(this, args);
    } as any;
}

main(async () => {
    prefixTimestamp(console, "log");
    prefixTimestamp(console, "info");
    prefixTimestamp(console, "warn");
    prefixTimestamp(console, "error");

    if (!process.env.DEBUG && !process.env.NODE_ENV) {
        console.info("Tip: use `DEBUG=bridge:*` to enable verbose debug info");
    }

    const configPath =
        process.argv[2] ?? path.resolve(__dirname, "../config.json");
    console.log(`Reading configuration from ${configPath}`);
    const config = require(configPath) as Config;

    for (const [port, portOptions] of Object.entries(config.ports)) {
        if (typeof portOptions.topicPrefix !== "string") {
            throw new Error(`invalid topicPrefix for port '${port}'`);
        }
        if (typeof portOptions.node !== "string") {
            throw new Error(`invalid node for port '${port}'`);
        }
    }

    const hub = new Hub(config.mhub.url, config.mhub.user, config.mhub.pass);
    const bridge = new Bridge(hub);

    const scanner = new SerialPortScanner(
        config,
        async (port, options, portName) => {
            await bridge.attach(port, options);
            console.log(
                `Serial port '${portName}' found, connected to '${options.topicPrefix}'`
            );
            port.once("close", () =>
                console.log(
                    `Serial port '${portName}' ('${options.topicPrefix}') closed.`
                )
            );
        }
    );

    scanner.pause(); // unpaused on MHub connection
    hub.on("connect", () => {
        console.log("MHub connected, scanning for ports...");
        scanner.resume();
    });
    hub.on("disconnect", () => {
        console.log("MHub disconnected, reconnecting...");
        scanner.pause();
    });

    // Start connecting to MHub, and automatically keep reconnecting
    main(async () => {
        console.log(`Connecting to MHub at ${config.mhub.url}...`);
        await hub.run();
    });

    // Start searching for Serial API devices and connecting them to hosts
    await scanner.run();
});
