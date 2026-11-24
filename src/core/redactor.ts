import type { ForensicBundle } from '../schemas/forensics.js';

const BEARER_TOKEN_REGEX = /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const AUTH_HEADER_REGEX = /\bAuthorization:\s*([^\r\n|]+)/gi;
const COOKIE_HEADER_REGEX = /\b(Set-Cookie|Cookie):\s*([^\r\n|]+)/gi;
const API_KEY_QUERY_REGEX = /(?:api_key|token)=([^\s&|]+)/gi;
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const CREDIT_CARD_REGEX = /\b(?:\d{4}[ -]?){3}\d{4}\b/g;

export function redactString(input: string): string {
  if (!input) return input;

  return input
    .replace(BEARER_TOKEN_REGEX, 'Bearer [REDACTED]')
    .replace(AUTH_HEADER_REGEX, 'Authorization: [REDACTED]')
    .replace(COOKIE_HEADER_REGEX, (match, prefix) => {
      return `${prefix}: [REDACTED]`;
    })
    .replace(API_KEY_QUERY_REGEX, (match) => {
      const param = match.split('=')[0];
      return `${param}=[REDACTED]`;
    })
    .replace(EMAIL_REGEX, '[REDACTED]')
    .replace(CREDIT_CARD_REGEX, '[REDACTED]');
}

export function redactForensicBundle(bundle: ForensicBundle): ForensicBundle {
  return {
    ...bundle,
    errorMessage: redactString(bundle.errorMessage),
    errorStack: redactString(bundle.errorStack),
    ariaSnapshot: redactString(bundle.ariaSnapshot),
    errorContext: redactString(bundle.errorContext),
    firstPartyNetworkErrors: bundle.firstPartyNetworkErrors.map((err) => ({
      ...err,
      url: redactString(err.url),
      responseBodySnippet: redactString(err.responseBodySnippet),
    })),
    pageErrors: bundle.pageErrors.map(redactString),
    consoleErrors: bundle.consoleErrors.map((err) => ({
      ...err,
      text: redactString(err.text),
    })),
  };
}
