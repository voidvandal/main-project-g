// Default library layout used by the seed endpoint.
// Edit this to match your own library: one entry per zone.
export const LAYOUT = [
  { floor: 'Ground', zone: 'Reference Section', prefix: 'G-R', count: 12, powerEvery: 3 },
  { floor: 'Ground', zone: 'Newspaper Corner', prefix: 'G-N', count: 6, powerEvery: 0 },
  { floor: 'First', zone: 'Silent Reading', prefix: 'F1-S', count: 24, powerEvery: 2 },
  { floor: 'First', zone: 'Group Study Tables', prefix: 'F1-G', count: 8, powerEvery: 1 },
  { floor: 'Second', zone: 'Digital Library (PCs)', prefix: 'F2-D', count: 12, powerEvery: 1 },
];

export function buildSeats(layout = LAYOUT) {
  const seats = [];
  for (const z of layout) {
    for (let i = 1; i <= z.count; i++) {
      seats.push({
        seatId: `${z.prefix}${String(i).padStart(2, '0')}`,
        floor: z.floor,
        zone: z.zone,
        hasPower: z.powerEvery > 0 && i % z.powerEvery === 0,
        status: 'free',
        version: 0,
      });
    }
  }
  return seats;
}
