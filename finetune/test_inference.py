"""
推理测试脚本 - 验证微调后的模型效果
"""

import os
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_BASE_MODEL = os.path.join(SCRIPT_DIR, "base_model")
DEFAULT_LORA_PATH = os.path.join(SCRIPT_DIR, "output", "final")


def test_inference(
    model_path: str = DEFAULT_LORA_PATH,
    base_model: str = DEFAULT_BASE_MODEL,
    use_lora: bool = True,
):
    print(f"Loading model...")
    tokenizer = AutoTokenizer.from_pretrained(
        base_model if use_lora else model_path,
        trust_remote_code=True,
    )

    if use_lora:
        model = AutoModelForCausalLM.from_pretrained(
            base_model,
            torch_dtype=torch.bfloat16,
            device_map="auto",
            trust_remote_code=True,
        )
        model = PeftModel.from_pretrained(model, model_path)
        model = model.merge_and_unload()
    else:
        model = AutoModelForCausalLM.from_pretrained(
            model_path,
            torch_dtype=torch.bfloat16,
            device_map="auto",
            trust_remote_code=True,
        )

    model.eval()

    system_prompt = "你是一位经验丰富的C语言编程教师，擅长用清晰易懂的方式解答编程问题，注重实践经验和常见陷阱的讲解。"

    test_questions = [
        "我的程序出现了段错误，怎么排查？",
        "C语言中 malloc 和 calloc 有什么区别？",
        "如何用C语言实现一个链表？",
        "为什么我的scanf读取字符串后，下一个输入被跳过了？",
        "C语言中指针和数组有什么区别？",
        "如何避免内存泄漏？",
    ]

    print("\n" + "=" * 60)
    print("Testing fine-tuned model")
    print("=" * 60)

    for q in test_questions:
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": q},
        ]
        text = tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True
        )
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

        response = tokenizer.decode(
            outputs[0][inputs["input_ids"].shape[1]:],
            skip_special_tokens=True,
        )

        print(f"\n{'─' * 40}")
        print(f"Q: {q}")
        print(f"A: {response[:500]}...")
        print()


if __name__ == "__main__":
    test_inference()
