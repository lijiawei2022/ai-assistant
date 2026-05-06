"""
DPO 偏好数据生成脚本
使用 SFT 微调后的模型生成多个候选回答，再用 GLM-4.5-air 评分，
选出 chosen（最佳）和 rejected（最差）组成偏好对。

理论依据：
- DPO (Direct Preference Optimization): Rafailov et al., 2023
  "Direct Preference Optimization: Your Language Model is Secretly a Reward Model"
- RLAIF (RL from AI Feedback): Lee et al., 2023
  "RLAIF: Scaling Reinforcement Learning from Human Feedback with AI Feedback"
- LLM-as-a-Judge: Zheng et al., 2023
  "Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena"

DPO Loss:
  L_DPO = -E[log σ(β * (log π_θ(y_w|x)/π_ref(y_w|x) - log π_θ(y_l|x)/π_ref(y_l|x)))]
  其中 y_w = chosen, y_l = rejected, β = 温度参数

与 CE Loss 的区别：
  - CE Loss: 只有一个参考答案，惩罚所有偏离
  - DPO Loss: 只需知道 A 比 B 好，学习偏好关系
  - DPO 更适合开放式 Q&A，因为同一问题有多种正确回答方式
"""

import json
import os
import re
import time
import torch
import requests
import argparse
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
from peft import PeftModel

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_BASE_MODEL = os.path.join(SCRIPT_DIR, "base_model")
DEFAULT_LORA_PATH = os.path.join(SCRIPT_DIR, "output", "final")
DEFAULT_TRAIN_FILE = os.path.join(SCRIPT_DIR, "fine_tune_train_set_c_programming.json")
DEFAULT_OUTPUT_FILE = os.path.join(SCRIPT_DIR, "dpo_preference_data.json")
DEFAULT_NUM_CANDIDATES = 4

GLM_API_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions"
GLM_API_KEY = os.environ.get("GLM_API_KEY", "062fbc74205f4d13b6edfcbc6b084cbc.LIe2858OXG7XgfWc")
GLM_MODEL = "glm-4.5-air"

SYSTEM_PROMPT = "你是程序设计领域的AI助教，专注于帮助学生掌握编程知识和技能。熟悉C语言等主流编程语言，精通数据结构、算法、软件工程等核心知识。\n\n## 输入格式\n每条用户消息固定包含以下四部分（某部分为\"空\"表示未提供）：\n- 用户问题：用户的核心诉求\n- 用户提供的代码：用户选中的代码片段\n- 知识图谱关联：从知识图谱检索的结构化关联信息（知识点层级、错误-原因-解决方案的因果链）\n- 参考文档：从知识库检索的相关文档片段\n\n## 回答要求\n1. 优先依据知识图谱关联理解问题的上下文关系，再结合参考文档获取详细内容\n2. 知识图谱关联不为空时，按图谱中的因果链和解决方案链组织回答结构\n3. 参考文档不为空时，用文档内容充实回答的细节\n4. 用户提供的代码不为空时，结合代码实际情况分析问题，将文档知识与代码对应\n5. 简洁精准，直接回答核心问题\n6. 必要时提供完整可运行的代码示例（用代码块包裹）\n7. 使用简洁中文，专业术语保留英文原文"

JUDGE_PROMPT = """你是一位严格的C语言编程教学评估专家。请对以下AI助教的回答打分。

评分标准（1-10分）：
- 正确性：技术内容是否准确（权重最高）
- 完整性：是否覆盖关键要点
- 有帮助性：对学生是否有实际帮助
- 格式规范：是否遵循回答要求

请只输出一个1-10的整数分数，不要输出其他内容。"""


def load_model(base_model, lora_path):
    tokenizer = AutoTokenizer.from_pretrained(base_model, trust_remote_code=True)
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
    if lora_path and os.path.exists(lora_path):
        model = PeftModel.from_pretrained(model, lora_path)
        print(f"  Loaded LoRA from: {lora_path}")
    model.eval()
    return model, tokenizer


def generate_candidates(model, tokenizer, user_content, num_candidates=4):
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_content},
    ]
    text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    inputs = tokenizer(text, return_tensors="pt").to(model.device)

    candidates = []
    for i in range(num_candidates):
        with torch.no_grad():
            outputs = model.generate(
                **inputs,
                max_new_tokens=512,
                temperature=0.9,
                top_p=0.95,
                top_k=50,
                do_sample=True,
                repetition_penalty=1.1,
            )
        response = tokenizer.decode(
            outputs[0][inputs["input_ids"].shape[1]:],
            skip_special_tokens=True,
        )
        candidates.append(response.strip())
    return candidates


def score_with_glm(question, answer):
    user_content = f"问题：{question}\n\n回答：{answer}\n\n请打分："
    headers = {
        "Authorization": f"Bearer {GLM_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": GLM_MODEL,
        "messages": [
            {"role": "system", "content": JUDGE_PROMPT},
            {"role": "user", "content": user_content},
        ],
        "temperature": 0.1,
        "max_tokens": 10,
    }

    try:
        response = requests.post(GLM_API_URL, headers=headers, json=payload, timeout=30)
        response.raise_for_status()
        content = response.json()["choices"][0]["message"]["content"].strip()
        match = re.search(r'(\d+)', content)
        if match:
            score = int(match.group(1))
            return min(max(score, 1), 10)
        return 5
    except Exception as e:
        print(f"    GLM API error: {str(e)[:80]}")
        return 5


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base_model", type=str, default=DEFAULT_BASE_MODEL)
    parser.add_argument("--lora_path", type=str, default=DEFAULT_LORA_PATH)
    parser.add_argument("--train_file", type=str, default=DEFAULT_TRAIN_FILE)
    parser.add_argument("--output_file", type=str, default=DEFAULT_OUTPUT_FILE)
    parser.add_argument("--num_candidates", type=int, default=DEFAULT_NUM_CANDIDATES)
    parser.add_argument("--max_samples", type=int, default=None,
                        help="Max number of samples to process (for testing)")
    args = parser.parse_args()

    with open(args.train_file, "r", encoding="utf-8") as f:
        train_data = json.load(f)

    if args.max_samples:
        train_data = train_data[:args.max_samples]

    print(f"Loading model...")
    model, tokenizer = load_model(args.base_model, args.lora_path)

    preference_data = []
    print(f"\nGenerating preference data for {len(train_data)} samples...")
    print(f"Candidates per question: {args.num_candidates}")

    for i, entry in enumerate(train_data):
        messages = entry["messages"]
        user_msg = messages[1]["content"]
        reference = messages[2]["content"]

        q_match = re.search(r'用户问题：(.*?)(?:\n\n|$)', user_msg)
        question = q_match.group(1).strip() if q_match else f"问题{i+1}"

        print(f"\n[{i+1}/{len(train_data)}] {question[:50]}...")

        candidates = generate_candidates(model, tokenizer, user_msg, args.num_candidates)
        candidates.append(reference)
        all_answers = candidates

        scores = []
        for j, ans in enumerate(all_answers):
            score = score_with_glm(question, ans)
            scores.append(score)
            label = "参考" if j == len(all_answers) - 1 else f"候选{j+1}"
            print(f"  {label}: {score}/10 ({len(ans)}字)")
            time.sleep(0.5)

        max_idx = scores.index(max(scores))
        min_idx = scores.index(min(scores))

        if max_idx == min_idx:
            print(f"  跳过（所有回答得分相同: {scores[max_idx]}）")
            continue

        chosen = all_answers[max_idx]
        rejected = all_answers[min_idx]

        if chosen == rejected:
            continue

        preference_data.append({
            "prompt": user_msg,
            "chosen": chosen,
            "rejected": rejected,
            "chosen_score": scores[max_idx],
            "rejected_score": scores[min_idx],
            "score_gap": scores[max_idx] - scores[min_idx],
        })

        print(f"  → chosen={scores[max_idx]}, rejected={scores[min_idx]}, gap={scores[max_idx]-scores[min_idx]}")

    with open(args.output_file, "w", encoding="utf-8") as f:
        json.dump(preference_data, f, ensure_ascii=False, indent=2)

    print(f"\n{'=' * 60}")
    print(f"Preference data saved: {args.output_file}")
    print(f"Total pairs: {len(preference_data)}")
    if preference_data:
        avg_gap = sum(d["score_gap"] for d in preference_data) / len(preference_data)
        print(f"Average score gap: {avg_gap:.1f}")
    print(f"\nNext step: python finetune_dpo.py")


if __name__ == "__main__":
    main()
