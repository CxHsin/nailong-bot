// Ported from akashic-agent 94027a5c, MIT, Copyright (c) 2026 kachofugetsu09.
// Full license notice is in ./LICENSE.
import type { Vector, WeightedNodes } from "./model.js";

/** NumPy's contiguous float64 pairwise reduction (eight lanes, block size 128). */
export function numpy_sum(values: ArrayLike<number>, start = 0, length = values.length - start): number {
  if (length < 8) {
    let result = -0;
    for (let index = start; index < start + length; index++) result += values[index]!;
    return result;
  }
  if (length <= 128) {
    const lanes = Array.from({ length: 8 }, (_, lane) => values[start + lane]!);
    let offset = 8;
    for (; offset < length - length % 8; offset += 8)
      for (let lane = 0; lane < 8; lane++) lanes[lane] = lanes[lane]! + values[start + offset + lane]!;
    let result = ((lanes[0]! + lanes[1]!) + (lanes[2]! + lanes[3]!)) + ((lanes[4]! + lanes[5]!) + (lanes[6]! + lanes[7]!));
    for (; offset < length; offset++) result += values[start + offset]!;
    return result;
  }
  const half = Math.floor(length / 2 / 8) * 8;
  return numpy_sum(values, start, half) + numpy_sum(values, start + half, length - half);
}

/** Complementary error function via converged incomplete-gamma series/fraction. */
export function erfc(value: number): number {
  if (value < 0) return 2 - erfc(-value);
  if (value === 0) return 1;
  if (!Number.isFinite(value)) return value === Infinity ? 0 : Number.NaN;
  if (value > 27.3) return 0;
  const x = value * value, factor = Math.exp(-x + 0.5 * Math.log(x) - 0.57236494292470008707);
  if (x < 1.5) {
    let sum = 2, term = 2, denominator = 0.5;
    for (let iteration = 1; iteration <= 1000; iteration++) {
      denominator++; term *= x / denominator; sum += term;
      if (Math.abs(term) <= Math.abs(sum) * Number.EPSILON) break;
    }
    return 1 - sum * factor;
  }
  let b = x + 0.5, c = 1e300, d = 1 / b, fraction = d;
  for (let iteration = 1; iteration <= 1000; iteration++) {
    const numerator = -iteration * (iteration - 0.5);
    b += 2; d = numerator * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + numerator / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d; const change = d * c; fraction *= change;
    if (Math.abs(change - 1) <= Number.EPSILON) break;
  }
  return factor * fraction;
}

/** Expansion summation preserves the deliberate math.fsum boundaries upstream. */
export function fsum(values: Iterable<number>): number {
  const partials: number[] = [];
  for (let value of values) {
    let index = 0;
    for (let partial of partials) {
      if (Math.abs(value) < Math.abs(partial)) [value, partial] = [partial, value];
      const high = value + partial;
      const low = partial - (high - value);
      if (low !== 0) partials[index++] = low;
      value = high;
    }
    partials.length = index;
    partials.push(value);
  }
  let total = 0;
  for (const value of partials) total += value;
  return total;
}

export function dot(first: ArrayLike<number>, second: ArrayLike<number>, float32 = false): number {
  if (first.length !== second.length) throw new Error("dense vectors must share one dimension");
  let value = 0;
  for (let index = 0; index < first.length; index++) value += first[index]! * second[index]!;
  return float32 ? Math.fround(value) : value;
}

export function unit(vector: Vector, float32 = vector instanceof Float32Array): Float32Array | Float64Array {
  const norm = float32 ? Math.fround(Math.sqrt(dot(vector, vector, true))) : Math.sqrt(dot(vector, vector));
  if (!Number.isFinite(norm) || norm === 0) throw new Error("dense vector must be finite and non-zero");
  return float32 ? Float32Array.from(vector, value => value / norm) : Float64Array.from(vector, value => value / norm);
}

export function normalize_pairs_by_id(values: WeightedNodes): Array<[number, number]> {
  const ordered = [...values].sort(([first], [second]) => first - second);
  const total = fsum(ordered.filter(([, value]) => value > 0).map(([, value]) => value));
  if (total === 0) throw new Error("context members must contain positive mass");
  return ordered.filter(([, value]) => value > 0).map(([node, value]) => [node, value / total]);
}

export function sigmoid(value: number): number {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exponent = Math.exp(value);
  return exponent / (1 + exponent);
}

export function sparsemax(logits: ArrayLike<number>): Array<[number, number]> {
  const values = Array.from(logits);
  if (!values.length || !values.some(value => value !== 0)) return [];
  const order = values.map((_, index) => index).sort((first, second) => values[second]! - values[first]! || first - second);
  let cumulative = 0, supportSize = 0, supportTotal = 0;
  for (let index = 0; index < order.length; index++) {
    cumulative += values[order[index]!]!;
    if (1 + (index + 1) * values[order[index]!]! > cumulative) {
      supportSize = index + 1; supportTotal = cumulative;
    }
  }
  const threshold = (supportTotal - 1) / supportSize;
  return order.slice(0, supportSize).sort((first, second) => first - second)
    .filter(node => values[node]! > threshold).map(node => [node, values[node]! - threshold]);
}

export function tail_surprisal(scores: ArrayLike<number>): Float64Array {
  const values = Array.from(scores);
  if (!values.length || !values.some(value => value !== 0)) return new Float64Array(values.length);
  const ordered = [...values].sort((first, second) => first - second);
  return Float64Array.from(values, value => {
    let low = 0, high = ordered.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (ordered[middle]! < value) low = middle + 1; else high = middle;
    }
    return -Math.log((values.length - low) / values.length);
  });
}

export function entmax(logits: ArrayLike<number>, alpha = 1.5): Array<[number, number]> {
  const values = Array.from(logits);
  if (!values.length) return [];
  const exponent = 1 / (alpha - 1);
  let lower = Math.min(...values) - exponent, upper = Math.max(...values);
  for (let step = 0; step < 80; step++) {
    const threshold = (lower + upper) / 2;
    const total = numpy_sum(values.map(value => Math.max((alpha - 1) * (value - threshold), 0) ** exponent));
    if (total > 1) lower = threshold; else upper = threshold;
  }
  const weights = values.map(value => Math.max((alpha - 1) * (value - upper), 0) ** exponent);
  const total = numpy_sum(weights);
  return weights.flatMap((value, node) => value > 0 ? [[node, value / total] as [number, number]] : []);
}

export function effective_support(values: ArrayLike<number>): number {
  const positive = Array.from(values).filter(value => value > 0);
  if (!positive.length) return 0;
  const total = fsum(positive);
  return Math.exp(-fsum(positive.map(value => { const normalized = value / total; return normalized * Math.log(normalized); })));
}

export function binary_entropy(probability: number): number {
  if (probability <= 0 || probability >= 1) return 0;
  return -(probability * Math.log(probability) + (1 - probability) * Math.log(1 - probability)) / Math.log(2);
}
