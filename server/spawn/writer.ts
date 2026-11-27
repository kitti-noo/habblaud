// Grava os anexos das MENSAGENS (imagens e arquivos mandados a um agente que já está rodando) no computador do agente,
// em ~/.habblaud/attachments/, e devolve os caminhos para irem no fim da mensagem. No modo Node o próprio servidor
// grava; no Docker (que não alcança a pasta pessoal do host) o auxiliar do host (scripts/codex-bridge.ts) busca os
// arquivos em POST /api/host/attachments/poll, grava e devolve os caminhos em /api/host/attachments/ack.
// (Os anexos do Novo agente seguem com o pedido: spawn/spawn.ts.)
import { randomUUID } from 'node:crypto';
import { tr } from '../../shared/i18n';
import { HostWait, pollWithWait } from '../host-wait';
import { attachmentsRoot, writeAttachments, type Attachment } from './attachments';

export const HOST_PRESENCE_MS = 10_000;
/** Quanto a página espera o auxiliar gravar. */
export const WRITE_WAIT_MS = 30_000;
const MAX_PENDING = 8;
/**
 * Buscado e sem confirmação há este tempo: entrega de novo na próxima rodada (a rodada pode ter caído no caminho, ex.:
 * o auxiliar reiniciou). Gravar duas vezes só deixa uma cópia a mais; vale a primeira confirmação.
 */
export const RESEND_MS = 10_000;
const PATH_MAX = 1_024;

export type WriteResult = { paths: string[] } | { error: string; status: number };

export interface PolledWrite {
  id: string;
  files: Array<{ name: string; type: string; data: string }>;
}

interface Pending {
  id: string;
  files: Attachment[];
  count: number;
  /** Quando foi entregue ao auxiliar pela última vez (undefined = ainda não). */
  sentAt?: number;
  done: (r: WriteResult) => void;
}

export interface AttachmentWriterOptions {
  /** Modo Node: grava aqui mesmo. Ausente (Docker): o auxiliar do host grava. */
  direct?: boolean;
  write?: (id: string, files: readonly Attachment[]) => string[];
  now?: () => number;
  waitMs?: number;
  /** Os arquivos saíram da memória (para o teto do AttachmentStore). */
  release?: (bytes: number) => void;
}

export class AttachmentWriter {
  private readonly pending = new Map<string, Pending>();
  private readonly host: HostWait;
  private readonly now: () => number;

  constructor(private readonly opts: AttachmentWriterOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.host = new HostWait(HOST_PRESENCE_MS, this.now);
  }

  available(): boolean {
    return !!this.opts.direct || this.host.present();
  }

  async write(files: Attachment[]): Promise<WriteResult> {
    const bytes = files.reduce((n, f) => n + f.data.length, 0);
    if (!files.length) return { paths: [] };
    const id = randomUUID();
    if (this.opts.direct) {
      try {
        return { paths: (this.opts.write ?? ((i, f) => writeAttachments(attachmentsRoot(), i, f)))(id, files) };
      } catch (err) {
        return { error: tr('não deu para gravar os anexos ({0})', [(err as Error).message]).slice(0, 300), status: 500 };
      } finally {
        this.opts.release?.(bytes);
      }
    }
    if (!this.host.present() || this.pending.size >= MAX_PENDING) {
      this.opts.release?.(bytes);
      return this.host.present()
        ? { error: tr('anexos demais sendo gravados: tente de novo'), status: 429 }
        : { error: tr('o auxiliar do computador (npm run codex:bridge) não está rodando: os anexos não têm onde ser gravados'), status: 503 };
    }
    return new Promise<WriteResult>((done) => {
      const p: Pending = { id, files, count: files.length, done };
      this.pending.set(id, p);
      this.host.wake();
      setTimeout(() => {
        if (!this.pending.delete(id)) return;
        this.drop(p);
        done({ error: tr('o computador não gravou os anexos a tempo'), status: 504 });
      }, this.opts.waitMs ?? WRITE_WAIT_MS).unref?.();
    });
  }

  poll(): PolledWrite[] {
    this.host.seen();
    const now = this.now();
    const out: PolledWrite[] = [];
    for (const p of this.pending.values()) {
      if (p.sentAt !== undefined && now - p.sentAt < RESEND_MS) continue;
      p.sentAt = now;
      out.push({ id: p.id, files: p.files.map((f) => ({ name: f.name, type: f.type, data: f.data.toString('base64') })) });
    }
    return out;
  }

  pollWait(ms: number, signal?: AbortSignal): Promise<PolledWrite[]> {
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
      this.drop(p);
      const paths = Array.isArray(x.paths) ? x.paths.filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= PATH_MAX && !v.includes('\0')) : [];
      if (x.ok === true && paths.length === p.count) p.done({ paths });
      else p.done({ error: typeof x.error === 'string' && x.error ? x.error.slice(0, 300) : tr('o computador não gravou os anexos'), status: 502 });
    }
  }

  private drop(p: Pending): void {
    if (!p.files.length) return;
    this.opts.release?.(p.files.reduce((n, f) => n + f.data.length, 0));
    p.files = [];
  }
}
