"""
LLM-as-a-Judge 评估脚本
使用 GLM-4.5-air 对微调模型的回答进行评分

评估维度：
1. 正确性 (1-5)：技术内容是否正确
2. 完整性 (1-5)：是否完整回答了问题
3. 有帮助性 (1-5)：对学生是否有实际帮助
4. 格式规范 (1-5)：是否遵循插件消息格式要求
"""

import json
import os
import re
import time
import argparse
import torch
import requests
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
from peft import PeftModel

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_BASE_MODEL = os.path.join(SCRIPT_DIR, "base_model")
DEFAULT_LORA_PATH = os.path.join(SCRIPT_DIR, "output", "final")
DEFAULT_TEST_FILE = os.path.join(SCRIPT_DIR, "fine_tune_test_set_c_programming.json")

GLM_API_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions"
GLM_API_KEY = os.environ.get("GLM_API_KEY", "062fbc74205f4d13b6edfcbc6b084cbc.LIe2858OXG7XgfWc")
GLM_MODEL = "glm-4.5-air"

SYSTEM_PROMPT = "你是程序设计领域的AI助教，专注于帮助学生掌握编程知识和技能。熟悉C语言等主流编程语言，精通数据结构、算法、软件工程等核心知识。\n\n## 输入格式\n每条用户消息固定包含以下四部分（某部分为\"空\"表示未提供）：\n- 用户问题：用户的核心诉求\n- 用户提供的代码：用户选中的代码片段\n- 知识图谱关联：从知识图谱检索的结构化关联信息（知识点层级、错误-原因-解决方案的因果链）\n- 参考文档：从知识库检索的相关文档片段\n\n## 回答要求\n1. 优先依据知识图谱关联理解问题的上下文关系，再结合参考文档获取详细内容\n2. 知识图谱关联不为空时，按图谱中的因果链和解决方案链组织回答结构\n3. 参考文档不为空时，用文档内容充实回答的细节\n4. 用户提供的代码不为空时，结合代码实际情况分析问题，将文档知识与代码对应\n5. 简洁精准，直接回答核心问题\n6. 必要时提供完整可运行的代码示例（用代码块包裹）\n7. 使用简洁中文，专业术语保留英文原文"

JUDGE_SYSTEM_PROMPT = """你是一位严格的C语言编程教学评估专家。你的任务是评估AI助教的回答质量。

评分标准（每项1-5分）：

1. **正确性**：技术内容是否准确无误
   - 5分：完全正确，无任何技术错误
   - 4分：基本正确，有微小瑕疵
   - 3分：主要观点正确，但有部分错误
   - 2分：存在明显技术错误
   - 1分：严重错误或误导

2. **完整性**：是否完整回答了问题
   - 5分：全面覆盖，包含所有要点
   - 4分：覆盖主要要点，略有遗漏
   - 3分：回答了核心问题，但不够深入
   - 2分：只回答了部分问题
   - 1分：几乎没有回答问题

3. **有帮助性**：对学生是否有实际帮助
   - 5分：非常有帮助，提供修复代码和关键要点
   - 4分：有帮助，但可以更实用
   - 3分：有一定帮助，但缺乏实操指导
   - 2分：帮助有限
   - 1分：没有帮助

4. **格式规范**：是否遵循助教回答要求
   - 5分：完全遵循（简洁中文、代码块、专业术语保留英文）
   - 4分：基本遵循，小问题
   - 3分：部分遵循
   - 2分：格式混乱
   - 1分：完全不符合

请严格按照以下JSON格式输出评分，不要输出其他内容：
{"correctness": X, "completeness": X, "helpfulness": X, "format": X, "comment": "简短评语"}"""


def load_finetuned_model(base_model=DEFAULT_BASE_MODEL, lora_path=DEFAULT_LORA_PATH):
    print("Loading fine-tuned model...")
    print(f"  Base model: {base_model}")
    print(f"  LoRA path: {lora_path}")
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
    model.eval()
    return model, tokenizer


def generate_answer(model, tokenizer, user_content):
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_content},
    ]
    text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    inputs = tokenizer(text, return_tensors="pt").to(model.device)

    with torch.no_grad():
        outputs = model.generate(
            **inputs,
            max_new_tokens=512,
            temperature=0.7,
            top_p=0.9,
            do_sample=True,
            repetition_penalty=1.1,
        )

    return tokenizer.decode(outputs[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True)


def judge_with_glm(question, reference_answer, model_answer, code=None, docs=None):
    user_content = f"""请评估以下AI助教的回答质量。

## 用户问题
{question}
"""
    if code:
        user_content += f"\n## 用户提供的代码\n```\n{code}\n```\n"
    if docs:
        user_content += f"\n## 参考文档\n{docs}\n"

    user_content += f"""
## 参考答案（评分参照，模型回答不必完全一致，只要语义正确即可）
{reference_answer}

## 模型回答（需要评估的内容）
{model_answer}

请对"模型回答"进行评分，参考答案仅作参考，模型回答只要技术正确、逻辑清晰即可得高分。"""

    headers = {
        "Authorization": f"Bearer {GLM_API_KEY}",
        "Content-Type": "application/json",
    }

    payload = {
        "model": GLM_MODEL,
        "messages": [
            {"role": "system", "content": JUDGE_SYSTEM_PROMPT},
            {"role": "user", "content": user_content},
        ],
        "temperature": 0.1,
        "max_tokens": 500,
    }

    try:
        response = requests.post(GLM_API_URL, headers=headers, json=payload, timeout=30)
        response.raise_for_status()
        result = response.json()
        content = result["choices"][0]["message"]["content"]

        match = re.search(r'\{[^}]+\}', content)
        if match:
            scores = json.loads(match.group())
            return scores
        else:
            return {"correctness": 0, "completeness": 0, "helpfulness": 0, "format": 0, "comment": f"解析失败: {content[:100]}"}
    except Exception as e:
        return {"correctness": 0, "completeness": 0, "helpfulness": 0, "format": 0, "comment": f"API错误: {str(e)[:100]}"}


def main():
    parser = argparse.ArgumentParser(description="LLM-as-a-Judge 评估微调模型")
    parser.add_argument("--base_model", type=str, default=DEFAULT_BASE_MODEL)
    parser.add_argument("--lora_path", type=str, default=DEFAULT_LORA_PATH)
    parser.add_argument("--test_file", type=str, default=DEFAULT_TEST_FILE)
    parser.add_argument("--max_samples", type=int, default=None,
                        help="Max number of samples to evaluate")
    args = parser.parse_args()

    with open(args.test_file, "r", encoding="utf-8") as f:
        test_data = json.load(f)

    if args.max_samples:
        test_data = test_data[:args.max_samples]

    model, tokenizer = load_finetuned_model(args.base_model, args.lora_path)

    results = []
    total_scores = {"correctness": 0, "completeness": 0, "helpfulness": 0, "format": 0}
    valid_count = 0

    print(f"\n{'=' * 60}")
    print(f"LLM-as-a-Judge Evaluation ({GLM_MODEL})")
    print(f"Test samples: {len(test_data)}")
    print(f"{'=' * 60}")

    for i, entry in enumerate(test_data):
        messages = entry["messages"]
        user_msg = messages[1]["content"]
        reference = messages[2]["content"]

        question_match = re.search(r'用户问题：(.*?)(?:\n\n|$)', user_msg)
        question = question_match.group(1).strip() if question_match else "未知问题"

        code_match = re.search(r'用户提供的代码：\n(.*?)(?:\n\n参考文档|$)', user_msg, re.DOTALL)
        code = code_match.group(1).strip() if code_match and code_match.group(1) != "空" else None

        docs_match = re.search(r'参考文档：\n(.*)', user_msg, re.DOTALL)
        docs = docs_match.group(1).strip() if docs_match and docs_match.group(1) != "空" else None

        print(f"\n[{i+1}/{len(test_data)}] {question[:50]}...")

        model_answer = generate_answer(model, tokenizer, user_msg)
        print(f"  生成回答完成 ({len(model_answer)} 字)")

        scores = judge_with_glm(question, reference, model_answer, code, docs)
        print(f"  评分: 正确={scores.get('correctness',0)} 完整={scores.get('completeness',0)} "
              f"有帮助={scores.get('helpfulness',0)} 格式={scores.get('format',0)}")
        if scores.get('comment'):
            print(f"  评语: {scores['comment'][:80]}")

        if scores.get('correctness', 0) > 0:
            for key in total_scores:
                total_scores[key] += scores.get(key, 0)
            valid_count += 1

        results.append({
            "index": i + 1,
            "question": question,
            "has_code": code is not None,
            "has_docs": docs is not None,
            "model_answer": model_answer[:300],
            "reference_answer": reference[:300],
            "scores": scores,
        })

        time.sleep(1)

    print(f"\n{'=' * 60}")
    print("EVALUATION SUMMARY")
    print(f"{'=' * 60}")

    if valid_count > 0:
        avg = {k: v / valid_count for k, v in total_scores.items()}
        print(f"有效评估: {valid_count}/{len(test_data)}")
        print(f"平均正确性:   {avg['correctness']:.2f}/5")
        print(f"平均完整性:   {avg['completeness']:.2f}/5")
        print(f"平均有帮助性: {avg['helpfulness']:.2f}/5")
        print(f"平均格式规范: {avg['format']:.2f}/5")
        overall = sum(avg.values()) / 4
        print(f"综合得分:     {overall:.2f}/5")

        if overall >= 4.0:
            print("\n✅ 微调效果优秀，模型回答质量高")
        elif overall >= 3.0:
            print("\n⚠️ 微调效果尚可，部分维度需要改进")
        else:
            print("\n❌ 微调效果不佳，建议调整训练数据或参数")

    output_path = os.path.join(SCRIPT_DIR, "evaluation_results.json")
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print(f"\n详细结果已保存到: {output_path}")


if __name__ == "__main__":
    main()
