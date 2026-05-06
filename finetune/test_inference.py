"""
推理测试脚本 - 验证微调后的模型效果
使用4-bit量化加载，适配6GB显存
"""

import os
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
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

    bnb_config = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16,
        bnb_4bit_use_double_quant=True,
    )

    if use_lora:
        model = AutoModelForCausalLM.from_pretrained(
            base_model,
            quantization_config=bnb_config,
            device_map="auto",
            trust_remote_code=True,
            torch_dtype=torch.bfloat16,
        )
        model = PeftModel.from_pretrained(model, model_path)
    else:
        model = AutoModelForCausalLM.from_pretrained(
            model_path,
            quantization_config=bnb_config,
            device_map="auto",
            trust_remote_code=True,
            torch_dtype=torch.bfloat16,
        )

    model.eval()

    system_prompt = "你是程序设计领域的AI助教，专注于帮助学生掌握编程知识和技能。熟悉C语言等主流编程语言，精通数据结构、算法、软件工程等核心知识。\n\n## 输入格式\n每条用户消息固定包含以下四部分（某部分为\"空\"表示未提供）：\n- 用户问题：用户的核心诉求\n- 用户提供的代码：用户选中的代码片段\n- 知识图谱关联：从知识图谱检索的结构化关联信息（知识点层级、错误-原因-解决方案的因果链）\n- 参考文档：从知识库检索的相关文档片段\n\n## 回答要求\n1. 优先依据知识图谱关联理解问题的上下文关系，再结合参考文档获取详细内容\n2. 知识图谱关联不为空时，按图谱中的因果链和解决方案链组织回答结构\n3. 参考文档不为空时，用文档内容充实回答的细节\n4. 用户提供的代码不为空时，结合代码实际情况分析问题，将文档知识与代码对应\n5. 简洁精准，直接回答核心问题\n6. 必要时提供完整可运行的代码示例（用代码块包裹）\n7. 使用简洁中文，专业术语保留英文原文"

    test_cases = [
        {
            "question": "我的程序出现了段错误，怎么排查？",
            "code": None,
            "docs": None,
        },
        {
            "question": "这段代码有什么问题？",
            "code": "int *p;\n*p = 42;\nprintf(\"%d\\n\", *p);",
            "docs": None,
        },
        {
            "question": "C语言中 malloc 和 calloc 有什么区别？",
            "code": None,
            "docs": None,
        },
        {
            "question": "如何用C语言实现一个链表？",
            "code": None,
            "docs": None,
        },
        {
            "question": "这段代码有什么问题？",
            "code": "char *s = \"hello\";\ns[0] = 'H';",
            "docs": None,
        },
        {
            "question": "我的链表删除节点后程序崩溃了",
            "code": "void delete_node(Node *head, int target) {\n    Node *cur = head;\n    while (cur && cur->data != target)\n        cur = cur->next;\n    if (cur) free(cur);\n}",
            "docs": "链表删除节点时，必须先将被删除节点的前驱节点的next指针指向后继节点，否则链表断裂。",
        },
    ]

    print("\n" + "=" * 60)
    print("Testing fine-tuned model (Plugin Message Format)")
    print("=" * 60)

    for tc in test_cases:
        q = tc["question"]
        code = tc.get("code")
        docs = tc.get("docs")

        user_content = f"用户问题：{q}"
        user_content += f"\n\n用户提供的代码：\n{code}" if code else "\n\n用户提供的代码：空"
        user_content += f"\n\n参考文档：\n{docs}" if docs else "\n\n参考文档：空"

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
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
        if code:
            print(f"Code: {code[:80]}...")
        if docs:
            print(f"Docs: {docs[:80]}...")
        print(f"A: {response[:600]}")
        print()


if __name__ == "__main__":
    test_inference()
