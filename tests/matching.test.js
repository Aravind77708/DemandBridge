const test = require('node:test');
const assert = require('node:assert/strict');
const { matchSuppliers } = require('../database/matching');

const demand = (overrides = {}) => ({
  id: 'DEM-MATCH', item: 'Organic cane sugar', category: 'Food ingredients',
  qty: 10, unit: 'kg', destination: 'Pune', due: '2026-01-11',
  qualityRequirements: { organic: true, certifications: ['FSSAI'] },
  latitude: 18.5204, longitude: 73.8567, ...overrides,
});
const supplier = (overrides = {}) => ({
  id: 'SUP-1', name: 'Supplier 1', category: 'Food ingredients', location: 'Pune',
  products: ['Organic cane sugar'], qualityAttributes: { organic: true, certifications: ['FSSAI', 'ISO 22000'] },
  capacity: 20, minimumOrderQuantity: 1, price: 10, lead: 3, rating: 4, verified: true,
  latitude: 19.076, longitude: 72.8777, ...overrides,
});

test('requires an exact catalog product and requested category', () => {
  const result = matchSuppliers(demand(), [supplier(), supplier({ id: 'SUP-WRONG-PRODUCT', products: ['Wheat flour'] }), supplier({ id: 'SUP-WRONG-CATEGORY', category: 'Packaging' })], { today: '2026-01-01' });
  assert.deepEqual(result.matches.map((entry) => entry.id), ['SUP-1']);
  assert.ok(result.excluded.find((entry) => entry.id === 'SUP-WRONG-PRODUCT').reasons.some((reason) => reason.includes('Catalog does not list')));
  assert.ok(result.excluded.find((entry) => entry.id === 'SUP-WRONG-CATEGORY').reasons.some((reason) => reason.includes('Category does not match')));
});

test('detects aggregate capacity below requested demand while preserving eligible split suppliers', () => {
  const result = matchSuppliers(demand({ qty: 10 }), [supplier({ id: 'SUP-A', capacity: 2 }), supplier({ id: 'SUP-B', capacity: 3 })], { today: '2026-01-01' });
  assert.equal(result.matches.length, 2);
  assert.equal(result.summary.totalAvailableCapacity, 5);
  assert.equal(result.summary.fullyCoverable, false);
  assert.match(result.summary.coverageReason, /5 kg total capacity for a 10 kg demand/);
  assert.equal(result.allocationPlan, null);
});

test('excludes suppliers whose MOQ exceeds their available capacity or the demand', () => {
  const result = matchSuppliers(demand({ qty: 10 }), [
    supplier({ id: 'SUP-MOQ-CAP', capacity: 5, minimumOrderQuantity: 6 }),
    supplier({ id: 'SUP-MOQ-DEMAND', capacity: 30, minimumOrderQuantity: 11 }),
  ], { today: '2026-01-01' });
  assert.equal(result.matches.length, 0);
  assert.ok(result.excluded.find((entry) => entry.id === 'SUP-MOQ-CAP').reasons.some((reason) => reason.includes('below MOQ')));
  assert.ok(result.excluded.find((entry) => entry.id === 'SUP-MOQ-DEMAND').reasons.some((reason) => reason.includes('exceeds demand quantity')));
  assert.equal(result.summary.fullyCoverable, false);
});

test('does not compare quantities measured in different units', () => {
  const result = matchSuppliers(demand({ unit: 'lb' }), [supplier({ capacityUnit: 'kg' })], { today: '2026-01-01' });
  assert.equal(result.matches.length, 0);
  assert.ok(result.excluded[0].reasons.some((reason) => reason.includes('Capacity is recorded in kg, but demand is lb')));
});

test('does not admit a supplier that fails a mandatory quality requirement', () => {
  const result = matchSuppliers(demand(), [supplier({ qualityAttributes: { organic: false, certifications: ['FSSAI'] } })], { today: '2026-01-01' });
  assert.equal(result.matches.length, 0);
  assert.ok(result.excluded[0].reasons.some((reason) => reason.includes('organic')));
});

test('excludes suppliers whose lead time misses the delivery deadline', () => {
  const result = matchSuppliers(demand({ due: '2026-01-04' }), [supplier({ lead: 5 })], { today: '2026-01-01' });
  assert.equal(result.matches.length, 0);
  assert.ok(result.excluded[0].reasons.some((reason) => reason.includes('exceeds 3 days')));
});

test('ranks eligible suppliers with a transparent weighted score and distance when coordinates exist', () => {
  const result = matchSuppliers(demand(), [
    supplier({ id: 'SUP-EXPENSIVE', price: 20, latitude: 18.53, longitude: 73.85 }),
    supplier({ id: 'SUP-CHEAP', price: 5, latitude: 18.53, longitude: 73.85 }),
  ], { today: '2026-01-01' });
  assert.equal(result.matches[0].id, 'SUP-CHEAP');
  assert.ok(result.matches[0].score > result.matches[1].score);
  assert.equal(result.matches[0].scoreBreakdown.product.points, result.matches[0].scoreBreakdown.product.max);
  assert.ok(result.matches[0].scoreBreakdown.distance);
  assert.ok(result.matches[0].reasons.some((reason) => reason.includes('km straight-line distance from destination')));
  assert.match(result.summary.scoring, /not a trained AI model/);
});

test('supports multiple eligible suppliers and a MOQ-valid split allocation plan', () => {
  const result = matchSuppliers(demand({ qty: 10 }), [
    supplier({ id: 'SUP-A', capacity: 6, minimumOrderQuantity: 4, rating: 4.5 }),
    supplier({ id: 'SUP-B', capacity: 6, minimumOrderQuantity: 4, rating: 4.2 }),
  ], { today: '2026-01-01' });
  assert.equal(result.matches.length, 2);
  assert.equal(result.summary.fullyCoverable, true);
  assert.equal(result.allocationPlan.reduce((sum, entry) => sum + entry.quantity, 0), 10);
  assert.ok(result.allocationPlan.every((entry) => entry.quantity >= 4 && entry.quantity <= 6));
});

test('reports infeasible aggregate MOQ even when total capacity is enough', () => {
  const result = matchSuppliers(demand({ qty: 10 }), [
    supplier({ id: 'SUP-MIN-A', capacity: 6, minimumOrderQuantity: 6 }),
    supplier({ id: 'SUP-MIN-B', capacity: 6, minimumOrderQuantity: 6 }),
  ], { today: '2026-01-01' });
  assert.equal(result.summary.totalAvailableCapacity, 12);
  assert.equal(result.summary.fullyCoverable, false);
  assert.match(result.summary.coverageReason, /MOQ constraints/);
});

test('uses recorded supplier-to-destination coordinates to prefer the nearer supplier', () => {
  const result = matchSuppliers(demand(), [
    supplier({ id: 'SUP-NEAR', latitude: 18.5205, longitude: 73.8568 }),
    supplier({ id: 'SUP-FAR', latitude: 28.6139, longitude: 77.209 }),
  ], { today: '2026-01-01' });
  assert.equal(result.matches[0].id, 'SUP-NEAR');
  assert.ok(result.matches[0].scoreBreakdown.distance.points > result.matches[1].scoreBreakdown.distance.points);
});

test('reports no eligible supplier and explains each exclusion', () => {
  const result = matchSuppliers(demand(), [supplier({ id: 'SUP-UNVERIFIED', verified: false })], { today: '2026-01-01' });
  assert.equal(result.matches.length, 0);
  assert.equal(result.summary.eligibleCount, 0);
  assert.match(result.summary.coverageReason, /No supplier passed/);
  assert.ok(result.excluded[0].reasons.includes('Supplier profile is not verified'));
});
