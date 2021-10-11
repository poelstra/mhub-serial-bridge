export function noop(): void {
    /* no-operation */
}

export function isDefined<T>(value: T | undefined): value is T {
    return value !== undefined;
}

export function unique<T>(values: T[]): T[] {
    return [...new Set(values).values()];
}

// From https://stackoverflow.com/questions/52454345/how-to-get-an-optional-part-of-object-type-with-mapped-type#comment91856442_52454642
export type OptionalKeys<T> = {
    [K in keyof T]-?: {} extends Pick<T, K> ? K : never;
}[keyof T];

export type PickOptionals<T> = Pick<T, OptionalKeys<T>>;

export function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface Deferred<T> {
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason: Error) => void;
    promise: Promise<T>;
}

// There can only be one simultaneous call to defer() at any
// one time, so we can create the closure once and re-use it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let deferResolve: Deferred<any>["resolve"];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let deferReject: Deferred<any>["reject"];
const deferExecutor = (
    res: typeof deferResolve,
    rej: typeof deferReject
): void => {
    deferResolve = res;
    deferReject = rej;
};

export function defer<T>(): Deferred<T> {
    return {
        promise: new Promise(deferExecutor),
        resolve: deferResolve,
        reject: deferReject,
    };
}

export function never(): Promise<never> {
    return new Promise(noop);
}

export class InterruptibleSleep {
    private _trigger: Deferred<void> = defer<void>();

    public async sleep(timeoutInMs: number): Promise<void> {
        let handle: NodeJS.Timer;
        try {
            await Promise.race([
                this._trigger.promise,
                new Promise(
                    (resolve) => (handle = setTimeout(resolve, timeoutInMs))
                ),
            ]);
        } finally {
            clearTimeout(handle!);
        }
    }

    public interrupt(): void {
        this._trigger.resolve();
        this._trigger = defer();
    }
}
