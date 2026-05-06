"""
HuggingFace 模型推理服务
兼容 Ollama /api/chat 接口格式，供 VSCode 插件直接调用

用法:
  python serve.py                              # 使用基础模型（默认）
  python serve.py --lora output/final          # 动态加载LoRA
  python serve.py --port 8000                  # 指定端口
  python serve.py --host 0.0.0.0               # 指定监听地址（默认0.0.0.0，允许远程访问）
  python serve.py --workers 2                  # 并发推理线程数（默认1，受GPU显存限制）

启动后，插件只需将 aiAssistant.llmBaseUrl 改为 http://服务器IP:端口
"""

import os
import sys
import json
import argparse
import time
import asyncio
from typing import Optional
from concurrent.futures import ThreadPoolExecutor

import torch
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
from pydantic import BaseModel
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
from peft import PeftModel

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_BASE_MODEL = os.path.join(SCRIPT_DIR, "base_model")
DEFAULT_PORT = 8000
DEFAULT_HOST = "0.0.0.0"

app = FastAPI(title="HuggingFace LLM Serve (Ollama-compatible)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

model = None
tokenizer = None
executor = None


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    model: str = ""
    messages: list[ChatMessage]
    stream: bool = False
    options: Optional[dict] = None


class ChatResponse(BaseModel):
    model: str
    created_at: str
    message: ChatMessage
    done: bool = True


def _generate(messages_dict: list, gen_kwargs: dict) -> str:
    global model, tokenizer

    text = tokenizer.apply_chat_template(
        messages_dict,
        tokenize=False,
        add_generation_prompt=True,
    )
    inputs = tokenizer(text, return_tensors="pt").to(model.device)

    with torch.no_grad():
        outputs = model.generate(
            **inputs,
            **gen_kwargs,
        )

    response_text = tokenizer.decode(
        outputs[0][inputs["input_ids"].shape[1]:],
        skip_special_tokens=True,
    )
    return response_text


@app.post("/api/chat")
async def chat(request: ChatRequest):
    global model, tokenizer, executor

    if model is None or tokenizer is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    messages_dict = [{"role": m.role, "content": m.content} for m in request.messages]

    gen_kwargs = {
        "max_new_tokens": 1024,
        "temperature": 0.7,
        "top_p": 0.9,
        "do_sample": True,
        "repetition_penalty": 1.1,
    }

    if request.options:
        if "temperature" in request.options:
            gen_kwargs["temperature"] = request.options["temperature"]
        if "top_p" in request.options:
            gen_kwargs["top_p"] = request.options["top_p"]
        if "num_predict" in request.options:
            gen_kwargs["max_new_tokens"] = request.options["num_predict"]

    if executor is not None:
        loop = asyncio.get_running_loop()
        response_text = await loop.run_in_executor(
            executor, _generate, messages_dict, gen_kwargs
        )
    else:
        response_text = _generate(messages_dict, gen_kwargs)

    return ChatResponse(
        model=request.model or "huggingface-serve",
        created_at=time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
        message=ChatMessage(role="assistant", content=response_text),
        done=True,
    )


@app.get("/api/tags")
async def tags():
    return {
        "models": [
            {
                "name": "huggingface-serve",
                "model": "huggingface-serve",
                "modified_at": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
                "size": 0,
            }
        ]
    }


@app.get("/health")
async def health():
    return {"status": "ok", "model_loaded": model is not None}


def load_model(model_path: str, lora_path: Optional[str] = None):
    global model, tokenizer

    print(f"Loading tokenizer from: {model_path}")
    tokenizer = AutoTokenizer.from_pretrained(
        model_path,
        trust_remote_code=True,
        padding_side="right",
    )
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    print(f"Loading model from: {model_path}")
    print("Using 4-bit quantization (NF4) to fit in 6GB VRAM...")

    bnb_config = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16,
        bnb_4bit_use_double_quant=True,
    )

    model = AutoModelForCausalLM.from_pretrained(
        model_path,
        quantization_config=bnb_config,
        device_map="auto",
        trust_remote_code=True,
        torch_dtype=torch.bfloat16,
    )
    model.eval()

    if lora_path and os.path.exists(lora_path):
        print(f"Loading LoRA weights from: {lora_path}")
        model = PeftModel.from_pretrained(model, lora_path)
        model = model.merge_and_unload()
        print("LoRA weights merged successfully")

    vram_used = torch.cuda.memory_allocated() / 1024**3
    print(f"Model loaded. VRAM used: {vram_used:.2f} GB")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--lora", type=str, default=None,
                        help="Path to LoRA weights (e.g. output/final)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--host", type=str, default=DEFAULT_HOST,
                        help="Host to bind (default: 0.0.0.0, allows remote access)")
    parser.add_argument("--workers", type=int, default=1,
                        help="Number of concurrent inference threads (default: 1)")
    args = parser.parse_args()

    model_path = DEFAULT_BASE_MODEL
    model_desc = "Base model"

    if args.lora:
        model_desc = f"Base model + LoRA ({args.lora})"

    if not os.path.exists(model_path):
        print(f"ERROR: Model not found at: {model_path}")
        sys.exit(1)

    if args.workers > 1:
        executor = ThreadPoolExecutor(max_workers=args.workers)
        print(f"Concurrent inference enabled: {args.workers} workers")

    print("=" * 60)
    print("  HuggingFace LLM Serve (Ollama-compatible)")
    print(f"  Model:    {model_desc}")
    print(f"  Path:     {model_path}")
    print(f"  Host:     {args.host}")
    print(f"  Port:     {args.port}")
    print(f"  Workers:  {args.workers}")
    print(f"  Endpoint: http://{args.host}:{args.port}/api/chat")
    print("=" * 60)

    load_model(model_path, args.lora)

    print(f"\nServer starting at http://{args.host}:{args.port}")
    print(f"Ollama-compatible endpoint: http://{args.host}:{args.port}/api/chat")
    if args.host == "0.0.0.0":
        print("Listening on all interfaces - remote devices can connect")
    print("\nPress Ctrl+C to stop.\n")

    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
