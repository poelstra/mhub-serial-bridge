# Serial port <-> MHub bridge

Simple bridge to connect any (newline-based) serial port device to [MHub](https://github.com/poelstra/mhub).

It connects a serial port (which can be given as an alias like `/dev/serial/by-id/usb-Arduino_Srl_Arduino_Uno_75533353637351302041-if00`)
to a set of topics on MHub. For example when specifying `/dev/myarduino` as the topic prefix,
it will publish all received lines on `/dev/myarduino/rx` and write any lines received on
`/dev/myarduino/tx` to the serial port.

It's mostly intended as a tool for my home usage, but let me know if you're interested in
an NPM package of it, too.

## Usage

-   Install NodeJS (tested with v14) and `pnpm`
-   Run `pnpm install`
-   Run `pnpm run build` to build
-   Copy `config.example.json` to `config.json` and adapt to your needs
-   Run `pnpm start` or `pnpm start -- /path/to/your/config.json` to start
-   Optionally set `DEBUG=bridge:*` to enable verbose output.

You'll need a running instance of MHub of course.
You can then subscribe to each port's `.../rx` and `.../state` topics,
and write lines (or array of bytes) to its `.../tx` topic.

If you specify a delimiter for the port, it will automatically parse
each line, stripping the delimiter (but still emitting any empty lines
as-is). The delimiter is also always added to any string or array to
be sent to the serial port.

If you don't specify a delimiter, data will be emitted as an
array of byte values as soon as each chunk comes in, and incoming
strings or byte arrays will always be forwarded as-is. (Note:
strings will first be decoded into an array of bytes according to
the specified encoding, which defaults to UTF-8.)

## License

MIT
