#!/usr/bin/env python3
"""CookLLM NInfer v3 GGUF conversion wrapper.

Bridges CookLLM's Rust backend and the upstream/KVMem `tools.convert` package:
- Ensures embedded Python isolated mode can import `tools.*`.
- Supports multi-shard split GGUFs (both `-00001-of-0000N` and `_00001_of_0000N`).
- Optionally reconstructs missing HF config/tokenizer/chat_template files from GGUF KV.
- Stages output inside a temporary sibling folder and atomically moves finished files.
- Emits `[COOKLLM_PROGRESS] {...}` JSON lines for deterministic UI progress updates.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import tempfile
import traceback
from pathlib import Path
from typing import Any

BUNDLE_ROOT = Path(__file__).resolve().parent
if str(BUNDLE_ROOT) not in sys.path:
    sys.path.insert(0, str(BUNDLE_ROOT))


def emit_progress(
    phase: str,
    percent: float,
    message: str,
    *,
    current: int = 0,
    total: int = 0,
) -> None:
    payload = {
        "phase": phase,
        "percent": max(0, min(100, int(round(percent)))),
        "current": current,
        "total": total,
        "message": message,
    }
    print(f"[COOKLLM_PROGRESS] {json.dumps(payload, ensure_ascii=False)}", flush=True)


def _patch_split_regex() -> None:
    """Allow both hyphen and underscore split GGUF names in `tools.convert.sources.gguf`."""
    from tools.convert.sources import gguf as gguf_mod

    gguf_mod.SPLIT_NAME = re.compile(r"(.*)[-_](\d+)[-_]of[-_](\d+)\.gguf", re.IGNORECASE)


def _first_present(kv: dict[str, Any], *keys: str, default: Any = None) -> Any:
    for key in keys:
        if key in kv and kv[key] is not None:
            return kv[key]
    return default


def _reconstruct_config(gguf: Any) -> dict[str, Any]:
    kv = gguf.kv
    arch = str(kv.get("general.architecture", "")).lower()
    if arch not in ("qwen35", "qwen3_5"):
        raise ValueError(f"Unsupported GGUF architecture for Qwen3.5 dense conversion: {arch!r}")

    if "qwen35.expert_count" in kv or "qwen3_5.expert_count" in kv:
        raise ValueError("MoE models (num_experts present) cannot use the dense GGUF recipe")

    prefix = "qwen35" if any(k.startswith("qwen35.") for k in kv) else "qwen3_5"

    def g(suffix: str, default: Any = None) -> Any:
        return _first_present(kv, f"{prefix}.{suffix}", f"qwen35.{suffix}", f"qwen3_5.{suffix}", default=default)

    hidden_size = int(g("embedding_length"))
    intermediate_size = int(g("feed_forward_length"))
    raw_blocks = int(g("block_count"))
    # -mtp GGUFs include the extra MTP layer inside block_count (e.g. 64 text + blk.64.nextn = 65).
    has_mtp_last = raw_blocks > 0 and f"blk.{raw_blocks - 1}.nextn.eh_proj.weight" in gguf.tensors
    num_hidden_layers = raw_blocks - 1 if has_mtp_last else raw_blocks
    num_attention_heads = int(g("attention.head_count"))
    num_key_value_heads = int(g("attention.head_count_kv", num_attention_heads))
    head_dim = int(g("attention.key_length", 256))
    max_pos = int(g("context_length", 262144))
    rms_eps = float(g("attention.layer_norm_rms_epsilon", 1e-6))

    key_heads = int(g("ssm.group_count", 16))
    value_heads = int(g("ssm.time_step_rank"))
    key_head_dim = int(g("ssm.state_size", 128))
    conv_kernel = int(g("ssm.conv_kernel", 4))
    interval = int(g("full_attention_interval", 4))

    vocab_size = int(gguf.tensors["token_embd.weight"].shape[0])
    tied = "output.weight" not in gguf.tensors

    rope_theta = float(g("rope.freq_base", 10_000_000.0))
    rope_dim = int(g("rope.dimension_count", 64))
    partial_rotary = round(rope_dim / max(1, head_dim), 6)
    half_rot = rope_dim // 2
    raw_sections = g("rope.dimension_sections")
    sections = None
    if isinstance(raw_sections, (list, tuple)) and len(raw_sections) >= 3:
        try:
            cand = [int(raw_sections[0]), int(raw_sections[1]), int(raw_sections[2])]
            if all(v > 0 for v in cand) and sum(cand) == half_rot:
                sections = cand
        except (TypeError, ValueError):
            sections = None
    if sections is None:
        if half_rot == 32:
            sections = [11, 11, 10]
        else:
            s0 = half_rot // 3 + (1 if half_rot % 3 > 0 else 0)
            s1 = half_rot // 3 + (1 if half_rot % 3 > 1 else 0)
            s2 = half_rot - s0 - s1
            sections = [s0, s1, s2]

    layer_types = [
        "full_attention" if (i + 1) % interval == 0 else "linear_attention"
        for i in range(num_hidden_layers)
    ]

    cfg: dict[str, Any] = {
        "architectures": ["Qwen3_5ForCausalLM"],
        "model_type": "qwen3_5_text",
        "hidden_size": hidden_size,
        "intermediate_size": intermediate_size,
        "vocab_size": vocab_size,
        "num_hidden_layers": num_hidden_layers,
        "max_position_embeddings": max_pos,
        "tie_word_embeddings": tied,
        "rms_norm_eps": rms_eps,
        "hidden_act": "silu",
        "attention_bias": False,
        "attn_output_gate": True,
        "mamba_ssm_dtype": "float32",
        "layer_types": layer_types,
        "num_attention_heads": num_attention_heads,
        "num_key_value_heads": num_key_value_heads,
        "head_dim": head_dim,
        "linear_num_key_heads": key_heads,
        "linear_key_head_dim": key_head_dim,
        "linear_num_value_heads": value_heads,
        "linear_value_head_dim": key_head_dim,
        "linear_conv_kernel_dim": conv_kernel,
        "rope_parameters": {
            "rope_theta": rope_theta,
            "partial_rotary_factor": partial_rotary,
            "mrope_section": sections,
        },
    }

    if f"blk.{num_hidden_layers}.nextn.eh_proj.weight" in gguf.tensors:
        cfg["mtp_num_hidden_layers"] = 1
        cfg["mtp_use_dedicated_embeddings"] = False

    return cfg


def _reconstruct_tokenizer(gguf: Any) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], str]:
    from tools.convert.resources import KQWEN35_PAD_TOKEN, STD_QWEN_SPLIT_PATTERN

    kv = gguf.kv
    tokens = list(kv.get("tokenizer.ggml.tokens") or [])
    if not tokens:
        raise ValueError("GGUF metadata does not contain tokenizer.ggml.tokens; please provide an auxiliary HF config folder.")

    merges_raw = list(kv.get("tokenizer.ggml.merges") or [])
    token_types = list(kv.get("tokenizer.ggml.token_type") or [])
    eos_id = kv.get("tokenizer.ggml.eos_token_id")
    bos_id = kv.get("tokenizer.ggml.bos_token_id")
    pad_id = kv.get("tokenizer.ggml.padding_token_id")

    # Build contiguous base vocab + added_tokens compatible with token_domain()
    vocab: dict[str, int] = {}
    added_tokens: list[dict[str, Any]] = []
    added_decoder: dict[str, dict[str, Any]] = {}

    for idx, raw_tok in enumerate(tokens):
        tok = str(raw_tok)
        ttype = int(token_types[idx]) if idx < len(token_types) else 1
        # gguf token_type: 1=normal, 2=unknown, 3=control, 4=user_defined, 5=unused, 6=byte
        is_special = ttype in (2, 3)
        is_added = ttype in (3, 4) or (tok.startswith("<|") and tok.endswith("|>"))
        if is_added:
            entry = {
                "id": idx,
                "content": tok,
                "single_word": False,
                "lstrip": False,
                "rstrip": False,
                "normalized": False,
                "special": bool(is_special),
            }
            added_tokens.append(entry)
            added_decoder[str(idx)] = {
                "content": tok,
                "single_word": False,
                "lstrip": False,
                "rstrip": False,
                "normalized": False,
                "special": bool(is_special),
            }
        else:
            vocab[tok] = idx

    # Ensure every ID is represented cleanly; if duplicate token string appeared in base vocab, place in added_tokens.
    if len(vocab) + len(added_tokens) != len(tokens):
        vocab = {}
        added_tokens = []
        added_decoder = {}
        seen: set[str] = set()
        for idx, raw_tok in enumerate(tokens):
            tok = str(raw_tok)
            ttype = int(token_types[idx]) if idx < len(token_types) else 1
            is_special = ttype in (2, 3)
            if tok in seen or ttype in (3, 4) or (tok.startswith("<|") and tok.endswith("|>")):
                added_tokens.append(
                    {
                        "id": idx,
                        "content": tok,
                        "single_word": False,
                        "lstrip": False,
                        "rstrip": False,
                        "normalized": False,
                        "special": bool(is_special),
                    }
                )
                added_decoder[str(idx)] = {
                    "content": tok,
                    "single_word": False,
                    "lstrip": False,
                    "rstrip": False,
                    "normalized": False,
                    "special": bool(is_special),
                }
            else:
                vocab[tok] = idx
                seen.add(tok)

    merges = []
    for item in merges_raw:
        if isinstance(item, str):
            merges.append(item)
        elif isinstance(item, (list, tuple)) and len(item) == 2:
            merges.append(f"{item[0]} {item[1]}")

    tokenizer_json = {
        "version": "1.0",
        "truncation": None,
        "padding": None,
        "added_tokens": added_tokens,
        "normalizer": None,
        "pre_tokenizer": {
            "type": "Sequence",
            "pretokenizers": [
                {
                    "type": "Split",
                    "pattern": {"Regex": STD_QWEN_SPLIT_PATTERN},
                    "behavior": "Isolated",
                    "invert": False,
                },
                {
                    "type": "ByteLevel",
                    "add_prefix_space": False,
                    "trim_offsets": False,
                    "use_regex": False,
                },
            ],
        },
        "post_processor": {
            "type": "ByteLevel",
            "add_prefix_space": False,
            "trim_offsets": False,
            "use_regex": False,
        },
        "decoder": {
            "type": "ByteLevel",
            "add_prefix_space": False,
            "trim_offsets": False,
            "use_regex": False,
        },
        "model": {
            "type": "BPE",
            "dropout": None,
            "unk_token": None,
            "continuing_subword_prefix": "",
            "end_of_word_suffix": "",
            "fuse_unk": False,
            "byte_fallback": False,
            "vocab": vocab,
            "merges": merges,
        },
    }

    eos_token = "<|im_end|>"
    if isinstance(eos_id, int) and 0 <= eos_id < len(tokens):
        eos_token = str(tokens[eos_id])

    tokenizer_config = {
        "add_bos_token": False,
        "add_prefix_space": False,
        "clean_up_tokenization_spaces": False,
        "eos_token": eos_token,
        "pad_token": KQWEN35_PAD_TOKEN,
        "tokenizer_class": "Qwen2Tokenizer",
        "added_tokens_decoder": added_decoder,
    }

    generation_config: dict[str, Any] = {"do_sample": True}
    if isinstance(eos_id, int):
        generation_config["eos_token_id"] = eos_id
    elif isinstance(eos_id, list):
        generation_config["eos_token_id"] = eos_id
    if isinstance(pad_id, int):
        generation_config["pad_token_id"] = pad_id
    if isinstance(bos_id, int):
        generation_config["bos_token_id"] = bos_id

    chat_template = kv.get("tokenizer.chat_template")
    if not isinstance(chat_template, str) or not chat_template.strip():
        for cand in (
            BUNDLE_ROOT / "tools" / "chat_templates" / "qwen3_8.jinja",
            BUNDLE_ROOT / "tools" / "chat_templates" / "qwen3_6.jinja",
        ):
            if cand.is_file():
                chat_template = cand.read_text(encoding="utf-8")
                break
        else:
            chat_template = ""

    return tokenizer_json, tokenizer_config, generation_config, chat_template


def _read_num_hidden_layers(config_path: Path) -> int:
    """Read num_hidden_layers from nested text_config or top-level config.json."""
    raw = json.loads(config_path.read_text(encoding="utf-8-sig"))
    text_cfg = raw.get("text_config")
    if isinstance(text_cfg, dict) and "num_hidden_layers" in text_cfg:
        return int(text_cfg["num_hidden_layers"])
    return int(raw["num_hidden_layers"])


def _prepare_model_dir(
    gguf_path: Path,
    aux_dir: Path | None,
    auto_reconstruct: bool,
    scratch_dir: Path,
) -> tuple[Path, bool]:
    """Ensure a directory containing config.json + tokenizer/chat_template resources."""
    from tools.convert.sources.gguf import open_gguf

    required = (
        "config.json",
        "tokenizer.json",
        "tokenizer_config.json",
        "chat_template.jinja",
        "generation_config.json",
    )

    if aux_dir is not None and all((aux_dir / name).is_file() for name in required):
        return aux_dir, False

    if not auto_reconstruct and aux_dir is None:
        raise ValueError("No auxiliary HF config directory provided and auto-reconstruction is disabled.")

    emit_progress("prepare", 3, "Inspecting GGUF metadata & reconstructing config/tokenizer...")
    work_dir = scratch_dir / "aux_reconstructed"
    work_dir.mkdir(parents=True, exist_ok=True)

    # Copy any existing files from aux_dir first so user-supplied files take precedence.
    if aux_dir is not None and aux_dir.is_dir():
        for item in aux_dir.iterdir():
            if item.is_file() and item.suffix.lower() in (".json", ".jinja", ".txt"):
                shutil.copy2(item, work_dir / item.name)

    with open_gguf(gguf_path) as gguf:
        if not (work_dir / "config.json").is_file():
            cfg = _reconstruct_config(gguf)
            (work_dir / "config.json").write_text(
                json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
            )

        need_tok = any(
            not (work_dir / name).is_file()
            for name in ("tokenizer.json", "tokenizer_config.json", "generation_config.json", "chat_template.jinja")
        )
        if need_tok:
            tok_json, tok_cfg, gen_cfg, tpl = _reconstruct_tokenizer(gguf)
            if not (work_dir / "tokenizer.json").is_file():
                (work_dir / "tokenizer.json").write_text(
                    json.dumps(tok_json, ensure_ascii=False) + "\n", encoding="utf-8"
                )
            if not (work_dir / "tokenizer_config.json").is_file():
                (work_dir / "tokenizer_config.json").write_text(
                    json.dumps(tok_cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
                )
            if not (work_dir / "generation_config.json").is_file():
                (work_dir / "generation_config.json").write_text(
                    json.dumps(gen_cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
                )
            if not (work_dir / "chat_template.jinja").is_file():
                if not tpl.strip():
                    raise ValueError("GGUF lacks tokenizer.chat_template and no fallback template was found.")
                (work_dir / "chat_template.jinja").write_text(tpl, encoding="utf-8")

    # Check has_mtp directly from GGUF
    with open_gguf(gguf_path) as gguf:
        num_layers = _read_num_hidden_layers(work_dir / "config.json")
        has_mtp = f"blk.{num_layers}.nextn.eh_proj.weight" in gguf.tensors

    return work_dir, has_mtp


def _resolve_recipe(requested: str) -> str:
    from tools.convert.gguf_blocks import RECIPES as GGUF_RECIPES

    if requested and requested != "auto":
        if requested not in GGUF_RECIPES:
            raise ValueError(f"Recipe {requested!r} not available in converter bundle: {sorted(GGUF_RECIPES)}")
        return requested
    for candidate in ("qwen3_5_dense_gguf", "qwen3_8_27b_gguf"):
        if candidate in GGUF_RECIPES:
            return candidate
    raise RuntimeError(f"No supported GGUF dense recipe found in converter bundle: {sorted(GGUF_RECIPES)}")


def _hook_pipeline_progress() -> None:
    """Wrap `tools.convert.pipeline.convert` (and `__main__.convert` alias) for [COOKLLM_PROGRESS]."""
    from tools.convert import __main__ as main_mod
    from tools.convert import pipeline as pipeline_mod

    orig_convert = pipeline_mod.convert

    def wrapped_convert(model, recipe, output, **kwargs):
        orig_progress = kwargs.get("progress")

        def progress_hook(index: int, total: int, job: Any) -> None:
            if orig_progress is not None:
                orig_progress(index, total, job)
            label = job.parameters[0] if getattr(job, "parameters", None) else job.spec.id
            pct = 10 + (87.0 * index / max(1, total))
            emit_progress(
                "convert",
                pct,
                f"[{index + 1}/{total}] {label}",
                current=index + 1,
                total=total,
            )

        kwargs["progress"] = progress_hook
        emit_progress("prepare", 8, "Planning NInfer v3 artifact layout...")
        result = orig_convert(model, recipe, output, **kwargs)
        total_weights = len(getattr(recipe, "weights", ()) or ())
        emit_progress(
            "convert",
            97,
            "Finalizing .ninfer package...",
            current=total_weights,
            total=total_weights,
        )
        return result

    pipeline_mod.convert = wrapped_convert
    # tools.convert.__main__ binds `from .pipeline import convert` at import time
    main_mod.convert = wrapped_convert


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="CookLLM GGUF -> NInfer v3 converter")
    parser.add_argument("--gguf", type=Path, required=True, help="Source GGUF (or first shard of split GGUF)")
    parser.add_argument("--out", type=Path, required=True, help="Output .ninfer file path")
    parser.add_argument("--name", default="", help="Instance display name embedded in artifact metadata")
    parser.add_argument("--aux-dir", type=Path, default=None, help="Directory with config.json and tokenizer files")
    parser.add_argument("--auto-reconstruct", action="store_true", help="Reconstruct missing config/tokenizer from GGUF KV")
    parser.add_argument("--vision", type=Path, default=None, help="Optional mmproj GGUF path")
    parser.add_argument("--dflash2", type=Path, default=None, help="Optional DFlash2 safetensors/GGUF path")
    parser.add_argument("--chat-template", type=Path, default=None, help="Optional chat_template.jinja override")
    parser.add_argument("--proposal", action="store_true", help="Include indexed proposal head")
    parser.add_argument("--include-mtp", action="store_true", help="Include MTP component if present in GGUF")
    parser.add_argument("--recipe", default="auto", help="Conversion recipe (default: auto)")
    parser.add_argument("--device", default="cpu", help="Torch device (default: cpu)")
    args = parser.parse_args(argv)

    _patch_split_regex()

    from tools.convert.__main__ import main as convert_main
    from tools.convert.sources.gguf import open_gguf

    gguf_path = args.gguf.resolve()
    out_path = args.out.resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if out_path.exists():
        raise FileExistsError(f"Output file already exists: {out_path}")

    recipe_name = _resolve_recipe(args.recipe)
    instance_name = args.name.strip() or out_path.stem

    staging_root = Path(tempfile.mkdtemp(prefix=".cookllm_ninfer_stage_", dir=str(out_path.parent)))
    try:
        model_dir, detected_mtp = _prepare_model_dir(
            gguf_path,
            args.aux_dir.resolve() if args.aux_dir else None,
            args.auto_reconstruct,
            staging_root,
        )

        # Double-check MTP presence if requested
        if args.include_mtp and not detected_mtp:
            with open_gguf(gguf_path) as gguf:
                num_layers = _read_num_hidden_layers(model_dir / "config.json")
                detected_mtp = f"blk.{num_layers}.nextn.eh_proj.weight" in gguf.tensors

        components = ["text"]
        if args.include_mtp and detected_mtp:
            components.append("mtp")
        if args.vision is not None:
            components.append("vision")
        if args.dflash2 is not None:
            components.append("dflash2")

        staged_out = staging_root / out_path.name
        cli_args = [
            "--model", str(model_dir),
            "--recipe", recipe_name,
            "--components", ",".join(components),
            "--source", f"gguf={gguf_path}",
            "--name", instance_name,
            "--out", str(staged_out),
            "--device", args.device,
        ]
        if args.vision is not None:
            cli_args.extend(["--source", f"vision={args.vision.resolve()}"])
        if args.dflash2 is not None:
            cli_args.extend(["--source", f"dflash2={args.dflash2.resolve()}"])
        if args.chat_template is not None:
            cli_args.extend(["--resource", f"chat_template.jinja={args.chat_template.resolve()}"])
        if args.proposal:
            cli_args.append("--proposal")

        _hook_pipeline_progress()
        emit_progress("convert", 10, f"Starting conversion ({recipe_name})...")
        convert_main(cli_args)

        emit_progress("finalize", 98, "Moving artifact into place...")
        produced = [staged_out]
        for part in sorted(staging_root.glob(f"{out_path.name}.part-*")):
            produced.append(part)
        for src in produced:
            dst = out_path.parent / src.name
            if dst.exists():
                raise FileExistsError(f"Destination already exists: {dst}")
            shutil.move(str(src), str(dst))

        report_src = Path(str(staged_out) + ".conversion.json")
        if report_src.is_file():
            shutil.move(str(report_src), str(Path(str(out_path) + ".conversion.json")))

        emit_progress("done", 100, f"Conversion complete: {out_path.name}")
        return 0
    finally:
        shutil.rmtree(staging_root, ignore_errors=True)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        traceback.print_exc()
        print(f"[COOKLLM_ERROR] {exc}", file=sys.stderr, flush=True)
        sys.exit(1)
