#!/usr/bin/env python3
"""끝말잇기 사전을 만든다.

  python3 tools/build-dict.py <stdict.tsv> <dict-ko-data.yaml> <opendict.tsv>

  stdict.tsv        tools/fetch-stdict.py 가 만든 표준국어대사전 표제어 (국립국어원, CC BY-SA 2.0 KR)
  dict-ko-data.yaml hunspell-dict-ko 의 낱말 데이터 (spellcheck-ko, CC BY-SA 4.0)
  opendict.tsv      tools/fetch-opendict.py 가 만든 우리말샘 명사 뜻 (국립국어원, CC BY-SA 2.0 KR)
  dict/injeong/*.txt  사전 외 낱말 — 사전에 없는 말을 주제별로 직접 모은 목록 (첫 줄 '# 주제: 이름')

결과
  dict/words.txt       서버가 쓰는 낱말 목록. 한 줄에 하나, 앞에 붙은 표시:
                         '*' 흔한 낱말(hunspell 명사) — 봇 · 제시어 · 힌트가 먼저 쓴다
                         '~' 외래어가 든 말 — '외래어 금지' 방에서 막는다
                         '!' 표준어 명사가 아닌 말(방언 · 옛말 · 북한어, 띄어 쓰는 구) — '표준어만' 방에서 막는다
                         '+' 사전 외 낱말(끄투의 어인정) — '사전 외 낱말'을 켠 방에서만 받는다
  public/dict/<hex>.json  첫 글자별 뜻풀이 {낱말: 뜻 | [뜻, 뜻, …]}. 화면이 낱말을 띄울 때 받아 간다.
                       소리가 같은 낱말은 넷까지. 사전 번호는 쓰임 순서가 아니라서(사과01 이 '참외')
                       분야 표시가 없는 일반 뜻을 앞에 세운다. 표준 뜻이 있으면 방언 · 옛말 뜻은 싣지 않는다.

받는 범위는 끄투를 따랐다(끄투의 '깐깐' = 여기 '표준어만'). 표준어만을 끄면(기본) 방언 · 옛말 · 북한어와 띄어 쓰는 구(치과 기공사 → 치과기공사)도
받고, 켜면 표준어 명사만 받는다.
"""
import collections, glob, json, os, re, shutil, sys

tsv, yaml, opendict = sys.argv[1], sys.argv[2], sys.argv[3]
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HANGUL = re.compile(r'[가-힣]{2,}')
NOUNS = ('명사', '대명사', '수사')
NONSTD = re.compile(r'’의 (방언|북한어|옛말)')     # '‘가위’의 방언(경상).' 같은 뜻풀이
MISSPELL = re.compile(r'’의 (잘못|비표준어)')
DEF_MAX = 56      # 첫 뜻
DEF_MORE = 40     # 소리가 같은 다른 낱말의 뜻
HOMONYMS = 4

def key(w):
    return re.sub(r'[\d\-^ ]', '', w)

def tidy(d, limit):
    d = re.sub(r'「\d+」', '', d)                  # 방열기「1」 → 방열기
    d = re.sub(r'(?<=[가-힣])\d{2,3}(?![\d㎢])', '', d)  # 뒤룩거리다02 → 뒤룩거리다
    d = re.sub(r'≒[^.]*\.?\s*$', '', d).strip()    # 끝에 붙은 비슷한말 표시
    d = d.replace('ㆍ', '·').replace('^', ' ').rstrip(' .')
    if len(d) > limit:
        cut = d[:limit]
        dot = cut.rfind('. ')                      # 첫 문장에서 끊을 수 있으면 거기서
        d = cut[:dot] if dot > 20 else cut.rstrip() + '…'
    return d

def is_foreign(wtype, langs):
    """외래어이거나, 혼종어 가운데 한자·고유어가 아닌 원어(영어 · '안 밝힘' 음역 등)가 섞인 말"""
    if wtype == '외래어':
        return True
    return wtype == '혼종어' and any(l not in ('한자', '고유어', '') for l in langs.split(','))

# 낱말 → 뜻 목록. 뜻 하나 = (표준어 아님, 출처 순서, 분야 있음, 들어온 순서, 뜻풀이, 외래어인가)
entries = collections.defaultdict(list)
foreign_any = {}   # 품사를 가리지 않고 — '럭스'처럼 사전엔 의존 명사로 있고 hunspell 에선 명사인 말을 위해

def add(w, std, src, cat, d, foreign):
    got = entries[w]
    got.append((0 if std else 1, src, 1 if cat else 0, len(got), d, foreign))

for line in open(tsv, encoding='utf-8'):
    f = line.rstrip('\n').split('\t')
    w, pos, unit, wtype, types, cat, d = f[:7]
    langs = f[7] if len(f) > 7 else ''
    k = key(w)
    if unit == '단어':
        foreign_any[k] = foreign_any.get(k, True) and is_foreign(wtype, langs)
    if not HANGUL.fullmatch(k) or MISSPELL.search(d):
        continue
    if unit == '단어' and pos in NOUNS:
        add(k, not NONSTD.search(d), 0, cat, d, is_foreign(wtype, langs))
    elif unit == '구' and pos == '품사 없음':
        add(k, False, 0, cat, d, is_foreign(wtype, langs))       # 띄어 쓰는 말 — 표준어만에서 막는다

for line in open(opendict, encoding='utf-8'):
    f = line.rstrip('\n').split('\t')
    if len(f) < 8:
        continue
    w, pos, unit, wtype, typ, cat, d, langs = f
    if unit != '어휘' or pos not in NOUNS:
        continue
    k = key(w)
    if not HANGUL.fullmatch(k) or MISSPELL.search(d):
        continue
    foreign_any[k] = foreign_any.get(k, True) and is_foreign(wtype, langs)
    if typ in ('일반어', '방언', '북한어', '옛말'):
        add(k, typ == '일반어' and not NONSTD.search(d), 1, cat, d, is_foreign(wtype, langs))

common, pos = set(), None
for line in open(yaml, encoding='utf-8'):
    m = re.match(r'- pos: (.*)', line)
    if m:
        pos = m.group(1).strip()
        continue
    m = re.match(r'  word: (.*)', line)
    if m and pos == '명사' and HANGUL.fullmatch(m.group(1).strip()):
        common.add(m.group(1).strip())

defs, foreign, strict_ok = {}, {}, set()
for w, got in entries.items():
    std = [e for e in got if e[0] == 0]
    use = std or got                     # 표준 뜻이 있으면 그것만 싣는다
    if std:
        strict_ok.add(w)
    foreign[w] = all(e[5] for e in use)  # '모라'처럼 소리가 같은 고유어가 하나라도 있으면 막지 않는다
    out = []
    for e in sorted(use):
        t = tidy(e[4], DEF_MORE if out else DEF_MAX)
        if t and t not in out:
            out.append(t)
        if len(out) == HOMONYMS:
            break
    defs[w] = out

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
strict_ok |= common

# 어인정 — 사전에 이미 있는 말은 그대로 두고, 없는 말만 '+' 로 더한다
injeong, topics = {}, collections.Counter()
for path in sorted(glob.glob(os.path.join(ROOT, 'dict', 'injeong', '*.txt'))):
    topic = os.path.splitext(os.path.basename(path))[0]
    for line in open(path, encoding='utf-8'):
        line = line.strip()
        if line.startswith('# 주제:'):
            topic = line.split(':', 1)[1].strip()
            continue
        if not line or line.startswith('#'):
            continue
        w = line.split()[0]
        if not HANGUL.fullmatch(w):
            print('어인정: 한글 두 글자 이상이 아님 —', os.path.basename(path), line)
            continue
        if w not in defs and w not in common and w not in injeong:
            injeong[w] = topic
            topics[topic] += 1
            defs[w] = [f'사전 외 낱말 · {topic}']
            foreign[w] = guess_foreign(w)

words = sorted(set(defs) | common)
os.makedirs(os.path.join(ROOT, 'dict'), exist_ok=True)
with open(os.path.join(ROOT, 'dict', 'words.txt'), 'w', encoding='utf-8') as f:
    for w in words:
        flags = ('*' if w in common else '') + ('~' if foreign.get(w) else '') + \
                ('+' if w in injeong else '!' if w not in strict_ok else '')
        f.write(flags + w + '\n')

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
nonstrict = sum(1 for w in words if w not in strict_ok and w not in injeong)
print(f'낱말 {len(words):,}개 — 표준어만에서도 되는 말 {len(strict_ok):,} · 표준어만에서 막는 말 {nonstrict:,} · '
      f'어인정 {len(injeong):,} {dict(topics)} · 흔한 낱말 {len(common):,} · 외래어 {sum(1 for w in words if foreign.get(w)):,}')
print(f'뜻풀이 {sum(map(len, shards.values())):,}개 · 조각 {len(shards):,}개 {size / 1e6:.1f}MB')
