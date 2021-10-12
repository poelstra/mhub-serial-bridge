FROM node:14.18-alpine AS build

RUN npm install -g pnpm
RUN apk add --no-cache make gcc g++ python3 linux-headers

WORKDIR /app/mhub-serial-bridge

COPY package.json .
RUN pnpm install

FROM node:14.18-alpine AS output

RUN npm install -g pnpm

WORKDIR /app/mhub-serial-bridge

COPY --from=build /app/mhub-serial-bridge .
COPY . .
RUN pnpm run build

ENTRYPOINT ["node", "dist/index"]
CMD []
