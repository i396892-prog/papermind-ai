import { rankSentences, terms, extractKeywords, extractNumbersAndDates, translationChunks } from './analysis.mjs';
import { extractPptxSlides } from './pptx-analysis.mjs';
const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
const PDF_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
const MODEL_ID = 'onnx-community/Qwen2.5-0.5B-Instruct';
const MAX_TRANSLATE_CHARS = 8000;
let lang = 'ko';
let pages = [];
let generatorPromise;
let pptxRenderer;
let pptxSlideIndex = 0;
let documentKind = '';
let pptxCorpus = [];
const PPTX_MODULE = 'https://cdn.jsdelivr.net/npm/pptx-browser@4.1.5/+esm';
const $ = (selector) => document.querySelector(selector);
const t = (ko, en) => lang === 'ko' ? ko : en;
const fieldLabel = (field) => ({
  'Technology & science': t('기술·과학', 'Technology & science'),
  'Business & economics': t('경영·경제', 'Business & economics'),
  Education: t('교육', 'Education'),
  'Society & policy': t('사회·정책', 'Society & policy'),
  Other: t('기타', 'Other'),
}[field] || field);
const sourceCitation = (item) => item.source
  ? `${item.field ? `${fieldLabel(item.field)} · ` : ''}${item.source} · ${t('슬라이드', 'slide')} ${item.page}`
  : `${t('p.', 'p.')} ${item.page}`;
const promptCitation = (item) => item.source ? `[${item.source} · slide ${item.page}]` : `[p. ${item.page}]`;
function detectTextLanguage(text) {
  const koreanCount = (text.match(/[\uAC00-\uD7A3]/gu) || []).length;
  const latinCount = (text.match(/[A-Za-z]/gu) || []).length;
  return koreanCount > Math.max(8, latinCount * 0.15) ? 'ko' : 'en';
}

function taskSystemPrompt(task, language) {
  if (task === 'summary' && language === 'ko') return '당신은 꼼꼼한 한국어 편집자입니다. 자연스럽고 부드러운 한국어로 읽기 편하게 정리하세요. 발췌에 없는 사실은 만들지 말고, 각 주장 뒤에 제공된 출처 표기를 그대로 유지하세요. 불필요하게 딱딱하거나 반복적인 표현, AI라는 자기소개는 쓰지 마세요.';
  if (task === 'summary') return 'You are a careful English editor. Write a clear, natural, easy-to-read summary. Do not add facts that are absent from the excerpts. Keep the supplied citation markers after supported claims. Avoid stiff or repetitive phrasing and do not introduce yourself as an AI.';
  if (task === 'qa' && language === 'ko') return '당신은 친절하고 정확한 한국어 문서 도우미입니다. 첫 문장에서 질문에 직접 답하고, 필요하면 이어서 짧게 설명하세요. 사실이 담긴 문장에는 제공된 출처 표기를 그대로 유지하세요. 제공된 발췌로 알 수 없는 내용은 문서에서 확인할 수 없다고 분명히 말하고 추측하지 마세요. 자연스럽게 답하고 AI라고 소개하지 마세요.';
  if (task === 'qa') return 'You are a helpful, precise document assistant. Answer the question directly in the first sentence, then add a brief explanation if useful. Preserve the supplied citation markers for factual claims. If the excerpts do not support an answer, say so plainly instead of guessing. Use natural, friendly language and do not introduce yourself as an AI.';
  if (language === 'ko') return '당신은 정확하고 읽기 쉬운 한국어 정보 정리 도우미입니다. 제공된 발췌에서 확인되는 개념과 사실만 짧은 항목으로 정리하고, 각 항목에 [p. 숫자] 출처를 붙이세요. 근거 없는 추측은 하지 말고 자연스러운 문장으로 쓰세요.';
  return 'You extract information carefully. List only concepts and facts supported by the supplied excerpts, with a [p. N] marker for each item. Keep the wording concise and natural. Do not guess.';
}

const setStatus = (ko, en, isError = false) => {
  const status = $('#modelStatus');
  status.textContent = t(ko, en);
  status.style.color = isError ? '#b42318' : 'var(--muted)';
};

function setLang(next) {
  lang = next;
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-ko]').forEach((el) => {
    const value = el.dataset[lang];
    if (value !== undefined) el.innerHTML = value;
  });
  document.querySelectorAll('[data-ko-placeholder]').forEach((el) => {
    el.placeholder = el.dataset[`${lang}Placeholder`];
  });
  $('#langBtn').textContent = lang === 'ko' ? 'EN' : '한국어';
  if (pages.length) setStatus(documentKind === 'pptx'
    ? `${pptxCorpus.length}개 발표자료 · ${pages.length}개 텍스트 슬라이드 · 브라우저 로컬 처리`
    : 'PDF가 이 브라우저에서 준비되었습니다.',
  documentKind === 'pptx' ? `${pptxCorpus.length} presentations · ${pages.length} text slides · processed locally` : 'PDF is ready in this browser.');
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.style.display = 'block';
  clearTimeout(window.toastTimer);
  window.toastTimer = setTimeout(() => { el.style.display = 'none'; }, 3500);
}

function renderResult(title, lines, label) {
  const root = $('#result');
  root.replaceChildren();
  const heading = document.createElement('h3');
  heading.textContent = title;
  heading.style.cssText = 'color:var(--navy);margin:0 0 8px;font-size:16px';
  root.append(heading);
  const badge = document.createElement('div');
  badge.textContent = label;
  badge.style.cssText = 'font-size:11px;color:#315eaa;font-weight:700;margin-bottom:10px';
  root.append(badge);
  lines.forEach((line) => {
    const p = document.createElement('p');
    p.textContent = `${line.text} (${sourceCitation(line)})`;
    p.style.cssText = 'margin:8px 0;color:var(--ink);font-size:14px';
    root.append(p);
  });
  $('#result').style.display = 'block';
}

function renderMessage(title, message, label = '') {
  const root = $('#result');
  root.replaceChildren();
  const heading = document.createElement('h3');
  heading.textContent = title;
  heading.style.cssText = 'color:var(--navy);margin:0 0 8px;font-size:16px';
  root.append(heading);
  if (label) {
    const badge = document.createElement('div');
    badge.textContent = label;
    badge.style.cssText = 'font-size:11px;color:#315eaa;font-weight:700;margin-bottom:10px';
    root.append(badge);
  }
  const body = document.createElement('p');
  body.textContent = message;
  body.style.cssText = 'white-space:pre-wrap;margin:8px 0;color:var(--ink);font-size:14px';
  root.append(body);
  root.style.display = 'block';
}

function renderExtractedInfo(keywords, facts) {
  const root = $('#result');
  root.replaceChildren();
  const heading = document.createElement('h3');
  heading.textContent = t('핵심 정보 추출', 'Key information');
  heading.style.cssText = 'color:var(--navy);margin:0 0 8px;font-size:16px';
  const badge = document.createElement('div');
  badge.textContent = t('키워드·수치 추출 · 생성형 AI가 아닙니다', 'Keyword and number extraction · not generative AI');
  badge.style.cssText = 'font-size:11px;color:#315eaa;font-weight:700;margin-bottom:10px';
  root.append(heading, badge);

  const addSection = (title, rows, format) => {
    if (!rows.length) return;
    const section = document.createElement('h4');
    section.textContent = title;
    section.style.cssText = 'color:var(--navy);margin:14px 0 6px;font-size:14px';
    const list = document.createElement('ul');
    list.style.cssText = 'margin:0;padding-left:20px';
    rows.forEach((row) => {
      const item = document.createElement('li');
      item.textContent = format(row);
      item.style.cssText = 'margin:6px 0;color:var(--ink);font-size:14px';
      list.append(item);
    });
    root.append(section, list);
  };
  addSection(t('자주 등장하는 핵심 단어', 'Frequent key terms'), keywords,
    (item) => `${item.word} · ${item.pages.map((page) => typeof page === 'number' ? `${t('페이지', 'page')} ${page}` : page).join(', ')}`);
  addSection(t('숫자·날짜가 포함된 문장', 'Sentences with numbers or dates'), facts,
    (item) => `${item.text} (${sourceCitation(item)})`);
  if (!keywords.length && !facts.length) {
    const empty = document.createElement('p');
    empty.textContent = t('추출할 만한 반복 키워드나 숫자·날짜 문장을 찾지 못했습니다.', 'No repeated keywords or number/date sentences were found.');
    root.append(empty);
  }
  root.style.display = 'block';
}

function renderModelResult(title, answer, sourcePages, label) {
  renderMessage(title, answer, label);
  const sources = document.createElement('small');
  sources.textContent = `${t('참고 근거: ', 'Sources: ')}${sourcePages.join(', ')}`;
  sources.style.cssText = 'display:block;color:var(--muted);margin-top:8px';
  $('#result').append(sources);
}

function selectEvidence(query = '', limit = 12) {
  const ranked = rankSentences(pages, query);
  if (query.trim()) {
    const queryTerms = [...new Set(terms(query))];
    if (!queryTerms.length) return [];
    const minimumMatches = queryTerms.length >= 3 ? 2 : 1;
    const matched = ranked.filter((item) => item.score > 0 && item.matchedTerms.length >= minimumMatches);
    if (documentKind !== 'pptx' || !pptxCorpus.length) return matched.slice(0, limit);
    const sourceTotal = new Set(matched.map((item) => item.source)).size;
    const fieldTotal = new Set(matched.map((item) => item.field)).size;
    const sourceCap = Math.max(1, Math.ceil(limit / Math.max(1, sourceTotal)));
    const fieldCap = Math.max(1, Math.ceil(limit / Math.max(1, fieldTotal)));
    const sourceCounts = new Map();
    const fieldCounts = new Map();
    const selected = [];
    for (const item of matched) {
      if ((sourceCounts.get(item.source) || 0) >= sourceCap || (fieldCounts.get(item.field) || 0) >= fieldCap) continue;
      selected.push(item);
      sourceCounts.set(item.source, (sourceCounts.get(item.source) || 0) + 1);
      fieldCounts.set(item.field, (fieldCounts.get(item.field) || 0) + 1);
      if (selected.length >= limit) break;
    }
    return selected;
  }
  if (documentKind !== 'pptx' || !pptxCorpus.length) return ranked.slice(0, limit);
  const sourceCap = Math.max(1, Math.ceil(limit / pptxCorpus.length));
  const fieldTotal = new Set(pptxCorpus.map((item) => item.field)).size;
  const fieldCap = Math.max(1, Math.ceil(limit / fieldTotal));
  const sourceCounts = new Map();
  const fieldCounts = new Map();
  const selected = [];
  for (const item of ranked) {
    const sourceCount = sourceCounts.get(item.source) || 0;
    const fieldCount = fieldCounts.get(item.field) || 0;
    if (sourceCount >= sourceCap || fieldCount >= fieldCap) continue;
    selected.push(item);
    sourceCounts.set(item.source, sourceCount + 1);
    fieldCounts.set(item.field, fieldCount + 1);
    if (selected.length >= limit) break;
  }
  if (selected.length < limit) {
    for (const item of ranked) {
      if (selected.includes(item) || (sourceCounts.get(item.source) || 0) >= 4) continue;
      selected.push(item);
      sourceCounts.set(item.source, (sourceCounts.get(item.source) || 0) + 1);
      if (selected.length >= limit) break;
    }
  }
  return selected;
}

function ensureGenerator() {
  if (!('WebAssembly' in window)) throw new Error('wasm');
  if (!generatorPromise) {
    setStatus('로컬 모델 라이브러리를 불러오는 중…', 'Loading the local model library…');
    generatorPromise = import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2');
    generatorPromise = generatorPromise.then(({ pipeline, env }) => {
      env.allowLocalModels = false;
      env.useBrowserCache = true;
      return pipeline('text-generation', MODEL_ID, { dtype: 'q8', device: 'wasm', progress_callback: (progress) => {
        if (progress.status === 'progress') {
          const percent = progress.total ? Math.round(progress.loaded / progress.total * 100) : 0;
          setStatus(`모델 다운로드 중… ${percent}%`, `Downloading model… ${percent}%`);
        }
      } });
    }).catch((error) => { generatorPromise = null; throw error; });
  }
  return generatorPromise;
}

async function generate(prompt, systemPrompt, maxTokens = 220) {
  const generator = await ensureGenerator();
  const output = await generator([{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }], { max_new_tokens: maxTokens, do_sample: false });
  const generated = output?.[0]?.generated_text;
  return typeof generated === 'string' ? generated : generated?.at(-1)?.content;
}

async function translateDocument() {
  if (!$('#useModel').checked) {
    renderMessage(t('번역에는 로컬 모델이 필요합니다', 'Local model required for translation'),
      t('번역을 하려면 위의 브라우저 생성형 모델 옵션을 켜 주세요. 모델은 처음 한 번 약 500MB 다운로드됩니다.', 'Turn on the in-browser generative model option above to translate. The model download is about 500 MB the first time.'),
      t('문서 내용은 이 기기에서 처리됩니다.', 'Document text stays on this device.'));
    return;
  }
  const { chunks, truncated } = translationChunks(pages, MAX_TRANSLATE_CHARS);
  if (!chunks.length) {
    renderMessage(t('번역할 텍스트가 없습니다', 'No text to translate'),
      t('PDF에서 선택 가능한 문장을 찾지 못했습니다. 스캔 PDF는 OCR이 필요합니다.', 'No selectable PDF text was found. Scanned PDFs require OCR.'));
    return;
  }
  const target = lang === 'ko' ? 'English' : 'Korean';
  const translations = [];
  try {
    for (let index = 0; index < chunks.length; index += 1) {
      setStatus(`${target} 번역 중… ${index + 1}/${chunks.length}`, `Translating to ${target}… ${index + 1}/${chunks.length}`);
      $('#result').textContent = t(`문서 번역 중… ${index + 1}/${chunks.length}`, `Translating document… ${index + 1}/${chunks.length}`);
      const translationPrompt = target === 'Korean'
        ? `다음 문장을 원문의 의미와 뉘앙스를 살려 자연스럽고 매끄러운 한국어로 번역하세요. 직역투를 피하고, 요약하거나 내용을 덧붙이지 마세요. 번역문만 출력하세요.\n\n${chunks[index].text}`
        : `Translate the passage below into fluent, natural English. Preserve its meaning and tone; avoid awkward word-for-word phrasing. Do not summarize or add information. Return only the translation.\n\n${chunks[index].text}`;
      const systemPrompt = target === 'Korean'
        ? '자연스러운 한국어 번역가처럼 쓰세요. 원문의 의미와 어조를 보존하고, 문장 흐름을 부드럽게 다듬되 새 내용을 추가하지 마세요. 설명이나 머리말 없이 번역만 반환하세요.'
        : 'Write like a fluent English translator. Preserve the source meaning and tone, smooth out unnatural phrasing without adding information, and return only the translation.';
      const answer = await generate(translationPrompt, systemPrompt, 420);
      if (!answer) throw new Error('empty');
      translations.push({ page: chunks[index].page, source: chunks[index].source, text: answer });
    }
    const root = $('#result');
    root.replaceChildren();
    const heading = document.createElement('h3');
    heading.textContent = target === 'English' ? t('영어 번역', 'English translation') : t('한국어 번역', 'Korean translation');
    heading.style.cssText = 'color:var(--navy);margin:0 0 8px;font-size:16px';
    const badge = document.createElement('div');
    badge.textContent = t('브라우저 로컬 모델 번역 · 결과를 원문과 대조해 주세요', 'Translated by a local browser model · review against the source');
    badge.style.cssText = 'font-size:11px;color:#315eaa;font-weight:700;margin-bottom:10px';
    root.append(heading, badge);
    translations.forEach((entry) => {
      const p = document.createElement('p');
      p.textContent = `${entry.text} (${sourceCitation(entry)})`;
      p.style.cssText = 'white-space:pre-wrap;margin:10px 0;color:var(--ink);font-size:14px';
      root.append(p);
    });
    if (truncated) {
      const note = document.createElement('small');
      note.textContent = t('문서가 길어 앞부분 8,000자만 번역했습니다.', 'The document is long; only the first 8,000 characters were translated.');
      note.style.color = '#b54708';
      root.append(note);
    }
    root.style.display = 'block';
    const sourcePages = [...new Set(translations.map((entry) => sourceCitation(entry)))].join(', ');
    setStatus(`${target} 번역 완료 · 페이지 ${sourcePages}`, `${target} translation complete · pages ${sourcePages}`);
  } catch (error) {
    console.warn('Local translation failed.', error);
    setStatus('모델을 사용할 수 없습니다. 연결과 브라우저 호환성을 확인해 주세요.', 'The model is unavailable. Check your connection and browser compatibility.', true);
    renderMessage(t('번역을 완료하지 못했습니다', 'Translation could not be completed'),
      t('모델 다운로드나 브라우저 실행에 실패했습니다. 모델을 다시 켜거나, 페이지를 새로고침한 뒤 다시 시도해 주세요.', 'The model download or browser inference failed. Re-enable the model or reload the page and try again.'));
  }
}

async function showTask(task, question = '') {
  if (!pages.length) { toast(t('먼저 분석할 PDF 또는 PPTX를 선택해 주세요.', 'Choose a PDF or PPTX first.')); return; }
  const result = $('#result');
  result.style.display = 'block';
  result.textContent = t('문서를 분석하는 중…', 'Analyzing document…');
  if (task === 'translate') { await translateDocument(); return; }
  if (task === 'extract') {
    const keywords = extractKeywords(pages);
    const facts = extractNumbersAndDates(pages);
    const evidence = selectEvidence('', documentKind === 'pptx' ? 10 : 8);
    if ($('#useModel').checked && evidence.length) {
      try {
        setStatus('문서에서 주요 사실을 추출하는 중…', 'Extracting key facts from the document…');
        const excerpts = evidence.map((item) => `${promptCitation(item)} ${item.field ? `[${item.field}] ` : ''}${item.text}`).join('\n');
        const language = detectTextLanguage(pages.map((page) => page.text).join(' '));
        const prompt = language === 'ko'
          ? `다음 자료에서 중요한 개념과 확인 가능한 사실을 한국어 항목으로 정리하세요. 사실 항목마다 제공된 출처 표기를 그대로 붙이고, 여러 분야의 자료가 있으면 관점 차이를 구분하세요. 자료에 없는 정보는 추측하지 마세요.\n${excerpts}`
          : `Extract important concepts and supported facts as concise English bullets. Preserve supplied citations for each fact and distinguish perspectives across fields. Do not guess beyond the excerpts.\n${excerpts}`;
        const answer = await generate(prompt, taskSystemPrompt('extract', language), 260);
        if (!answer) throw new Error('empty');
        renderModelResult(t('핵심 정보 추출', 'Key information'), answer, [...new Set(evidence.map((item) => sourceCitation(item)))],
          t('로컬 생성형 모델 · 원문 발췌 기반', 'Local generative model · grounded in excerpts'));
        return;
      } catch (error) {
        console.warn('Local extraction unavailable; using keyword fallback.', error);
        setStatus('모델을 사용할 수 없어 키워드와 숫자·날짜를 추출합니다.', 'Model unavailable; extracting keywords and numbers instead.', true);
      }
    }
    renderExtractedInfo(keywords, facts);
    return;
  }
  const ranked = selectEvidence(question, documentKind === 'pptx' ? 12 : 6);
  if (!ranked.length) {
    result.textContent = documentKind === 'pptx'
      ? t('질문과 일치하는 슬라이드 근거를 찾지 못했습니다. 핵심 단어를 바꿔 질문해 주세요.', 'No matching slide evidence was found. Try rephrasing with key terms from the presentations.')
      : t('이 PDF에서 추출 가능한 텍스트가 없습니다. 스캔 이미지 PDF는 OCR이 필요합니다.', 'No selectable text was found. Scanned image PDFs require OCR.');
    return;
  }
  if (task === 'qa' && ranked[0].score <= 0) {
    result.textContent = t('질문과 일치하는 문서 문장을 찾지 못했습니다. 단어를 바꿔 다시 질문해 주세요.', 'No matching passage was found. Try rephrasing your question.');
    return;
  }
  const chosen = ranked.slice(0, documentKind === 'pptx' ? (task === 'qa' ? 8 : 12) : (task === 'summary' ? 6 : 4));
  if ($('#useModel').checked) {
    try {
      setStatus('브라우저에서 모델을 준비하고 있습니다. 문서는 기기를 벗어나지 않습니다.', 'Preparing the model in your browser. Document text stays on this device.');
      const excerpts = chosen.map((item) => `${promptCitation(item)} ${item.field ? `[${item.field}] ` : ''}${item.text}`).join('\n');
      const language = task === 'qa' ? detectTextLanguage(question) : detectTextLanguage(pages.map((page) => page.text).join(' '));
      const prompt = task === 'summary'
        ? language === 'ko'
          ? `다음 자료 발췌를 자연스럽고 명확한 한국어로 분석하세요. 핵심 주장, 근거, 한계 또는 관점 차이를 구분하고, 여러 분야·발표자료 사이의 공통점과 차이가 있으면 따로 설명하세요. 중요한 주장마다 발췌에 붙은 [출처명 · slide N] 또는 [p. N] 표기를 그대로 유지하세요. 자료에 없는 내용은 추가하지 마세요.\n${excerpts}`
          : `Analyze these excerpts in clear, natural English. Separate key claims, evidence, limitations, and differences in perspective. If multiple fields or presentations share or disagree on a point, make that explicit. Preserve each supplied [source · slide N] or [p. N] citation exactly. Do not add unsupported facts.\n${excerpts}`
        : language === 'ko'
          ? `질문: ${question}\n아래 발췌만 근거로 자연스럽고 친절하게 답하세요. 첫 문장에서 바로 답하고, 발표자료가 여럿이면 분야별 관점이나 서로 다른 주장을 구분하세요. 사실 주장에는 발췌에 붙은 [출처명 · slide N] 또는 [p. N] 근거를 유지하세요. 충분한 근거가 없으면 확인할 수 없다고 말하고 추측하지 마세요.\n${excerpts}`
          : `Question: ${question}\nAnswer directly and naturally using only the excerpts. If multiple presentations are included, distinguish field-specific perspectives and conflicting claims. Preserve the supplied [source · slide N] or [p. N] citation for factual claims. Say plainly if there is not enough evidence; do not guess.\n${excerpts}`;
      const answer = await generate(prompt, taskSystemPrompt(task, language));
      if (!answer) throw new Error('empty');
      renderModelResult(task === 'summary' ? t('문서 요약', 'Document summary') : t('문서 답변', 'Document answer'), answer,
        [...new Set(chosen.map((item) => sourceCitation(item)))], t('로컬 생성형 모델 · 원문 발췌 기반', 'Local generative model · grounded in excerpts'));
      setStatus('로컬 생성형 모델 준비 완료 · 모델 파일은 브라우저에서 가져옵니다.', 'Local model ready · model files are fetched by the browser.');
      return;
    } catch (error) {
      console.warn('Local model unavailable; using extractive fallback.', error);
      setStatus('모델을 사용할 수 없어 추출식 결과를 표시합니다.', 'Model unavailable; showing extractive results instead.', true);
    }
  }
  renderResult(task === 'summary' ? t('핵심 문장', 'Key sentences') : t('질문과 관련된 문서 문장', 'Passages related to your question'), chosen,
    task === 'summary'
      ? t('근거 문장 추출 · 생성형 AI가 아닙니다', 'Extracted source passages · not generative AI')
      : t('질문과 관련된 근거 문장 · 생성형 AI 답변이 아닙니다', 'Source passages related to your question · not generated AI'));
}

function updatePptxLibrary() {
  const list = $('#pptxLibraryList');
  const deckSelect = $('#pptxDeck');
  list.replaceChildren();
  deckSelect.replaceChildren();
  pptxCorpus.forEach((presentation) => {
    const row = document.createElement('div');
    row.textContent = `${fieldLabel(presentation.field)} · ${presentation.name} · ${presentation.slideCount} ${t('슬라이드', 'slides')}`;
    row.style.cssText = 'padding:3px 0;overflow-wrap:anywhere';
    list.append(row);
    const option = document.createElement('option');
    option.value = String(pptxCorpus.indexOf(presentation));
    option.textContent = `${fieldLabel(presentation.field)} · ${presentation.name}`;
    deckSelect.append(option);
  });
  $('#pptxLibrary').style.display = pptxCorpus.length ? 'block' : 'none';
  $('#fieldLabel').style.display = pptxCorpus.length ? 'flex' : 'none';
}

async function acceptFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const pdfs = files.filter((file) => file.name.toLowerCase().endsWith('.pdf'));
  const pptxs = files.filter((file) => file.name.toLowerCase().endsWith('.pptx'));
  if (pdfs.length && (files.length !== 1 || pptxs.length)) {
    toast(t('PDF는 한 번에 한 개씩 선택하고, PPTX는 여러 개를 함께 선택해 주세요.', 'Choose one PDF at a time, or select multiple PPTX files.'));
    return;
  }
  if (pdfs.length) { await acceptPdf(pdfs[0]); return; }
  if (pptxs.length !== files.length) { toast(t('PDF 또는 PPTX 파일만 지원합니다.', 'Choose PDF or PPTX files only.')); return; }
  if (pptxs.length > 10 || pptxs.some((file) => file.size > 20 * 1024 * 1024)
    || pptxs.reduce((sum, file) => sum + file.size, 0) > 100 * 1024 * 1024) {
    toast(t('PPTX는 한 번에 최대 10개, 합계 100MB까지 추가할 수 있습니다. 각 파일은 20MB 이하여야 합니다.', 'Add up to 10 PPTX files and 100 MB at a time; each file must be 20 MB or smaller.'));
    return;
  }
  if (pptxCorpus.length + pptxs.length > 20) {
    toast(t('세션 자료 모음에는 최대 20개 발표자료를 넣을 수 있습니다. × 버튼으로 정리한 뒤 다시 추가해 주세요.', 'The session library holds up to 20 presentations. Clear it with × before adding more.'));
    return;
  }
  if (documentKind !== 'pptx') {
    pages = [];
    pptxCorpus = [];
    $('#result').style.display = 'none';
    $('#qaBox').style.display = 'none';
  }
  documentKind = 'pptx';
  $('#useModel').closest('label').style.display = 'flex';
  $('#modelLabel').style.display = 'flex';
  $('#modelStatus').style.display = 'block';
  $('#quick-actions').style.display = 'grid';
  $('#fileinfo').style.display = 'flex';
  $('#fileinfo').style.background = '#eef3fb';
  $('#fileinfo').style.color = 'var(--navy)';
  $('#filename').textContent = t(`${pptxs.length}개 발표자료를 추가하는 중…`, `Adding ${pptxs.length} presentations…`);
  $('#pptxViewer').style.display = 'none';
  updatePptxLibrary();

  const field = $('#fieldSelect').value;
  const imported = [];
  const failed = [];
  for (let index = 0; index < pptxs.length; index += 1) {
    const file = pptxs[index];
    setStatus(`${index + 1}/${pptxs.length} · ${file.name}의 슬라이드 텍스트를 읽는 중…`, `${index + 1}/${pptxs.length} · extracting slide text from ${file.name}…`);
    try {
      const extracted = await extractPptxSlides(file, {
        field,
        onProgress: (slide, total) => setStatus(`${file.name} · ${slide}/${total} 슬라이드 분석 준비 중…`, `${file.name} · preparing slide ${slide}/${total}…`),
      });
      const presentation = { file, name: file.name, field, slideCount: extracted.slideCount, pages: extracted.slides };
      const corpusChars = pages.reduce((sum, page) => sum + page.text.length, 0);
      if (pages.length + extracted.slides.length > 5000 || corpusChars + extracted.slides.reduce((sum, page) => sum + page.text.length, 0) > 2_000_000) {
        throw new Error('The in-session library is limited to 5,000 text slides and 2 million characters.');
      }
      pptxCorpus.push(presentation);
      imported.push({ file, presentation });
      pages.push(...extracted.slides);
    } catch (error) {
      console.warn(`Could not analyze ${file.name}.`, error);
      failed.push(`${file.name}: ${error.message}`);
    }
  }
  if (!pptxCorpus.length) {
    $('#filename').textContent = t('자료를 읽지 못했습니다', 'Could not read the presentations');
    setStatus(failed.join(' · '), failed.join(' · '), true);
    return;
  }
  $('#filename').textContent = `${pptxCorpus.length} ${t('개 발표자료', 'presentations')} · ${pages.length} ${t('개 텍스트 슬라이드', 'text slides')}`;
  $('#fileinfo').style.background = '#f1f7f4';
  $('#fileinfo').style.color = '#176444';
  $('#qaBox').style.display = 'block';
  updatePptxLibrary();
  setStatus(`${pptxCorpus.length}개 분야 자료 · ${pages.length.toLocaleString()}개 텍스트 슬라이드 · 브라우저 로컬 처리`, `${pptxCorpus.length} presentations across fields · ${pages.length.toLocaleString()} text slides · processed locally`);
  $('#result').style.display = 'none';
  if (failed.length) toast(t(`일부 자료를 건너뛰었습니다: ${failed.join(' · ')}`, `Some presentations were skipped: ${failed.join(' · ')}`));
  const latest = imported.at(-1)?.presentation;
  if (latest) {
    $('#pptxDeck').value = String(pptxCorpus.indexOf(latest));
    await openPptx(latest.file);
  }
}

async function acceptPdf(file) {
  if (file.size > 20 * 1024 * 1024) { toast(t('PDF는 20MB 이하여야 합니다.', 'PDF files must be 20 MB or smaller.')); return; }
  pages = [];
  pptxCorpus = [];
  documentKind = 'pdf';
  destroyPptx();
  $('#file').value = '';
  $('#filename').textContent = file.name;
  $('#fileinfo').style.display = 'flex';
  $('#fileinfo').style.background = '#f1f7f4';
  $('#fileinfo').style.color = '#176444';
  $('#pptxLibrary').style.display = 'none';
  $('#fieldLabel').style.display = 'none';
  $('#result').style.display = 'none';
  $('#qaBox').style.display = 'none';
  $('#pptxViewer').style.display = 'none';
  $('#modelLabel').style.display = 'flex';
  $('#modelStatus').style.display = 'block';
  $('#quick-actions').style.display = 'grid';
  setStatus('PDF를 브라우저에서 읽는 중…', 'Reading the PDF in your browser…');
  try {
    const pdfjs = await import(PDFJS);
    pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER;
    const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    const extracted = [];
    for (let number = 1; number <= pdf.numPages; number += 1) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      const text = content.items.map((item) => item.str).join(' ').replace(/\s+/g, ' ').trim();
      extracted.push({ number, text });
      setStatus(`${number}/${pdf.numPages}페이지 읽는 중…`, `Reading page ${number}/${pdf.numPages}…`);
    }
    pages = extracted;
    $('#qaBox').style.display = 'block';
    const chars = pages.reduce((sum, page) => sum + page.text.length, 0);
    if (!chars) setStatus('텍스트를 찾지 못했습니다. 스캔 PDF에는 OCR이 필요합니다.', 'No text found. Scanned PDFs require OCR.', true);
    else setStatus(`${pages.length}페이지 · ${chars.toLocaleString()}자 · 브라우저 로컬 처리`, `${pages.length} pages · ${chars.toLocaleString()} characters · processed locally`);
  } catch (error) {
    pages = [];
    console.error('PDF parsing failed', error);
    setStatus('PDF를 열지 못했습니다. 파일이 손상되지 않았는지 확인해 주세요.', 'Could not read the PDF. Check that the file is valid.', true);
  }
}

function destroyPptx() {
  if (pptxRenderer) {
    pptxRenderer.destroy();
    pptxRenderer = undefined;
  }
  const canvas = $('#pptxCanvas');
  canvas.width = 0;
  canvas.height = 0;
}

async function openPptx(file) {
  destroyPptx();
  const viewer = $('#pptxViewer');
  const status = $('#pptxStatus');
  viewer.style.display = 'block';
  status.textContent = t('PPTX 미리보기 라이브러리를 불러오는 중…', 'Loading the PPTX preview library…');
  $('#pptxPrev').disabled = true;
  $('#pptxNext').disabled = true;
  try {
    if (!('DecompressionStream' in window)) throw new Error('unsupported-browser');
    const { PptxRenderer } = await import(PPTX_MODULE);
    pptxRenderer = new PptxRenderer();
    await pptxRenderer.load(file, (progress) => {
      status.textContent = `${t('프레젠테이션을 읽는 중…', 'Reading presentation…')} ${Math.round(progress * 100)}%`;
    });
    if (!pptxRenderer.slideCount) throw new Error('empty-slides');
    pptxSlideIndex = 0;
    await renderPptxSlide();
    status.textContent = t('슬라이드 미리보기 · 일부 글꼴과 효과는 PowerPoint와 다르게 보일 수 있습니다.', 'Slide preview · some fonts and effects may differ from PowerPoint.');
  } catch (error) {
    console.warn('PPTX preview failed.', error);
    destroyPptx();
    status.textContent = error.message === 'unsupported-browser'
      ? t('현재 브라우저는 PPTX 미리보기에 필요한 기능을 지원하지 않습니다. 최신 Chrome, Edge, Firefox 또는 Safari를 사용해 주세요.', 'This browser lacks a feature required for PPTX preview. Use a current Chrome, Edge, Firefox, or Safari.')
      : t('미리보기를 열지 못했습니다. 손상된 파일이거나 지원되지 않는 PPTX 구성일 수 있습니다.', 'Preview failed. The file may be damaged or use unsupported PPTX features.');
  }
}

async function renderPptxSlide() {
  if (!pptxRenderer) return;
  const canvas = $('#pptxCanvas');
  const width = Math.min(1280, Math.max(480, Math.floor(canvas.parentElement.clientWidth - 20)));
  await pptxRenderer.renderSlide(pptxSlideIndex, canvas, width);
  $('#pptxCounter').textContent = `${pptxSlideIndex + 1} / ${pptxRenderer.slideCount}`;
  $('#pptxPrev').disabled = pptxSlideIndex <= 0;
  $('#pptxNext').disabled = pptxSlideIndex >= pptxRenderer.slideCount - 1;
}

$('#langBtn').addEventListener('click', () => setLang(lang === 'ko' ? 'en' : 'ko'));
$('#authInfo').addEventListener('click', () => $('#authDialog').showModal());
$('#authClose').addEventListener('click', () => $('#authDialog').close());
$('#browse').addEventListener('click', () => $('#file').click());
$('#file').addEventListener('change', (event) => {
  const selected = [...event.target.files];
  event.target.value = '';
  acceptFiles(selected);
});
$('#remove').addEventListener('click', () => {
  pages = [];
  pptxCorpus = [];
  documentKind = '';
  destroyPptx();
  $('#file').value = '';
  $('#fileinfo').style.display = 'none';
  $('#qaBox').style.display = 'none';
  $('#result').style.display = 'none';
  $('#pptxViewer').style.display = 'none';
  $('#pptxLibrary').style.display = 'none';
  $('#fieldLabel').style.display = 'none';
  $('#useModel').closest('label').style.display = 'flex';
  $('#modelStatus').style.display = 'block';
  $('#quick-actions').style.display = 'grid';
  setStatus('모델을 켜면 요약·질문 답변·번역을 브라우저에서 생성합니다. 처음에만 모델을 내려받습니다.', 'With the model on, summaries, answers, and translations are generated in your browser. The model downloads on first use.');
});
$('#pptxPrev').addEventListener('click', async () => { if (pptxSlideIndex > 0) { pptxSlideIndex -= 1; await renderPptxSlide(); } });
$('#pptxNext').addEventListener('click', async () => { if (pptxRenderer && pptxSlideIndex < pptxRenderer.slideCount - 1) { pptxSlideIndex += 1; await renderPptxSlide(); } });
$('#pptxDeck').addEventListener('change', async (event) => {
  const presentation = pptxCorpus[Number(event.target.value)];
  if (presentation) await openPptx(presentation.file);
});
const drop = $('#drop');
['dragenter', 'dragover'].forEach((eventName) => drop.addEventListener(eventName, (event) => { event.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((eventName) => drop.addEventListener(eventName, (event) => { event.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (event) => acceptFiles(event.dataTransfer.files));
document.querySelectorAll('[data-task]').forEach((button) => button.addEventListener('click', () => {
  if (button.dataset.task === 'qa') { $('#qaBox').style.display = 'block'; $('#question').focus(); return; }
  if (button.dataset.task === 'extract') { showTask('extract'); return; }
  showTask(button.dataset.task);
}));
$('#ask').addEventListener('click', () => {
  const question = $('#question').value.trim();
  if (!question) { toast(t('질문을 입력해 주세요.', 'Enter a question first.')); return; }
  showTask('qa', question);
});
$('#question').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('#ask').click(); });
