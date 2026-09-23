/**
 * A loopback stand-in for the release bucket and for registry.npmjs.org.
 *
 * `ml-dash update` talks to two remote shapes: R2 under
 * `/ml-dash-cli/releases/...` and an npm packument. Both are served here over
 * http on 127.0.0.1, which is the one non-HTTPS origin src/update/release.ts
 * accepts — so these tests drive the real network path, with the real fetch,
 * the real redirect and origin checks and the real streaming download, rather
 * than substituting a fake for the part being tested.
 */
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface ReleaseFixture {
  url: string;
  /** Version the `latest` pointer names. Reassign between requests. */
  latest: string;
  /** version → platform → bytes served for that platform's binary. */
  builds: Map<string, Map<string, Buffer>>;
  /** Bytes actually served, when they should differ from the hashed ones. */
  corrupt?: Buffer;
  /** Serve this many extra bytes past the manifest's declared size. */
  extraBytes: number;
  /** dist-tags.latest for the npm packument at /@dreamlake%2fml-dash. */
  npmLatest?: string;
  npmVersions: string[];
  requests: string[];
  close: () => Promise<void>;
}

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

const PKG = "@dreamlake/ml-dash";

export async function startReleaseFixture(): Promise<ReleaseFixture> {
  const state = {
    latest: "0.0.0",
    builds: new Map<string, Map<string, Buffer>>(),
    corrupt: undefined as Buffer | undefined,
    extraBytes: 0,
    npmLatest: undefined as string | undefined,
    npmVersions: [] as string[],
    requests: [] as string[],
  };

  const server: Server = createServer((req, res) => {
    const url = decodeURIComponent(req.url ?? "");
    state.requests.push(url);

    const send = (code: number, body: string | Buffer, type = "text/plain") => {
      res.writeHead(code, { "content-type": type });
      res.end(body);
    };

    // ── the npm registry ─────────────────────────────────────────────────
    if (url === `/${PKG}`) {
      if (!state.npmLatest) return send(404, "not found");
      const versions = Object.fromEntries(state.npmVersions.map((v) => [v, { name: PKG, version: v }]));
      return send(200, JSON.stringify({ name: PKG, "dist-tags": { latest: state.npmLatest }, versions }), "application/json");
    }
    const exact = url.match(new RegExp(`^/${PKG.replace("/", "\\/")}/(.+)$`));
    if (exact) {
      return state.npmVersions.includes(exact[1])
        ? send(200, JSON.stringify({ name: PKG, version: exact[1] }), "application/json")
        : send(404, "not found");
    }

    // ── the release bucket ───────────────────────────────────────────────
    if (url === "/ml-dash-cli/releases/latest") {
      return state.latest ? send(200, state.latest) : send(404, "no pointer");
    }

    const manifest = url.match(/^\/ml-dash-cli\/releases\/([^/]+)\/manifest\.json$/);
    if (manifest) {
      const built = state.builds.get(manifest[1]);
      if (!built) return send(404, "no such version");
      const platforms = Object.fromEntries(
        [...built].map(([platform, bytes]) => [
          platform,
          {
            target: `bun-${platform}`,
            binary: platform.startsWith("windows") ? "ml-dash.exe" : "ml-dash",
            checksum: sha256(bytes),
            size: bytes.length,
          },
        ]),
      );
      return send(
        200,
        JSON.stringify({ name: PKG, version: manifest[1], platforms }, null, 2),
        "application/json",
      );
    }

    const binary = url.match(/^\/ml-dash-cli\/releases\/([^/]+)\/([^/]+)\/(ml-dash(?:\.exe)?)$/);
    if (binary) {
      const bytes = state.builds.get(binary[1])?.get(binary[2]);
      if (!bytes) return send(404, "no such build");
      const body = state.corrupt ?? bytes;
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.write(body);
      if (state.extraBytes > 0) res.write(Buffer.alloc(state.extraBytes, 0x41));
      return res.end();
    }

    send(404, "not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    get latest() {
      return state.latest;
    },
    set latest(v: string) {
      state.latest = v;
    },
    builds: state.builds,
    get corrupt() {
      return state.corrupt;
    },
    set corrupt(v: Buffer | undefined) {
      state.corrupt = v;
    },
    get extraBytes() {
      return state.extraBytes;
    },
    set extraBytes(v: number) {
      state.extraBytes = v;
    },
    get npmLatest() {
      return state.npmLatest;
    },
    set npmLatest(v: string | undefined) {
      state.npmLatest = v;
    },
    npmVersions: state.npmVersions,
    requests: state.requests,
    close: () =>
      new Promise<void>((resolve) => {
        // fetch() pools keep-alive sockets, and server.close() waits for every
        // connection to end. Without this, a test whose client process is
        // still holding an idle socket hangs in its own cleanup hook instead
        // of finishing.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
