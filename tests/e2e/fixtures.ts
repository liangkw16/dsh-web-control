import { test as base, expect, type Page } from "@playwright/test";
import { mkdtemp, readFile, writeFile, cp, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:tls";
import { connect, type Socket } from "node:net";
import { Transform } from "node:stream";
import { randomBytes } from "node:crypto";
import { startRelay } from "../../packages/relay/src/server.ts";
import { hashSecret } from "../../packages/relay/src/auth.ts";
import { DEFAULT_LIMITS } from "../../packages/protocol/src/index.ts";
import { PublicHostDriver, instanceId } from "../support/public-host-driver.ts";
export const test = base.extend<{
  performanceBps: number;
  performanceRecords: number;
  connectedPage: Page;
  driver: PublicHostDriver;
  relayOrigin: string;
  browserNetwork: { disconnect(): Promise<void>; resume(): void };
}>({
  performanceBps: [0, { option: true }],
  performanceRecords: [0, { option: true }],
  relayOrigin: async ({ performanceBps }, use, testInfo) => {
    const dir = await mkdtemp(resolve(process.env.WEB_CONTROL_EVIDENCE_DIR ?? 'data/task12', 'tls-'));
    await writeFile(
      join(dir, "cert.cnf"),
      "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyCertSign,keyEncipherment\n",
    );
    execFileSync(
      "/usr/bin/openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
        "-days",
        "1",
        "-config",
        join(dir, "cert.cnf"),
      ],
      { stdio: "ignore" },
    );
    // Task15 opt-in: shared application-byte budget per direction, covering HTTP and WSS.
    // TLS handshakes are terminated here; no credential/body bytes are recorded.
    const clocks = { uplink: 0, downlink: 0 };
    const pacers = new Set<Transform>();
    const paced = (direction: keyof typeof clocks) => {
      const timers = new Set<ReturnType<typeof setTimeout>>();
      const stream = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          let offset = 0;
          const send = () => {
            if (stream.destroyed) return callback();
            if (offset === chunk.length) return callback();
            const piece = chunk.subarray(offset, offset + 1000); offset += piece.length;
            clocks[direction] = Math.max(performance.now(), clocks[direction]) + piece.length * 8000 / performanceBps;
            const timer = setTimeout(() => { timers.delete(timer); stream.push(piece); send(); }, Math.max(0, clocks[direction] - performance.now()));
            timers.add(timer);
          };
          send();
        },
        destroy(error, callback) { for (const timer of timers) clearTimeout(timer); timers.clear(); callback(error); },
      });
      pacers.add(stream); stream.once("close", () => pacers.delete(stream)); return stream;
    };
    let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
    const sockets = new Set<Socket>();
    const browserSockets = new Set<Socket>();
    let browserPaused = false;
    const tls = createServer(
      {
        key: await readFile(join(dir, "key.pem")),
        cert: await readFile(join(dir, "cert.pem")),
      },
      (incoming) => {
        if (!relay) return incoming.destroy();
        const upstream = connect(relay.port, "127.0.0.1");
        sockets.add(incoming);
        sockets.add(upstream);
        // Classify only the upgrade request line; never retain headers/body.
        incoming.once("data", bytes => {
          const line = bytes.subarray(0, 200).toString().split("\r\n", 1)[0];
          if (/^GET \/v1\/instances\/[^/ ]+\/control HTTP\//.test(line)) {
            browserSockets.add(incoming); browserSockets.add(upstream);
            if (browserPaused) { incoming.destroy(); upstream.destroy(); }
          }
        });
        incoming.on("error", () => upstream.destroy());
        upstream.on("error", () => incoming.destroy());
        incoming.on("close", () => {
          sockets.delete(incoming);
          browserSockets.delete(incoming);
          upstream.destroy();
        });
        upstream.on("close", () => {
          sockets.delete(upstream);
          browserSockets.delete(upstream);
          incoming.destroy();
        });
        if (performanceBps) {
          const up = paced("uplink"), down = paced("downlink");
          for (const stream of [up, down]) stream.on("error", () => { incoming.destroy(); upstream.destroy(); });
          incoming.once("close", () => { up.destroy(); down.destroy(); });
          incoming.pipe(up).pipe(upstream); upstream.pipe(down).pipe(incoming);
        } else incoming.pipe(upstream).pipe(incoming);
      },
    );
    await new Promise<void>((resolve) => tls.listen(0, "127.0.0.1", resolve));
    const origin = `https://localhost:${(tls.address() as { port: number }).port}`;
    const enrollmentSecret = randomBytes(32).toString("base64url");
    try {
      await cp(resolve("tests/fixtures/legacy-release/web"), join(dir, "site"), {
        recursive: true,
      });
      relay = await startRelay({
        publicOrigin: origin,
        listenHost: "127.0.0.1",
        port: 0,
        databasePath: join(dir, "relay.sqlite"),
        staticDir: join(dir, "site"),
        enrollmentVerifier: hashSecret(enrollmentSecret),
        heartbeatMs: 1000,
        leaseTtlMs: 5000,
        limits: { ...DEFAULT_LIMITS },
      });
      // Enrollment is the Host role on the internal listener; native browser tests use actual HTTPS Origin and cookies.
      origins.set(origin, {
        port: relay.port,
        enrollmentSecret,
        staticDir: join(dir, "site"),
        browserNetwork: {
          async disconnect() {
            browserPaused = true;
            expect(browserSockets.size).toBeGreaterThan(0);
            await Promise.all([...browserSockets].map(socket => new Promise<void>(resolve => { socket.once("close", resolve); socket.destroy(); })));
          },
          resume() { browserPaused = false; },
        },
      });
      await use(origin);
    } finally {
      origins.delete(origin);
      const socketDrains = [...sockets].map((socket) =>
        socket.closed
          ? Promise.resolve()
          : new Promise<void>((resolve) =>
              socket.once("close", () => resolve()),
            ),
      );
      for (const socket of sockets) socket.destroy();
      for (const pacer of pacers) pacer.destroy();
      await relay?.close();
      await new Promise<void>((resolve) => tls.close(() => resolve()));
      await Promise.all(socketDrains);
      expect(sockets.size).toBe(0);
      await unlink(join(dir, "key.pem"));
      await writeFile(
        join(dir, "cleanup.json"),
        JSON.stringify({
          tlsClosed: true,
          relayClosed: true,
          sockets: sockets.size,
          test: testInfo.title,
        }),
      );
    }
  },
  browserNetwork: async ({ relayOrigin }, use) => { await use(origins.get(relayOrigin)!.browserNetwork); },
  driver: async ({ relayOrigin, performanceRecords }, use) => {
    const { port, enrollmentSecret } = origins.get(relayOrigin)!;
    const deviceSecret = randomBytes(32).toString("base64url");
    const linkSecret = randomBytes(32).toString("base64url");
    const response = await fetch(
      `http://127.0.0.1:${port}/v1/devices/register`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enrollmentSecret,
          instanceId,
          deviceSecret,
          linkVerifier: hashSecret(linkSecret),
          authEpoch: 1,
        }),
      },
    );
    if (!response.ok) throw new Error("registration failed");
    const driver = new PublicHostDriver();
    links.set(driver, linkSecret);
    try {
      await driver.start(
        relayOrigin.replace("https:", "wss:") + "/v1/host",
        deviceSecret,
        linkSecret,
      );
      for (let i = 0; i < performanceRecords; i++) driver.append("a", "assistant/message", { content: [{ type: "text", text: `performance-record-${i} ` + "fixed-history-line\n".repeat(4) }] });
      await use(driver);
    } finally {
      await driver.close();
      links.delete(driver);
    }
  },
  connectedPage: async (
    { page, driver, relayOrigin, browser },
    use,
    testInfo,
  ) => {
    await writeFile(
      resolve(process.env.WEB_CONTROL_EVIDENCE_DIR ?? 'data/task12', `${testInfo.project.name}-version.json`),
      JSON.stringify({
        engine: testInfo.project.name,
        version: browser.version(),
        executable:
          testInfo.project.use.launchOptions?.executablePath ??
          "Playwright managed executable",
        physicalPhone: false,
      }),
    );
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(
      `${relayOrigin}/connect/${instanceId}?session=a#key=${links.get(driver)}`,
    );
    await expect(page.getByRole("status", { name: "连接状态" })).toHaveText(
      "已连接",
    );
    await use(page);
    expect(errors).toEqual([]);
  },
});
const origins = new Map<
  string,
  { port: number; enrollmentSecret: string; staticDir: string; browserNetwork: { disconnect(): Promise<void>; resume(): void } }
>();
const links = new Map<PublicHostDriver, string>();
export { expect, instanceId };
