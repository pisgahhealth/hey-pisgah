"""Speaker reality check: cosine of every clip to the owner's enrolment, group statistics, a two-cluster split and median pitch."""
import json
import sys
import wave

import numpy as np


def pitch(path):
    with wave.open(path, "rb") as w:
        r = w.getframerate()
        x = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768.0
    f, hop = int(0.04 * r), int(0.01 * r)
    e = np.array([np.sqrt(np.mean(x[i:i + f] ** 2)) for i in range(0, len(x) - f, hop)])
    if not len(e):
        return None
    th = np.percentile(e, 70)
    out = []
    for k, i in enumerate(range(0, len(x) - f, hop)):
        if e[k] < th:
            continue
        s = x[i:i + f] - x[i:i + f].mean()
        ac = np.correlate(s, s, "full")[f - 1:]
        lo, hi = int(r / 400), int(r / 70)
        if ac[0] <= 0:
            continue
        j = lo + int(np.argmax(ac[lo:hi]))
        if ac[j] / ac[0] > 0.45:
            out.append(r / j)
    return round(float(np.median(out)), 1) if len(out) >= 5 else None


def main():
    emb, plan, clips = json.load(open(sys.argv[1])), json.load(open(sys.argv[2])), sys.argv[3]
    who = {c["id"]: c["who"] for c in plan}
    E = {k: np.array(v["embedding"]) for k, v in emb["clips"].items()}
    t = sum(E[f"E{i}"] for i in (1, 2, 3)); t /= np.linalg.norm(t)
    ids = sorted(E)
    rows = {i: {"who": who[i], "cos_owner": round(float(E[i] @ t), 4), "pitch_hz": pitch(f"{clips}/{i}.wav"),
                "win_cos_owner": [round(float(np.array(w) @ t), 3) for w in emb["clips"][i]["windows"]]} for i in ids}
    groups = {}
    for i in ids:
        if not i.startswith("E"):
            groups.setdefault(who[i], []).append(i)
    M = np.array([E[i] for i in ids]); C = M @ M.T
    def mean_between(a, b):
        v = [C[ids.index(x), ids.index(y)] for x in a for y in b if x != y]
        return round(float(np.mean(v)), 4)
    stats = {g: {"n": len(v), "cos_owner_median": round(float(np.median([rows[i]["cos_owner"] for i in v])), 4),
                 "cos_owner_min": min(rows[i]["cos_owner"] for i in v), "pitch_median": float(np.median([rows[i]["pitch_hz"] for i in v if rows[i]["pitch_hz"]])),
                 "mean_cos_to_S_lines": mean_between(v, groups["S"]), "mean_cos_within": mean_between(v, v)} for g, v in groups.items()}
    # Average-linkage clustering on cosine distance, cut at two clusters, to see whether any group falls apart from the owner's.
    clusters = [[k] for k in range(len(ids))]
    while len(clusters) > 2:
        best, pair = -9, None
        for a in range(len(clusters)):
            for b in range(a + 1, len(clusters)):
                s = float(np.mean(C[np.ix_(clusters[a], clusters[b])]))
                if s > best:
                    best, pair = s, (a, b)
        a, b = pair
        clusters[a] += clusters[b]; del clusters[b]
        if len(clusters) == 2:
            last_merge = best
    two = [sorted(ids[k] for k in c) for c in sorted(clusters, key=len)]
    json.dump({"model": emb["model"], "clips": rows, "groups": stats, "two_clusters": two,
               "two_cluster_between_cos": round(float(np.mean(C[np.ix_(clusters[0], clusters[1])])), 4)}, open(sys.argv[4], "w"), indent=1)


if __name__ == "__main__":
    main()
