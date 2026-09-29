"""Stream official VoxCPM2 tensors with the official CPU/MPS precision policy.

No official repository files, model topology, checkpoint tensors, precision
policy, or generation methods are changed. Full-model inference must still
be verified separately. Never run alongside another resident TTS model.
"""

from __future__ import annotations

import gc
import json
from pathlib import Path
import sys


CACHE_ROOT = Path.home() / ".cache" / "shendu-voice-station"


def _assign_tensor(model, name, tensor, torch):
    """Assign one finalized parameter/buffer without retaining a CPU copy."""
    parent_name, _, leaf = name.rpartition('.')
    parent = model.get_submodule(parent_name) if parent_name else model
    if leaf in parent._parameters:
        previous = parent._parameters[leaf]
        setattr(parent, leaf, torch.nn.Parameter(tensor, requires_grad=previous.requires_grad))
    elif leaf in parent._buffers:
        parent._buffers[leaf] = tensor
    else:
        raise KeyError(f'Checkpoint key is not a parameter/buffer: {name}')


def load_voxcpm2_low_memory(model_dir, device='mps', optimize=False, repo_dir=None):
    """Return an ordinary official VoxCPM wrapper with a streamed VoxCPM2.

    CPU uses the official BF16 LM / FP32 VAE; MPS uses stable FP32. This avoids a full
    random CPU model and a second full CPU state dict while migrating to MPS.
    ``audiovae.pth`` is opened using PyTorch mmap, ``model.safetensors`` using
    safetensors CPU mmap, then each tensor is transferred/cast once.
    """
    if optimize:
        raise ValueError('This MPS loading adapter requires optimize=False.')
    sys.path.insert(0, str(Path(repo_dir or CACHE_ROOT / 'repos' / 'voxcpm') / 'src'))

    import torch
    from safetensors import safe_open
    from transformers import LlamaTokenizerFast
    from voxcpm import VoxCPM
    from voxcpm.model.voxcpm2 import VoxCPM2Model, VoxCPMConfig
    from voxcpm.model.utils import get_dtype, pick_runtime_dtype, resolve_runtime_device
    from voxcpm.modules.audiovae import AudioVAEV2
    from voxcpm.modules.minicpm4.model import MiniCPMLongRoPE

    if torch.get_default_dtype() != torch.float32:
        raise RuntimeError('This adapter requires the same float32 construction default as the official MPS loader.')
    model_dir = Path(model_dir)
    raw_config = json.loads((model_dir / 'config.json').read_text())
    if raw_config.get('architecture', '').lower() != 'voxcpm2':
        raise ValueError('Expected the official VoxCPM2 architecture.')
    device = resolve_runtime_device(device, raw_config.get('device', 'cuda'))
    if device not in ('mps', 'cpu'):
        raise ValueError('This adapter supports the official CPU/MPS routes only.')
    runtime_dtype = pick_runtime_dtype(device, raw_config.get('dtype', 'bfloat16'))
    if device == 'mps' and runtime_dtype not in ('float32', 'fp32'):
        raise ValueError('Remove VOXCPM_MPS_DTYPE overrides; this adapter requires official FP32 MPS precision.')
    config = VoxCPMConfig.model_validate_json((model_dir / 'config.json').read_text())
    tokenizer = LlamaTokenizerFast.from_pretrained(str(model_dir), local_files_only=True)
    main_weights = model_dir / 'model.safetensors'
    if not main_weights.is_file():
        raise FileNotFoundError(main_weights)
    vae_safe = model_dir / 'audiovae.safetensors'
    vae_pth = model_dir / 'audiovae.pth'
    if not vae_safe.is_file() and not vae_pth.is_file():
        raise FileNotFoundError(f'AudioVAE checkpoint missing in {model_dir}')

    print('VOX_LOW_MEMORY_META_INIT', flush=True)
    with torch.device('meta'):
        audio_vae_config = getattr(config, 'audio_vae_config', None)
        audio_vae = AudioVAEV2(config=audio_vae_config) if audio_vae_config else AudioVAEV2()
        model = VoxCPM2Model(config, tokenizer, audio_vae, None, device=device)
    lm_dtype = get_dtype(model.config.dtype)
    # Same casts as upstream from_local, applied while parameters are meta.
    model = model.to(lm_dtype)
    model.audio_vae = model.audio_vae.to(torch.float32)
    expected = {name: (tuple(value.shape), value.dtype) for name, value in model.state_dict().items()}
    loaded = set()

    def place(name, source):
        if name not in expected:
            raise KeyError(f'Unexpected official checkpoint tensor: {name}')
        shape, dtype = expected[name]
        if tuple(source.shape) != shape:
            raise ValueError(f'Checkpoint shape mismatch for {name}: {tuple(source.shape)} != {shape}')
        final = source.to(device=device, dtype=dtype)
        _assign_tensor(model, name, final, torch)
        loaded.add(name)
        del final

    print('VOX_LOW_MEMORY_MAIN_WEIGHTS', flush=True)
    with safe_open(str(main_weights), framework='pt', device='cpu') as reader:
        keys = list(reader.keys())
        for index, name in enumerate(keys, start=1):
            tensor = reader.get_tensor(name)
            place(name, tensor)
            del tensor
            if index % 128 == 0 or index == len(keys):
                if device == 'mps':
                    torch.mps.synchronize()
                    torch.mps.empty_cache()
                print(f'VOX_MAIN_TENSORS {index}/{len(keys)}', flush=True)

    print('VOX_LOW_MEMORY_AUDIOVAE', flush=True)
    if vae_safe.is_file():
        with safe_open(str(vae_safe), framework='pt', device='cpu') as reader:
            for name in reader.keys():
                tensor = reader.get_tensor(name)
                place(f'audio_vae.{name}', tensor)
                del tensor
    else:
        checkpoint = torch.load(str(vae_pth), map_location='cpu', weights_only=True, mmap=True)
        vae_state = checkpoint.get('state_dict', checkpoint)
        for name in list(vae_state):
            tensor = vae_state.pop(name)
            place(f'audio_vae.{name}', tensor)
            del tensor
        del vae_state, checkpoint

    missing = set(expected) - loaded
    if missing:
        raise RuntimeError(f'Unloaded official checkpoint tensors: {sorted(missing)}')
    del expected

    # RoPE tables are nonpersistent buffers and therefore are absent from the
    # checkpoint. Rebuild using the SAME official class/config on CPU, then
    # transfer the results, matching the upstream CPU-construction route.
    rope_count = 0
    for name, module in list(model.named_modules()):
        if isinstance(module, MiniCPMLongRoPE):
            with torch.device('cpu'):
                replacement = MiniCPMLongRoPE(module.config)
            replacement = replacement.to(device=device, dtype=lm_dtype)
            parent_name, _, leaf = name.rpartition('.')
            parent = model.get_submodule(parent_name) if parent_name else model
            setattr(parent, leaf, replacement)
            rope_count += 1

    # StaticKVCache is an ordinary object, not a registered module or buffer.
    # Its constructor explicitly requests the resolved device, so the caches
    # constructed above should already be real FP32 MPS tensors despite the
    # enclosing meta context. Repair only if an upstream change alters this.
    for lm in (model.base_lm, model.residual_lm):
        cache = getattr(lm, 'kv_cache', None)
        value = getattr(cache, 'kv_cache', None)
        if value is None or value.is_meta or value.device.type != device or value.dtype != lm_dtype:
            lm.kv_cache = None
            lm.setup_cache(1, model.config.max_length, device, lm_dtype)
    meta_left = [name for name, value in list(model.named_parameters()) + list(model.named_buffers()) if value.is_meta]
    if meta_left:
        raise RuntimeError(f'Unexpected unresolved meta tensors: {meta_left}')
    bad_precision = [name for name, value in model.named_parameters()
                     if value.dtype != (torch.float32 if name.startswith('audio_vae.') else lm_dtype)]
    if bad_precision:
        raise RuntimeError(f'Unexpected parameter precision: {bad_precision}')
    model.eval()
    gc.collect()
    if device == 'mps':
        torch.mps.synchronize()
        torch.mps.empty_cache()
    allocated = torch.mps.current_allocated_memory() if device == 'mps' else 'cpu'
    print(f'VOX_LOW_MEMORY_READY ropes={rope_count} lm_dtype={lm_dtype} allocated={allocated}', flush=True)

    # Upstream VoxCPM.__init__ sets these three fields and otherwise only
    # performs model loading, optional denoiser/LoRA loading, and warmup.
    # Preserve its own public generation/prompt-cache/retry implementation.
    wrapper = VoxCPM.__new__(VoxCPM)
    wrapper.tts_model = model
    wrapper.text_normalizer = None
    wrapper.denoiser = None
    return wrapper
