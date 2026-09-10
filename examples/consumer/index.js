// Plain CommonJS (not TypeScript) on purpose: this proves the *installed,
// built* package works from a totally independent consumer project, not
// just via ts-node/tsx resolving the monorepo's own src/.
const { MemoryKujiEngine } = require('unakuji-fair-draw/memory');
const { createBox, draw, getPublicBox } = require('unakuji-fair-draw');

async function main() {
  // 1. The pure, storage-free functions imported from the package root.
  const { state } = createBox({ id: 'consumer-box', prizes: [{ id: 'A', quantity: 2 }, { id: 'B', quantity: 1 }] });
  const onSale = { ...state, status: 'on_sale' };
  const { nextState, result } = draw(onSale, { requestId: 'r1', holder: 'h1', ticketNos: [1] });
  console.log('[core] draw result:', result);
  console.log('[core] public view after the draw:', getPublicBox(nextState));

  // 2. The memory adapter imported from its own subpath export.
  const engine = new MemoryKujiEngine();
  await engine.createBox({ id: 'consumer-box-2', prizes: [{ id: 'A', quantity: 1 }] });
  await engine.openBox('consumer-box-2');
  const drawResult = await engine.draw('consumer-box-2', { requestId: 'r1', holder: 'h1', ticketNos: [1] });
  console.log('[memory adapter] draw result:', drawResult);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
