import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanListing, FolderBrowser, listFolders, parseBrowsePath } from './browse';

describe('parseBrowsePath', () => {
  it('drive-letter paths only count as absolute on Windows', () => {
    expect(parseBrowsePath('C:/x', 'darwin')).toHaveProperty('error');
    expect(parseBrowsePath('C:\\x', 'win32')).toBe('C:\\x');
  });

  it('accepts empty (home) and absolute paths only', () => {
    expect(parseBrowsePath('')).toBe('');
    expect(parseBrowsePath('  /Users/x  ')).toBe('/Users/x');
    expect(parseBrowsePath('relative/x')).toHaveProperty('error');
    expect(parseBrowsePath('/a\0b')).toHaveProperty('error');
  });
});

describe('listFolders', () => {
  let dir = '';
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it('lists only folders, marks projects and hidden ones, sorted', () => {
    dir = mkdtempSync(join(tmpdir(), 'habblaud-browse-'));
    mkdirSync(join(dir, 'b-app'));
    mkdirSync(join(dir, 'b-app', '.git'));
    mkdirSync(join(dir, 'A-notes'));
    mkdirSync(join(dir, '.cache'));
    writeFileSync(join(dir, 'file.txt'), 'x');
    symlinkSync(join(dir, 'A-notes'), join(dir, 'link'));
    const r = listFolders(dir, { home: '/home/me' });
    if (!('listing' in r)) throw new Error(r.error);
    expect(r.listing.path).toBe(dir);
    expect(r.listing.home).toBe('/home/me');
    expect(r.listing.entries.map((e) => e.name)).toEqual(['.cache', 'A-notes', 'b-app', 'link']);
    expect(r.listing.entries.find((e) => e.name === 'b-app')?.project).toBe(true);
    expect(r.listing.entries.find((e) => e.name === '.cache')?.hidden).toBe(true);
    expect(r.listing.parent).toBeTruthy();
  });

  it('uses home when empty and reports missing folders', () => {
    dir = mkdtempSync(join(tmpdir(), 'habblaud-browse-'));
    const r = listFolders('', { home: dir });
    expect('listing' in r && r.listing.path).toBe(dir);
    expect(listFolders(join(dir, 'nope'))).toMatchObject({ status: 404 });
    expect(listFolders('rel')).toMatchObject({ status: 400 });
  });

  it('has no parent at the root', () => {
    const r = listFolders('/', { readdir: () => [], isDir: () => true });
    expect('listing' in r && r.listing.parent).toBeUndefined();
  });
});

describe('cleanListing', () => {
  it('drops malformed entries and rejects malformed listings', () => {
    expect(cleanListing({ path: '/a', entries: [] })).toBeUndefined();
    expect(cleanListing({ path: '/a', home: '/h', entries: [{ name: 'x', path: '/a/x', project: true }, { name: 1 }, null] })).toEqual({
      path: '/a',
      home: '/h',
      entries: [{ name: 'x', path: '/a/x', project: true }],
    });
  });
});

describe('FolderBrowser', () => {
  it('direct mode lists in place', async () => {
    const b = new FolderBrowser({ direct: true, list: (p) => ({ listing: { path: p || '/h', home: '/h', entries: [] } }) });
    expect(await b.browse('')).toEqual({ listing: { path: '/h', home: '/h', entries: [] } });
    expect(b.available()).toBe(true);
  });

  it('host mode needs the helper, then relays through poll/ack', async () => {
    const b = new FolderBrowser({});
    expect(await b.browse('/x')).toMatchObject({ status: 503 });
    b.poll();
    const pending = b.browse('/x');
    const [req] = b.poll();
    expect(req.path).toBe('/x');
    expect(b.poll()).toEqual([]);
    b.ack({ results: [{ id: req.id, ok: true, listing: { path: '/x', home: '/h', entries: [{ name: 'y', path: '/x/y' }] } }] });
    expect(await pending).toEqual({ listing: { path: '/x', home: '/h', entries: [{ name: 'y', path: '/x/y' }] } });
    const failing = b.browse('/z');
    const [z] = b.poll();
    b.ack({ results: [{ id: z.id, ok: false, error: 'nope', status: 403 }] });
    expect(await failing).toEqual({ error: 'nope', status: 403 });
  });

  it('times out when the helper never answers', async () => {
    const b = new FolderBrowser({ waitMs: 5 });
    b.poll();
    expect(await b.browse('/x')).toMatchObject({ status: 504 });
  });
});

describe('FolderBrowser resend', () => {
  it('hands a listing request out again when it was never answered', () => {
    let now = 0;
    const b = new FolderBrowser({ now: () => now });
    b.poll();
    void b.browse('/x');
    const [first] = b.poll();
    expect(b.poll()).toEqual([]);
    now += 5_000;
    expect(b.poll().map((p) => p.id)).toEqual([first.id]);
  });
});
