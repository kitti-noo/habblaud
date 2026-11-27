// Novo agente (botão na barra do topo): começa uma sessão do Claude Code em segundo plano no Mac, na pasta escolhida e
// com o pedido (POST /api/spawn; server/spawn/spawn.ts). As pastas são os projetos recentes do computador
// (GET /api/spawn/folders: histórico de sessões + salas), para escolher com um toque; "Outra pasta" aceita um caminho
// digitado. O pedido pode levar anexos (POST /api/spawn/attachments, um por arquivo, antes do pedido) e ser ditado
// (ui/dictation.ts, Whisper local no Mac). Pasta que o Claude Code não conhece cai no app (Enter lá).
import { tr } from '../../../shared/i18n';
import { isDemoId } from '../../../shared/timeline';
import type { OfficeSnapshot } from '../../../shared/types';
import type { UiContext } from './context';
import { DictationButton, dictationAvailable, insertDictation } from './dictation';
import { h, iconButton, setHidden, setText } from './dom';
import { ICONS } from './icons';
import { AttachmentTray } from './attachments';

export { formatBytes, MAX_FILE_BYTES, MAX_FILES } from './attachments';

export const SPAWN_PROMPT_MAX = 8_000;
const POLL_MS = 700;
/**
 * Quanto a página espera o pedido abrir: mais que o servidor leva para desistir (fila 30 s + `claude --bg` e `open`,
 * 50 s; server/spawn/spawn.ts), para nunca dizer "não confirmou" de algo que ainda vai abrir.
 */
const WAIT_MS = 90_000;
const LAST_FOLDER_KEY = 'habblaud.spawn.folder';

interface SpawnInfo {
  id: string;
  status: 'queued' | 'sent' | 'opened' | 'failed';
  error?: string;
  how?: 'cli' | 'app';
  note?: string;
}

export interface FolderOption {
  path: string;
  name: string;
  lastAt: number;
  sessions?: number;
}

/** Pastas das salas, da mais recente para a mais antiga (reserva quando o servidor não manda a lista). */
export function spawnFolders(snap: Pick<OfficeSnapshot, 'rooms' | 'agents'> | null | undefined): string[] {
  if (!snap) return [];
  const last = new Map<string, number>();
  for (const a of snap.agents) last.set(a.roomId, Math.max(last.get(a.roomId) ?? 0, a.lastEventAt ?? 0));
  const paths = [...snap.rooms]
    .filter((r) => !isDemoId(r.id) && /^(\/|[A-Za-z]:[\\/])/.test(r.path ?? ''))
    .sort((a, b) => (last.get(b.id) ?? 0) - (last.get(a.id) ?? 0))
    .map((r) => r.path);
  return [...new Set(paths)];
}

/** Caminho curto para a lista: a pasta pessoal vira "~". */
export function shortPath(path: string): string {
  return path.replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, '~').replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/i, '~');
}

/** "agora", "5 min", "3 h", "2 d" (vazio sem horário). */
export function ago(at: number, now = Date.now()): string {
  if (!at) return '';
  const min = Math.max(0, Math.round((now - at) / 60_000));
  if (min < 1) return tr('agora');
  if (min < 60) return `${min} min`;
  const hours = Math.round(min / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
  } catch {
    throw new Error(tr('o Habblaud não respondeu'));
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? tr('erro {0}', [res.status]));
  return body;
}

function readPref(): string {
  try {
    return localStorage.getItem(LAST_FOLDER_KEY) ?? '';
  } catch {
    return '';
  }
}

function writePref(path: string): void {
  try {
    localStorage.setItem(LAST_FOLDER_KEY, path);
  } catch {
    // sem armazenamento: só não lembra
  }
}

export class SpawnPanel {
  readonly el: HTMLElement;
  private readonly folderList: HTMLElement;
  private readonly otherBtn: HTMLButtonElement;
  private readonly folder: HTMLInputElement;
  private readonly prompt: HTMLTextAreaElement;
  private readonly tray: AttachmentTray;
  private readonly dictate: DictationButton;
  private readonly submitBtn: HTMLButtonElement;
  private readonly status: HTMLElement;
  private anchor?: HTMLElement;
  private busy = false;
  private folders: FolderOption[] = [];
  private selected = '';
  private typing = false;
  private readonly browser: FolderBrowserView;

  constructor(private readonly ctx: UiContext) {
    this.folderList = h('div', { class: 'ui-spawn__folders', role: 'radiogroup', attrs: { 'aria-label': tr('Projetos recentes') } });
    this.otherBtn = h('button', { class: 'ui-spawn__other', type: 'button', on: { click: () => this.showOther(true) } }, tr('+ Outra pasta'));
    this.browser = new FolderBrowserView((path) => this.choose(path));
    const browseBtn = h('button', { class: 'ui-spawn__other ui-spawn__browse-btn', type: 'button', on: { click: () => this.browser.toggle(this.typing ? this.folder.value.trim() : this.selected) } }, tr('📁 Procurar pasta…'));
    this.folder = h('input', {
      class: 'ui-rename__input ui-spawn__path',
      type: 'text',
      hidden: true,
      attrs: { id: 'ui-spawn-folder', placeholder: '/Users/voce/projeto', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'none', 'aria-label': tr('Caminho da pasta') },
    });
    this.prompt = h('textarea', {
      class: 'ui-rename__input ui-spawn__prompt',
      attrs: { id: 'ui-spawn-prompt', rows: 5, maxlength: SPAWN_PROMPT_MAX, placeholder: tr('O que o agente deve fazer (opcional)') },
    });
    this.tray = new AttachmentTray({ say: (text, error) => this.say(text, error) });
    const attachBtn = this.tray.button(false, 'ui-spawn__attach');
    this.dictate = new DictationButton(
      (t) => {
        const { value, caret } = insertDictation(this.prompt.value, this.prompt.selectionStart ?? this.prompt.value.length, this.prompt.selectionEnd ?? this.prompt.value.length, t.text);
        this.prompt.value = value.slice(0, SPAWN_PROMPT_MAX);
        this.prompt.setSelectionRange(caret, caret);
      },
      (text, error) => this.say(text, error),
    );
    setHidden(this.dictate.el, true);
    this.submitBtn = h('button', { class: 'ui-btn ui-perm__btn ui-perm__btn--allow ui-spawn__go', type: 'button', on: { click: () => void this.submit() } }, tr('Começar'));
    this.status = h('p', { class: 'ui-rename__hint ui-spawn__status', attrs: { role: 'status', 'aria-live': 'polite' } });
    for (const field of [this.folder, this.prompt] as HTMLElement[]) {
      field.addEventListener('keydown', (e: KeyboardEvent) => {
        e.stopPropagation();
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void this.submit();
        }
      });
      field.addEventListener('keyup', (e) => e.stopPropagation());
    }
    this.folder.addEventListener('input', () => {
      this.selected = this.folder.value.trim();
      this.renderFolders();
    });
    const close = iconButton(ICONS.close, tr('Fechar'), () => this.hide(), 'ui-icon-btn--sm');
    this.el = h(
      'div',
      { class: 'ui-popover ui-spawn', role: 'dialog', tabIndex: -1, attrs: { 'aria-label': tr('Novo agente'), id: 'ui-spawn', popover: 'auto' } },
      h('div', { class: 'ui-popover__head' }, h('h2', { text: tr('Novo agente') }), close),
      h(
        'div',
        { class: 'ui-set-group ui-spawn__body' },
        h('p', { class: 'ui-spawn__label', attrs: { id: 'ui-spawn-folders-label' }, text: tr('Projeto') }),
        this.folderList,
        h('div', { class: 'ui-spawn__pick' }, this.otherBtn, browseBtn),
        this.browser.el,
        this.folder,
        h('label', { class: 'ui-spawn__label', attrs: { for: 'ui-spawn-prompt' }, text: tr('Pedido') }),
        this.prompt,
        h('div', { class: 'ui-spawn__tools' }, this.dictate.el, attachBtn, this.tray.input),
        this.tray.list,
        h('p', { class: 'ui-rename__hint', text: tr('Começa na hora uma sessão do Claude Code em segundo plano no computador, na pasta escolhida; as permissões chegam aqui. Pasta que o Claude Code ainda não conhece abre no app do Claude e espera o Enter lá. Anexos vão para ~/.habblaud/attachments e o pedido leva os caminhos.') }),
        this.submitBtn,
        this.status,
      ),
    );
    // Colar uma imagem no pedido ou soltar arquivos no painel: anexos.
    this.tray.wire(this.prompt, this.el);
    this.el.addEventListener('toggle', () => {
      this.anchor?.setAttribute('aria-expanded', String(this.isOpen));
      if (!this.isOpen) this.dictate.cancel();
    });
  }

  get isOpen(): boolean {
    try {
      return this.el.matches(':popover-open');
    } catch {
      return this.el.classList.contains('is-open');
    }
  }

  /** Abre já com a pasta escolhida (botão "+" de uma sala na barra lateral). */
  openFor(anchor: HTMLElement, folder: string): void {
    if (this.isOpen && this.anchor === anchor) return this.hide();
    if (this.isOpen) this.hide();
    this.toggle(anchor);
    this.choose(folder);
  }

  toggle(anchor: HTMLElement): void {
    this.anchor = anchor;
    if (this.isOpen) return this.hide();
    this.browser.close();
    // Primeiro com o que o escritório já sabe; a lista do servidor (histórico) chega logo depois.
    if (!this.folders.length) this.setFolders(spawnFolders(this.ctx.store.snapshot).map((path) => ({ path, name: path.split(/[\\/]/).pop() || path, lastAt: 0 })));
    void this.loadFolders();
    void this.checkDictation();
    if (!this.busy) setText(this.status, '');
    const r = anchor.getBoundingClientRect();
    this.el.style.top = `${Math.round(r.bottom + 8)}px`;
    this.el.style.right = `${Math.max(8, Math.round(innerWidth - r.right - 4))}px`;
    if (typeof this.el.showPopover === 'function') this.el.showPopover();
    else this.el.classList.add('is-open');
    anchor.setAttribute('aria-expanded', 'true');
    // No celular, focar o campo abriria o teclado por cima da lista de projetos.
    if (!matchMedia('(pointer: coarse)').matches) this.prompt.focus();
  }

  hide(): void {
    this.dictate.cancel();
    if (typeof this.el.hidePopover === 'function' && this.isOpen) this.el.hidePopover();
    this.el.classList.remove('is-open');
    this.anchor?.setAttribute('aria-expanded', 'false');
  }

  private async loadFolders(): Promise<void> {
    try {
      const r = await api<{ folders: FolderOption[] }>('/api/spawn/folders');
      if (Array.isArray(r.folders) && r.folders.length) this.setFolders(r.folders);
    } catch {
      // fica a lista das salas
    }
  }

  private async checkDictation(): Promise<void> {
    setHidden(this.dictate.el, !(await dictationAvailable()));
  }

  private setFolders(list: FolderOption[]): void {
    this.folders = list;
    if (!this.selected) {
      const pref = readPref();
      this.selected = list.some((f) => f.path === pref) ? pref : (list[0]?.path ?? '');
    }
    this.renderFolders();
  }

  private renderFolders(): void {
    const now = Date.now();
    const known = this.folders.some((f) => f.path === this.selected);
    this.folderList.replaceChildren(
      ...this.folders.map((f) => {
        const on = f.path === this.selected && !this.typing;
        const when = ago(f.lastAt, now);
        return h(
          'button',
          {
            class: `ui-spawn__folder${on ? ' is-on' : ''}`,
            type: 'button',
            role: 'radio',
            attrs: { 'aria-checked': String(on), title: f.path },
            on: { click: () => this.pick(f.path) },
          },
          h('span', { class: 'ui-spawn__folder-name', text: f.name }),
          h('span', { class: 'ui-spawn__folder-path', text: shortPath(f.path) }),
          when ? h('span', { class: 'ui-spawn__folder-when', text: when }) : null,
        );
      }),
    );
    if (!this.folders.length) this.showOther(true);
    else if (!known && this.selected && !this.typing) this.showOther(true, this.selected);
  }

  /** Escolhe uma pasta: a da lista, se estiver nela; senão, no campo de caminho. */
  private choose(path: string): void {
    if (this.folders.some((f) => f.path === path)) this.pick(path);
    else this.showOther(true, path);
    this.browser.close();
  }

  private pick(path: string): void {
    this.selected = path;
    this.typing = false;
    setHidden(this.folder, true);
    this.otherBtn.classList.remove('is-on');
    this.renderFolders();
  }

  private showOther(on: boolean, value?: string): void {
    this.typing = on;
    setHidden(this.folder, !on);
    this.otherBtn.classList.toggle('is-on', on);
    if (on) {
      if (value !== undefined) this.folder.value = value;
      this.selected = this.folder.value.trim();
      this.folderList.querySelectorAll('.ui-spawn__folder').forEach((b) => {
        b.classList.remove('is-on');
        b.setAttribute('aria-checked', 'false');
      });
      if (value === undefined) this.folder.focus();
    }
  }

  private say(text: string, error = false): void {
    setText(this.status, text);
    this.status.classList.toggle('is-error', error);
  }

  private async submit(): Promise<void> {
    if (this.busy) return;
    if (this.dictate.busy) return this.say(tr('Espere o ditado terminar.'), true);
    const folder = (this.typing ? this.folder.value : this.selected).trim();
    if (!folder) return this.say(tr('Escolha o projeto.'), true);
    this.busy = true;
    this.submitBtn.disabled = true;
    try {
      const ids = await this.tray.upload('/api/spawn/attachments', (i, n) =>
        this.say(n > 1 ? tr('Enviando anexos ({0} de {1})…', [i + 1, n]) : tr('Enviando o anexo…')),
      );
      this.say(tr('Começando no computador…'));
      let info = await api<SpawnInfo>('/api/spawn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder, prompt: this.prompt.value, ...(ids.length ? { attachments: ids } : {}) }),
      });
      const end = Date.now() + WAIT_MS;
      while ((info.status === 'queued' || info.status === 'sent') && Date.now() < end) {
        await new Promise((ok) => setTimeout(ok, POLL_MS));
        info = await api<SpawnInfo>(`/api/spawn/${encodeURIComponent(info.id)}`);
      }
      if (info.status === 'opened') {
        const running = info.how === 'cli';
        this.say(
          running
            ? tr('Rodando: a sessão já começou no computador e aparece no escritório em instantes.')
            : info.note
              ? tr('Abri no app do Claude: aperte Enter lá para começar. Não rodou sozinho: {0}.', [info.note])
              : tr('Abri no app do Claude: aperte Enter lá para começar.'),
          !running && !!info.note,
        );
        this.prompt.value = '';
        this.tray.clear();
        writePref(folder);
        this.ctx.announce(running ? tr('Agente novo rodando.') : tr('Agente novo aberto no app do Claude.'));
      } else this.say(info.error ? tr('Não abriu: {0}', [info.error]) : tr('O computador não confirmou a abertura.'), true);
    } catch (err) {
      this.say(tr('Não abriu: {0}', [(err as Error).message]), true);
    } finally {
      this.busy = false;
      this.submitBtn.disabled = false;
    }
  }
}

interface BrowseEntry {
  name: string;
  path: string;
  project?: boolean;
  hidden?: boolean;
}

interface BrowseListing {
  path: string;
  parent?: string;
  home: string;
  entries: BrowseEntry[];
  truncated?: boolean;
}

/** Caminho em pedaços clicáveis ("/", "Users", "voce", ...). */
export function crumbs(path: string): Array<{ name: string; path: string }> {
  const win = /^[A-Za-z]:[\\/]/.test(path);
  const sep = win ? '\\' : '/';
  const parts = path.split(/[\\/]+/).filter(Boolean);
  const out: Array<{ name: string; path: string }> = win ? [] : [{ name: '/', path: '/' }];
  let acc = '';
  for (const [i, part] of parts.entries()) {
    acc = win ? (i === 0 ? `${part}${sep}` : `${acc.replace(/[\\/]$/, '')}${sep}${part}`) : `${acc}/${part}`;
    out.push({ name: part, path: acc });
  }
  return out;
}

/** Navegador de pastas do computador (GET /api/spawn/browse; no Docker, quem lista é o auxiliar do host). */
export class FolderBrowserView {
  readonly el: HTMLElement;
  private readonly crumbsEl: HTMLElement;
  private readonly list: HTMLElement;
  private readonly status: HTMLElement;
  private readonly useBtn: HTMLButtonElement;
  private readonly hiddenToggle: HTMLInputElement;
  private readonly filter: HTMLInputElement;
  private listing?: BrowseListing;
  private seq = 0;

  constructor(private readonly onChoose: (path: string) => void) {
    this.crumbsEl = h('div', { class: 'ui-browse__crumbs', attrs: { 'aria-label': tr('Caminho') } });
    this.filter = h('input', { class: 'ui-rename__input ui-browse__filter', type: 'search', attrs: { placeholder: tr('Filtrar pastas'), spellcheck: 'false', autocomplete: 'off', 'aria-label': tr('Filtrar pastas') } });
    this.filter.addEventListener('input', () => this.render());
    for (const ev of ['keydown', 'keyup'] as const) this.filter.addEventListener(ev, (e) => e.stopPropagation());
    this.hiddenToggle = h('input', { type: 'checkbox' });
    this.hiddenToggle.addEventListener('change', () => this.render());
    this.list = h('ul', { class: 'ui-browse__list', role: 'listbox', attrs: { 'aria-label': tr('Pastas') } });
    this.status = h('p', { class: 'ui-rename__hint ui-browse__status', attrs: { role: 'status', 'aria-live': 'polite' } });
    this.useBtn = h('button', { class: 'ui-btn ui-perm__btn ui-perm__btn--allow ui-browse__use', type: 'button', on: { click: () => this.listing && this.onChoose(this.listing.path) } }, tr('Usar esta pasta'));
    const upBtn = h('button', { class: 'ui-btn ui-browse__nav', type: 'button', attrs: { title: tr('Pasta de cima') }, on: { click: () => this.listing?.parent && void this.go(this.listing.parent) } }, '↑');
    const homeBtn = h('button', { class: 'ui-btn ui-browse__nav', type: 'button', attrs: { title: tr('Pasta pessoal') }, on: { click: () => void this.go('') } }, '~');
    this.el = h(
      'div',
      { class: 'ui-browse', hidden: true },
      h('div', { class: 'ui-browse__bar' }, upBtn, homeBtn, this.crumbsEl),
      h('div', { class: 'ui-browse__bar' }, this.filter, h('label', { class: 'ui-browse__hidden' }, this.hiddenToggle, h('span', { text: tr('Ocultas') }))),
      this.list,
      this.status,
      this.useBtn,
    );
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  toggle(start: string): void {
    if (this.isOpen) return this.close();
    setHidden(this.el, false);
    void this.go(/^(\/|[A-Za-z]:[\\/])/.test(start) ? start : '');
  }

  close(): void {
    setHidden(this.el, true);
  }

  private async go(path: string): Promise<void> {
    const n = ++this.seq;
    setText(this.status, tr('Lendo as pastas…'));
    this.status.classList.remove('is-error');
    try {
      const listing = await api<BrowseListing>(`/api/spawn/browse?path=${encodeURIComponent(path)}`);
      if (n !== this.seq) return;
      this.listing = listing;
      this.filter.value = '';
      setText(this.status, listing.truncated ? tr('Muitas pastas: mostrando as primeiras {0}.', [listing.entries.length]) : '');
      this.render();
    } catch (err) {
      if (n !== this.seq) return;
      // Pasta que sumiu (ou caminho digitado errado): volta para a pasta pessoal uma vez.
      if (path && !this.listing) return void this.go('');
      setText(this.status, (err as Error).message);
      this.status.classList.add('is-error');
    }
  }

  private render(): void {
    const l = this.listing;
    if (!l) return;
    this.crumbsEl.replaceChildren(
      ...crumbs(l.path).map((c, i, all) =>
        i === all.length - 1
          ? h('span', { class: 'ui-browse__crumb is-current', text: c.name })
          : h('button', { class: 'ui-browse__crumb', type: 'button', on: { click: () => void this.go(c.path) } }, c.name),
      ),
    );
    this.crumbsEl.scrollLeft = this.crumbsEl.scrollWidth;
    const q = this.filter.value.trim().toLowerCase();
    const shown = l.entries.filter((e) => (this.hiddenToggle.checked || !e.hidden) && (!q || e.name.toLowerCase().includes(q)));
    this.list.replaceChildren(
      ...shown.map((e) => {
        const row = h(
          'li',
          { class: `ui-browse__item${e.project ? ' is-project' : ''}`, role: 'option', tabIndex: 0, attrs: { title: e.path } },
          h('span', { class: 'ui-browse__icon', attrs: { 'aria-hidden': 'true' }, text: e.project ? '📦' : '📁' }),
          h('span', { class: 'ui-browse__name', text: e.name }),
          e.project ? h('span', { class: 'ui-browse__tag', text: tr('projeto') }) : null,
          h('button', { class: 'ui-browse__pick', type: 'button', attrs: { title: tr('Usar esta pasta') }, on: { click: (ev: Event) => { ev.stopPropagation(); this.onChoose(e.path); } } }, tr('Usar')),
        );
        row.addEventListener('click', () => void this.go(e.path));
        row.addEventListener('keydown', (ev: KeyboardEvent) => {
          ev.stopPropagation();
          if (ev.key === 'Enter') void this.go(e.path);
        });
        return row;
      }),
    );
    if (!shown.length) this.list.append(h('li', { class: 'ui-browse__empty', text: q ? tr('Nenhuma pasta com esse nome.') : tr('Sem subpastas.') }));
    setText(this.useBtn, tr('Usar {0}', [shortPath(l.path)]));
  }
}
