// Anexos (imagens e arquivos) do Novo agente e da caixa de mensagem: a lista com miniaturas, o botão de escolher,
// colar (Cmd/Ctrl+V com uma imagem ou arquivo copiado) e arrastar e soltar. Cada arquivo sobe separado, em JSON base64
// (o guard exige JSON em todo POST), e o servidor devolve um id; o pedido ou a mensagem leva os ids. Quem grava no
// computador é o servidor (Node) ou o auxiliar do host (Docker), em ~/.habblaud/attachments/.
import { tr } from '../../../shared/i18n';
import { h, iconButton } from './dom';
import { ICONS } from './icons';

export const MAX_FILES = 8;
export const MAX_FILE_BYTES = 15 * 1024 * 1024;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

/** Nome para um arquivo colado sem nome (captura de tela: "image.png" vira "colado-<hora>.png"). */
export function pastedName(name: string, type: string, at = new Date()): string {
  if (name && name !== 'image.png' && name !== 'blob') return name;
  const ext = (/^image\/(\w+)/.exec(type)?.[1] ?? 'bin').replace('jpeg', 'jpg');
  const p = (n: number) => String(n).padStart(2, '0');
  return `colado-${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}.${ext}`;
}

/** Os arquivos de um colar ou soltar (vazio = só texto: o colar segue normal). */
export function filesFrom(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];
  const out: File[] = [];
  if (data.items?.length) {
    for (const item of [...data.items]) {
      if (item.kind !== 'file') continue;
      const f = item.getAsFile();
      if (f) out.push(f);
    }
  } else out.push(...[...(data.files ?? [])]);
  return out.map((f) => (f.name && f.name !== 'image.png' ? f : new File([f], pastedName(f.name, f.type), { type: f.type, lastModified: f.lastModified })));
}

function fileToBase64(file: Blob): Promise<string> {
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => fail(new Error(tr('não deu para ler o arquivo')));
    r.readAsDataURL(file);
  });
}

interface PendingFile {
  file: File;
  url?: string;
  el: HTMLElement;
}

export interface TrayOptions {
  /** Aviso para a pessoa (limite, arquivo grande). */
  say: (text: string, error?: boolean) => void;
  /** A lista mudou (para habilitar o botão de mandar). */
  onChange?: () => void;
  /** Lista compacta (caixa de mensagem). */
  compact?: boolean;
}

export class AttachmentTray {
  /** A lista dos anexos (vazia = escondida pelo CSS). */
  readonly list: HTMLElement;
  /** O seletor de arquivos (escondido; o botão abre). */
  readonly input: HTMLInputElement;
  private files: PendingFile[] = [];

  constructor(private readonly opts: TrayOptions) {
    this.list = h('ul', { class: `ui-spawn__files${opts.compact ? ' ui-attach--compact' : ''}`, attrs: { 'aria-label': tr('Anexos') } });
    this.input = h('input', { type: 'file', hidden: true, attrs: { multiple: true, 'aria-hidden': 'true', tabindex: '-1' } });
    this.input.addEventListener('change', () => {
      this.add([...(this.input.files ?? [])]);
      this.input.value = '';
    });
  }

  get count(): number {
    return this.files.length;
  }

  /** Abre o seletor de arquivos. */
  pick(): void {
    this.input.click();
  }

  /** Botão "Anexar" (com rótulo) ou só o clipe (compacto). */
  button(compact = false, extraClass = ''): HTMLButtonElement {
    if (compact) return iconButton(ICONS.attach, tr('Anexar imagens ou arquivos (ou cole / arraste aqui)'), () => this.pick(), `ui-attach__btn ${extraClass}`.trim());
    const b = h('button', { class: `ui-btn ${extraClass}`.trim(), type: 'button', attrs: { title: tr('Anexar imagens ou arquivos (ou cole / arraste aqui)') }, on: { click: () => this.pick() } });
    const clip = h('span', { attrs: { 'aria-hidden': 'true' } });
    clip.innerHTML = ICONS.attach;
    b.append(clip, h('span', { text: tr('Anexar') }));
    return b;
  }

  /** Colar arquivos em `field` e soltar arquivos em `zone` viram anexos. `enabled` desliga sem tirar os eventos. */
  wire(field: HTMLElement, zone: HTMLElement, enabled: () => boolean = () => true): void {
    field.addEventListener('paste', (e: ClipboardEvent) => {
      if (!enabled()) return;
      const files = filesFrom(e.clipboardData);
      if (!files.length) return;
      e.preventDefault();
      this.add(files);
    });
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...(e.dataTransfer.types ?? [])].includes('Files');
    let depth = 0;
    zone.addEventListener('dragenter', (e: DragEvent) => {
      if (!enabled() || !hasFiles(e)) return;
      e.preventDefault();
      depth++;
      zone.classList.add('is-dropping');
    });
    zone.addEventListener('dragover', (e: DragEvent) => {
      if (!enabled() || !hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    zone.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) zone.classList.remove('is-dropping');
    });
    zone.addEventListener('drop', (e: DragEvent) => {
      depth = 0;
      zone.classList.remove('is-dropping');
      if (!enabled() || !hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      this.add(filesFrom(e.dataTransfer));
    });
  }

  add(list: File[]): void {
    for (const file of list) {
      if (this.files.length >= MAX_FILES) {
        this.opts.say(tr('No máximo {0} anexos por pedido.', [MAX_FILES]), true);
        break;
      }
      if (file.size > MAX_FILE_BYTES) {
        this.opts.say(tr('{0} passa de {1} MB.', [file.name, MAX_FILE_BYTES / 1024 / 1024]), true);
        continue;
      }
      if (!file.size) continue;
      const url = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
      const item: PendingFile = { file, url, el: h('li', { class: 'ui-spawn__file' }) };
      const thumb = url
        ? h('img', { class: 'ui-spawn__thumb', attrs: { src: url, alt: '' } })
        : h('span', { class: 'ui-spawn__thumb ui-spawn__thumb--doc', attrs: { 'aria-hidden': 'true' }, text: (file.name.split('.').pop() ?? '').slice(0, 4).toUpperCase() || tr('ARQ') });
      const remove = iconButton(ICONS.close, tr('Tirar {0}', [file.name]), () => this.remove(item), 'ui-icon-btn--sm ui-spawn__file-x');
      item.el.append(thumb, h('span', { class: 'ui-spawn__file-name', text: file.name, attrs: { title: file.name } }), h('span', { class: 'ui-spawn__file-size', text: formatBytes(file.size) }), remove);
      this.files.push(item);
      this.list.append(item.el);
    }
    this.opts.onChange?.();
  }

  clear(): void {
    for (const f of [...this.files]) this.remove(f, false);
    this.opts.onChange?.();
  }

  /** Sobe cada arquivo (POST `endpoint`) e devolve os ids, na ordem. Erro: lança com a mensagem do servidor. */
  async upload(endpoint: string, progress?: (i: number, total: number) => void): Promise<string[]> {
    const ids: string[] = [];
    for (const [i, f] of this.files.entries()) {
      progress?.(i, this.files.length);
      let res: Response;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: f.file.name, type: f.file.type, data: await fileToBase64(f.file) }),
        });
      } catch {
        throw new Error(tr('o Habblaud não respondeu'));
      }
      const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!res.ok || !body.id) throw new Error(body.error ?? tr('erro {0}', [res.status]));
      ids.push(body.id);
    }
    return ids;
  }

  private remove(item: PendingFile, notify = true): void {
    if (item.url) URL.revokeObjectURL(item.url);
    item.el.remove();
    this.files = this.files.filter((f) => f !== item);
    if (notify) this.opts.onChange?.();
  }
}
