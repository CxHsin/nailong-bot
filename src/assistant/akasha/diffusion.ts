// Ported from akashic-agent 94027a5c, MIT, Copyright (c) 2026 kachofugetsu09.
// Full license notice is in ./LICENSE.
import type { DiffusionResult, WeightedNodes } from "./model.js";
import { fsum } from "./numeric.js";

export interface TransitionGraph {
  max_nodes: number;
  transitions(node_id: number, event: number): [Array<[number, number, number]>, number];
}

class IndexedMaxHeap {
  nodes: number[] = [];
  private position: number[];
  constructor(capacity: number, private residual: Float64Array) { this.position = Array(capacity).fill(-1); }
  private higher(first: number, second: number): boolean {
    return this.residual[first]! > this.residual[second]! || (this.residual[first] === this.residual[second] && first < second);
  }
  update(node: number): void {
    let position = this.position[node]!;
    if (position < 0) { position = this.nodes.length; this.nodes.push(node); this.position[node] = position; }
    while (position > 0) {
      const parent = (position - 1) >>> 1, parentNode = this.nodes[parent]!;
      if (!this.higher(node, parentNode)) break;
      this.nodes[position] = parentNode; this.position[parentNode] = position; position = parent;
    }
    this.nodes[position] = node; this.position[node] = position;
  }
  pop(): number {
    if (!this.nodes.length) throw new Error("pop from empty residual heap");
    const root = this.nodes[0]!, last = this.nodes.pop()!;
    this.position[root] = -1;
    if (!this.nodes.length) return root;
    let position = 0;
    while (true) {
      const left = position * 2 + 1;
      if (left >= this.nodes.length) break;
      const right = left + 1;
      const child = right < this.nodes.length && this.higher(this.nodes[right]!, this.nodes[left]!) ? right : left;
      const childNode = this.nodes[child]!;
      if (!this.higher(childNode, last)) break;
      this.nodes[position] = childNode; this.position[childNode] = position; position = child;
    }
    this.nodes[position] = last; this.position[last] = position;
    return root;
  }
  stable_nodes(): number[] { return [...this.nodes].sort((first, second) => first - second); }
}

export function residual_push(graph: TransitionGraph, seed: WeightedNodes, event: number,
  options: { restart: number; tolerance: number; capture_paths: boolean }): DiffusionResult {
  if (!seed.length) return { reserve: new Float64Array(graph.max_nodes), active_nodes: new Int32Array(), pushes: 0,
    residual_l1: 0, parent_node: null, parent_edge: null };
  const residual = new Float64Array(graph.max_nodes), reserve = new Float64Array(graph.max_nodes);
  const heap = new IndexedMaxHeap(graph.max_nodes, residual);
  for (const [node, value] of seed) { residual[node] = value; heap.update(node); }
  let residualTotal = fsum(seed.map(([, value]) => value)), pushes = 0;
  const parentNode = options.capture_paths ? new Int32Array(graph.max_nodes).fill(-1) : null;
  const parentEdge = options.capture_paths ? new Int32Array(graph.max_nodes).fill(-1) : null;
  const parentMass = options.capture_paths ? new Float64Array(graph.max_nodes) : null;
  while (true) {
    if (residualTotal <= options.tolerance) {
      residualTotal = fsum(heap.stable_nodes().map(node => residual[node]!));
      if (residualTotal <= options.tolerance) break;
    }
    if (!heap.nodes.length) throw new Error("positive residual mass has no heap entry");
    const node = heap.pop(), value = residual[node]!;
    residual[node] = 0; residualTotal -= value;
    reserve[node] = reserve[node]! + options.restart * value;
    const propagated = (1 - options.restart) * value;
    const [transitions, unspread] = graph.transitions(node, event);
    for (const [target, probability, edge] of transitions) {
      const addition = propagated * probability;
      if (addition !== 0) {
        residual[target] = residual[target]! + addition; heap.update(target); residualTotal += addition;
        if (parentNode && parentEdge && parentMass && addition > parentMass[target]!) {
          parentMass[target] = addition; parentNode[target] = node; parentEdge[target] = edge;
        }
      }
    }
    for (const [target, probability] of seed) {
      const addition = propagated * unspread * probability;
      if (addition !== 0) { residual[target] = residual[target]! + addition; heap.update(target); residualTotal += addition; }
    }
    pushes++;
    if (pushes % 4096 === 0) residualTotal = fsum(heap.stable_nodes().map(node => residual[node]!));
  }
  return { reserve, active_nodes: Int32Array.from([...reserve.keys()].filter(node => reserve[node]! > 0)),
    pushes, residual_l1: residualTotal, parent_node: parentNode, parent_edge: parentEdge };
}
