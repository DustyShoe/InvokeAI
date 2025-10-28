import json
from collections import Counter
from pathlib import Path
from typing import Any, Optional, TypeAlias

import safetensors.torch
import torch
from picklescan.scanner import scan_file_path
from safetensors import safe_open

from invokeai.app.services.config.config_default import get_config
from invokeai.backend.model_hash.model_hash import HASHING_ALGORITHMS, ModelHash
from invokeai.backend.model_manager.taxonomy import ModelRepoVariant
from invokeai.backend.quantization.gguf.loaders import gguf_sd_loader
from invokeai.backend.util.logging import InvokeAILogger
from invokeai.backend.util.silence_warnings import SilenceWarnings

StateDict: TypeAlias = dict[str | int, Any]  # When are the keys int?

logger = InvokeAILogger.get_logger()


class ModelOnDisk:
    """A utility class representing a model stored on disk."""

    def __init__(self, path: Path, hash_algo: HASHING_ALGORITHMS = "blake3_single"):
        self.path = path
        if self.path.suffix in {".safetensors", ".bin", ".pt", ".ckpt"}:
            self.name = path.stem
        else:
            self.name = path.name
        self.hash_algo = hash_algo
        # Having a cache helps users of ModelOnDisk (i.e. configs) to save state
        # This prevents redundant computations during matching and parsing
        self._state_dict_cache: dict[Path, Any] = {}
        self._metadata_cache: dict[Path, Any] = {}

    def hash(self) -> str:
        return ModelHash(algorithm=self.hash_algo).hash(self.path)

    def size(self) -> int:
        if self.path.is_file():
            return self.path.stat().st_size
        return sum(file.stat().st_size for file in self.path.rglob("*"))

    def weight_files(self) -> set[Path]:
        if self.path.is_file():
            return {self.path}
        extensions = {".safetensors", ".pt", ".pth", ".ckpt", ".bin", ".gguf"}
        return {f for f in self.path.rglob("*") if f.suffix in extensions and f.is_file()}

    def metadata(self, path: Optional[Path] = None) -> dict[str, str]:
        path = path or self.path
        if path in self._metadata_cache:
            return self._metadata_cache[path]
        try:
            with safe_open(self.path, framework="pt", device="cpu") as f:
                metadata = f.metadata()
                assert isinstance(metadata, dict)
        except Exception:
            metadata = {}

        self._metadata_cache[path] = metadata
        return metadata

    def repo_variant(self) -> Optional[ModelRepoVariant]:
        if self.path.is_file():
            return None

        weight_files = list(self.path.glob("**/*.safetensors"))
        weight_files.extend(list(self.path.glob("**/*.bin")))
        for x in weight_files:
            if ".fp16" in x.suffixes:
                return ModelRepoVariant.FP16
            if "openvino_model" in x.name:
                return ModelRepoVariant.OpenVINO
            if "flax_model" in x.name:
                return ModelRepoVariant.Flax
            if x.suffix == ".onnx":
                return ModelRepoVariant.ONNX
        return ModelRepoVariant.Default

    def load_state_dict(self, path: Optional[Path] = None) -> StateDict:
        if path in self._state_dict_cache:
            return self._state_dict_cache[path]

        path = self.resolve_weight_file(path)

        with SilenceWarnings():
            if path.suffix.endswith((".ckpt", ".pt", ".pth", ".bin")):
                scan_result = scan_file_path(path)
                if scan_result.infected_files != 0:
                    if get_config().unsafe_disable_picklescan:
                        logger.warning(
                            f"The model {path.stem} is potentially infected by malware, but picklescan is disabled. "
                            "Proceeding with caution."
                        )
                    else:
                        raise RuntimeError(
                            f"The model {path.stem} is potentially infected by malware. Aborting import."
                        )
                if scan_result.scan_err:
                    if get_config().unsafe_disable_picklescan:
                        logger.warning(
                            f"Error scanning the model at {path.stem} for malware, but picklescan is disabled. "
                            "Proceeding with caution."
                        )
                    else:
                        raise RuntimeError(f"Error scanning the model at {path.stem} for malware. Aborting import.")
                checkpoint = torch.load(path, map_location="cpu")
                assert isinstance(checkpoint, dict)
            elif path.suffix.endswith(".gguf"):
                checkpoint = gguf_sd_loader(path, compute_dtype=torch.float32)
            elif path.suffix.endswith(".safetensors"):
                checkpoint = safetensors.torch.load_file(path)
            else:
                raise ValueError(f"Unrecognized model extension: {path.suffix}")

        state_dict = checkpoint.get("state_dict", checkpoint)
        self._state_dict_cache[path] = state_dict
        return state_dict

    def resolve_weight_file(self, path: Optional[Path] = None) -> Path:
        if path:
            return path

        weight_files = list(self.weight_files())
        if not weight_files:
            raise ValueError("No weight files found for this model")

        if len(weight_files) == 1:
            return weight_files[0]

        preferred = self._select_weight_file_from_model_index(weight_files)
        if preferred:
            return preferred

        preferred = self._select_preferred_weight_file(weight_files)
        if preferred:
            return preferred

        # Fallback to a deterministic selection to preserve previous behaviour of
        # picking the "first" discovered weight file instead of failing outright.
        return sorted(weight_files)[0]

    def _select_weight_file_from_model_index(self, weight_files: list[Path]) -> Optional[Path]:
        """Use the diffusers ``model_index.json`` metadata to pick a primary weight file.

        When a diffusers repository ships multiple weight shards, ``model_index.json``
        includes a ``weight_map`` describing which tensor lives in which file. The
        UNet shard typically hosts the majority of the tensors, so we pick the file
        referenced most often in the weight map. Falling back to heuristics keeps the
        behaviour predictable when the metadata is missing or unexpected.
        """

        if not weight_files:
            return None

        if self.path.is_file():
            return None

        index_path = self.path / "model_index.json"
        if not index_path.exists():
            return None

        try:
            index_data = json.loads(index_path.read_text())
        except Exception:
            return None

        def collect_weight_maps(node: Any, acc: list[dict[str, Any]]) -> None:
            if isinstance(node, dict):
                for key in ("weight_map", "_weight_map"):
                    weight_map = node.get(key)
                    if isinstance(weight_map, dict):
                        acc.append(weight_map)
                for value in node.values():
                    collect_weight_maps(value, acc)
            elif isinstance(node, list):
                for item in node:
                    collect_weight_maps(item, acc)

        weight_maps: list[dict[str, Any]] = []
        collect_weight_maps(index_data, weight_maps)

        if not weight_maps:
            return None

        # Normalise candidates to POSIX relative paths so they match the metadata.
        candidates: dict[str, Path] = {}
        for wf in weight_files:
            try:
                rel = wf.relative_to(self.path)
            except ValueError:
                rel = wf.name
            candidates[rel.as_posix()] = wf

        frequency = Counter()
        for weight_map in weight_maps:
            for rel_path in weight_map.values():
                if not isinstance(rel_path, str):
                    continue
                normalised = Path(rel_path.replace("\\", "/")).as_posix()
                if normalised in candidates:
                    frequency[normalised] += 1

        if not frequency:
            return None

        max_count = max(frequency.values())
        best = sorted(
            (candidates[path] for path, count in frequency.items() if count == max_count)
        )
        return best[0] if best else None

    @staticmethod
    def _select_preferred_weight_file(weight_files: list[Path]) -> Optional[Path]:
        """Choose a reasonable default weight file when multiple are present.

        Historically, the model manager would simply pick one of the discovered
        weight files. During the refactor to `ModelOnDisk`, this behaviour was
        replaced with a hard error, which broke models that legitimately ship
        multiple weight shards (for example diffusers-style FLUX repositories).

        To restore compatibility we attempt to select the most likely primary
        file based on common naming patterns. The selection intentionally errs
        on the side of being deterministic rather than perfect – callers that
        require a specific file can still provide it explicitly via ``path``.
        """

        if not weight_files:
            return None

        def score(p: Path) -> tuple[int, str]:
            normalized = p.as_posix().lower()

            priority = 100
            if "unet" in normalized and "diffusion_pytorch_model" in normalized:
                priority = 0
            elif "diffusion_pytorch_model" in normalized:
                priority = 1
            elif normalized.endswith("model.safetensors") or normalized.endswith("model.bin"):
                priority = 2
            elif "pytorch_model" in normalized:
                priority = 3
            elif "pytorch_lora_weights" in normalized:
                priority = 4
            elif "lora" in normalized:
                priority = 5

            return (priority, normalized)

        return min(weight_files, key=score)
        
