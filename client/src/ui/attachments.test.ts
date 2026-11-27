import { describe, expect, it } from 'vitest';
import { isRichText, pastedName } from './attachments';

describe('pastedName', () => {
  const at = new Date(2026, 10, 28, 9, 5, 7);
  it('names pasted screenshots after the time', () => {
    expect(pastedName('image.png', 'image/png', at)).toBe('colado-20261128-090507.png');
    expect(pastedName('', 'image/jpeg', at)).toBe('colado-20261128-090507.jpg');
    expect(pastedName('blob', 'application/pdf', at)).toBe('colado-20261128-090507.bin');
  });
  it('keeps real file names', () => {
    expect(pastedName('report.pdf', 'application/pdf', at)).toBe('report.pdf');
  });
});

describe('isRichText', () => {
  it('lets spreadsheet / Word pastes through as text, but not screenshots or Finder files', () => {
    expect(isRichText(['text/plain', 'text/html', 'image/png'])).toBe(true);
    expect(isRichText(['text/rtf', 'Files'])).toBe(true);
    expect(isRichText(['Files', 'image/png'])).toBe(false);
    expect(isRichText(['Files', 'text/plain', 'text/uri-list'])).toBe(false);
  });
});
