import { MAX_TABLE_CELLS } from './types';

/** 保留空单元格、换行和转义引号，用于单元格剪贴板交换。 */
export function encodeTabularText(rows: readonly (readonly string[])[]): string {
  return rows
    .map((row, index) =>
      row
        .map((value) =>
          value.includes('\t') ||
          /["\r\n]/.test(value) ||
          (!value && row.length === 1 && index > 0 && index === rows.length - 1)
            ? `"${value.replaceAll('"', '""')}"`
            : value
        )
        .join('\t')
    )
    .join('\r\n');
}

export function parseTabularText(text: string): string[][] | null {
  if (text.length > 1_048_576) return null;
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;
  let afterQuote = false;
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        value += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
        afterQuote = true;
      } else {
        value += ch;
      }
    } else if (afterQuote && ch !== '\t' && ch !== '\r' && ch !== '\n') {
      return null;
    } else if (ch === '"' && value.length === 0) {
      quoted = true;
    } else if (ch === '\t' || ch === '\r' || ch === '\n') {
      row.push(value);
      if (++count > MAX_TABLE_CELLS) return null;
      value = '';
      afterQuote = false;
      if (ch !== '\t') {
        rows.push(row);
        row = [];
        if (ch === '\r' && text[i + 1] === '\n') i++;
      }
    } else {
      value += ch;
    }
  }
  if (quoted) return null;
  if (row.length || value || !rows.length || !/[\r\n]$/.test(text)) {
    row.push(value);
    rows.push(row);
    count++;
  }
  return count <= MAX_TABLE_CELLS ? rows : null;
}
