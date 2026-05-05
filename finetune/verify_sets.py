import json

d = json.load(open('fine_tune_train_set_c_programming.json', 'r', encoding='utf-8'))
print(f'训练集条目: {len(d)}')
print(f'第1条user消息前100字: {d[0]["messages"][1]["content"][:100]}')
print(f'最后1条user消息前100字: {d[-1]["messages"][1]["content"][:100]}')

has_docs = sum(1 for e in d if '参考文档：\n' in e['messages'][1]['content'])
has_code = sum(1 for e in d if '用户提供的代码：\n' in e['messages'][1]['content'])
print(f'有参考文档: {has_docs}, 有代码: {has_code}')
print(f'无参考文档: {len(d) - has_docs}, 无代码: {len(d) - has_code}')

t = json.load(open('fine_tune_test_set_c_programming.json', 'r', encoding='utf-8'))
print(f'\n测试集条目: {len(t)}')
has_docs_t = sum(1 for e in t if '参考文档：\n' in e['messages'][1]['content'])
has_code_t = sum(1 for e in t if '用户提供的代码：\n' in e['messages'][1]['content'])
print(f'有参考文档: {has_docs_t}, 有代码: {has_code_t}')
