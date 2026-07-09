/** Disjoint-set union over indices 0..n-1, with path compression. */

export interface UnionFind {
  find(i: number): number;
  join(i: number, j: number): void;
}

export function unionFind(n: number): UnionFind {
  const parent = Array.from({ length: n }, (_, i) => i);
  // Iterative find: recursion could overflow the stack on 10⁵+ buildings.
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    while (parent[i] !== root) {
      const next = parent[i];
      parent[i] = root;
      i = next;
    }
    return root;
  };
  const join = (i: number, j: number) => {
    parent[find(i)] = find(j);
  };
  return { find, join };
}
