const ZIP_LIBRARY = 'https://cdn.jsdelivr.net/npm/fflate@0.8.3/esm/browser.js';
const PRESENTATION_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

function parseXml(bytes, name) {
  const xml = new DOMParser().parseFromString(new TextDecoder('utf-8').decode(bytes), 'application/xml');
  if (xml.querySelector('parsererror')) throw new Error(`Invalid XML in ${name}`);
  return xml;
}

function resolveTarget(fromPath, target) {
  if (target.startsWith('/')) return target.slice(1);
  const segments = fromPath.split('/').slice(0, -1);
  for (const part of target.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') segments.pop();
    else segments.push(part);
  }
  return segments.join('/');
}

export async function extractPptxSlides(file, { field = 'Other', onProgress = () => {} } = {}) {
  if (file.size > 20 * 1024 * 1024) throw new Error('Each presentation must be 20 MB or smaller.');
  const { unzipSync } = await import(ZIP_LIBRARY);
  const bytes = new Uint8Array(await file.arrayBuffer());
  let expanded = 0;
  let exceedsLimit = false;
  const entries = unzipSync(bytes, {
    filter: (entry) => {
      const relevant = entry.name === 'ppt/presentation.xml'
        || entry.name === 'ppt/_rels/presentation.xml.rels'
        || /^ppt\/slides\/slide\d+\.xml$/u.test(entry.name);
      if (!relevant) return false;
      if (entry.originalSize > 4 * 1024 * 1024 || expanded + entry.originalSize > 60 * 1024 * 1024) {
        exceedsLimit = true;
        return false;
      }
      expanded += entry.originalSize;
      return true;
    },
  });
  if (exceedsLimit) throw new Error('The presentation expands beyond the safe in-browser parsing limit.');
  const presentationBytes = entries['ppt/presentation.xml'];
  const relationshipsBytes = entries['ppt/_rels/presentation.xml.rels'];
  if (!presentationBytes || !relationshipsBytes) throw new Error('This file is not a readable PowerPoint presentation.');

  const presentation = parseXml(presentationBytes, 'presentation.xml');
  const relationships = parseXml(relationshipsBytes, 'presentation.xml.rels');
  const targets = new Map([...relationships.getElementsByTagNameNS(PACKAGE_REL_NS, 'Relationship')]
    .filter((relationship) => relationship.getAttribute('TargetMode') !== 'External')
    .map((relationship) => [relationship.getAttribute('Id'), resolveTarget('ppt/presentation.xml', relationship.getAttribute('Target'))]));
  const slideIds = [...presentation.getElementsByTagNameNS(PRESENTATION_NS, 'sldId')];
  if (!slideIds.length || slideIds.length > 1500) throw new Error('A presentation must contain between 1 and 1,500 slides.');

  const slides = [];
  for (let index = 0; index < slideIds.length; index += 1) {
    const slidePath = targets.get(slideIds[index].getAttributeNS(REL_NS, 'id'));
    const slideBytes = slidePath && entries[slidePath];
    let text = '';
    if (slideBytes) {
      const slide = parseXml(slideBytes, slidePath);
      text = [...slide.getElementsByTagNameNS(DRAWING_NS, 'p')]
        .map((paragraph) => [...paragraph.getElementsByTagNameNS(DRAWING_NS, 't')].map((run) => run.textContent).join(''))
        .filter(Boolean).join('\n').replace(/\s+/gu, ' ').trim();
    }
    slides.push({ number: index + 1, source: file.name, field, text });
    if (index % 20 === 0 || index === slideIds.length - 1) onProgress(index + 1, slideIds.length);
  }
  const textSlides = slides.filter((slide) => slide.text.length > 0);
  if (!textSlides.length) throw new Error('No selectable slide text was found. Image-only slides need OCR.');
  return { slides: textSlides, slideCount: slideIds.length, expandedBytes: expanded };
}
