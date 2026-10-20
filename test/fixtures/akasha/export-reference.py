"""Export deterministic reference data from the pinned, unmodified Akasha core.

Development-only; the application must not start this Python program in production.
Requires numpy==2.5.4 and jieba==0.42.1 under Python 3.12.
"""
from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
import math
import platform
import os
import subprocess
import sys
from array import array
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace


PIN = "94027a5cce9fc494f20bb7931fddf26f1e15e8df"
ROOT = Path(os.environ["AKASHA_REFERENCE_ROOT"]).resolve()
sys.path.insert(0, str(ROOT))

import jieba
import numpy as np

from plugins.akasha.application.cycle import MemoryCycle
from plugins.akasha.domain.features import BurstAwareFeaturePool, FeaturePool, _sparsemax, _tail_surprisal
from plugins.akasha.domain.graph import DynamicMemoryGraph, HubRecord, RetrievalState
from plugins.akasha.domain.model import (
    ContextState, MemoryConfig, PlasticityResult, SeedEvidence,
    Turn, TurnFeedback,
)
from plugins.akasha.domain.readout import PatternCompletion, RecallCapture, RecallItem, read_pattern_completion
from plugins.akasha.infrastructure.lexical import tokenize


def plain(value):
    if dataclasses.is_dataclass(value):
        return {field.name: plain(getattr(value, field.name)) for field in dataclasses.fields(value)}
    if isinstance(value, np.ndarray):
        return plain(value.tolist())
    if isinstance(value, np.generic):
        return plain(value.item())
    if isinstance(value, array):
        return list(value)
    if isinstance(value, dict):
        return {str(key): plain(item) for key, item in value.items()}
    if isinstance(value, (set, frozenset)):
        return [plain(item) for item in sorted(value)]
    if isinstance(value, (tuple, list)):
        return [plain(item) for item in value]
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("fixture contains a non-finite value")
    return value


EDGE_FIELDS = (
    "source", "target", "kind", "weight", "last_updated", "created_event",
    "observed_credit", "recurrent_credit", "resource", "plasticity_threshold",
    "last_stimulated_seconds", "last_support_seconds", "support_credit", "independent_credit",
)


def graph_snapshot(graph):
    return {
        "turn_count": graph.turn_count,
        "max_nodes": graph.max_nodes,
        "columns": {name: plain(getattr(graph, name)) for name in EDGE_FIELDS},
        "bidirectional": list(graph.bidirectional),
        "adjacency": graph.adjacency,
        "hubs": plain(graph.hubs),
        "hub_members": {str(node): list(edges) for node, edges in graph.hub_members.items()},
        "temporal_lookup": [[*key, value] for key, value in sorted(graph.temporal_lookup.items())],
        "state": plain(graph.capture_retrieval_state()),
    }


def cycle_snapshot(cycle):
    return plain({
        "config": cycle.config,
        "turns": cycle.turns,
        "graph": graph_snapshot(cycle.graph),
        "context": cycle.context,
        "events": cycle.events,
        "evidence": cycle.evidence,
        "recalls": cycle.recalls,
        "burst_members": cycle.burst_members,
        "inhibited_nodes": cycle.inhibited_nodes,
    })


def decode_turn(row):
    fields = dict(row)
    for name in ("user_dense", "assistant_dense"):
        fields[name] = None if fields[name] is None else np.asarray(fields[name], dtype=np.float32)
    for name in ("user_terms", "assistant_terms"):
        fields[name] = tuple(tuple(item) for item in fields[name])
    feedback = fields.pop("feedback")
    fields["feedback"] = TurnFeedback(
        remember_nodes=tuple(feedback["remember_nodes"]),
        forget_nodes=tuple(feedback["forget_nodes"]),
        remember_boost=feedback["remember_boost"],
    )
    return Turn(**fields)


def decode_evidence(row):
    return SeedEvidence(
        seed=tuple(tuple(item) for item in row["seed"]),
        channels={name: frozenset(nodes) for name, nodes in row["channels"].items()},
        time_prior=row["time_prior"], continuation=row["continuation"], surprise=row["surprise"],
    )


def restore_cycle(snapshot):
    # Rebuild domain objects from an actual JSON round-trip, not a live-object copy.
    state = json.loads(json.dumps(snapshot, ensure_ascii=False, allow_nan=False))
    config = MemoryConfig(**state["config"])
    saved = state["graph"]
    graph = DynamicMemoryGraph(saved["turn_count"], config)
    for name in EDGE_FIELDS:
        setattr(graph, name, array(getattr(graph, name).typecode, saved["columns"][name]))
    graph.bidirectional = saved["bidirectional"]
    graph.adjacency = saved["adjacency"]
    graph.hubs = [HubRecord(**{**hub, "member_edge_ids": tuple(hub["member_edge_ids"])}) for hub in saved["hubs"]]
    graph.hub_members = {int(node): edges for node, edges in saved["hub_members"].items()}
    graph.temporal_lookup = {tuple(row[:3]): row[3] for row in saved["temporal_lookup"]}
    retrieval = saved["state"]
    for name in ("last_external_seed_seconds", "current_external"):
        retrieval[name] = tuple(tuple(item) for item in retrieval[name])
    graph.apply_retrieval_state(RetrievalState(**retrieval))
    context = state["context"]
    if context is None:
        return MemoryCycle(config)
    decoded_context = ContextState(
        members=tuple(tuple(item) for item in context["members"]),
        dense=None if context["dense"] is None else np.asarray(context["dense"], dtype=np.float64),
        terms=tuple(tuple(item) for item in context["terms"]),
    )
    events = [PlasticityResult(**{**row, "integrated": tuple(tuple(item) for item in row["integrated"])}) for row in state["events"]]
    recalls = []
    for row in state["recalls"]:
        completion = row["completion"]
        items = tuple(RecallItem(**{**item, "sources": tuple(item["sources"]), "basin_ids": tuple(item["basin_ids"])}) for item in completion["items"])
        recalls.append(RecallCapture(query_node_id=row["query_node_id"], completion=PatternCompletion(**{**completion, "items": items})))
    return MemoryCycle.restore(
        config=config, turns=[decode_turn(row) for row in state["turns"]], graph=graph,
        context=decoded_context, events=events,
        evidence=[decode_evidence(row) for row in state["evidence"]],
        recalls=recalls, burst_members=state["burst_members"],
    )


def make_turn(index, user, answer, user_vector, answer_vector, *, session="session-a", gap=1.0, feedback=TurnFeedback()):
    started = datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(minutes=index)
    return Turn(
        node_id=index, turn_id=f"user-{index}::assistant-{index}", session_key=session,
        user_seq=index * 2, user_message_id=f"user-{index}", assistant_message_id=f"assistant-{index}",
        started_at=started.isoformat(), committed_at=(started + timedelta(seconds=1)).isoformat(),
        user_text=user, assistant_text=answer,
        user_dense=None if user_vector is None else np.asarray(user_vector, dtype=np.float32),
        assistant_dense=None if answer_vector is None else np.asarray(answer_vector, dtype=np.float32),
        user_terms=tuple(sorted(tokenize(user).items())), assistant_terms=tuple(sorted(tokenize(answer).items())),
        inter_gap_seconds=None if index == 0 else gap, feedback=feedback,
    )


def cue_of(turn):
    return dataclasses.replace(turn, assistant_text="", assistant_dense=None, assistant_terms=())


def run_case(name, turns, probes):
    cycle = MemoryCycle()
    steps = []
    for turn in turns:
        before = cycle_snapshot(cycle)
        ticket = cycle.retrieve(cue_of(turn), capture_paths=True)
        assert cycle_snapshot(cycle) == before, "retrieve changed committed state"
        commit = cycle.commit(turn, ticket)
        steps.append({"input": plain(turn), "ticket": plain(ticket), "commit": plain(commit), "state": cycle_snapshot(cycle)})
    final = cycle_snapshot(cycle)
    restored = restore_cycle(final)
    assert cycle_snapshot(restored) == final, "restore changed serialized domain state"
    queries = []
    for probe in probes:
        original_ticket = cycle.retrieve(probe, capture_paths=True)
        restored_ticket = restored.retrieve(probe, capture_paths=True)
        # Rebuilt vs appendable feature matrices can choose distinct BLAS paths;
        # compare the observable identity exactly and numerical values separately downstream.
        assert [item.node_id for item in original_ticket.completion.items] == [item.node_id for item in restored_ticket.completion.items]
        assert cycle_snapshot(cycle) == final
        queries.append({"input": plain(probe), "ticket": plain(original_ticket), "restored_ticket": plain(restored_ticket)})
    return {"name": name, "steps": steps, "queries": queries, "state": final}


def export():
    actual = subprocess.check_output(["git", "-C", str(ROOT), "rev-parse", "HEAD"], text=True).strip()
    if actual != PIN:
        raise RuntimeError(f"wrong upstream commit: {actual}")
    e1, e2, e3 = [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]
    mixed = [0.8, 0.6, 0.0]
    rows = [
        ("周六去杭州看西湖，住湖滨酒店", "已经记录杭州西湖与湖滨酒店", e1, mixed, "travel", 1.0),
        ("酒店附近有素食餐厅", "湖滨酒店旁边可以吃素食", mixed, e1, "travel", 2.0),
        ("开发项目使用 TypeScript 与 SQLite", "项目技术栈已记录", e2, e2, "coding", 300.0),
        ("周末旅行坐高铁出发", "去杭州的高铁安排", mixed, e1, "travel", 3.0),
        ("测试模型连接耗时", "连接测试使用合成文本", e3, e3, "coding", 600.0),
        ("西湖旅行还需要什么", "准备身份证与酒店地址", e1, mixed, "travel", 4.0),
        ("查询数据库事务", "SQLite 支持事务", e2, e2, "coding", 3600.0),
        ("湖滨吃饭安排", "素食餐厅在酒店附近", mixed, mixed, "travel", 5.0),
    ]
    turns = [make_turn(index, user, answer, uv, av, session=session, gap=gap) for index, (user, answer, uv, av, session, gap) in enumerate(rows)]
    probes = [
        cue_of(make_turn(len(turns), "杭州住宿附近的吃饭地点", "", mixed, None, session="fresh", gap=10.0)),
        cue_of(make_turn(len(turns), "数据库事务", "", e2, None, session="fresh", gap=86400.0)),
        cue_of(make_turn(len(turns), "那边呢", "", mixed, None, session="travel", gap=1.0)),
    ]
    chinese = run_case("chinese-association-and-real-gaps", turns, probes)
    tie_turns = [
        make_turn(0, "alpha beta", "beta alpha", e1, e1),
        make_turn(1, "alpha beta", "beta alpha", e1, e1, session="b", gap=1.0),
        make_turn(2, "gamma delta", "delta gamma", e2, e2, session="c", gap=20.0),
        make_turn(3, "alpha epsilon", "epsilon alpha", mixed, mixed, session="d", gap=2.0),
        make_turn(4, "forget alpha", "acknowledged", mixed, e1, session="e", gap=200.0, feedback=TurnFeedback(forget_nodes=(0,))),
        make_turn(5, "remember beta", "acknowledged", e1, mixed, session="f", gap=3.0, feedback=TurnFeedback(remember_nodes=(0,), remember_boost=2.0)),
    ]
    ties = run_case("ties-feedback-and-restoration", tie_turns, [cue_of(make_turn(6, "alpha beta", "", e1, None, session="probe", gap=10.0))])
    # Exercise the >256 mixed float32-matrix/float64-context branch independently
    # of graph growth. Its output is fixed by upstream, not recomputed in TS tests.
    boundary_turns = [make_turn(index, "alpha beta" if index % 2 else "gamma alpha", "beta gamma", e1 if index % 3 else mixed, e2, session=f"s-{index}") for index in range(260)]
    feature_pool = FeaturePool(boundary_turns)
    cue = np.asarray([0.6, 0.8, 0.0], dtype=np.float32)
    mixed_context = feature_pool.build_context(((0, 1.0), (1, 1.0), (2, 1.0)))
    feature_boundaries = {
        "description": "260 rows cross the upstream >256 mixed-precision block boundary",
        "inputs": plain(boundary_turns),
        "cue": plain(cue),
        "float32_scores": plain(feature_pool.dense_scores(cue, 260)),
        "float64_scores": plain(feature_pool.dense_scores(cue.astype(np.float64), 260)),
        "context": plain(mixed_context),
        "context_scores": plain(feature_pool.dense_scores(mixed_context.dense, 260)),
        "bm25": plain(feature_pool.bm25_scores({"alpha": 0.5, "beta": 0.5}, 260)),
    }
    stale_cycle = MemoryCycle()
    for turn in tie_turns[:4]:
        stale_cycle.commit(turn, stale_cycle.retrieve(cue_of(turn), capture_paths=True))
    waiting = make_turn(4, "alpha beta pending", "pending answer", e1, mixed, session="pending", gap=9.0)
    stale_ticket = stale_cycle.retrieve(cue_of(waiting), capture_paths=True)
    concurrent = make_turn(4, "gamma delta concurrent", "concurrent answer", e2, e2, session="concurrent", gap=7.0)
    stale_cycle.commit(concurrent, stale_cycle.retrieve(cue_of(concurrent), capture_paths=True))
    before_stale = cycle_snapshot(stale_cycle)
    recomputed = stale_cycle.commit(waiting, stale_ticket)
    assert recomputed.retrieval_recomputed and stale_cycle.state_version == 6
    stale = {"waiting": plain(waiting), "ticket": plain(stale_ticket), "concurrent": plain(concurrent), "before_commit": before_stale, "commit": plain(recomputed), "after_commit": cycle_snapshot(stale_cycle)}
    readout_cases = []
    for scenario in (chinese, ties):
        restored = restore_cycle(scenario["state"])
        probe = decode_turn(scenario["queries"][0]["input"])
        ticket = restored.retrieve(probe, capture_paths=True)
        restored.graph.grow_turn_capacity(ticket.prepared_turn_capacity)
        restored.graph.apply_retrieval_state(ticket.prepared_state)
        pool = BurstAwareFeaturePool([*restored.turns, probe])
        for name, dependence, excluded, visible in (
            ("context-only", 1.0, frozenset(), ()),
            ("address-only", 0.0, frozenset(), ()),
            ("inhibited-and-visible", 0.0, frozenset((0,)), (1,)),
        ):
            options = dict(graph=restored.graph, pool=pool, query=probe, context=ticket.burst_decision.context,
                precomputed_fields=ticket.burst_decision.fields, evidence=ticket.evidence, diffusion=ticket.diffusion,
                historical_surprise=np.asarray([item.surprise for item in restored.evidence], dtype=np.float64),
                config=restored.config, context_dependence=dependence, visible_nodes=visible,
                burst_continued=ticket.burst_decision.continued, inhibited_nodes=excluded)
            output = read_pattern_completion(**options)
            without_fields = read_pattern_completion(**{**options, "precomputed_fields": None})
            readout_cases.append({"name": f"{scenario['name']}-{name}", "graph": graph_snapshot(restored.graph),
                "turns": plain([*restored.turns, probe]),
                "options": plain({key: value for key, value in options.items() if key not in {"graph", "pool"}}),
                "output": plain(output), "without_precomputed": plain(without_fields)})
    source_documents = [
        {"id": "source-travel", "text": "我周末会去杭州看湖", "dense": e1},
        {"id": "source-code", "text": "工作环境是 TypeScript", "dense": e2},
        {"id": "source-food", "text": "我偏爱素食餐厅", "dense": mixed},
    ]
    source_pool = FeaturePool([SimpleNamespace(user_dense=np.asarray(row["dense"], dtype=np.float32), assistant_dense=None,
        user_terms=tuple(sorted(tokenize(row["text"]).items())), assistant_terms=(), inter_gap_seconds=None) for row in source_documents])
    source_queries = []
    for text, vector in (("明天游玩安排", e1), ("TypeScript", None)):
        query_terms = dict(tokenize(text))
        total = sum(query_terms.values())
        query_terms = {term: value / total for term, value in query_terms.items()}
        dense_field = source_pool.dense_scores(None if vector is None else np.asarray(vector, dtype=np.float32), len(source_documents))
        bm25_field = source_pool.bm25_scores(query_terms, len(source_documents))
        selected = _sparsemax(_tail_surprisal(dense_field) + _tail_surprisal(bm25_field))
        results = [{"id": source_documents[node]["id"], "score": score} for node, score in sorted(selected, key=lambda row: (-row[1], row[0]))]
        source_queries.append({"text": text, "dense": vector, "results": results})
    lexical_texts = [
        "南京市长江大桥", "小明硕士毕业于中国科学院计算所，后在日本京都大学深造", "杭州西湖湖滨酒店和素食餐厅", "TypeScript SQLITE foo_bar123 FOO foo 你好你好", "研究生命起源", "结巴分词中文搜索模式测试", "龘靐齉爩，𠀀扩展字符 A1 a B c99", "重复 重复重复 alpha alpha",
    ]
    source_paths = [
        "plugins/akasha/domain/model.py", "plugins/akasha/domain/features.py", "plugins/akasha/domain/graph.py",
        "plugins/akasha/domain/diffusion.py", "plugins/akasha/domain/readout.py", "plugins/akasha/application/cycle.py", "plugins/akasha/infrastructure/lexical.py",
    ]
    dictionary = Path(jieba.__file__).with_name("dict.txt")
    return {
        "metadata": {
            "upstream_commit": PIN, "python": platform.python_version(), "numpy": np.__version__, "jieba": jieba.__version__,
            "jieba_dictionary_sha256": hashlib.sha256(dictionary.read_bytes()).hexdigest(),
            "source_sha256": {path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest() for path in source_paths},
            "tolerance": {"float32_derived_absolute": 2e-6, "float64_absolute": 1e-10, "relative": 1e-8, "discrete_identity": "exact; no tolerance for ranking, node IDs, topology, sources, or learned qualification"},
            "license": "MIT; Copyright (c) 2026 kachofugetsu09",
        },
        "tokenization": [{"text": text, "terms": plain(tuple(sorted(tokenize(text).items())))} for text in lexical_texts],
        "numeric_boundaries": {
            "erfc": [{"input": value, "output": math.erfc(value)} for value in (-10, -3, -1, -0.1, 0, 0.1, 0.5, 1, 1.224744871391589, 1.5, 2, 3, 5, 10, 20, 27)],
            "sparsemax": [{"input": values, "output": plain(_sparsemax(np.asarray(values, dtype=np.float64)))} for values in ([1, 1, 1], [1, 0], [1, 1e-16], [0.5, 0.5], [0, 0], [-1, -1, -1])],
            "tail_surprisal": [{"input": values, "output": plain(_tail_surprisal(np.asarray(values, dtype=np.float64)))} for values in ([0, 0, 0], [1, 1, 0], [-1, 0, 1], [0.5, 0.5, 0.5000000000000001])],
        },
        "feature_boundaries": feature_boundaries,
        "stale_ticket": stale,
        "readout": readout_cases,
        "source_only": {"documents": source_documents, "queries": source_queries,
            "note": "Host document adapter over original FeaturePool mathematical fields; no Turn closure or graph commit"},
        "cases": [chinese, ties],
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path(__file__).with_name("upstream-golden.json"))
    arguments = parser.parse_args()
    fixture = export()
    arguments.output.write_text(json.dumps(fixture, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps({"path": str(arguments.output), "cases": len(fixture["cases"]), "steps": sum(len(case["steps"]) for case in fixture["cases"]), "queries": sum(len(case["queries"]) for case in fixture["cases"]), "bytes": arguments.output.stat().st_size, "numpy": np.__version__, "jieba": jieba.__version__}))
