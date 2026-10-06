import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { servePackageFile } from '../src/utils/servePackageFile.js';

const app = express();
const data = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
let directory: string;
let filePath: string;
app.get('/payload.ipa', (_req, res) => servePackageFile(res, res.app.locals.filePath));

function binary(res: NodeJS.ReadableStream, callback: (error: Error | null, body?: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
  res.on('error', callback);
}

describe('IPA 文件分段传输', () => {
  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asspp-range-'));
    filePath = path.join(directory, 'fixture.ipa');
    fs.writeFileSync(filePath, data);
    app.locals.filePath = filePath;
  });
  afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

  it('普通 GET 和 HEAD 提供完整长度、Range 能力及相同文件标识', async () => {
    const full = await request(app).get('/payload.ipa').buffer(true).parse(binary).expect(200);
    expect(full.body).toEqual(data);
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(full.headers['cache-control']).toContain('no-transform');
    expect(full.headers['x-accel-buffering']).toBe('no');
    const head = await request(app).head('/payload.ipa').expect(200);
    expect(head.headers['content-length']).toBe(String(data.length));
    expect(head.headers.etag).toBe(full.headers.etag);
    expect(head.text).toBeUndefined();
  });

  it.each([
    ['bytes=5-9', 5, 9], ['bytes=30-', 30, 35], ['bytes=-4', 32, 35], ['bytes=34-999', 34, 35],
  ])('分段 %s 只返回指定字节，支持续传和末尾读取', async (range, start, end) => {
    const result = await request(app).get('/payload.ipa').set('Range', range as string)
      .buffer(true).parse(binary).expect(206);
    expect(result.headers['content-range']).toBe(`bytes ${start}-${end}/${data.length}`);
    expect(result.headers['content-length']).toBe(String(Number(end) - Number(start) + 1));
    expect(result.body).toEqual(data.subarray(Number(start), Number(end) + 1));
  });

  it('范围超出文件返回 416 和正确总长度', async () => {
    const result = await request(app).get('/payload.ipa').set('Range', 'bytes=99-100').expect(416);
    expect(result.headers['content-range']).toBe(`bytes */${data.length}`);
  });

  it('If-Range 文件标识过期时发送完整文件；匹配日期时续传', async () => {
    const head = await request(app).head('/payload.ipa');
    const stale = await request(app).get('/payload.ipa').set('Range', 'bytes=5-9')
      .set('If-Range', 'Tue, 01 Jan 1980 00:00:00 GMT').buffer(true).parse(binary).expect(200);
    expect(stale.body).toEqual(data);
    const resumed = await request(app).get('/payload.ipa').set('Range', 'bytes=5-9')
      .set('If-Range', head.headers['last-modified']).buffer(true).parse(binary).expect(206);
    expect(resumed.body).toEqual(data.subarray(5, 10));
  });
});
