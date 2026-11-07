import { expect, it } from 'vitest';
import {
  DARK_CANVAS_THEME_SEED,
  deriveCanvasTheme,
  LIGHT_CANVAS_THEME_SEED,
  parseCanvasDocument,
  SkyNoteEngine,
  SyntheticPointerEvent
} from '@skynote/core';
import { TablePlugin } from '../src/table-plugin';
import { TableNodeType } from '../src/table-node';
import { FALLBACK_TABLE_THEME, withTableThemeColor } from '../src/themes';

it.each([
  { fill: '#FFFFFF', text: '$foreground' },
  { fill: '#000000', text: '$background' },
  { fill: 'transparent', text: '$foreground' },
  { fill: 'rgba(255,255,255,0.1)', text: '$background' }
])('局部表头底色$fill按最终背景选取文字，保留主题且撤销恢复', ({ fill, text }) => {
  const engine = new SkyNoteEngine();
  const plugin = new TablePlugin();
  engine.use(plugin);
  const id = engine.documentStore.createNode({ nodeType: 'table', x: 0, y: 0 })!;
  const canvas = deriveCanvasTheme({ seed: LIGHT_CANVAS_THEME_SEED });
  const render = () => new TableNodeType().compose(engine.documentStore.getNode(id)!, { theme: canvas });
  try {
    plugin.setThemeColor('#000000', id);
    const click = new SyntheticPointerEvent({ point: { x: 30, y: 15 } });
    engine.pointer.dispatchPointerDown(click);
    engine.pointer.dispatchPointerUp(click);
    expect(plugin.setCellFill(fill, id)).toBe(true);
    const cell = render().find((p) => p.kind === 'text' && p.id === 'table:cell:0:0');
    expect(cell?.kind === 'text' && cell.style.color).toBe(text);
    expect(engine.documentStore.getNode(id)?.table?.themeColor).toBe('#000000');
    expect(engine.documentStore.undo()).toBe(true);
    const restored = render().find((p) => p.kind === 'text' && p.id === 'table:cell:0:0');
    expect(restored?.kind === 'text' && restored.style.color).toBe('$background');
  } finally {
    engine.destroy();
  }
});

it('表头手动块级、节点级和行内文字颜色优先于自动对比度', () => {
  const engine = new SkyNoteEngine();
  const plugin = new TablePlugin();
  engine.use(plugin);
  const id = engine.documentStore.createNode({ nodeType: 'table', x: 0, y: 0, options: { themeColor: '#000000' } })!;
  const theme = deriveCanvasTheme({ seed: LIGHT_CANVAS_THEME_SEED });
  try {
    const node = engine.documentStore.getNode(id)!;
    engine.documentStore.updateNode(id, {
      textStyle: { color: '$red' },
      textBlocks: node.textBlocks!.map((block, index) =>
        index === 0
          ? { ...block, style: { ...block.style, color: '$green' }, runs: [{ text: '手动', color: '$blue' }] }
          : block
      )
    });
    const texts = new TableNodeType()
      .compose(engine.documentStore.getNode(id)!, { theme })
      .filter((p) => p.kind === 'text');
    expect(texts.find((p) => p.id === 'table:cell:0:0')?.style.color).toBe('$green');
    expect(texts.find((p) => p.id === 'table:cell:0:0')?.runs[0].color).toBe('$blue');
    expect(texts.find((p) => p.id === 'table:cell:0:1')?.style.color).toBe('$red');
  } finally {
    engine.destroy();
  }
});

it.each([
  { seed: LIGHT_CANVAS_THEME_SEED, darkText: '$foreground', lightText: '$background' },
  { seed: DARK_CANVAS_THEME_SEED, darkText: '$background', lightText: '$foreground' }
])('自定义浅色与深色表头在两种画布主题下选择对比度更高的文字', ({ seed, darkText, lightText }) => {
  const canvas = deriveCanvasTheme({ seed });
  expect(withTableThemeColor(FALLBACK_TABLE_THEME, '#FFFFFF', canvas).headerText).toBe(darkText);
  expect(withTableThemeColor(FALLBACK_TABLE_THEME, '#000000', canvas).headerText).toBe(lightText);
});

it('主题色支持Token、自定义、恢复默认、撤销和保存重开，不覆盖框线或局部格式', () => {
  const engine = new SkyNoteEngine();
  const table = new TablePlugin();
  engine.use(table);
  const id = engine.documentStore.createNode({
    nodeType: 'table',
    x: 0,
    y: 0,
    options: { rowCount: 3, columnCount: 2, gridStyle: 'three-line' }
  })!;
  try {
    const original = engine.documentStore.getNode(id)!;
    engine.documentStore.updateNode(id, {
      table: { ...original.table!, bandedRows: true, totalRow: true, cellMeta: { '1,0': { fill: '$red' } } }
    });
    expect(table.setThemeColor('$blue', id)).toBe(true);
    expect(table.setThemeColor('#123456', id)).toBe(true);
    const node = engine.documentStore.getNode(id)!;
    expect(node.table).toMatchObject({
      themeColor: '#123456',
      gridStyle: 'three-line',
      cellMeta: { '1,0': { fill: '$red' } }
    });
    const theme = deriveCanvasTheme({ seed: LIGHT_CANVAS_THEME_SEED });
    const primitives = new TableNodeType().compose(node, { theme });
    expect(primitives.some((p) => p.kind === 'rect' && p.fill === '#123456')).toBe(true);
    expect(primitives.filter((p) => p.kind === 'line').every((p) => p.stroke === '#123456')).toBe(true);
    expect(table.getTheme(undefined, '#123456').bandedFill).toBe('#123456');
    expect(table.getTheme(undefined, '#123456').totalFill).toBe('#123456');
    const saved = parseCanvasDocument(JSON.parse(JSON.stringify(engine.documentStore.getView())));
    expect(saved.ok).toBe(true);
    const reopened = new SkyNoteEngine();
    reopened.use(new TablePlugin());
    try {
      if (saved.ok) {
        reopened.documentStore.replaceContent(saved.value.content, { undoable: false }, saved.value.assets);
        expect(reopened.documentStore.getNode(id)?.table?.themeColor).toBe('#123456');
      }
    } finally {
      reopened.destroy();
    }
    expect(table.setThemeColor(undefined, id)).toBe(true);
    expect(engine.documentStore.getNode(id)?.table?.themeColor).toBeUndefined();
    expect(engine.documentStore.undo()).toBe(true);
    expect(engine.documentStore.getNode(id)?.table?.themeColor).toBe('#123456');
    expect(engine.documentStore.undo()).toBe(true);
    expect(engine.documentStore.getNode(id)?.table?.themeColor).toBe('$blue');
  } finally {
    engine.destroy();
  }
});

it('拒绝无效与透明主题色，锁定和只读不产生写入；网格名称与顺序符合菜单约定', () => {
  const engine = new SkyNoteEngine();
  const table = new TablePlugin();
  engine.use(table);
  const id = engine.documentStore.createNode({ nodeType: 'table', x: 0, y: 0 })!;
  try {
    expect(table.listGridStyles().map((grid) => grid.label)).toEqual([
      '经典网格',
      '四周包围',
      '无边框',
      '三线表',
      '极简横线'
    ]);
    for (const color of ['invalid', 'transparent', '#12345600']) expect(table.setThemeColor(color, id)).toBe(false);
    engine.documentStore.updateNode(id, { locked: true });
    expect(table.setThemeColor('$blue', id)).toBe(false);
    engine.documentStore.updateNode(id, { locked: false });
    engine.session.setReadOnly(true);
    expect(table.setThemeColor('$blue', id)).toBe(false);
    expect(engine.documentStore.getNode(id)?.table?.themeColor).toBeUndefined();
  } finally {
    engine.destroy();
  }
});
