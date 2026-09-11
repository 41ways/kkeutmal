#!/usr/bin/env python3
"""끝말잇기 사전을 만든다.

  python3 tools/build-dict.py <stdict.tsv> <dict-ko-data.yaml>

  stdict.tsv        tools/fetch-stdict.py 가 만든 표준국어대사전 표제어 (국립국어원, CC BY-SA 2.0 KR)
  dict-ko-data.yaml hunspell-dict-ko 의 낱말 데이터 (spellcheck-ko, CC BY-SA 4.0)

결과
  dict/words.txt       서버가 쓰는 낱말 목록. 한 줄에 하나, 흔한 낱말(hunspell 명사)은 앞에 '*'.
  public/dict/<hex>.json  첫 글자별 뜻풀이 {낱말: 뜻 | [뜻, 뜻, …]}. 화면이 낱말을 띄울 때 받아 간다.
                       소리가 같은 낱말(가격01 加擊 · 가격02 價格)은 넷까지 담는다. 사전 번호는 쓰임 순서가
                       아니라서(사과01 이 '참외') 분야 표시가 없는 일반 뜻을 앞에 세운다.
"""
import collections, json, os, re, shutil, sys

tsv, yaml = sys.argv[1], sys.argv[2]
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HANGUL = re.compile(r'[가-힣]{2,}')
# 표준어가 아닌 것을 가리키는 뜻풀이 — '‘가위’의 방언(경상).' 같은 것
NONSTD = re.compile(r'’의 (방언|북한어|옛말|잘못|비표준어)')
DEF_MAX = 56      # 첫 뜻
DEF_MORE = 40     # 소리가 같은 다른 낱말의 뜻
HOMONYMS = 4

def tidy(d, limit):
    d = re.sub(r'「\d+」', '', d)                  # 방열기「1」 → 방열기
    d = re.sub(r'(?<=[가-힣])\d{2}(?![\d㎢])', '', d)  # 뒤룩거리다02 → 뒤룩거리다
    d = re.sub(r'≒[^.]*\.?\s*$', '', d).strip()    # 끝에 붙은 비슷한말 표시
    d = d.replace('ㆍ', '·').rstrip(' .')
    if len(d) > limit:
        cut = d[:limit]
        # 첫 문장에서 끊을 수 있으면 거기서
        dot = cut.rfind('. ')
        d = cut[:dot] if dot > 20 else cut.rstrip() + '…'
    return d

defs = {}
for line in open(tsv, encoding='utf-8'):
    w, pos, unit, wtype, types, cat, d = line.rstrip('\n').split('\t')
    if unit != '단어' or pos not in ('명사', '대명사', '수사'):
        continue
    w = re.sub(r'[\d\-^]', '', w)
    if not HANGUL.fullmatch(w) or NONSTD.search(d):
        continue
    defs.setdefault(w, []).append((1 if cat else 0, len(defs[w]), d))

for w, got in defs.items():
    out = []
    for _, _, d in sorted(got):
        t = tidy(d, DEF_MORE if out else DEF_MAX)
        if t and t not in out:
            out.append(t)
        if len(out) == HOMONYMS:
            break
    defs[w] = out

common, pos = set(), None
for line in open(yaml, encoding='utf-8'):
    m = re.match(r'- pos: (.*)', line)
    if m:
        pos = m.group(1).strip()
        continue
    m = re.match(r'  word: (.*)', line)
    if m and pos == '명사' and HANGUL.fullmatch(m.group(1).strip()):
        common.add(m.group(1).strip())

words = sorted(set(defs) | common)
os.makedirs(os.path.join(ROOT, 'dict'), exist_ok=True)
with open(os.path.join(ROOT, 'dict', 'words.txt'), 'w', encoding='utf-8') as f:
    for w in words:
        f.write(('*' if w in common else '') + w + '\n')

shard_dir = os.path.join(ROOT, 'public', 'dict')
shutil.rmtree(shard_dir, ignore_errors=True)
os.makedirs(shard_dir)
shards = collections.defaultdict(dict)
for w, d in defs.items():
    if d:
        shards[w[0]][w] = d[0] if len(d) == 1 else d
for ch, m in shards.items():
    with open(os.path.join(shard_dir, f'{ord(ch):x}.json'), 'w', encoding='utf-8') as f:
        json.dump(m, f, ensure_ascii=False, separators=(',', ':'), sort_keys=True)

size = sum(os.path.getsize(os.path.join(shard_dir, x)) for x in os.listdir(shard_dir))
print(f'낱말 {len(words):,}개 (흔한 낱말 {len(common):,}) · 뜻풀이 {sum(map(len, shards.values())):,}개 '
      f'· 조각 {len(shards):,}개 {size / 1e6:.1f}MB')
