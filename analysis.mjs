const STOP_WORDS = new Set('the and for that with from this are was were have has into about which their them then than they you your what where when how why these those document documents paper report study research key main can could should would will them our its their there across between after before because while who of to in on at as by an a is it be been being or not no do does did use used using also if may might must we they but so 문서 문서는 내용 내용을 대한 있는 하는 그리고 또는 통해 위한 이를 수는 있다 한다 에서 에게 으로 로 및 것 것이 이런 같은 위해 따른 때문에 대해 하고 되다 없다 있게 매우 더 가장 중요 주요 사람 사람들 경우 과정 결과 방식 역할 함께 여러 위한 대해 따라서 대한 필요 있다 없다 한다 한다고 있으며 한다는 것이다 것임 내용으로'.split(' '));

export function sentencesFrom(page) {
  return page.text.split(/(?<=[.!?。！？])\s+|\n+/u).map((text) => text.trim()).filter((text) => text.length > 20);
}

export function terms(text) {
  return (text.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []).filter((word) => !STOP_WORDS.has(word) && !/^\d+$/.test(word));
}

export function rankSentences(pages, query = '') {
  const queryTerms = terms(query);
  const frequency = new Map();
  pages.forEach((page) => terms(page.text).forEach((word) => frequency.set(word, (frequency.get(word) || 0) + 1)));
  return pages.flatMap((page) => sentencesFrom(page).map((text) => {
    const words = terms(text);
    const score = words.reduce((sum, word) => {
      if (!queryTerms.length) return sum + 1 / (frequency.get(word) || 1);
      const matched = queryTerms.some((term) => term === word || (term.length > 1 && word.includes(term)) || (word.length > 1 && term.includes(word)));
      return sum + (matched ? 3 : 0);
    }, 0) / Math.sqrt(words.length || 1);
    return { page: page.number, text, score };
  })).sort((a, b) => b.score - a.score);
}

export function extractKeywords(pages) {
  const counts = new Map();
  for (const page of pages) {
    for (const word of terms(page.text)) {
      const item = counts.get(word) || { count: 0, pages: new Set() };
      item.count += 1;
      item.pages.add(page.number);
      counts.set(word, item);
    }
  }
  return [...counts.entries()].filter(([, item]) => item.count >= 2)
    .sort((a, b) => b[1].count / (1 + Math.log(b[1].pages.size)) - a[1].count / (1 + Math.log(a[1].pages.size)))
    .slice(0, 8).map(([word, item]) => ({ word, pages: [...item.pages].sort((a,b)=>a-b), count: item.count }));
}

export function extractNumbersAndDates(pages) {
  const pattern = /(?:\b\d{4}\s*년(?:\s*\d{1,2}\s*월)?(?:\s*\d{1,2}\s*일)?\b|\b\d{1,2}\s*월\s*\d{1,2}\s*일\b|\b\d+(?:\.\d+)?\s*(?:%|퍼센트|명|건|개|원|배|회|년|개월|일)\b|\b\d{4}-\d{1,2}(?:-\d{1,2})?\b|(?<!\d)(?:19|20)\d{2}(?!\d))/u;
  return pages.flatMap((page) => sentencesFrom(page).filter((text) => pattern.test(text)).map((text) => ({ page: page.number, text })));
}

export function translationChunks(pages, maxChars = 8000, chunkSize = 700) {
  let remaining = maxChars;
  const chunks = [];
  for (const page of pages) {
    if (remaining <= 0) break;
    const source = page.text.slice(0, remaining);
    remaining -= source.length;
    const words = source.match(/\S+/gu) || [];
    let chunk = '';
    for (const word of words) {
      if (chunk && (chunk.length + word.length + 1) > chunkSize) {
        chunks.push({ page: page.number, text: chunk });
        chunk = '';
      }
      chunk += `${chunk ? ' ' : ''}${word}`;
    }
    if (chunk) chunks.push({ page: page.number, text: chunk });
  }
  return { chunks, truncated: pages.reduce((n, page) => n + page.text.length, 0) > maxChars };
}
