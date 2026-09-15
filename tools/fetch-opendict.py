#!/usr/bin/env python3
"""우리말샘 XML(spellcheck-ko/korean-dict-nikl 의 opendict/)을 하나씩 받아 명사 뜻풀이만 뽑는다.

  python3 tools/fetch-opendict.py <작업 폴더>

파일 26개(각 80MB 안팎, 모두 약 2GB)를 차례로 받아 흘려 읽고 바로 지운다. 결과는 <작업 폴더>/opendict.tsv:
  표제어 \t 품사 \t 어휘|구… \t 고유어·한자어… \t 뜻 갈래(일반어,방언…) \t 분야 \t 뜻풀이 \t 원어 갈래(영어,한자…)
tools/fetch-stdict.py 의 stdict.tsv 와 칸이 같다(한 줄 = 뜻 하나). 이미 읽은 파일은 건너뛴다.
"""
import json, os, re, subprocess, sys, urllib.request
import xml.etree.ElementTree as ET

BASE = 'https://raw.githubusercontent.com/spellcheck-ko/korean-dict-nikl/master/opendict/'
NOUNS = ('명사', '대명사', '수사')

work = sys.argv[1]
os.makedirs(work, exist_ok=True)
out_path = os.path.join(work, 'opendict.tsv')
done_path = os.path.join(work, 'done.txt')
done = set(open(done_path).read().split()) if os.path.exists(done_path) else set()

api = 'https://api.github.com/repos/spellcheck-ko/korean-dict-nikl/contents/opendict'
files = sorted(x['name'] for x in json.load(urllib.request.urlopen(api)) if x['name'].endswith('.xml'))

def text(el, path):
    x = el.find(path)
    return re.sub(r'\s+', ' ', x.text).strip() if x is not None and x.text else ''

with open(out_path, 'a', encoding='utf-8') as out:
    for name in files:
        if name in done:
            continue
        tmp = os.path.join(work, name)
        subprocess.run(['curl', '-sS', '-m', '900', '--retry', '3', '-o', tmp, BASE + name], check=True)
        n = 0
        for _, item in ET.iterparse(tmp, events=('end',)):
            if item.tag != 'item':
                continue
            wi, si = item.find('wordInfo'), item.find('senseInfo')
            if wi is not None and si is not None and text(si, 'pos') in NOUNS:
                langs = []
                for lt in wi.iter('language_type'):
                    if lt.text and lt.text.strip() not in langs:
                        langs.append(lt.text.strip())
                cats = [c.text.strip() for c in si.iter('cat') if c.text and c.text.strip()]
                out.write('\t'.join([text(wi, 'word'), text(si, 'pos'), text(wi, 'word_unit'), text(wi, 'word_type'),
                                     text(si, 'type'), ','.join(cats), text(si, 'definition'), ','.join(langs)]) + '\n')
                n += 1
            item.clear()
        os.remove(tmp)
        with open(done_path, 'a') as d:
            d.write(name + '\n')
        out.flush()
        print(f'{name}: 명사 뜻 {n}', flush=True)
print('끝')
