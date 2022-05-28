# FROM node:16.15-alpine as base

# FROM base AS build

# RUN npm install -g pnpm@7.1.5
# RUN apk add --no-cache make gcc g++ python3 linux-headers

# WORKDIR /app/mhub-serial-bridge

# COPY package.json .
# RUN pnpm install

# FROM base AS output

# RUN npm install -g pnpm@7.1.5

# WORKDIR /app/mhub-serial-bridge

# COPY --from=build /app/mhub-serial-bridge .
# COPY . .
# RUN pnpm run build

# ENTRYPOINT ["node", "dist/index"]
# CMD []

FROM node:16.15.0

WORKDIR /app/mhub-serial-bridge
RUN npm install -g pnpm@7.1.5

COPY package.json .
RUN pnpm install

COPY . .
RUN pnpm run build

ENTRYPOINT ["node", "dist/index"]
CMD []
