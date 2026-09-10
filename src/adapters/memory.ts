import { kujiError } from '../errors';
import { createBox as coreCreateBox } from '../core/createBox';
import { draw as coreDraw } from '../core/draw';
import { getPublicBox as coreGetPublicBox } from '../core/getPublicBox';
import {
  expireReservations as coreExpireReservations,
  releaseReservation as coreReleaseReservation,
  reserveTickets as coreReserveTickets,
} from '../reservations/reserve';
import type { BoxStore } from '../store';
import type {
  BoxState,
  CreateBoxInput,
  DrawInput,
  DrawResult,
  PublicBoxView,
  ReleaseReservationInput,
  ReservationResult,
  ReserveTicketsInput,
} from '../types';

/**
 * Serializes async work per key so concurrent calls for the same box run
 * one-at-a-time in FIFO order, while different boxes run fully in parallel.
 * Single-process only — this is what makes the memory adapter NOT a
 * multi-server-safe substitute for the PostgreSQL adapter (see README).
 */
class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => T): Promise<T> {
    const previousTail = this.tails.get(key) ?? Promise.resolve();
    let releaseNext!: () => void;
    const ownTail = new Promise<void>((resolve) => {
      releaseNext = resolve;
    });
    this.tails.set(key, previousTail.then(() => ownTail));
    await previousTail;
    try {
      return fn();
    } finally {
      releaseNext();
    }
  }
}

/**
 * Single-process, in-memory reference implementation of BoxStore, plus
 * ergonomic wrappers over the core functions. Intended for tests, examples,
 * and prototyping. It has no durability (state is lost on process exit) and
 * no cross-process concurrency safety — passing its tests does NOT mean a
 * deployment is production-ready. Use `adapters/postgres` for that; see
 * README "Which adapter should I use?".
 */
export class MemoryKujiEngine implements BoxStore {
  private readonly boxes = new Map<string, BoxState>();
  private readonly mutex = new KeyedMutex();

  async create(state: BoxState): Promise<void> {
    if (this.boxes.has(state.id)) {
      throw kujiError('BOX_ALREADY_EXISTS', `Box "${state.id}" already exists.`, { boxId: state.id });
    }
    this.boxes.set(state.id, state);
  }

  async transact<T>(boxId: string, run: (current: BoxState) => { nextState: BoxState; value: T }): Promise<T> {
    return this.mutex.run(boxId, () => {
      const current = this.boxes.get(boxId);
      if (!current) {
        throw kujiError('BOX_NOT_FOUND', `Box "${boxId}" does not exist.`, { boxId });
      }
      const { nextState, value } = run(current);
      this.boxes.set(boxId, nextState);
      return value;
    });
  }

  async createBox(input: CreateBoxInput, now?: Date): Promise<PublicBoxView> {
    const { state } = coreCreateBox(input, now);
    await this.create(state);
    return coreGetPublicBox(state);
  }

  async openBox(boxId: string): Promise<PublicBoxView> {
    return this.transact(boxId, (current) => {
      if (current.status !== 'preparing' && current.status !== 'upcoming') {
        throw kujiError('INVALID_STATE', `Box "${boxId}" cannot open from status "${current.status}".`, {
          boxId,
          status: current.status,
        });
      }
      const nextState: BoxState = { ...current, status: 'on_sale', updatedAt: new Date().toISOString() };
      return { nextState, value: coreGetPublicBox(nextState) };
    });
  }

  async cancelBox(boxId: string): Promise<PublicBoxView> {
    return this.transact(boxId, (current) => {
      if (current.status === 'sold_out' || current.status === 'ended') {
        throw kujiError('INVALID_STATE', `Box "${boxId}" cannot be canceled from status "${current.status}".`, {
          boxId,
          status: current.status,
        });
      }
      const nextState: BoxState = { ...current, status: 'canceled', updatedAt: new Date().toISOString() };
      return { nextState, value: coreGetPublicBox(nextState) };
    });
  }

  async draw(boxId: string, input: DrawInput): Promise<DrawResult> {
    return this.transact(boxId, (current) => {
      const { nextState, result } = coreDraw(current, input);
      return { nextState, value: result };
    });
  }

  async reserveTickets(boxId: string, input: ReserveTicketsInput): Promise<ReservationResult> {
    return this.transact(boxId, (current) => {
      const { nextState, result } = coreReserveTickets(current, input);
      return { nextState, value: result };
    });
  }

  async releaseReservation(boxId: string, input: ReleaseReservationInput): Promise<void> {
    await this.transact(boxId, (current) => ({ nextState: coreReleaseReservation(current, input), value: undefined }));
  }

  async expireReservations(boxId: string): Promise<void> {
    await this.transact(boxId, (current) => ({ nextState: coreExpireReservations(current), value: undefined }));
  }

  async getPublicBox(boxId: string): Promise<PublicBoxView> {
    const current = this.boxes.get(boxId);
    if (!current) {
      throw kujiError('BOX_NOT_FOUND', `Box "${boxId}" does not exist.`, { boxId });
    }
    return coreGetPublicBox(current);
  }

  /** Escape hatch for tests/tools that need the full internal state (includes undrawn ticket assignment — never expose this over a public API). */
  async getInternalState(boxId: string): Promise<BoxState> {
    const current = this.boxes.get(boxId);
    if (!current) {
      throw kujiError('BOX_NOT_FOUND', `Box "${boxId}" does not exist.`, { boxId });
    }
    return current;
  }
}
