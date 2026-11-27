// "Procurar pasta" do Novo agente: lista as subpastas de uma pasta do computador, para escolher o projeto navegando em
// vez de digitar o caminho. Só nomes de PASTAS (nunca arquivos nem o conteúdo deles); qualquer caminho
// absoluto pode ser listado e links para pastas são seguidos (a trava é a do Novo agente: só pelo próprio computador). No modo Node o próprio servidor lista; no Docker (que não enxerga as pastas do host) o auxiliar do host
// (scripts/codex-bridge.ts) busca os pedidos em POST /api/host/browse/poll e devolve a lista em /api/host/browse/ack.
// Node puro e sem dependências: também é importado pelo auxiliar do host (via tsx).
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { tr } from '../../shared/i18n';
import { HostWait, pollWithWait } from '../host-wait';

/** Teto de pastas numa listagem (o resto é cortado; `truncated: true`). */
export const BROWSE_MAX_ENTRIES = 400;
export const BROWSE_PATH_MAX = 1_024;
export const HOST_PRESENCE_MS = 10_000;
/** Quanto a página espera o auxiliar responder. */
export const BROWSE_WAIT_MS = 15_000;
const MAX_PENDING = 8;
/** Buscado e sem resposta há este tempo: entrega de novo (a rodada do auxiliar pode ter caído no caminho). */
export const RESEND_MS = 5_000;

export interface BrowseEntry {
  name: string;
  path: string;
  /** Tem cara de projeto (.git, package.json...). */
  project?: boolean;
  /** Começa com ponto (escondida por padrão na página). */
  hidden?: boolean;
}

export interface BrowseListing {
  /** A pasta listada (absoluta). */
  path: string;
  /** A pasta de cima (ausente na raiz). */
  parent?: string;
  /** A pasta pessoal de quem lista (atalho "~"). */
  home: string;
  entries: BrowseEntry[];
  truncated?: boolean;
}

export type BrowseResult = { listing: BrowseListing } | { error: string; status: number };

const PROJECT_MARKERS = ['.git', 'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'composer.json', 'Gemfile', 'CLAUDE.md', 'AGENTS.md'];

/** Confere o caminho pedido; vazio = pasta pessoal. */
export function parseBrowsePath(raw: unknown, platform: NodeJS.Platform = process.platform): string | { error: string } {
  const p = typeof raw === 'string' ? raw.trim() : '';
  if (!p) return '';
  // "C:\x" só é absoluto no Windows (no Mac/Linux o resolve() o colaria na pasta atual).
  const abs = platform === 'win32' ? isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) : p.startsWith('/');
  if (p.length > BROWSE_PATH_MAX || p.includes('\0') || !abs) return { error: tr('caminho inválido (precisa ser absoluto)') };
  return p;
}

export interface ListOptions {
  home?: string;
  readdir?: (p: string) => Array<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }>;
  isDir?: (p: string) => boolean;
  exists?: (p: string) => boolean;
}

/** Lista as subpastas de `path` (vazio = pasta pessoal). Nunca lança. */
export function listFolders(raw: string, opts: ListOptions = {}): BrowseResult {
  const home = opts.home ?? homedir();
  const parsed = parseBrowsePath(raw);
  if (typeof parsed !== 'string') return { error: parsed.error, status: 400 };
  const path = resolve(parsed || home);
  const isDir =
    opts.isDir ??
    ((p: string) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
  const exists = opts.exists ?? existsSync;
  if (!isDir(path)) return { error: tr('pasta não encontrada neste computador'), status: 404 };
  let dirents: Array<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }>;
  try {
    dirents = (opts.readdir ?? ((p: string) => readdirSync(p, { withFileTypes: true })))(path);
  } catch {
    return { error: tr('sem permissão para ler esta pasta'), status: 403 };
  }
  const entries: BrowseEntry[] = [];
  let truncated = false;
  const sorted = [...dirents].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  for (const d of sorted) {
    const full = join(path, d.name);
    // Links para pastas contam (ex.: ~/code -> /Volumes/...); os demais arquivos ficam de fora.
    if (!(d.isDirectory() || (d.isSymbolicLink() && isDir(full)))) continue;
    if (entries.length >= BROWSE_MAX_ENTRIES) {
      truncated = true;
      break;
    }
    const hidden = d.name.startsWith('.');
    const project = !hidden && PROJECT_MARKERS.some((m) => exists(join(full, m)));
    entries.push({ name: d.name, path: full, ...(project ? { project } : {}), ...(hidden ? { hidden } : {}) });
  }
  const up = dirname(path);
  return { listing: { path, ...(up !== path ? { parent: up } : {}), home, entries, ...(truncated ? { truncated } : {}) } };
}

/** Confere uma listagem vinda do auxiliar (o Docker não confia no formato). */
export function cleanListing(raw: unknown): BrowseListing | undefined {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined;
  const str = (v: unknown, max = BROWSE_PATH_MAX) => (typeof v === 'string' && v.length <= max && !v.includes('\0') ? v : undefined);
  const path = str(r?.path);
  const home = str(r?.home);
  if (!r || !path || !home || !Array.isArray(r.entries)) return undefined;
  const entries: BrowseEntry[] = [];
  for (const e of r.entries.slice(0, BROWSE_MAX_ENTRIES)) {
    const x = e && typeof e === 'object' ? (e as Record<string, unknown>) : {};
    const name = str(x.name, 255);
    const p = str(x.path);
    if (!name || !p) continue;
    entries.push({ name, path: p, ...(x.project === true ? { project: true } : {}), ...(x.hidden === true ? { hidden: true } : {}) });
  }
  const parent = str(r.parent);
  return { path, ...(parent ? { parent } : {}), home, entries, ...(r.truncated === true ? { truncated: true } : {}) };
}

interface Pending {
  id: string;
  path: string;
  sentAt?: number;
  done: (r: BrowseResult) => void;
}

export interface FolderBrowserOptions {
  /** Modo Node: lista aqui mesmo. Ausente (Docker): pede ao auxiliar do host. */
  direct?: boolean;
  list?: (path: string) => BrowseResult;
  now?: () => number;
  waitMs?: number;
}

export class FolderBrowser {
  private readonly pending = new Map<string, Pending>();
  private readonly host: HostWait;
  private readonly now: () => number;

  constructor(private readonly opts: FolderBrowserOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.host = new HostWait(HOST_PRESENCE_MS, this.now);
  }

  mode(): 'direct' | 'host' {
    return this.opts.direct ? 'direct' : 'host';
  }

  available(): boolean {
    return !!this.opts.direct || this.host.present();
  }

  async browse(raw: unknown): Promise<BrowseResult> {
    const parsed = parseBrowsePath(raw);
    if (typeof parsed !== 'string') return { error: parsed.error, status: 400 };
    if (this.opts.direct) return (this.opts.list ?? listFolders)(parsed);
    if (!this.host.present()) return { error: tr('o auxiliar do computador (npm run codex:bridge) não está rodando: o Docker não enxerga as pastas do computador'), status: 503 };
    if (this.pending.size >= MAX_PENDING) return { error: tr('pastas demais sendo listadas: tente de novo'), status: 429 };
    return new Promise<BrowseResult>((done) => {
      const p: Pending = { id: randomUUID(), path: parsed, done };
      this.pending.set(p.id, p);
      this.host.wake();
      setTimeout(() => {
        if (this.pending.delete(p.id)) done({ error: tr('o computador não respondeu a tempo'), status: 504 });
      }, this.opts.waitMs ?? BROWSE_WAIT_MS).unref?.();
    });
  }

  /** Rodada do auxiliar: marca presença e entrega as pastas pedidas. */
  poll(): Array<{ id: string; path: string }> {
    this.host.seen();
    const now = this.now();
    const out: Array<{ id: string; path: string }> = [];
    for (const p of this.pending.values()) {
      if (p.sentAt !== undefined && now - p.sentAt < RESEND_MS) continue;
      p.sentAt = now;
      out.push({ id: p.id, path: p.path });
    }
    return out;
  }

  pollWait(ms: number, signal?: AbortSignal): Promise<Array<{ id: string; path: string }>> {
    return pollWithWait(this.host, () => this.poll(), ms, signal);
  }

  ack(raw: unknown): void {
    this.host.seen();
    const list = raw && typeof raw === 'object' && Array.isArray((raw as { results?: unknown }).results) ? (raw as { results: unknown[] }).results : [];
    for (const r of list) {
      const x = r && typeof r === 'object' ? (r as Record<string, unknown>) : {};
      const p = typeof x.id === 'string' ? this.pending.get(x.id) : undefined;
      if (!p) continue;
      this.pending.delete(p.id);
      const listing = x.ok === true ? cleanListing(x.listing) : undefined;
      if (listing) p.done({ listing });
      else {
        const status = typeof x.status === 'number' && [400, 403, 404].includes(x.status) ? x.status : 404;
        p.done({ error: typeof x.error === 'string' && x.error ? x.error.slice(0, 200) : tr('o computador não listou a pasta'), status });
      }
    }
  }
}
