"""
下载 Qwen2.5-Coder-3B-Instruct 基础模型到本地目录
支持代理和镜像源

用法:
  1. 有代理: python download_model.py --proxy http://127.0.0.1:7890
  2. 用镜像: python download_model.py --mirror https://hf-mirror.com
  3. 手动下载: 见下方 MANUAL_DOWNLOAD_INSTRUCTIONS
"""

import os
import sys
import argparse
from huggingface_hub import snapshot_download

MIRRORS = [
    "https://hf-mirror.com",
    "https://huggingface.do.mirr.one",
    "https://huggingface.clbang.cc",
    None,
]

MANUAL_DOWNLOAD_INSTRUCTIONS = """
============================================================
  手动下载指南（当自动下载失败时使用）
============================================================

需要下载的模型: Qwen/Qwen2.5-Coder-3B-Instruct
目标目录: finetune/base_model/

方法1: 浏览器下载（推荐）
  1. 用浏览器（需能访问HuggingFace）打开:
     https://huggingface.co/Qwen/Qwen2.5-Coder-3B-Instruct/tree/main
  2. 下载以下所有文件到 finetune/base_model/ 目录:
     - config.json
     - generation_config.json
     - model-00001-of-00002.safetensors  (~2.9GB)
     - model-00002-of-00002.safetensors  (~2.9GB)
     - model.safetensors.index.json
     - tokenizer.json
     - tokenizer_config.json
     - vocab.json
     - merges.txt
     - special_tokens_map.json (如有)

方法2: 用 modelscope 下载（国内直连）
  1. pip install modelscope
  2. 运行:
     from modelscope import snapshot_download
     snapshot_download('Qwen/Qwen2.5-Coder-3B-Instruct',
                       local_dir='./base_model')

方法3: 用 huggingface-cli + 代理
  1. 设置代理: set HTTPS_PROXY=http://127.0.0.1:7890
  2. huggingface-cli download Qwen/Qwen2.5-Coder-3B-Instruct
     --local-dir ./base_model

============================================================
"""


def download_model(model_id: str, local_dir: str, mirror: str = None, proxy: str = None):
    if proxy:
        os.environ["HTTP_PROXY"] = proxy
        os.environ["HTTPS_PROXY"] = proxy
        print(f"Using proxy: {proxy}")

    if mirror:
        os.environ["HF_ENDPOINT"] = mirror
        print(f"Using mirror: {mirror}")
    else:
        os.environ.pop("HF_ENDPOINT", None)
        print("Using official HuggingFace source")

    print(f"Downloading model: {model_id}")
    print(f"Target directory: {local_dir}")

    os.makedirs(local_dir, exist_ok=True)

    snapshot_download(
        repo_id=model_id,
        local_dir=local_dir,
    )

    print(f"\nModel downloaded to: {local_dir}")
    print("You can now use this path as --base_model in fine-tuning scripts.")


def try_download_with_fallback(model_id: str, local_dir: str,
                                preferred_mirror: str = None, proxy: str = None):
    if proxy:
        mirrors_to_try = [None]
    elif preferred_mirror:
        mirrors_to_try = [preferred_mirror] + [m for m in MIRRORS if m != preferred_mirror]
    else:
        mirrors_to_try = MIRRORS

    for i, mirror in enumerate(mirrors_to_try):
        try:
            print(f"\n--- Attempt {i+1}/{len(mirrors_to_try)} ---")
            download_model(model_id, local_dir, mirror, proxy)
            return True
        except Exception as e:
            print(f"\nFailed: {type(e).__name__}: {str(e)[:200]}")
            if i < len(mirrors_to_try) - 1:
                print("Trying next source...")
            else:
                print("\nAll automatic download methods failed.")
                print(MANUAL_DOWNLOAD_INSTRUCTIONS)
                return False
    return False


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--model_id", type=str, default="Qwen/Qwen2.5-Coder-3B-Instruct")
    parser.add_argument("--local_dir", type=str, default="./base_model")
    parser.add_argument("--mirror", type=str, default=None,
                        help="HuggingFace mirror URL (e.g. https://hf-mirror.com)")
    parser.add_argument("--proxy", type=str, default=None,
                        help="HTTP proxy (e.g. http://127.0.0.1:7890)")
    args = parser.parse_args()

    success = try_download_with_fallback(args.model_id, args.local_dir, args.mirror, args.proxy)
    if not success:
        sys.exit(1)
