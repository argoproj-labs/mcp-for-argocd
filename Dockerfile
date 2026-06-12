FROM node:20-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Run pnpm non-interactively: without a TTY, pnpm 10 otherwise aborts when it
# needs to purge node_modules (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY).
ENV CI=true
RUN corepack enable
COPY . /app
WORKDIR /app

FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile

# Run the build on the NATIVE builder platform (--platform=$BUILDPLATFORM), not
# the target platform. tsup/esbuild ship a Go binary that crashes under QEMU
# emulation (fatal error: lfstack.push) when cross-building. The output is plain,
# architecture-independent JavaScript, so it is safe to copy into a target-arch
# final image below.
FROM --platform=$BUILDPLATFORM node:20-slim AS build
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV CI=true
RUN corepack enable
COPY . /app
WORKDIR /app
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm run build

FROM base
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=build /app/dist /app/dist
EXPOSE 3000
CMD [ "node", "dist/index.js", "http" ]
USER 1000
