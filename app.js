import { rankSentences, extractKeywords, extractNumbersAndDates, translationChunks } from './analysis.mjs';
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
const PPTX_MODULE = 'https://cdn.jsdelivr.net/npm/pptx-browser@4.1.5/+esm';
const $ = (selector) => document.querySelector(selector);
const t = (ko, en) => lang === 'ko' ? ko : en;
function detectTextLanguage(text) {
  const koreanCount = (text.match(/[\uAC00-\uD7A3]/gu) || []).length;
  const latinCount = (text.match(/[A-Za-z]/gu) || []).length;
  return koreanCount > Math.max(8, latinCount * 0.15) ? 'ko' : 'en';
}

function taskSystemPrompt(task, language) {
  if (task === 'summary' && language === 'ko') return '당신은 꼼꼼한 한국어 편집자입니다. 자연스럽고 부드러운 한국어로 읽기 편하게 정리하세요. 발췌에 없는 사실은 만들지 말고, 핵심 주장 뒤에 [p. 숫자] 형식의 출처를 유지하세요. 불필요하게 딱딱하거나 반복적인 표현, AI라는 자기소개는 쓰지 마세요.';
  if (task === 'summary') return 'You are a careful English editor. Write a clear, natural, easy-to-read summary. Do not add facts that are absent from the excerpts. Keep [p. N] source markers after key claims. Avoid stiff or repetitive phrasing and do not introduce yourself as an AI.';
  if (task === 'qa' && language === 'ko') return '당신은 친절하고 정확한 한국어 문서 도우미입니다. 첫 문장에서 질문에 직접 답하고, 필요하면 이어서 짧게 설명하세요. 사실이 담긴 문장에는 [p. 숫자] 출처를 표시하세요. 제공된 발췌로 알 수 없는 내용은 문서에서 확인할 수 없다고 분명히 말하고 추측하지 마세요. 자연스럽게 답하고 AI라고 소개하지 마세요.';
  if (task === 'qa') return 'You are a helpful, precise document assistant. Answer the question directly in the first sentence, then add a brief explanation if useful. Cite factual claims with [p. N]. If the excerpts do not support an answer, say so plainly instead of guessing. Use natural, friendly language and do not introduce yourself as an AI.';
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
  if (pages.length) setStatus('PDF가 이 브라우저에서 준비되었습니다.', 'PDF is ready in this browser.');
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
    p.textContent = `${line.text} (${t('p.', 'p.')} ${line.page})`;
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
    (item) => `${item.word} · ${t('페이지', 'page')} ${item.pages.join(', ')}`);
  addSection(t('숫자·날짜가 포함된 문장', 'Sentences with numbers or dates'), facts,
    (item) => `${item.text} (${t('p.', 'p.')} ${item.page})`);
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
  sources.textContent = `${t('참고 페이지: ', 'Source pages: ')}${sourcePages.join(', ')}`;
  sources.style.cssText = 'display:block;color:var(--muted);margin-top:8px';
  $('#result').append(sources);
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
      translations.push({ page: chunks[index].page, text: answer });
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
      p.textContent = `${entry.text} (${t('p.', 'p.')} ${entry.page})`;
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
    const sourcePages = [...new Set(translations.map((entry) => entry.page))].join(', ');
    setStatus(`${target} 번역 완료 · 페이지 ${sourcePages}`, `${target} translation complete · pages ${sourcePages}`);
  } catch (error) {
    console.warn('Local translation failed.', error);
    setStatus('모델을 사용할 수 없습니다. 연결과 브라우저 호환성을 확인해 주세요.', 'The model is unavailable. Check your connection and browser compatibility.', true);
    renderMessage(t('번역을 완료하지 못했습니다', 'Translation could not be completed'),
      t('모델 다운로드나 브라우저 실행에 실패했습니다. 모델을 다시 켜거나, 페이지를 새로고침한 뒤 다시 시도해 주세요.', 'The model download or browser inference failed. Re-enable the model or reload the page and try again.'));
  }
}

async function showTask(task, question = '') {
  if (!pages.length) { toast(t('먼저 분석할 PDF를 선택해 주세요.', 'Choose a PDF first.')); return; }
  const result = $('#result');
  result.style.display = 'block';
  result.textContent = t('문서를 분석하는 중…', 'Analyzing document…');
  if (task === 'translate') { await translateDocument(); return; }
  if (task === 'extract') {
    const keywords = extractKeywords(pages);
    const facts = extractNumbersAndDates(pages);
    if ($('#useModel').checked && rankSentences(pages).length) {
      try {
        setStatus('문서에서 주요 사실을 추출하는 중…', 'Extracting key facts from the document…');
        const evidence = rankSentences(pages).slice(0, 8);
        const excerpts = evidence.map((item) => `[p. ${item.page}] ${item.text}`).join('\n');
        const language = detectTextLanguage(pages.map((page) => page.text).join(' '));
        const prompt = language === 'ko'
          ? `다음 문서 발췌에서 중요한 개념과 확인 가능한 사실을 자연스럽고 간결한 한국어 항목으로 정리하세요. 각 항목에 [p. 숫자] 출처를 붙이고, 자료에 없는 정보는 추측하지 마세요.\n${excerpts}`
          : `Extract the important concepts and supported facts from these excerpts as concise, natural English bullets. Cite every item with [p. N] and do not guess.\n${excerpts}`;
        const answer = await generate(prompt, taskSystemPrompt('extract', language), 260);
        if (!answer) throw new Error('empty');
        renderModelResult(t('핵심 정보 추출', 'Key information'), answer, [...new Set(rankSentences(pages).slice(0, 8).map((item) => item.page))],
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
  const ranked = rankSentences(pages, question);
  if (!ranked.length) {
    result.textContent = t('이 PDF에서 추출 가능한 텍스트가 없습니다. 스캔 이미지 PDF는 OCR이 필요합니다.', 'No selectable text was found. Scanned image PDFs require OCR.');
    return;
  }
  if (task === 'qa' && ranked[0].score <= 0) {
    result.textContent = t('질문과 일치하는 문서 문장을 찾지 못했습니다. 단어를 바꿔 다시 질문해 주세요.', 'No matching passage was found. Try rephrasing your question.');
    return;
  }
  const chosen = ranked.slice(0, task === 'summary' ? 6 : 4);
  if ($('#useModel').checked) {
    try {
      setStatus('브라우저에서 모델을 준비하고 있습니다. 문서는 기기를 벗어나지 않습니다.', 'Preparing the model in your browser. Document text stays on this device.');
      const excerpts = chosen.map((item) => `[p. ${item.page}] ${item.text}`).join('\n');
      const language = task === 'qa' ? detectTextLanguage(question) : detectTextLanguage(pages.map((page) => page.text).join(' '));
      const prompt = task === 'summary'
        ? language === 'ko'
          ? `다음 원문 발췌를 바탕으로 핵심을 자연스럽고 부드러운 한국어로 요약하세요. 서로 관련된 내용은 묶어 3~5개 항목으로 정리하고, 각 항목은 완결된 문장으로 쓰세요. 표현을 반복하지 말고, 중요한 주장 뒤에 [p. 숫자] 출처를 붙이세요. 근거에 없는 내용은 추가하지 마세요.\n${excerpts}`
          : `Write a natural, easy-to-read English summary of these source excerpts. Group related ideas into 3–5 complete-sentence bullets, avoid repeated phrasing, keep [p. N] citations after key claims, and do not add unsupported facts.\n${excerpts}`
        : language === 'ko'
          ? `질문: ${question}\n아래 문서 발췌만 근거로 삼아 자연스럽고 친절한 한국어로 답하세요. 첫 문장에서 질문에 바로 답하고, 필요하면 짧게 설명하세요. 사실이 담긴 문장에 [p. 숫자] 출처를 붙이세요. 답을 뒷받침할 근거가 없으면 문서에서 확인할 수 없다고 말하세요.\n${excerpts}`
          : `Question: ${question}\nAnswer naturally and directly in English using only the excerpts below. Start with the answer, add a brief explanation if useful, cite factual claims with [p. N], and say plainly if the document does not provide enough evidence.\n${excerpts}`;
      const answer = await generate(prompt, taskSystemPrompt(task, language));
      if (!answer) throw new Error('empty');
      renderModelResult(task === 'summary' ? t('문서 요약', 'Document summary') : t('문서 답변', 'Document answer'), answer,
        [...new Set(chosen.map((item) => item.page))], t('로컬 생성형 모델 · 원문 발췌 기반', 'Local generative model · grounded in excerpts'));
      setStatus('로컬 생성형 모델 준비 완료 · 모델 파일은 브라우저에서 가져옵니다.', 'Local model ready · model files are fetched by the browser.');
      return;
    } catch (error) {
      console.warn('Local model unavailable; using extractive fallback.', error);
      setStatus('모델을 사용할 수 없어 추출식 결과를 표시합니다.', 'Model unavailable; showing extractive results instead.', true);
    }
  }
  renderResult(task === 'summary' ? t('핵심 문장', 'Key sentences') : t('질문과 관련된 문서 문장', 'Passages related to your question'), chosen,
    task === 'summary'
      ? t('추출식 키포인트 · 생성형 AI가 아닙니다', 'Extractive key points · not generative AI')
      : t('질문 단어와 일치하는 원문 발췌 · 생성형 AI 답변이 아닙니다', 'Source passages matching question terms · not a generated answer'));
}

async function acceptFile(file) {
  if (!file) return;
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  const isPptx = file.name.toLowerCase().endsWith('.pptx');
  if (!isPdf && !isPptx) { toast(t('PDF 또는 PPTX 파일만 지원합니다.', 'Choose a PDF or PPTX file.')); return; }
  if (file.size > 20 * 1024 * 1024) { toast(t('파일 크기는 20MB 이하여야 합니다.', 'File must be 20 MB or smaller.')); return; }
  pages = [];
  documentKind = isPdf ? 'pdf' : 'pptx';
  destroyPptx();
  $('#filename').textContent = file.name;
  $('#fileinfo').style.display = 'flex';
  $('#result').style.display = 'none';
  $('#qaBox').style.display = 'none';
  $('#pptxViewer').style.display = 'none';
  $('#useModel').closest('label').style.display = isPdf ? 'flex' : 'none';
  $('#modelStatus').style.display = isPdf ? 'block' : 'none';
  $('#quick-actions').style.display = isPdf ? 'grid' : 'none';
  if (isPptx) {
    await openPptx(file);
    return;
  }
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
$('#file').addEventListener('change', (event) => acceptFile(event.target.files[0]));
$('#remove').addEventListener('click', () => {
  pages = [];
  documentKind = '';
  destroyPptx();
  $('#file').value = '';
  $('#fileinfo').style.display = 'none';
  $('#qaBox').style.display = 'none';
  $('#result').style.display = 'none';
  $('#pptxViewer').style.display = 'none';
  $('#useModel').closest('label').style.display = 'flex';
  $('#modelStatus').style.display = 'block';
  $('#quick-actions').style.display = 'grid';
  setStatus('모델을 켜면 요약·질문 답변·번역을 브라우저에서 생성합니다. 처음에만 모델을 내려받습니다.', 'With the model on, summaries, answers, and translations are generated in your browser. The model downloads on first use.');
});
$('#pptxPrev').addEventListener('click', async () => { if (pptxSlideIndex > 0) { pptxSlideIndex -= 1; await renderPptxSlide(); } });
$('#pptxNext').addEventListener('click', async () => { if (pptxRenderer && pptxSlideIndex < pptxRenderer.slideCount - 1) { pptxSlideIndex += 1; await renderPptxSlide(); } });
const drop = $('#drop');
['dragenter', 'dragover'].forEach((eventName) => drop.addEventListener(eventName, (event) => { event.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((eventName) => drop.addEventListener(eventName, (event) => { event.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (event) => acceptFile(event.dataTransfer.files[0]));
document.querySelectorAll('[data-task]').forEach((button) => button.addEventListener('click', () => {
  if (documentKind === 'pptx') { toast(t('PPTX는 현재 화면 미리보기만 지원합니다. 분석은 PDF 파일을 선택해 주세요.', 'PPTX preview is available. Choose a PDF to analyze its contents.')); return; }
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

