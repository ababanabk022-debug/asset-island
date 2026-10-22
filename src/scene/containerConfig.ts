/** Play limits follow the actual dry shore at waterY + shoreClearance.
 * radius is a legacy envelope only; visual water has its own extent. */
export const CONTAINER = {
  radius: 6.35,
  waterRadius: 7.4,
  waterY: .065,
  shoreClearance: .05,
  floorY: -1.55,
  wallTop: 8.5,
  cloud: [.8, 7.2, 1.4] as [number, number, number],
  dropRadius: 1.05,
}
