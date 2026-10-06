import { describe, it, expect, afterEach } from "vitest";
import { createServer, Server } from "http";
import net from "net";
import { WebSocket } from "ws";
import express from "express";
import { server as wisp } from '@mercuryworkshop/wisp-js/server';
import { setupWsProxy } from "../src/services/wsProxy.js";

let httpServer: Server | null = null;
let serverPort: number;

async function startServer() {
  const app = express();
  httpServer = createServer(app);
  setupWsProxy(httpServer);

  await new Promise<void>((resolve) => {
    httpServer!.listen(0, () => {
      serverPort = (httpServer!.address() as net.AddressInfo).port;
      resolve();
    });
  });
}

async function stopServer() {
  if (!httpServer) return;
  const server = httpServer;
  httpServer = null;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

describe("Wisp Proxy", () => {
  afterEach(async () => {
    await stopServer();
  });

  it('允许 SAP 公共端点并拒绝相似域名，保留端口和 IP 限制', () => {
    const allowed = (host: string) => wisp.options.hostname_whitelist.some(
      (pattern: RegExp | string) => typeof pattern === 'string'
        ? pattern === host : pattern.test(host),
    );
    for (const host of ['s.mzstatic.com', 'fpinit.itunes.apple.com', 'p25-buy.itunes.apple.com',
      'uclient-api.itunes.apple.com']) {
      expect(allowed(host)).toBe(true);
    }
    for (const host of [
      'mzstatic.com', 'sub.s.mzstatic.com', 's.mzstatic.com.evil.example',
      'fpinit.itunes.apple.com.evil.example', 'evilfpinit.itunes.apple.com',
      'uclient-api.itunes.apple.com.evil.example', 'evil.uclient-api.itunes.apple.com',
      'example.com', '127.0.0.1',
    ]) {
      expect(allowed(host)).toBe(false);
    }
    expect(wisp.options.port_whitelist).toEqual([443]);
    expect(wisp.options.allow_direct_ip).toBe(false);
    expect(wisp.options.allow_loopback_ips).toBe(false);
  });

  it("should accept WebSocket connections on /wisp/ path", async () => {
    await startServer();

    const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/wisp/`);

    const opened = await new Promise<boolean>((resolve) => {
      ws.on("open", () => resolve(true));
      ws.on("error", () => resolve(false));
      setTimeout(() => resolve(false), 5000);
    });

    expect(opened).toBe(true);
    ws.close();
  });

  it("should reject connections on non-wisp paths", async () => {
    await startServer();

    const ws = new WebSocket(
      `ws://127.0.0.1:${serverPort}/proxy?host=buy.itunes.apple.com&port=443`,
    );

    const rejected = await new Promise<boolean>((resolve) => {
      ws.on("error", () => resolve(true));
      ws.on("close", () => resolve(true));
      ws.on("open", () => {
        ws.close();
        resolve(false);
      });
    });

    expect(rejected).toBe(true);
  });

  it("should reject connections on random paths", async () => {
    await startServer();

    const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/other`);

    const rejected = await new Promise<boolean>((resolve) => {
      ws.on("error", () => resolve(true));
      ws.on("close", () => resolve(true));
      ws.on("open", () => {
        ws.close();
        resolve(false);
      });
    });

    expect(rejected).toBe(true);
  });
});
