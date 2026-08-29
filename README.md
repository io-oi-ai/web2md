# web2md-core

Turn messy HTML into clean, LLM-ready Markdown.

This is the extraction and conversion engine behind [Web2MD](https://web2md.org).
It is a pure library — give it an HTML string, get Markdown back. No network
calls, no API key, no account. Nothing in this package talks to a server.

```bash
npm install web2md-core
```

## Why convert at all

Feeding raw HTML to a language model wastes most of your context window on
markup, navigation, and ads. Converting first cuts that down and gives the model
a document it can actually follow.

The library reports both numbers so you can see the difference:

```ts
import { convertToMarkdown } from 'web2md-core'

const result = convertToMarkdown(html, { url: 'https://example.com/post' })

console.log(result.markdown)
console.log(result.metadata.originalTokenCount, '→', result.metadata.tokenCount)
// e.g. 417 → 281
```

`convertToMarkdown` returns `null` when it cannot find a main content block —
check for that rather than assuming a result.

## What it does

- **Finds the actual article.** Strips navigation, sidebars, ads, cookie banners,
  and footers, keeping the content a reader came for.
- **Preserves structure.** Headings, lists, tables, and fenced code blocks survive
  the round trip — that structure is what lets a model answer questions about one
  specific section.
- **Reports tokens.** Estimated counts for both the original HTML and the cleaned
  Markdown, plus helpers to split or trim for a target context window.
- **Runs anywhere.** Uses [linkedom](https://github.com/WebReflection/linkedom)
  for parsing, so it works in Node without a browser.

## API

### `convertToMarkdown(html, options?)`

The main entry point. Note the signature takes **two** arguments — the URL goes
inside `options`, not as a positional parameter:

```ts
convertToMarkdown(html, { url: 'https://example.com/post' })
```

| Option | Default | Meaning |
| --- | --- | --- |
| `url` | — | Source URL. Used to resolve relative links and fill `metadata.url`. |
| `includeLinks` | `false` | Keep `<a>` as Markdown links. Off by default because link URLs are often the bulk of the tokens on navigation-heavy pages. |
| `includeImages` | `false` | Keep images. Off by default for the same reason. |
| `includeMeta` | `false` | Prepend a metadata block (title, source, timestamp). |
| `customRule` | — | A `CustomRule` for site-specific extraction. |
| `detectCodeLanguage` | `false` | Try to infer the language of fenced code blocks. |

`includeLinks` and `includeImages` default to **off**. That is deliberate — the
primary use case is feeding an LLM, where both are usually noise. Turn them on
when you are archiving rather than summarising.

### Other exports

```ts
quickConvert(html, url?)        // same result, but with links, images and
                                // metadata turned ON — the "archive it" preset
extractContent(html, url?)      // main content element, before conversion
htmlToMarkdown(html, options?)  // low-level conversion, no extraction
countTokens(text)               // token estimate
splitByTokens(md, limit)        // chunk for RAG ingestion
optimizeForContextWindow(md, model)
htmlLooksLikeLoginWall(html)    // detect login walls so you can fail loudly
MODEL_CONTEXT_LIMITS            // context sizes for common models
```

Markdown → sanitized HTML (via DOMPurify), for previewing output:

```ts
renderMarkdownSync(md)
renderMarkdownFull(md)          // async; includes syntax highlighting
renderMarkdownWithFormulas(md)  // KaTeX math
```

`getPageHTML()` and `getSelectionHTML()` read `document` directly and therefore
only work in a browser. They throw in Node — that boundary is intentional.

## Site-specific extraction

Generic extraction handles most pages. When a site needs special treatment,
pass a rule:

```ts
convertToMarkdown(html, {
  url: 'https://example.com/thread',
  customRule: {
    name: 'Example forum',
    domain: 'example.com',
    contentSelector: '.thread-body',
    removeSelectors: ['.signature', '.ad-slot'],
  },
})
```

## Scope

This package covers extraction and conversion. It does not include Web2MD's
browser extension, hosted API, or account system — those stay in the product.

Contributions to extraction quality are especially welcome: if a site converts
badly, an issue with the URL and what went wrong is genuinely useful.

## License

MIT
