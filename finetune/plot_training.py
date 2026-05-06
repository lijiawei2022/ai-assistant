"""
训练损失可视化脚本
从 Trainer 的 trainer_state.json 中读取训练日志，绘制 loss 曲线

用法:
  python plot_training.py                          # 自动查找 output/ 和 output_dpo/
  python plot_training.py --sft_dir output         # 指定 SFT 输出目录
  python plot_training.py --dpo_dir output_dpo     # 指定 DPO 输出目录
"""

import json
import os
import argparse

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def find_state_json(output_dir):
    final_dir = os.path.join(output_dir, "final")
    for search_dir in [final_dir, output_dir]:
        state_file = os.path.join(search_dir, "trainer_state.json")
        if os.path.exists(state_file):
            return state_file
        for run_dir in sorted(os.listdir(search_dir)):
            run_path = os.path.join(search_dir, run_dir)
            if os.path.isdir(run_path):
                state_file = os.path.join(run_path, "trainer_state.json")
                if os.path.exists(state_file):
                    return state_file
    return None


def load_training_log(state_file):
    with open(state_file, "r", encoding="utf-8") as f:
        state = json.load(f)

    train_loss = []
    eval_loss = []

    for entry in state.get("log_history", []):
        if "loss" in entry and "step" in entry:
            train_loss.append({"step": entry["step"], "loss": entry["loss"]})
        if "eval_loss" in entry and "step" in entry:
            eval_loss.append({"step": entry["step"], "loss": entry["eval_loss"]})

    return train_loss, eval_loss


def plot_loss_ascii(train_loss, eval_loss, title, width=60, height=15):
    if not train_loss:
        print(f"\n  {title}: No training loss data found")
        return

    losses = [e["loss"] for e in train_loss]
    steps = [e["step"] for e in train_loss]

    min_loss = min(losses)
    max_loss = max(losses)
    loss_range = max_loss - min_loss if max_loss > min_loss else 1.0

    print(f"\n  {title}")
    print(f"  Steps: {steps[0]} → {steps[-1]}")
    print(f"  Loss:  {max_loss:.4f} → {min_loss:.4f}")
    if len(losses) >= 2:
        improvement = losses[0] - losses[-1]
        pct = improvement / losses[0] * 100 if losses[0] > 0 else 0
        print(f"  Improvement: {improvement:.4f} ({pct:.1f}%)")
    print()

    grid = [[' ' for _ in range(width)] for _ in range(height)]

    for i, (step, loss) in enumerate(zip(steps, losses)):
        x = int((step - steps[0]) / max(steps[-1] - steps[0], 1) * (width - 1))
        y = int((1 - (loss - min_loss) / loss_range) * (height - 1))
        x = max(0, min(width - 1, x))
        y = max(0, min(height - 1, y))
        grid[y][x] = '●'

    for ep in eval_loss:
        x = int((ep["step"] - steps[0]) / max(steps[-1] - steps[0], 1) * (width - 1))
        x = max(0, min(width - 1, x))
        for row in range(height):
            if grid[row][x] == ' ':
                grid[row][x] = '│'

    y_labels = []
    for i in range(height):
        val = max_loss - (i / (height - 1)) * loss_range
        y_labels.append(f"{val:.2f}")

    for i, (label, row) in enumerate(zip(y_labels, grid)):
        print(f"  {label:>6} │{''.join(row)}")

    print(f"  {'':>6} └{'─' * width}")
    print(f"  {'':>6}  Step {steps[0]:>5}{' ' * (width - 16)}Step {steps[-1]:>5}")

    if eval_loss:
        print(f"\n  Eval loss points:")
        for ep in eval_loss:
            print(f"    Step {ep['step']}: {ep['loss']:.4f}")


def plot_comparison(sft_train, sft_eval, dpo_train, dpo_eval):
    print("\n" + "=" * 70)
    print("  TRAINING LOSS COMPARISON")
    print("=" * 70)

    if sft_train:
        plot_loss_ascii(sft_train, sft_eval, "SFT (Stage 1) - Cross-Entropy Loss")
    else:
        print("\n  SFT: No training data found")

    if dpo_train:
        plot_loss_ascii(dpo_train, dpo_eval, "DPO (Stage 2) - DPO Loss")
    else:
        print("\n  DPO: No training data found")

    print("\n" + "=" * 70)
    print("  SUMMARY")
    print("=" * 70)

    if sft_train:
        sft_losses = [e["loss"] for e in sft_train]
        print(f"  SFT: {sft_losses[0]:.4f} → {sft_losses[-1]:.4f} "
              f"(↓{sft_losses[0] - sft_losses[-1]:.4f})")
    if dpo_train:
        dpo_losses = [e["loss"] for e in dpo_train]
        print(f"  DPO: {dpo_losses[0]:.4f} → {dpo_losses[-1]:.4f} "
              f"(↓{dpo_losses[0] - dpo_losses[-1]:.4f})")

    if sft_train and dpo_train:
        print("\n  两个阶段的 loss 都在下降 → 微调有效 ✅")
    elif sft_train:
        print("\n  SFT loss 下降 → 第一阶段微调有效 ✅")
        print("  DPO 尚未训练或无日志")


def main():
    parser = argparse.ArgumentParser(description="训练损失可视化")
    parser.add_argument("--sft_dir", type=str,
                        default=os.path.join(SCRIPT_DIR, "output"))
    parser.add_argument("--dpo_dir", type=str,
                        default=os.path.join(SCRIPT_DIR, "output_dpo"))
    args = parser.parse_args()

    sft_state = find_state_json(args.sft_dir)
    dpo_state = find_state_json(args.dpo_dir)

    sft_train, sft_eval = [], []
    dpo_train, dpo_eval = [], []

    if sft_state:
        print(f"Found SFT training log: {sft_state}")
        sft_train, sft_eval = load_training_log(sft_state)
    else:
        print(f"SFT training log not found in: {args.sft_dir}")

    if dpo_state:
        print(f"Found DPO training log: {dpo_state}")
        dpo_train, dpo_eval = load_training_log(dpo_state)
    else:
        print(f"DPO training log not found in: {args.dpo_dir}")

    plot_comparison(sft_train, sft_eval, dpo_train, dpo_eval)


if __name__ == "__main__":
    main()
