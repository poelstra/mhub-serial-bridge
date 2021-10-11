import debug from "debug";
import { EventEmitter, once } from "events";
import MHubClient, { Message } from "mhub";
import { delay } from "./util";

const log = debug("bridge:hub");

export interface Hub {
    on(event: "connect", callback: (client: MHubClient) => void): this;
    on(event: "disconnect", callback: () => void): this;
    on(
        event: "message",
        callback: (message: Message, subscriptionId: string) => void
    ): this;
}

export class Hub extends EventEmitter {
    private _client: MHubClient;
    private _user: string | undefined;
    private _pass: string | undefined;

    constructor(url: string, user?: string, pass?: string) {
        super();
        this._user = user;
        this._pass = pass;
        this._client = new MHubClient(url, { noImplicitConnect: true });
        this._client.on("error", () => {
            // no-op, already handled elsewhere, but need to 'handle' these errors
            // to prevent NodeJS EventEmitter errors
        });
        this._client.on("message", (message, subscriptionId) =>
            this.emit("message", message, subscriptionId)
        );
    }

    public async run(): Promise<never> {
        let lastSuccess = false;
        while (true) {
            try {
                log(`connecting to ${this._client.url} ...`);
                await this._client.connect();
                if (this._user !== undefined && this._pass !== undefined) {
                    log(`logging in...`);
                    await this._client.login(this._user, this._pass);
                } else {
                    log("using anonymous access");
                }
                log(`connected`);
                this.emit("connect", this._client);
                await once(this._client, "close");
                this.emit("disconnect");
                log(`disconnected`);
            } catch (err) {
                log("connect error", err);
            }
            try {
                await this._client.close();
            } catch {
                // ignore follow-up error
            }
            if (!lastSuccess) {
                // Quick reconnect on first error, otherwise wait a bit
                await delay(3000);
            }
            lastSuccess = false;
        }
    }
}
