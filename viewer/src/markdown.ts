import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import sql from 'highlight.js/lib/languages/sql';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import diff from 'highlight.js/lib/languages/diff';
import yaml from 'highlight.js/lib/languages/yaml';
import { LOCAL_IMAGE_MARKER } from '../../shared/format';
import { replaceLocalImages } from '../../shared/convert';
import type { Translations } from './i18n';

for (const [name, language] of Object.entries({ javascript, typescript, python, bash, json, css, xml, sql, go, rust, diff, yaml })) {
  hljs.registerLanguage(name, language);
}

export function safeLink(url: string, image = false): boolean {
  try { return (image ? ['http:', 'https:'] : ['http:', 'https:', 'mailto:']).includes(new URL(url).protocol); }
  catch { return false; }
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

export function highlighted(text: string, language: string): string {
  // Very large outputs stay complete, while avoiding expensive syntax work on megabytes of text.
  return text.length <= 100_000 && hljs.getLanguage(language)
    ? hljs.highlight(text, { language, ignoreIllegals: true }).value : escapeHtml(text);
}

export function markdownRenderer(t: Translations): (source: string) => string {
  const md = new MarkdownIt({ html: false, linkify: false, breaks: false, highlight: highlighted });
  md.validateLink = url => safeLink(url);
  const defaultRenderToken = md.renderer.renderToken.bind(md.renderer);
  md.renderer.renderToken = (tokens, idx, options) => {
    const token = tokens[idx]!;
    if (token.attrs) token.attrs = token.attrs.filter(([name]) => name !== 'style');
    return defaultRenderToken(tokens, idx, options);
  };
  md.renderer.rules.fence = (tokens, index) => {
    const token = tokens[index]!;
    const info = token.info ? token.info.trim() : '';
    const lang = info ? info.split(/\s+/)[0]! : '';
    const codeContent = token.content;
    const highlightedCode = highlighted(codeContent, lang);
    const langDisplay = escapeHtml(lang || 'code');
    return `<div class="code-block">` +
      `<div class="code-block-header">` +
        `<span class="code-lang">${langDisplay}</span>` +
        `<button type="button" class="copy-code-btn" aria-label="${escapeHtml(t.copyCode)}">` +
          `<svg class="copy-icon" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M3.5 10.5V3.5a1 1 0 0 1 1-1h7"/></svg>` +
          `<span class="copy-label">${escapeHtml(t.copyCode)}</span>` +
        `</button>` +
      `</div>` +
      `<pre class="code-block-pre"><code>${highlightedCode}</code></pre>` +
    `</div>\n`;
  };
  const image = md.renderer.rules.image!;
  md.renderer.rules.image = (tokens, index, options, env, renderer) => {
    const token = tokens[index]!;
    if (!safeLink(token.attrGet('src') ?? '', true)) return escapeHtml(t.image);
    token.attrSet('referrerpolicy', 'no-referrer');
    return image(tokens, index, options, env, renderer);
  };
  const link = md.renderer.rules.link_open ?? ((tokens, i, options, _env, renderer) => renderer.renderToken(tokens, i, options));
  md.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
    tokens[index]!.attrSet('rel', 'noopener noreferrer');
    return link(tokens, index, options, env, renderer);
  };
  return source => md.render(replaceLocalImages(source).replaceAll(LOCAL_IMAGE_MARKER, t.image));
}
