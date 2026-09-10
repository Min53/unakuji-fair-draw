import { releaseReservation as coreRelease, reserveTickets as coreReserve } from './reservations/reserve';
import type { BoxStore } from './store';
import type { ReleaseReservationInput, ReservationResult, ReserveTicketsInput } from './types';

export async function executeReserveTickets(store: BoxStore, boxId: string, input: ReserveTicketsInput): Promise<ReservationResult> {
  return store.transact(boxId, (current) => {
    const { nextState, result } = coreReserve(current, input);
    return { nextState, value: result };
  });
}

export async function executeReleaseReservation(store: BoxStore, boxId: string, input: ReleaseReservationInput): Promise<void> {
  await store.transact(boxId, (current) => ({ nextState: coreRelease(current, input), value: undefined }));
}
