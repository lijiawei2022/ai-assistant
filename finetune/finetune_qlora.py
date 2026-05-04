"""
QLoRA 微调 Qwen2.5-Coder-3B-Instruct 用于 C 语言编程教学
适配 RTX 3060 Laptop 6GB 显存

显存预算分析（4-bit 量化 + LoRA）:
- 模型权重 (4-bit):        ~1.8 GB
- LoRA 参数 (fp16):         ~0.05 GB
- 优化器状态 (8-bit):       ~0.1 GB
- 梯度 (fp16):              ~0.05 GB
- 激活值 (gradient ckpt):   ~1.5 GB
- KV Cache:                 ~0.5 GB
- 其他开销:                 ~0.5 GB
- 总计:                     ~4.5 GB (6GB 显存可容纳)
"""

import json
import os
import torch
from dataclasses import dataclass, field
from typing import Optional
from datasets import Dataset
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    BitsAndBytesConfig,
    TrainingArguments,
    Trainer,
    DataCollatorForSeq2Seq,
)
from peft import LoraConfig, get_peft_model, TaskType, prepare_model_for_kbit_training

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_BASE_MODEL = os.path.join(SCRIPT_DIR, "base_model")


@dataclass
class FineTuneConfig:
    model_name: str = field(default=DEFAULT_BASE_MODEL)
    train_file: str = field(default=os.path.join(SCRIPT_DIR, "fine_tune_train_set_c_programming.json"))
    test_file: str = field(default=os.path.join(SCRIPT_DIR, "fine_tune_test_set_c_programming.json"))
    output_dir: str = field(default=os.path.join(SCRIPT_DIR, "output"))

    max_seq_length: int = field(default=1024)
    lora_rank: int = field(default=8)
    lora_alpha: int = field(default=16)
    lora_dropout: float = field(default=0.05)

    per_device_train_batch_size: int = field(default=1)
    gradient_accumulation_steps: int = field(default=8)
    learning_rate: float = field(default=2e-4)
    num_train_epochs: int = field(default=3)
    warmup_ratio: float = field(default=0.1)
    weight_decay: float = field(default=0.01)
    lr_scheduler_type: str = field(default="cosine")

    logging_steps: int = field(default=10)
    save_steps: int = field(default=100)
    eval_steps: int = field(default=100)
    save_total_limit: int = field(default=3)


def load_dataset(file_path: str) -> Dataset:
    with open(file_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return Dataset.from_list(data)


def create_bnb_config() -> BitsAndBytesConfig:
    return BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16,
        bnb_4bit_use_double_quant=True,
    )


def create_lora_config(cfg: FineTuneConfig) -> LoraConfig:
    return LoraConfig(
        task_type=TaskType.CAUSAL_LM,
        r=cfg.lora_rank,
        lora_alpha=cfg.lora_alpha,
        lora_dropout=cfg.lora_dropout,
        target_modules=[
            "q_proj", "k_proj", "v_proj", "o_proj",
            "gate_proj", "up_proj", "down_proj",
        ],
        bias="none",
    )


def tokenize_function(examples, tokenizer, max_seq_length):
    input_ids_list = []
    labels_list = []

    for messages in examples["messages"]:
        full_text = tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=False,
        )
        full_encodings = tokenizer(
            full_text,
            truncation=True,
            max_length=max_seq_length,
            padding=False,
        )
        input_ids = full_encodings["input_ids"]

        assistant_text = ""
        for msg in messages:
            if msg["role"] == "assistant":
                assistant_text += msg["content"]

        if assistant_text:
            assistant_encodings = tokenizer(
                assistant_text,
                truncation=True,
                max_length=max_seq_length,
                padding=False,
            )
            assistant_len = len(assistant_encodings["input_ids"])
        else:
            assistant_len = 0

        labels = [-100] * (len(input_ids) - assistant_len) + input_ids[-assistant_len:]

        if len(labels) > max_seq_length:
            labels = labels[:max_seq_length]

        input_ids_list.append(input_ids)
        labels_list.append(labels)

    return {
        "input_ids": input_ids_list,
        "labels": labels_list,
    }


def main():
    cfg = FineTuneConfig()

    if not os.path.exists(cfg.model_name):
        print(f"ERROR: Base model not found at: {cfg.model_name}")
        print("Please download the model first:")
        print("  python download_model.py")
        return

    if not os.path.exists(cfg.train_file):
        print(f"ERROR: Training data not found at: {cfg.train_file}")
        return

    print("=" * 60)
    print("QLoRA Fine-tuning for C Programming Teaching")
    print(f"Base model: {cfg.model_name}")
    print(f"LoRA Rank: {cfg.lora_rank}, Alpha: {cfg.lora_alpha}")
    print(f"Batch Size: {cfg.per_device_train_batch_size} x {cfg.gradient_accumulation_steps} accumulation")
    print(f"Max Seq Length: {cfg.max_seq_length}")
    print(f"Epochs: {cfg.num_train_epochs}")
    print(f"Output: {cfg.output_dir}")
    print("=" * 60)

    print("\n[1/6] Loading tokenizer...")
    tokenizer = AutoTokenizer.from_pretrained(
        cfg.model_name,
        trust_remote_code=True,
        padding_side="right",
    )
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    print("\n[2/6] Loading model with 4-bit quantization...")
    bnb_config = create_bnb_config()
    model = AutoModelForCausalLM.from_pretrained(
        cfg.model_name,
        quantization_config=bnb_config,
        device_map="auto",
        trust_remote_code=True,
        torch_dtype=torch.bfloat16,
        attn_implementation="eager",
    )
    model = prepare_model_for_kbit_training(
        model,
        use_gradient_checkpointing=True,
    )
    model.gradient_checkpointing_enable()
    model.enable_input_require_grads()

    print("\n[3/6] Applying LoRA...")
    lora_config = create_lora_config(cfg)
    model = get_peft_model(model, lora_config)
    model.print_trainable_parameters()

    print("\n[4/6] Loading and tokenizing dataset...")
    train_dataset = load_dataset(cfg.train_file)
    print(f"  Training samples: {len(train_dataset)}")

    eval_dataset = None
    if os.path.exists(cfg.test_file):
        eval_dataset = load_dataset(cfg.test_file)
        test_messages = []
        for item in eval_dataset:
            test_messages.append({"messages": item["messages"]})
        eval_dataset = Dataset.from_list(test_messages)
        print(f"  Eval samples: {len(eval_dataset)}")

    tokenize_fn = lambda examples: tokenize_function(
        examples, tokenizer, cfg.max_seq_length
    )

    train_dataset = train_dataset.map(
        tokenize_fn,
        batched=True,
        remove_columns=train_dataset.column_names,
    )

    if eval_dataset is not None:
        eval_dataset = eval_dataset.map(
            tokenize_fn,
            batched=True,
            remove_columns=eval_dataset.column_names,
        )

    print("\n[5/6] Configuring training arguments...")
    training_args = TrainingArguments(
        output_dir=cfg.output_dir,
        per_device_train_batch_size=cfg.per_device_train_batch_size,
        gradient_accumulation_steps=cfg.gradient_accumulation_steps,
        learning_rate=cfg.learning_rate,
        num_train_epochs=cfg.num_train_epochs,
        lr_scheduler_type=cfg.lr_scheduler_type,
        warmup_ratio=cfg.warmup_ratio,
        weight_decay=cfg.weight_decay,
        bf16=True,
        logging_steps=cfg.logging_steps,
        save_steps=cfg.save_steps,
        eval_strategy="steps" if eval_dataset else "no",
        eval_steps=cfg.eval_steps if eval_dataset else None,
        save_total_limit=cfg.save_total_limit,
        report_to="none",
        remove_unused_columns=False,
        dataloader_pin_memory=False,
        gradient_checkpointing=True,
        optim="paged_adamw_8bit",
        max_grad_norm=1.0,
    )

    data_collator = DataCollatorForSeq2Seq(
        tokenizer=tokenizer,
        padding=True,
        max_length=cfg.max_seq_length,
    )

    print("\n[6/6] Starting training...")
    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=train_dataset,
        eval_dataset=eval_dataset,
        data_collator=data_collator,
    )

    trainer.train()

    print("\nTraining complete! Saving model...")
    output_dir = os.path.join(cfg.output_dir, "final")
    trainer.save_model(output_dir)
    tokenizer.save_pretrained(output_dir)

    print(f"Model saved to: {output_dir}")
    print("\nNext steps:")
    print(f"  1. Test:  python test_inference.py")
    print(f"  2. Merge: python merge_lora.py")


if __name__ == "__main__":
    main()
