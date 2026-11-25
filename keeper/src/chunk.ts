// Adaptive sizing for swap-heavy calls (allocatePartial / payoutPartial / routePartial).
// Thin pools can't absorb a big batch within the slippage limit, so the keeper
// halves the amount until a simulation passes, sends one piece per tick (spacing
// pieces out so the oracle's average keeps up), and grows again after successes.

export const MIN_FRACTION = 64n; // never go below balance / 64 in one tick

export function firstTry(remembered: bigint | undefined, balance: bigint): bigint {
  if (balance <= 0n) return 0n;
  if (remembered === undefined || remembered <= 0n) return balance;
  return remembered > balance ? balance : remembered;
}

/** Next smaller size to try after a price revert, or undefined to give up this tick. */
export function shrink(amount: bigint, balance: bigint): bigint | undefined {
  const next = amount / 2n;
  const floor = balance / MIN_FRACTION;
  if (next === 0n || next < floor) return undefined;
  return next;
}

/** Size to remember after a successful piece: grow back toward the full balance. */
export function afterSuccess(amount: bigint): bigint {
  return amount * 2n;
}
