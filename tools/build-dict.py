#!/usr/bin/env python3
"""끝말잇기 사전을 만든다.

  python3 tools/build-dict.py <stdict.tsv> <dict-ko-data.yaml> [opendict.tsv]

  stdict.tsv        tools/fetch-stdict.py 가 만든 표준국어대사전 표제어 (국립국어원, CC BY-SA 2.0 KR)
  dict-ko-data.yaml hunspell-dict-ko 의 낱말 데이터 (spellcheck-ko, CC BY-SA 4.0)
  opendict.tsv      tools/fetch-opendict.py 가 만든 우리말샘 명사 뜻 (국립국어원, CC BY-SA 2.0 KR).
                    표준국어대사전에 없는 낱말 가운데 뜻 갈래가 '일반어'인 것만 더한다(방언 · 북한어 · 옛말 제외).
                    치맥 · 혼밥 · 와이파이 · 마라탕 같은 새말과 전문어 · 지명이 여기서 들어온다.

결과
  dict/words.txt       서버가 쓰는 낱말 목록. 한 줄에 하나, 앞에 붙은 표시:
                       '*' 흔한 낱말(hunspell 명사) · '~' 외래어가 든 말('외래어 금지' 방에서 막는다)
  public/dict/<hex>.json  첫 글자별 뜻풀이 {낱말: 뜻 | [뜻, 뜻, …]}. 화면이 낱말을 띄울 때 받아 간다.
                       소리가 같은 낱말(가격01 加擊 · 가격02 價格)은 넷까지 담는다. 사전 번호는 쓰임 순서가
                       아니라서(사과01 이 '참외') 분야 표시가 없는 일반 뜻을 앞에 세운다.
"""
import collections, json, os, re, shutil, sys

tsv, yaml = sys.argv[1], sys.argv[2]
opendict = sys.argv[3] if len(sys.argv) > 3 else None
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

def is_foreign(wtype, langs):
    """외래어이거나, 혼종어 가운데 한자·고유어가 아닌 원어(영어 · '안 밝힘' 음역 등)가 섞인 말"""
    if wtype == '외래어':
        return True
    return wtype == '혼종어' and any(l not in ('한자', '고유어', '') for l in langs.split(','))

defs = {}
foreign = {}       # 낱말 → 소리가 같은 낱말이 모두 외래어인가
foreign_any = {}   # 품사를 가리지 않고 — '럭스'처럼 사전엔 의존 명사로 있고 hunspell 에선 명사인 말을 위해
for line in open(tsv, encoding='utf-8'):
    f = line.rstrip('\n').split('\t')
    w, pos, unit, wtype, types, cat, d = f[:7]
    langs = f[7] if len(f) > 7 else ''
    if unit == '단어':
        k = re.sub(r'[\d\-^]', '', w)
        foreign_any[k] = foreign_any.get(k, True) and is_foreign(wtype, langs)
    if unit != '단어' or pos not in ('명사', '대명사', '수사'):
        continue
    w = re.sub(r'[\d\-^]', '', w)
    if not HANGUL.fullmatch(w) or NONSTD.search(d):
        continue
    defs.setdefault(w, []).append((1 if cat else 0, len(defs[w]), d))
    # '모라'처럼 소리가 같은 고유어가 하나라도 있으면 그 뜻으로 친 것일 수 있어 막지 않는다
    foreign[w] = foreign.get(w, True) and is_foreign(wtype, langs)

# 우리말샘 — 표준국어대사전에 없는 낱말만. 한 줄이 뜻 하나라 같은 낱말이 여러 줄로 온다.
od_added = 0
if opendict:
    od_defs, od_foreign = {}, {}
    for line in open(opendict, encoding='utf-8'):
        f = line.rstrip('\n').split('\t')
        if len(f) < 8:
            continue
        w, pos, unit, wtype, typ, cat, d, langs = f
        if unit != '어휘' or pos not in ('명사', '대명사', '수사'):
            continue
        k = re.sub(r'[\d\-^]', '', w)
        if not HANGUL.fullmatch(k):
            continue
        foreign_any[k] = foreign_any.get(k, True) and is_foreign(wtype, langs)
        if typ != '일반어' or k in defs or NONSTD.search(d):
            continue
        od_defs.setdefault(k, []).append((1 if cat else 0, len(od_defs[k]), d))
        od_foreign[k] = od_foreign.get(k, True) and is_foreign(wtype, langs)
    defs.update(od_defs)
    foreign.update(od_foreign)
    od_added = len(od_defs)

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

# hunspell 에만 있는 낱말은 원어 정보가 없다. 킬로그램 · 팬미팅 · 요격미사일 같은 합성어를 가려낸다:
#  앞이나 뒤가 사전의 외래어(두 글자 이상)이거나, 외래어에만 나오는 글자(샤 · 럼 …)가 들어 있으면 외래어로 친다.
loan = {w for w, v in foreign_any.items() if v and len(w) >= 2 and HANGUL.fullmatch(w)}
native_syl = {c for w, v in foreign_any.items() if not v for c in w}
loan_syl = {c for w in loan for c in w} - native_syl
def guess_foreign(w):
    if w in foreign_any:
        return foreign_any[w]
    if any(c in loan_syl for c in w):
        return True
    return any(w[:k] in loan or w[-k:] in loan for k in range(2, len(w)))
for w in common - set(defs):
    foreign[w] = guess_foreign(w)

words = sorted(set(defs) | common)
os.makedirs(os.path.join(ROOT, 'dict'), exist_ok=True)
with open(os.path.join(ROOT, 'dict', 'words.txt'), 'w', encoding='utf-8') as f:
    for w in words:
        f.write(('*' if w in common else '') + ('~' if foreign.get(w) else '') + w + '\n')

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
print(f'낱말 {len(words):,}개 (우리말샘에서 더한 것 {od_added:,} · 흔한 낱말 {len(common):,} · 외래어 {sum(1 for w in words if foreign.get(w)):,}) · 뜻풀이 {sum(map(len, shards.values())):,}개 '
      f'· 조각 {len(shards):,}개 {size / 1e6:.1f}MB')
