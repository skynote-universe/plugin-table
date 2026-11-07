import type { CanvasPatch, NodeEntity } from '@skynote/core';

/** 只提交改变的单元格/属性，不把整表文字及未修改单元格复制进历史与协同补丁。 */
export function createTableStylePatches(before: Readonly<NodeEntity>, after: Readonly<NodeEntity>): CanvasPatch[] {
  const patches: CanvasPatch[] = [];
  const base = ['content', 'nodes', before.id];
  const field = (path: (string | number)[], previous: unknown, next: unknown): void => {
    if (previous === next) return;
    patches.push(next === undefined ? { op: 'unset', path } : { op: 'set', path, value: next });
  };
  const previousTable = before.table!;
  const nextTable = after.table!;
  for (const key of new Set([...Object.keys(previousTable), ...Object.keys(nextTable)])) {
    if (key === 'cellMeta') continue;
    field(
      [...base, 'table', key],
      previousTable[key as keyof typeof previousTable],
      nextTable[key as keyof typeof nextTable]
    );
  }
  const previousMeta = previousTable.cellMeta;
  const nextMeta = nextTable.cellMeta;
  if (!previousMeta && nextMeta) {
    patches.push({ op: 'set', path: [...base, 'table', 'cellMeta'], value: nextMeta, merge: true });
  } else if (previousMeta && !nextMeta) {
    patches.push({ op: 'unset', path: [...base, 'table', 'cellMeta'] });
  } else {
    for (const key of new Set([...Object.keys(previousMeta ?? {}), ...Object.keys(nextMeta ?? {})])) {
      const previous = previousMeta?.[key];
      const next = nextMeta?.[key];
      if (previous === next) continue;
      if (!previous || !next) field([...base, 'table', 'cellMeta', key], previous, next);
      else
        for (const property of new Set([...Object.keys(previous), ...Object.keys(next)])) {
          field(
            [...base, 'table', 'cellMeta', key, property],
            previous[property as keyof typeof previous],
            next[property as keyof typeof next]
          );
        }
    }
  }
  const previousBlocks = before.textBlocks;
  const nextBlocks = after.textBlocks;
  if (previousBlocks !== nextBlocks) {
    if (
      !previousBlocks ||
      !nextBlocks ||
      previousBlocks.length !== nextBlocks.length ||
      previousBlocks.some((block, index) => block.id !== nextBlocks[index].id)
    ) {
      field([...base, 'textBlocks'], previousBlocks, nextBlocks);
    } else
      for (let index = 0; index < nextBlocks.length; index++) {
        const previous = previousBlocks[index];
        const next = nextBlocks[index];
        if (previous === next) continue;
        for (const key of new Set([...Object.keys(previous), ...Object.keys(next)]))
          field(
            [...base, 'textBlocks', index, key],
            previous[key as keyof typeof previous],
            next[key as keyof typeof next]
          );
      }
  }
  return patches;
}
