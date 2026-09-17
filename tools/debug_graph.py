import json

d = json.load(open('maps/puri_indah.json'))
nodes = {int(k): tuple(v) for k, v in d['nodes'].items()}
adj = {}
for r in d['roads']:
    for a, b in zip(r['points'], r['points'][1:]):
        adj.setdefault(a, set()).add(b)
        adj.setdefault(b, set()).add(a)

start = max(adj, key=lambda n: len(adj[n]))
seen = {start}
stack = [start]
while stack:
    u = stack.pop()
    for v in adj.get(u, ()):
        if v not in seen:
            seen.add(v)
            stack.append(v)
print('total nodes with edges:', len(adj), 'largest component:', len(seen))
sx = min(seen, key=lambda n: nodes[n][0])
gx = max(seen, key=lambda n: nodes[n][0])
print('west node', sx, nodes[sx], 'east node', gx, nodes[gx])
