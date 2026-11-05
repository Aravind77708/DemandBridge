module.exports = {
  demands: [
    { id: 'DEM-1048', buyer: 'Northstar Foods', item: 'Organic cane sugar', qty: 12000, unit: 'kg', destination: 'Pune, IN', due: '2026-11-20', status: 'Matching', created: '2026-11-05T00:00:00.000Z' },
    { id: 'DEM-1047', buyer: 'Asteria Home', item: 'Recycled PET resin', qty: 8000, unit: 'kg', destination: 'Mumbai, IN', due: '2026-11-24', status: 'Approved', created: '2026-11-05T00:00:00.000Z' },
  ],
  suppliers: [
    { id: 'SUP-001', name: 'Greenline Commodities', category: 'Food ingredients', location: 'Maharashtra', rating: 4.9, capacity: 20000, price: 68, lead: 6, verified: true },
    { id: 'SUP-002', name: 'Sundar Agro Exports', category: 'Food ingredients', location: 'Gujarat', rating: 4.7, capacity: 16000, price: 65, lead: 9, verified: true },
    { id: 'SUP-003', name: 'TerraSource Materials', category: 'Food ingredients', location: 'Karnataka', rating: 4.8, capacity: 10000, price: 72, lead: 4, verified: true },
    { id: 'SUP-004', name: 'Evergreen Mills', category: 'Food ingredients', location: 'Madhya Pradesh', rating: 4.5, capacity: 22000, price: 63, lead: 12, verified: true },
  ],
};
