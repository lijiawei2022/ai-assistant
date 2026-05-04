"""
HuggingFace 模型推理服务
兼容 Ollama /api/chat 接口格式，供 VSCode 插件直接调用

用法:
  python serve.py                          # 使用 base_model
  python serve.py --lora output/final      # 使用 LoRA 微调后的模型
  python serve.py --port 8000              # 指定端口

启动后，插件只需将 OLLAMA_URL 改为 http://localhost:8000/api/chat
"""

import os
import sys
import json
import argparse
import time
from typing import Optional

import torch
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
from pydantic import BaseModel
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_BASE_MODEL = os.path.join(SCRIPT_DIR, "base_model")
DEFAULT_PORT = 8000

app = FastAPI(title="HuggingFace LLM Serve (Ollama-compatible)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

model = None
tokenizer = None


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


@app.post("/api/chat")
async def chat(request: ChatRequest):
    global model, tokenizer

    if model is None or tokenizer is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    messages_dict = [{"role": m.role, "content": m.content} for m in request.messages]

    text = tokenizer.apply_chat_template(
        messages_dict,
        tokenize=False,
        add_generation_prompt=True,
    )
    inputs = tokenizer(text, return_tensors="pt").to(model.device)

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

    with torch.no_grad():
        outputs = model.generate(
            **inputs,
            **gen_kwargs,
        )

    response_text = tokenizer.decode(
        outputs[0][inputs["input_ids"].shape[1]:],
        skip_special_tokens=True,
    )

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


def load_model(base_model: str, lora_path: Optional[str] = None):
    global model, tokenizer

    print(f"Loading tokenizer from: {base_model}")
    tokenizer = AutoTokenizer.from_pretrained(
        base_model,
        trust_remote_code=True,
        padding_side="right",
    )
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    print(f"Loading model from: {base_model}")
    print("Using 4-bit quantization (NF4) to fit in 6GB VRAM...")

    from transformers import BitsAndBytesConfig
    bnb_config = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16,
        bnb_4bit_use_double_quant=True,
    )

    model = AutoModelForCausalLM.from_pretrained(
        base_model,
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
    parser.add_argument("--base_model", type=str, default=DEFAULT_BASE_MODEL)
    parser.add_argument("--lora", type=str, default=None,
                        help="Path to LoRA weights (e.g. output/final)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    args = parser.parse_args()

    if not os.path.exists(args.base_model):
        print(f"ERROR: Base model not found at: {args.base_model}")
        print("Please download the model first: python download_model.py")
        sys.exit(1)

    print("=" * 60)
    print("  HuggingFace LLM Serve (Ollama-compatible)")
    print(f"  Base model: {args.base_model}")
    print(f"  LoRA:       {args.lora or 'None (base model only)'}")
    print(f"  Port:       {args.port}")
    print(f"  Endpoint:   http://localhost:{args.port}/api/chat")
    print("=" * 60)

    load_model(args.base_model, args.lora)

    print(f"\nServer starting at http://localhost:{args.port}")
    print(f"Ollama-compatible endpoint: http://localhost:{args.port}/api/chat")
    print("\nTo use in plugin, change OLLAMA_URL to:")
    print(f'  const OLLAMA_URL = "http://localhost:{args.port}/api/chat";')
    print("\nPress Ctrl+C to stop.\n")

    uvicorn.run(app, host="0.0.0.0", port=args.port, log_level="warning")
