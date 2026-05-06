"""
合并 LoRA 权重到基础模型，生成完整的可独立使用的模型
合并后可直接导入 Ollama 使用

支持两种合并模式：
1. 单层合并：base + LoRA → merged_model_sft
2. 双层合并：base + SFT LoRA + DPO LoRA → merged_model_dpo

用法：
  python merge_lora.py --lora_path output/final --output_dir merged_model_sft
  python merge_lora.py --lora_path output_dpo/final --sft_lora_path output/final --output_dir merged_model_dpo
"""

import os
import argparse
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_BASE_MODEL = os.path.join(SCRIPT_DIR, "base_model")
DEFAULT_LORA_PATH = os.path.join(SCRIPT_DIR, "output", "final")
DEFAULT_OUTPUT_DIR = os.path.join(SCRIPT_DIR, "merged_model")


def merge_lora(base_model: str, lora_path: str, output_dir: str, sft_lora_path: str = None):
    print(f"Loading base model: {base_model}")
    tokenizer = AutoTokenizer.from_pretrained(base_model, trust_remote_code=True)

    model = AutoModelForCausalLM.from_pretrained(
        base_model,
        torch_dtype=torch.bfloat16,
        device_map="cpu",
        trust_remote_code=True,
    )

    if sft_lora_path:
        print(f"Loading SFT LoRA weights: {sft_lora_path}")
        model = PeftModel.from_pretrained(model, sft_lora_path)
        print("Merging SFT LoRA into base model...")
        model = model.merge_and_unload()
        print("SFT LoRA merged successfully")

    print(f"Loading LoRA weights: {lora_path}")
    model = PeftModel.from_pretrained(model, lora_path)

    print("Merging LoRA weights...")
    model = model.merge_and_unload()

    print(f"Saving merged model to: {output_dir}")
    model.save_pretrained(output_dir, safe_serialization=True)
    tokenizer.save_pretrained(output_dir)

    print("Done! Merged model saved.")
    if sft_lora_path:
        print(f"  Composition: base + {sft_lora_path} + {lora_path}")
    else:
        print(f"  Composition: base + {lora_path}")
    print("\nTo import into Ollama:")
    print(f"  1. Create a Modelfile with: FROM {output_dir}")
    print(f"  2. Run: ollama create qwen2.5-coder-c-teaching -f Modelfile")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--base_model", type=str, default=DEFAULT_BASE_MODEL)
    parser.add_argument("--lora_path", type=str, default=DEFAULT_LORA_PATH)
    parser.add_argument("--sft_lora_path", type=str, default=None,
                        help="Path to SFT LoRA weights (for two-stage merge: base + SFT + DPO)")
    parser.add_argument("--output_dir", type=str, default=DEFAULT_OUTPUT_DIR)
    args = parser.parse_args()

    merge_lora(args.base_model, args.lora_path, args.output_dir, args.sft_lora_path)
