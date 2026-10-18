/**
 * Production-grade Context-Aware Email Templating Engine (Issue #36).
 *
 * Prevents Server-Side Template Injection (SSTI), Cross-Site Scripting (XSS),
 * HTML tag injection, attribute breakouts, link/scheme hijacking, and CRLF
 * email header splitting.
 *
 * Architecture & Design:
 *  - Strict Contextual Escaping: Variables are automatically escaped based on their
 *    lexical output context (HTML body, HTML attribute, safe URL, email header, plain text).
 *  - No Dynamic Code Execution: Does NOT use `eval()`, `new Function()`, or unsafe regex replacements.
 *  - Safe Property Access: Reads strictly from trusted dictionary keys; blocks prototype
 *    pollution and prototype chain traversal (`__proto__`, `constructor`, `prototype`).
 *  - Linear Time & Space Complexity: Single-pass tokenized parsing and rendering in O(T + V)
 *    time and O(T + V) space, where T is template size and V is interpolated value length.
 */

import {
  escapeHtml,
  escapeHtmlAttribute,
  safeHttpUrl,
  sanitizeEmailHeader,
} from '../security/content-safety';

export type EscapingContext = 'html' | 'attr' | 'url' | 'header' | 'text' | 'raw_numeric';

export interface TemplateContextData {
  [key: string]: string | number | boolean | null | undefined;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  recipient?: string;
  from?: string;
}

export interface CompiledTemplate {
  renderHtml(data: TemplateContextData): string;
  renderText(data: TemplateContextData): string;
  renderSubject(data: TemplateContextData): string;
}

const DISALLOWED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Safely extracts a value from context data without prototype inheritance leaks.
 */
function getSafeValue(data: TemplateContextData, key: string): string | number | boolean | undefined {
  if (!key || DISALLOWED_KEYS.has(key)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(data, key)) return undefined;
  const val = data[key];
  if (val === null || val === undefined) return undefined;
  return val;
}

/**
 * Applies contextual escaping based on target context type.
 * Time Complexity: O(K) where K is length of value.
 * Space Complexity: O(K) output buffer.
 */
export function escapeForContext(value: unknown, context: EscapingContext): string {
  if (value === null || value === undefined) return '';

  switch (context) {
    case 'html':
      return escapeHtml(value);
    case 'attr':
      return escapeHtmlAttribute(value);
    case 'url': {
      const urlStr = String(value).trim();
      const safe = safeHttpUrl(urlStr, { allowHttp: true });
      return safe ? escapeHtmlAttribute(safe) : '#';
    }
    case 'header':
      return sanitizeEmailHeader(value);
    case 'text':
      return String(value)
        .normalize('NFC')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');
    case 'raw_numeric': {
      const num = Number(value);
      return Number.isFinite(num) ? String(num) : '0';
    }
    default:
      return escapeHtml(value);
  }
}

/**
 * Token types for the template lexer.
 */
type Token =
  | { type: 'literal'; value: string }
  | { type: 'variable'; key: string; context: EscapingContext }
  | { type: 'if_start'; key: string }
  | { type: 'else' }
  | { type: 'if_end' };

/**
 * Compiles a template string into linear tokens.
 * Time Complexity: O(N) where N is template string length.
 * Space Complexity: O(N) token array.
 */
export function compileTemplateString(templateStr: string, defaultContext: EscapingContext = 'html'): Token[] {
  const tokens: Token[] = [];
  const regex = /\{\{(#if\s+[\w.-]+|\/if|else|(?:(?:html|attr|url|header|text|raw_numeric):)?[\w.-]+)\}\}/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(templateStr)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: 'literal', value: templateStr.slice(lastIndex, match.index) });
    }

    const tag = match[1].trim();
    if (tag.startsWith('#if ')) {
      const key = tag.slice(4).trim();
      tokens.push({ type: 'if_start', key });
    } else if (tag === 'else') {
      tokens.push({ type: 'else' });
    } else if (tag === '/if') {
      tokens.push({ type: 'if_end' });
    } else {
      let key = tag;
      let context: EscapingContext = defaultContext;
      const colonIdx = tag.indexOf(':');
      if (colonIdx !== -1) {
        context = tag.slice(0, colonIdx) as EscapingContext;
        key = tag.slice(colonIdx + 1);
      }
      tokens.push({ type: 'variable', key, context });
    }

    lastIndex = regex.lastIndex;
  }

  if (lastIndex < templateStr.length) {
    tokens.push({ type: 'literal', value: templateStr.slice(lastIndex) });
  }

  return tokens;
}

/**
 * Evaluates tokens against context data.
 * Supports conditional branches (`#if`, `else`, `/if`) and contextual variable substitution.
 * Time Complexity: O(T + V)
 * Space Complexity: O(T + V)
 */
export function renderTokens(tokens: Token[], data: TemplateContextData): string {
  const output: string[] = [];
  const conditionStack: Array<{ active: boolean; executed: boolean }> = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const isSuppressed = conditionStack.some((c) => !c.active);

    switch (token.type) {
      case 'literal':
        if (!isSuppressed) output.push(token.value);
        break;

      case 'variable':
        if (!isSuppressed) {
          const rawVal = getSafeValue(data, token.key);
          output.push(escapeForContext(rawVal, token.context));
        }
        break;

      case 'if_start': {
        const rawVal = getSafeValue(data, token.key);
        const conditionMet = Boolean(rawVal && rawVal !== 'false' && rawVal !== 0);
        const parentSuppressed = isSuppressed;
        conditionStack.push({
          active: !parentSuppressed && conditionMet,
          executed: conditionMet,
        });
        break;
      }

      case 'else': {
        const top = conditionStack[conditionStack.length - 1];
        if (top) {
          const parentSuppressed = conditionStack.slice(0, -1).some((c) => !c.active);
          top.active = !parentSuppressed && !top.executed;
        }
        break;
      }

      case 'if_end':
        conditionStack.pop();
        break;
    }
  }

  return output.join('');
}

/**
 * Template Definition containing HTML, Text, and Subject templates.
 */
export interface EmailTemplateDefinition {
  subject: string;
  html: string;
  text: string;
}

export class EmailTemplateEngine {
  private compiledSubject: Token[];
  private compiledHtml: Token[];
  private compiledText: Token[];

  constructor(definition: EmailTemplateDefinition) {
    this.compiledSubject = compileTemplateString(definition.subject, 'header');
    this.compiledHtml = compileTemplateString(definition.html, 'html');
    this.compiledText = compileTemplateString(definition.text, 'text');
  }

  renderSubject(data: TemplateContextData): string {
    return sanitizeEmailHeader(renderTokens(this.compiledSubject, data));
  }

  renderHtml(data: TemplateContextData): string {
    return renderTokens(this.compiledHtml, data);
  }

  renderText(data: TemplateContextData): string {
    return renderTokens(this.compiledText, data);
  }

  render(data: TemplateContextData): RenderedEmail {
    return {
      subject: this.renderSubject(data),
      html: this.renderHtml(data),
      text: this.renderText(data),
      recipient: typeof data.recipientEmail === 'string' ? String(data.recipientEmail) : undefined,
    };
  }
}
