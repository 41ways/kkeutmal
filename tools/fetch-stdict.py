#!/usr/bin/env python3
"""표준국어대사전 XML(spellcheck-ko/korean-dict-nikl-stdict)을 하나씩 받아 표제어만 뽑는다.

  python3 tools/fetch-stdict.py <작업 폴더>

파일 87개(각 5MB 안팎)를 차례로 받아 읽고 바로 지운다. 결과는 <작업 폴더>/stdict.tsv:
  표제어 \t 품사 \t 단어|구 \t 고유어·한자어… \t 뜻 갈래(일반어,방언…) \t 분야 \t 첫 뜻풀이
이미 읽은 파일은 건너뛰므로 끊겨도 다시 돌리면 이어 간다.
"""
import os, re, subprocess, sys, xml.etree.ElementTree as ET

BASE = 'https://raw.githubusercontent.com/spellcheck-ko/korean-dict-nikl-stdict/master/'
FILES = [f'{n}.xml' for n in range(5000, 434240, 5000)] + ['434240.xml']

work = sys.argv[1]
os.makedirs(work, exist_ok=True)
out_path = os.path.join(work, 'stdict.tsv')
done_path = os.path.join(work, 'done.txt')
done = set(open(done_path).read().split()) if os.path.exists(done_path) else set()

def text(el, path):
    x = el.find(path)
    return (x.text or '').strip() if x is not None and x.text else ''

with open(out_path, 'a', encoding='utf-8') as out:
    for name in FILES:
        if name in done:
            continue
        tmp = os.path.join(work, name)
        subprocess.run(['curl', '-sS', '-m', '300', '--retry', '3', '-o', tmp, BASE + name], check=True)
        root = ET.parse(tmp).getroot()
        n = 0
        for item in root.iter('item'):
            wi = item.find('word_info')
            if wi is None:
                continue
            word = text(wi, 'word')
            unit = text(wi, 'word_unit')
            wtype = text(wi, 'word_type')
            for pi in wi.findall('pos_info'):
                pos = text(pi, 'pos')
                types, cats, first = [], [], ''
                for si in pi.iter('sense_info'):
                    t = text(si, 'type')
                    if t and t not in types:
                        types.append(t)
                    for c in si.iter('cat'):
                        if c.text and c.text.strip() not in cats and c.text.strip() != '없음':
                            cats.append(c.text.strip())
                    if not first:
                        first = text(si, 'definition')
                first = re.sub(r'\s+', ' ', first)
                out.write('\t'.join([word, pos, unit, wtype, ','.join(types), ','.join(cats), first]) + '\n')
                n += 1
        os.remove(tmp)
        with open(done_path, 'a') as d:
            d.write(name + '\n')
        out.flush()
        print(f'{name}: {n}', flush=True)
print('끝')
