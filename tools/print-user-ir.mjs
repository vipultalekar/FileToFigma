import fs from 'fs';

const d = JSON.parse(fs.readFileSync('tools/out/user-run-ir.json', 'utf8'));

function printNode(n, depth = 0) {
  const ind = '  '.repeat(depth);
  const r = n.rect ? `[${Math.round(n.rect.x)},${Math.round(n.rect.y)} ${Math.round(n.rect.w)}x${Math.round(n.rect.h)}]` : 'no-rect';
  const l = n.layout ? ` mode:${n.layout.mode} pad:[${n.layout.padding}] gap:${n.layout.itemSpacing} sizing:${JSON.stringify(n.layout.sizing)} abs:${!!n.layout.absolute}` : '';
  const fills = n.fills?.length ? ` fills:${n.fills.map(f => f.type === 'SOLID' ? `rgb(${Math.round(f.color.r*255)},${Math.round(f.color.g*255)},${Math.round(f.color.b*255)})` : f.type).join(',')}` : '';
  console.log(`${ind}${n.name} ${r}${l}${fills}`);
  if (n.children) {
    n.children.forEach(c => printNode(c, depth + 1));
  }
}

printNode(d.root);
