import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeAttachments } from './attachments';
import { AttachmentWriter, RESEND_MS } from './writer';
import { attachmentsRound } from '../../scripts/codex-bridge';

const file = (name: string, text: string) => ({ name, type: 'text/plain', data: Buffer.from(text) });

describe('AttachmentWriter', () => {
  it('direct mode writes in place and releases the memory', async () => {
    let released = 0;
    const w = new AttachmentWriter({ direct: true, write: (_id, f) => f.map((x) => `/t/${x.name}`), release: (n) => (released += n) });
    expect(await w.write([file('a.txt', 'abc')])).toEqual({ paths: ['/t/a.txt'] });
    expect(released).toBe(3);
  });

  it('host mode: 503 without the helper; then relays through poll/ack', async () => {
    let released = 0;
    const w = new AttachmentWriter({ release: (n) => (released += n) });
    expect(await w.write([file('a.txt', 'abc')])).toMatchObject({ status: 503 });
    expect(released).toBe(3);
    w.poll();
    const pending = w.write([file('b.txt', 'hello')]);
    const [job] = w.poll();
    expect(job.files).toEqual([{ name: 'b.txt', type: 'text/plain', data: Buffer.from('hello').toString('base64') }]);
    // Fica na memória até a confirmação (a rodada pode cair no caminho).
    expect(released).toBe(3);
    w.ack({ results: [{ id: job.id, ok: true, paths: ['/h/b.txt'] }] });
    expect(await pending).toEqual({ paths: ['/h/b.txt'] });
    expect(released).toBe(8);
  });

  it('hands the job out again when the helper never confirmed it', async () => {
    let now = 1_000;
    const w = new AttachmentWriter({ now: () => now });
    w.poll();
    const pending = w.write([file('a.txt', 'x')]);
    const [first] = w.poll();
    expect(w.poll()).toEqual([]);
    now += RESEND_MS;
    const [again] = w.poll();
    expect(again.id).toBe(first.id);
    w.ack({ results: [{ id: first.id, ok: true, paths: ['/h/a.txt'] }] });
    w.ack({ results: [{ id: first.id, ok: true, paths: ['/h/a-2.txt'] }] });
    expect(await pending).toEqual({ paths: ['/h/a.txt'] });
  });

  it('a wrong number of paths is a failure; and it times out', async () => {
    const w = new AttachmentWriter({ waitMs: 20 });
    w.poll();
    const p = w.write([file('a', '1'), file('b', '2')]);
    const [job] = w.poll();
    w.ack({ results: [{ id: job.id, ok: true, paths: ['/x'] }] });
    expect(await p).toMatchObject({ status: 502 });
    expect(await w.write([file('c', '3')])).toMatchObject({ status: 504 });
  });
});

describe('attachmentsRound (host helper)', () => {
  let dir = '';
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it('writes the files and acks the paths', async () => {
    dir = mkdtempSync(join(tmpdir(), 'habblaud-att-'));
    const sent: Array<{ path: string; body: unknown }> = [];
    const post = async (path: string, body: unknown) => {
      sent.push({ path, body });
      if (path.startsWith('/api/host/attachments/poll')) {
        return { status: 200, json: { writes: [{ id: 'w1', files: [{ name: '../evil.txt', type: 'text/plain', data: Buffer.from('hi').toString('base64') }] }, { id: 'w2', files: [{ name: 'x', data: '!!' }] }] } };
      }
      return { status: 200, json: { ok: true } };
    };
    const r = await attachmentsRound(post, (id, files) => writeAttachments(dir, id, files));
    expect(r).toEqual({ state: 'ok', results: [{ id: 'w1', ok: true }, { id: 'w2', ok: false, error: 'anexo ilegível' }] });
    const ack = sent.at(-1)!.body as { results: Array<{ id: string; paths?: string[] }> };
    const path = ack.results[0].paths![0];
    expect(path.startsWith(dir)).toBe(true);
    expect(path.endsWith('/evil.txt')).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('hi');
  });
});
