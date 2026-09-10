import { draw as coreDraw } from './core/draw';
import type { BoxStore } from './store';
import type { DrawInput, DrawResult } from './types';

/** Runs `draw` inside `store.transact`, so the read-validate-write cycle is atomic under the store's concurrency guarantees. */
export async function executeDraw(store: BoxStore, boxId: string, input: DrawInput): Promise<DrawResult> {
  return store.transact(boxId, (current) => {
    const { nextState, result } = coreDraw(current, input);
    return { nextState, value: result };
  });
}
