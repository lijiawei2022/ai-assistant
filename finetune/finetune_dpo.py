"""
DPO (Direct Preference Optimization) 微调脚本
在 SFT 基础上进行第二阶段训练，让模型学会区分好回答和差回答

理论依据：
- Rafailov et al., 2023 "Direct Preference Optimization:
  Your Language Model is Secretly a Reward Model"
  证明了 DPO 是 RLHF 的闭式解，无需单独训练奖励模型

DPO Loss:
  L_DPO = -E[log σ(β * (log π_θ(y_w|x)/π_ref(y_w|x)
                         - log π_θ(y_l|x)/π_ref(y_l|x)))]

  y_w = chosen (更好的回答)
  y_l = rejected (更差的回答)
  π_ref = SFT 模型（参考策略，训练中冻结）
  π_θ = 当前策略（训练中更新）
  β = 温度参数，控制偏好强度

与 SFT (CE Loss) 的对比：
  ┌─────────────┬──────────────────────┬──────────────────────┐
  │             │ SFT (CE Loss)        │ DPO                  │
  ├─────────────┼──────────────────────┼──────────────────────┤
  │ 训练信号     │ 模仿参考答案          │ 学习偏好关系          │
  │ 答案唯一性   │ 假设唯一正确答案      │ 只需 A 比 B 好        │
  │ 语义等价     │ 不同措辞被惩罚        │ 正确措辞多样性被保留   │
  │ 质量梯度     │ 无法区分             │ 显式区分好/差回答      │
  │ 过拟合风险   │ 容易过拟合特定措辞    │ 学习偏好方向，更鲁棒   │
  └─────────────┴──────────────────────┴──────────────────────┘

显存预算（6GB RTX 3060）：
  - 模型权重 (4-bit):         ~1.8 GB
  - LoRA 参数 (fp16):          ~0.05 GB
  - 参考模型 (共享基底):        0 GB (与训练模型共享4-bit权重)
  - 优化器状态 (8-bit):        ~0.1 GB
  - 梯度 + 激活值:             ~2.0 GB
  - 总计:                      ~4.0 GB
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
)
from peft import LoraConfig, get_peft_model, TaskType, prepare_model_for_kbit_training
from trl import DPOConfig, DPOTrainer

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_BASE_MODEL = os.path.join(SCRIPT_DIR, "base_model")
DEFAULT_SFT_PATH = os.path.join(SCRIPT_DIR, "output", "final")
DEFAULT_DPO_DATA = os.path.join(SCRIPT_DIR, "dpo_preference_data.json")
DEFAULT_OUTPUT_DIR = os.path.join(SCRIPT_DIR, "output_dpo")


@dataclass
class DPOFineTuneConfig:
    model_name: str = field(default=DEFAULT_BASE_MODEL)
    sft_path: str = field(default=DEFAULT_SFT_PATH)
    dpo_data_file: str = field(default=DEFAULT_DPO_DATA)
    output_dir: str = field(default=DEFAULT_OUTPUT_DIR)

    max_seq_length: int = field(default=1024)
    lora_rank: int = field(default=8)
    lora_alpha: int = field(default=16)
    lora_dropout: float = field(default=0.05)

    per_device_train_batch_size: int = field(default=1)
    gradient_accumulation_steps: int = field(default=8)
    learning_rate: float = field(default=5e-5)
    num_train_epochs: int = field(default=1)
    warmup_ratio: float = field(default=0.1)
    weight_decay: float = field(default=0.01)
    lr_scheduler_type: str = field(default="cosine")

    beta: float = field(default=0.1)

    logging_steps: int = field(default=5)
    save_steps: int = field(default=50)
    save_total_limit: int = field(default=3)


def create_bnb_config() -> BitsAndBytesConfig:
    return BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16,
        bnb_4bit_use_double_quant=True,
    )


def create_lora_config(cfg: DPOFineTuneConfig) -> LoraConfig:
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


def main():
    cfg = DPOFineTuneConfig()

    if not os.path.exists(cfg.model_name):
        print(f"ERROR: Base model not found at: {cfg.model_name}")
        return

    if not os.path.exists(cfg.dpo_data_file):
        print(f"ERROR: DPO data not found at: {cfg.dpo_data_file}")
        print("Please generate preference data first:")
        print("  python generate_dpo_data.py")
        return

    print("=" * 60)
    print("DPO Fine-tuning (Stage 2: Preference Optimization)")
    print(f"Base model: {cfg.model_name}")
    print(f"SFT LoRA: {cfg.sft_path}")
    print(f"DPO data: {cfg.dpo_data_file}")
    print(f"LoRA Rank: {cfg.lora_rank}, Alpha: {cfg.lora_alpha}")
    print(f"Beta (preference strength): {cfg.beta}")
    print(f"Batch Size: {cfg.per_device_train_batch_size} x {cfg.gradient_accumulation_steps}")
    print(f"Epochs: {cfg.num_train_epochs}")
    print(f"Learning Rate: {cfg.learning_rate}")
    print(f"Output: {cfg.output_dir}")
    print("=" * 60)

    print("\n[1/5] Loading tokenizer...")
    tokenizer = AutoTokenizer.from_pretrained(
        cfg.model_name,
        trust_remote_code=True,
        padding_side="right",
    )
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    print("\n[2/5] Loading model with 4-bit quantization...")
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

    if os.path.exists(cfg.sft_path):
        print(f"  Loading SFT LoRA weights: {cfg.sft_path}")
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, cfg.sft_path)
        model = model.merge_and_unload()
        print("  SFT weights merged into base model")
        model = prepare_model_for_kbit_training(
            model,
            use_gradient_checkpointing=True,
        )
        model.gradient_checkpointing_enable()
        model.enable_input_require_grads()

    print("\n[3/5] Applying LoRA for DPO...")
    lora_config = create_lora_config(cfg)
    model = get_peft_model(model, lora_config)
    model.print_trainable_parameters()

    print("\n[4/5] Loading DPO preference data...")
    with open(cfg.dpo_data_file, "r", encoding="utf-8") as f:
        dpo_data = json.load(f)

    dataset = Dataset.from_list(dpo_data)
    print(f"  Preference pairs: {len(dataset)}")
    if len(dataset) > 0:
        avg_gap = sum(d.get("score_gap", 0) for d in dpo_data) / len(dpo_data)
        print(f"  Average score gap: {avg_gap:.1f}")

    train_test_split = dataset.train_test_split(test_size=0.1, seed=42)
    train_dataset = train_test_split["train"]
    eval_dataset = train_test_split["test"]
    print(f"  Train: {len(train_dataset)}, Eval: {len(eval_dataset)}")

    print("\n[5/5] Starting DPO training...")
    training_args = DPOConfig(
        output_dir=cfg.output_dir,
        per_device_train_batch_size=cfg.per_device_train_batch_size,
        gradient_accumulation_steps=cfg.gradient_accumulation_steps,
        learning_rate=cfg.learning_rate,
        num_train_epochs=cfg.num_train_epochs,
        lr_scheduler_type=cfg.lr_scheduler_type,
        warmup_ratio=cfg.warmup_ratio,
        weight_decay=cfg.weight_decay,
        bf16=True,
        beta=cfg.beta,
        max_length=cfg.max_seq_length,
        max_prompt_length=cfg.max_seq_length // 2,
        logging_steps=cfg.logging_steps,
        save_steps=cfg.save_steps,
        save_total_limit=cfg.save_total_limit,
        report_to="none",
        remove_unused_columns=False,
        dataloader_pin_memory=False,
        gradient_checkpointing=True,
        optim="paged_adamw_8bit",
        max_grad_norm=1.0,
    )

    trainer = DPOTrainer(
        model=model,
        args=training_args,
        train_dataset=train_dataset,
        eval_dataset=eval_dataset,
        processing_class=tokenizer,
    )

    trainer.train()

    print("\nDPO training complete! Saving model...")
    output_dir = os.path.join(cfg.output_dir, "final")
    trainer.save_model(output_dir)
    tokenizer.save_pretrained(output_dir)

    print(f"Model saved to: {output_dir}")
    print("\nNext steps:")
    print(f"  1. Test:  python test_inference.py --lora {output_dir}")
    print(f"  2. Eval:  python evaluate_with_glm.py")
    print(f"  3. Merge: python merge_lora.py --lora_path {output_dir}")


if __name__ == "__main__":
    main()
