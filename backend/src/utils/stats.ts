export const mean = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;

export const stdDev = (values: number[]): number => {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1));
};

export const round = (value: number, decimals = 4): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/**
 * Wilson score interval — preferred over the normal approximation because
 * fairness tests frequently involve small subgroup sample sizes.
 */
export const wilsonInterval = (
  successes: number,
  total: number,
  z = 1.96,
): { low: number; high: number } => {
  if (total === 0) return { low: 0, high: 0 };
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return {
    low: clamp((centre - spread) / denominator, 0, 1),
    high: clamp((centre + spread) / denominator, 0, 1),
  };
};

/** Two-proportion z-test; returns the absolute z statistic. */
export const twoProportionZ = (
  successesA: number,
  totalA: number,
  successesB: number,
  totalB: number,
): number => {
  if (totalA === 0 || totalB === 0) return 0;
  const pA = successesA / totalA;
  const pB = successesB / totalB;
  const pooled = (successesA + successesB) / (totalA + totalB);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / totalA + 1 / totalB));
  if (se === 0) return 0;
  return Math.abs((pA - pB) / se);
};

/** Shannon entropy of a categorical distribution, in bits. */
export const entropy = (counts: number[]): number => {
  const total = counts.reduce((sum, c) => sum + c, 0);
  if (total === 0) return 0;
  return -counts
    .filter((c) => c > 0)
    .reduce((sum, c) => {
      const p = c / total;
      return sum + p * Math.log2(p);
    }, 0);
};

export const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = clamp(Math.floor((p / 100) * (sorted.length - 1)), 0, sorted.length - 1);
  return sorted[index] as number;
};
