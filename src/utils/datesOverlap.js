import { combineDateAndTime } from "./rentalPricing.js";

/** Hours required after return before the vehicle can be booked again. */
export const VEHICLE_TURNAROUND_BUFFER_HOURS = 4;
export const VEHICLE_TURNAROUND_BUFFER_MS = VEHICLE_TURNAROUND_BUFFER_HOURS * 60 * 60 * 1000;

export function datesOverlap(
  existingPickup,
  existingReturn,
  requestedPickup,
  requestedReturn,
) {
  const ep = new Date(existingPickup).getTime();
  const er = new Date(existingReturn).getTime();
  const rp = new Date(requestedPickup).getTime();
  const rr = new Date(requestedReturn).getTime();
  return ep < rr && er > rp;
}

/** Overlap check using pickup/return dates and HH:mm times (no buffer). */
export function rentalPeriodsOverlap(
  existingPickup,
  existingPickupTime,
  existingReturn,
  existingReturnTime,
  requestedPickup,
  requestedPickupTime,
  requestedReturn,
  requestedReturnTime,
) {
  const ep = combineDateAndTime(existingPickup, existingPickupTime ?? "00:00").getTime();
  const er = combineDateAndTime(existingReturn, existingReturnTime ?? "23:59").getTime();
  const rp = combineDateAndTime(requestedPickup, requestedPickupTime ?? "00:00").getTime();
  const rr = combineDateAndTime(requestedReturn, requestedReturnTime ?? "23:59").getTime();
  return ep < rr && er > rp;
}

/**
 * True when a requested rental conflicts with an existing booking, including
 * the turnaround buffer after the existing booking's return time.
 *
 * Blocked window: [existing pickup, existing return + buffer)
 */
export function rentalPeriodsConflict(
  existingPickup,
  existingPickupTime,
  existingReturn,
  existingReturnTime,
  requestedPickup,
  requestedPickupTime,
  requestedReturn,
  requestedReturnTime,
  bufferMs = VEHICLE_TURNAROUND_BUFFER_MS,
) {
  const blockedStart = combineDateAndTime(existingPickup, existingPickupTime ?? "00:00").getTime();
  const blockedEnd =
    combineDateAndTime(existingReturn, existingReturnTime ?? "23:59").getTime() + bufferMs;
  const reqStart = combineDateAndTime(requestedPickup, requestedPickupTime ?? "00:00").getTime();
  const reqEnd = combineDateAndTime(requestedReturn, requestedReturnTime ?? "23:59").getTime();
  return blockedStart < reqEnd && blockedEnd > reqStart;
}

/** Buffer applies after both rentals — conflict if either blocked window overlaps the other. */
export function rentalPeriodsConflictEitherWay(
  aPickup,
  aPickupTime,
  aReturn,
  aReturnTime,
  bPickup,
  bPickupTime,
  bReturn,
  bReturnTime,
  bufferMs = VEHICLE_TURNAROUND_BUFFER_MS,
) {
  return (
    rentalPeriodsConflict(
      aPickup,
      aPickupTime,
      aReturn,
      aReturnTime,
      bPickup,
      bPickupTime,
      bReturn,
      bReturnTime,
      bufferMs,
    ) ||
    rentalPeriodsConflict(
      bPickup,
      bPickupTime,
      bReturn,
      bReturnTime,
      aPickup,
      aPickupTime,
      aReturn,
      aReturnTime,
      bufferMs,
    )
  );
}
