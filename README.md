# PaperMind AI

A static, bilingual PDF workspace based on the original white/navy SaaS starter design. PDF reading and analysis happen in the browser. There is no backend, login, cloud storage, OpenAI API, API key, or document upload endpoint.

## Run locally on Windows

1. Extract the ZIP.
2. Open the extracted `PaperMind_AI` folder and double-click `시작하기.bat`.
3. A browser opens at `http://127.0.0.1:8000/`. Keep the black window open while using the site; close it to stop the local server.

This launcher uses the Windows PowerShell already included with Windows; Python and Node.js are not required. It does not install software or change a system-wide setting.

Opening `index.html` directly can block JavaScript modules/workers. On other systems, start any static web server in this folder and visit its localhost address.

## Features and limits

- Korean/English interface, retaining the original visual layout.
- Local PDF selection and drag/drop, up to 20 MB. PDF.js extracts selectable text page by page in the browser.
- Summary shows ranked source sentences with page numbers. Document Q&A returns matching passages with page numbers; turn on the optional local model for a generated answer based on those passages. Without the model, Q&A is clearly labeled as source matching, not a generated answer.
- Key information extraction finds frequent terms and sentences containing dates or quantities. It is a lightweight text heuristic, not named-entity recognition or generative AI.
- Translation uses the optional local model and translates Korean ↔ English based on the selected UI language. It handles up to the first 8,000 extracted characters per request and shows source pages. Review model translations against the PDF.
- Optional Qwen2.5-0.5B-Instruct browser model via Transformers.js. It is opt-in and fetched by the browser from Hugging Face on first use. Prompts are tuned to match the document/question language and produce smoother, concise wording with page citations, but this small model can still sound awkward or make mistakes. The quantized weights are roughly 0.5 GB; download/storage, memory and speed vary by device. It is not included in this project and no AI provider inference API is called. A model loading or compatibility failure leaves extractive summary, passage matching and keyword extraction available; translation requires the model.
- OCR for scanned/image-only PDFs, DOCX/TXT, translation, accounts, persistence, cross-device sync, and server features are not included. Documents are held only in the current page session.
- PDF.js and the optional model need an internet connection on initial use (and browser access to their public CDNs/model host). The model may remain cached by the browser.

## Static deployment

The simplest route that keeps the source private is a private GitHub repository connected to Cloudflare Pages. The site itself will still be public at its `pages.dev` address. Cloudflare Pages supports public and private GitHub repositories. For this plain static site, use the Free plan, leave the build command blank, and set the output directory to `.`. Static asset requests are currently free and unlimited; the Free plan has build and file-count limits, so check the current limits before growth. See the [Cloudflare Pages Git guide](https://developers.cloudflare.com/pages/get-started/git-integration/) and [current limits](https://developers.cloudflare.com/pages/platform/limits/).

GitHub Pages is an alternative, but on GitHub Free the repository must be public, which makes the source files public too. If choosing that route, publish the root of the `main` branch in **Settings → Pages → Deploy from a branch**. See [GitHub's publishing-source guide](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).

Step-by-step Korean instructions are in [`배포 안내.md`](배포%20안내.md). This project is prepared for deployment, but no public site or repository has been created from this workspace.

## Privacy and network behavior

The selected PDF is passed to PDF.js as an in-memory `ArrayBuffer`. Extracted text is held in page memory. The application code contains no `fetch`/XHR calls that send documents, no API secret, and no server endpoint. Third-party network requests are limited to loading the public PDF.js library/worker and, only after opt-in, the Transformers.js library and model assets. A deployed static site host receives ordinary site requests; the PDF bytes are not sent to that host by this app.

## Commercial-use and license notes

- PDF.js is distributed under Apache License 2.0. See [Mozilla PDF.js license](https://github.com/mozilla/pdf.js/blob/master/LICENSE).
- Transformers.js is Apache License 2.0. See [Transformers.js license](https://github.com/huggingface/transformers.js/blob/main/LICENSE).
- Qwen2.5-0.5B-Instruct is marked Apache-2.0 by its upstream model card. The ONNX Community repo provides compatible ONNX weights for Transformers.js and traces to the upstream model. See [upstream model card](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct) and [ONNX model card](https://huggingface.co/onnx-community/Qwen2.5-0.5B-Instruct). Preserve the relevant license and attribution if redistributing model weights. This project does not bundle model weights.
- Apache 2.0 permits commercial use subject to its terms, including preserving notices and license text on redistribution. This is a practical license summary, not legal advice. Review upstream files/terms again before commercial distribution, since hosted model repositories and dependencies can change.

The optional model is small and multilingual, but output quality can be inconsistent, especially for nuanced Korean reasoning. It can hallucinate despite evidence prompting. Verify generated statements against the cited PDF pages. Model download and inference use the end user's bandwidth and device; “zero recurring cost” does not mean zero resource use or a guaranteed free third-party hosting plan.
