const asNumber = (value) => Number(value || 0);

function normalizeText(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function qualityMismatches(requirements, attributes, prefix = '') {
  const mismatches = [];
  for (const [key, required] of Object.entries(requirements || {})) {
    const label = prefix ? `${prefix}.${key}` : key;
    if (!Object.prototype.hasOwnProperty.call(attributes || {}, key)) {
      mismatches.push(`${label}: supplier has no recorded value`);
      continue;
    }
    const actual = attributes[key];
    if (isRecord(required)) {
      if (!isRecord(actual)) mismatches.push(`${label}: supplier value does not meet the requested criteria`);
      else mismatches.push(...qualityMismatches(required, actual, label));
    } else if (Array.isArray(required)) {
      const actualSet = new Set((Array.isArray(actual) ? actual : []).map(normalizeText));
      const missing = required.filter((item) => !actualSet.has(normalizeText(item)));
      if (missing.length) mismatches.push(`${label}: missing ${missing.join(', ')}`);
    } else if (typeof required === 'string') {
      if (typeof actual !== 'string' || normalizeText(actual) !== normalizeText(required)) mismatches.push(`${label}: requested ${required}, supplier records ${String(actual ?? 'no value')}`);
    } else if (actual !== required) {
      mismatches.push(`${label}: requested ${String(required)}, supplier records ${String(actual)}`);
    }
  }
  return mismatches;
}

function dateDistanceDays(due, today) {
  if (!due) return null;
  const dueMs = Date.parse(`${String(due).slice(0, 10)}T00:00:00Z`);
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(dueMs) || !Number.isFinite(todayMs)) return null;
  return Math.floor((dueMs - todayMs) / 86400000);
}

function haversineKm(aLat, aLng, bLat, bLng) {
  const radians = (value) => value * Math.PI / 180;
  const dLat = radians(bLat - aLat);
  const dLng = radians(bLng - aLng);
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(radians(aLat)) * Math.cos(radians(bLat)) * Math.sin(dLng / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function toHundredths(value) {
  return Math.round(asNumber(value) * 100);
}

function buildAllocationPlan(matches, quantity) {
  let remaining = toHundredths(quantity);
  const plan = [];
  for (const supplier of matches) {
    if (remaining <= 0) break;
    const capacity = toHundredths(supplier.capacity);
    const minimum = Math.max(1, toHundredths(supplier.minimumOrderQuantity));
    if (capacity < minimum || capacity <= 0) continue;
    if (remaining > capacity) {
      plan.push({ supplier, quantity: capacity });
      remaining -= capacity;
      continue;
    }
    if (remaining >= minimum) {
      plan.push({ supplier, quantity: remaining });
      remaining = 0;
      break;
    }

    // If the final remainder is below this supplier's MOQ, rebalance prior
    // allocations while keeping every supplier at or above its own MOQ.
    let needed = minimum - remaining;
    const reducible = plan.reduce((sum, entry) => sum + Math.max(0, entry.quantity - Math.max(1, toHundredths(entry.supplier.minimumOrderQuantity))), 0);
    if (reducible < needed) continue;
    for (let index = plan.length - 1; index >= 0 && needed > 0; index -= 1) {
      const entry = plan[index];
      const floor = Math.max(1, toHundredths(entry.supplier.minimumOrderQuantity));
      const reduction = Math.min(needed, entry.quantity - floor);
      entry.quantity -= reduction;
      needed -= reduction;
    }
    plan.push({ supplier, quantity: minimum });
    remaining = 0;
    break;
  }
  if (remaining !== 0) return null;
  return plan.map(({ supplier, quantity: units }) => ({
    supplierId: supplier.supplierId || supplier.id,
    supplierProductId: supplier.productId || supplier.id,
    productName: supplier.productName || supplier.item || null,
    quantity: units / 100,
  }));
}

function matchSuppliers(demand, suppliers, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const demandQuantity = asNumber(demand.qty ?? demand.quantity);
  const item = normalizeText(demand.item);
  const requestedCategory = normalizeText(demand.category);
  const requirements = demand.qualityRequirements || demand.quality_requirements || {};
  const daysAvailable = dateDistanceDays(demand.due, today);
  const itemCandidates = [];
  const excluded = [];

  for (const supplier of suppliers) {
    const reasons = [];
    const products = Array.isArray(supplier.products) ? supplier.products : [];
    const productMatch = products.some((product) => normalizeText(product) === item);
    const categoryMatch = !requestedCategory || normalizeText(supplier.category) === requestedCategory;
    const qualityFailures = qualityMismatches(requirements, supplier.qualityAttributes || supplier.quality_attributes || {});
    const capacity = asNumber(supplier.capacity ?? supplier.available_capacity);
    const minimumOrderQuantity = asNumber(supplier.minimumOrderQuantity ?? supplier.minimum_order_quantity);
    const lead = asNumber(supplier.lead ?? supplier.lead_days);
    const capacityUnit = normalizeText(supplier.capacityUnit || supplier.capacity_unit || 'kg');
    const demandUnit = normalizeText(demand.unit || 'kg');
    const profileVerified = supplier.supplierVerified ?? supplier.verified;
    if (!profileVerified) reasons.push(`Supplier profile is ${supplier.supplierVerificationStatus || 'not verified'}`);
    if (supplier.productVerificationStatus && supplier.productVerificationStatus !== 'approved') reasons.push(`Catalogue product is ${supplier.productVerificationStatus}`);
    if (supplier.productVerificationStatus && supplier.productVerificationStatus === 'approved' && !profileVerified) reasons.push('Supplier profile must be approved before catalog products can match');
    if (!productMatch) reasons.push(`Catalog does not list requested item “${demand.item}”`);
    if (!categoryMatch) reasons.push(`Category does not match requested category “${demand.category}”`);
    if (qualityFailures.length) reasons.push(...qualityFailures);
    if (capacity <= 0) reasons.push('No available capacity');
    else if (minimumOrderQuantity > capacity) reasons.push(`Available capacity ${capacity} is below MOQ ${minimumOrderQuantity}`);
    if (capacityUnit !== demandUnit) reasons.push(`Capacity is recorded in ${capacityUnit}, but demand is ${demandUnit}`);
    if (minimumOrderQuantity > demandQuantity) reasons.push(`MOQ ${minimumOrderQuantity} exceeds demand quantity ${demandQuantity}`);
    if (daysAvailable === null) reasons.push('Delivery deadline is missing or invalid');
    else if (daysAvailable < 0) reasons.push('Delivery deadline has passed');
    else if (lead > daysAvailable) reasons.push(`Lead time ${lead} days exceeds ${daysAvailable} days until deadline`);

    if (reasons.length) {
      excluded.push({ ...supplier, eligible: false, reasons, score: null, scoreBreakdown: {}, locationAssessment: { used: false, reason: 'Not scored for an ineligible supplier' } });
      continue;
    }
    const locationAvailable = [supplier.latitude, supplier.longitude, demand.latitude, demand.longitude].every((value) => value !== null && value !== undefined && Number.isFinite(Number(value)));
    const distanceKm = locationAvailable ? haversineKm(Number(supplier.latitude), Number(supplier.longitude), Number(demand.latitude), Number(demand.longitude)) : null;
    itemCandidates.push({
      ...supplier, capacity, capacityUnit, minimumOrderQuantity, lead, productMatch, categoryMatch,
      qualityFailures, daysAvailable, distanceKm,
      reasons: [
        `Catalog item exactly matches “${demand.item}”`,
        ...(requestedCategory ? [`Category matches “${demand.category}”`] : []),
        ...(Object.keys(requirements).length ? ['All mandatory quality requirements are met'] : ['No mandatory quality requirements specified']),
        `Available capacity is ${capacity} ${demand.unit || ''}; shared sourcing may combine suppliers`,
        `MOQ is ${minimumOrderQuantity}`,
        `Lead time is ${lead} days within the ${daysAvailable}-day deadline`,
        locationAvailable ? `Approximately ${distanceKm.toFixed(1)} km straight-line distance from destination` : 'Distance not scored because supplier and destination coordinates are incomplete',
      ],
      eligible: true,
    });
  }

  const prices = itemCandidates.map((supplier) => asNumber(supplier.price ?? supplier.unit_price));
  const minPrice = prices.length ? Math.min(...prices) : 0;
  const maxPrice = prices.length ? Math.max(...prices) : 0;
  const distances = itemCandidates.filter((supplier) => supplier.distanceKm !== null).map((supplier) => supplier.distanceKm);
  const minDistance = distances.length ? Math.min(...distances) : 0;
  const maxDistance = distances.length ? Math.max(...distances) : 0;
  const weights = { product: 25, category: 15, quality: 20, capacity: 15, price: 10, leadTime: 10, rating: 5, distance: 5 };
  const matches = itemCandidates.map((supplier) => {
    const breakdown = {};
    const add = (key, points, max = weights[key]) => { breakdown[key] = { points: Number(points.toFixed(2)), max }; };
    add('product', weights.product);
    if (requestedCategory) add('category', weights.category);
    if (Object.keys(requirements).length) add('quality', weights.quality);
    add('capacity', weights.capacity * Math.min(1, supplier.capacity / Math.max(1, demandQuantity)));
    const price = asNumber(supplier.price ?? supplier.unit_price);
    add('price', maxPrice === minPrice ? weights.price : weights.price * (maxPrice - price) / (maxPrice - minPrice));
    add('leadTime', daysAvailable <= 0 ? (supplier.lead === 0 ? weights.leadTime : 0) : weights.leadTime * Math.max(0, 1 - supplier.lead / Math.max(1, daysAvailable)));
    add('rating', weights.rating * Math.max(0, Math.min(5, asNumber(supplier.rating))) / 5);
    if (supplier.distanceKm !== null) add('distance', maxDistance === minDistance ? weights.distance : weights.distance * (maxDistance - supplier.distanceKm) / (maxDistance - minDistance));
    const max = Object.values(breakdown).reduce((sum, item) => sum + item.max, 0);
    const points = Object.values(breakdown).reduce((sum, item) => sum + item.points, 0);
    return { ...supplier, score: Number((points / max * 100).toFixed(2)), scoreBreakdown: breakdown };
  }).sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));

  const allocationPlan = buildAllocationPlan(matches, demandQuantity);
  const totalAvailableCapacity = matches.reduce((sum, supplier) => sum + supplier.capacity, 0);
  let coverageReason = null;
  if (!allocationPlan) {
    if (!matches.length) coverageReason = 'No supplier passed product, quality, verification, capacity, MOQ, and deadline requirements.';
    else if (totalAvailableCapacity < demandQuantity) coverageReason = `Eligible suppliers have ${totalAvailableCapacity} ${demand.unit || ''} total capacity for a ${demandQuantity} ${demand.unit || ''} demand.`;
    else coverageReason = 'Eligible supplier capacity exists, but the MOQ constraints do not permit a complete allocation.';
  }
  return {
    matches,
    excluded: excluded.map((supplier) => ({ ...supplier, name: supplier.name, id: supplier.id })),
    summary: {
      requestedQuantity: demandQuantity,
      unit: demand.unit || '',
      eligibleCount: matches.length,
      excludedCount: excluded.length,
      totalAvailableCapacity: Number(totalAvailableCapacity.toFixed(2)),
      fullyCoverable: Boolean(allocationPlan),
      coverageReason,
      scoring: 'Rule-based feasibility filtering and weighted ranking; not a trained AI model.',
    },
    allocationPlan,
  };
}

module.exports = { matchSuppliers, buildAllocationPlan, qualityMismatches, normalizeText, haversineKm };
