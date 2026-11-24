import type { ForensicBundle, ClassificationVerdict } from '../schemas/forensics.js';

export function classifyFailure(bundle: ForensicBundle): ClassificationVerdict {
  // 1) firstPartyNetworkErrors.length > 0 -> verdict: 'APP_BUG', allowHealing: false, confidence: 0.95.
  if (bundle.firstPartyNetworkErrors.length > 0) {
    const errorDetails = bundle.firstPartyNetworkErrors
      .map((e) => `${e.method} ${e.url} failed with status ${e.status}`)
      .join(', ');
    return {
      verdict: 'APP_BUG',
      allowHealing: false,
      confidence: 0.95,
      reasons: [`First-party network error(s) detected: ${errorDetails}`],
    };
  }

  // 2) pageErrors.length > 0 -> verdict: 'APP_BUG', allowHealing: false, confidence: 0.95.
  if (bundle.pageErrors.length > 0) {
    return {
      verdict: 'APP_BUG',
      allowHealing: false,
      confidence: 0.95,
      reasons: [`Uncaught page exception(s) detected: ${bundle.pageErrors.join(' | ')}`],
    };
  }

  const errorMsg = bundle.errorMessage || '';

  // 3) Assertion value mismatch: error matches expect( AND does NOT contain element(s) not found AND does NOT contain Timeout on a locator action -> verdict: 'ASSERTION_MISMATCH', allowHealing: false, confidence: 0.9.
  // Note: in Playwright, web-first assertions (e.g. expect(locator).toHaveText(...)) log:
  // "unexpected value ..." when the element is resolved but values differ, accompanied by "Timeout: 4000ms".
  // A true locator failure times out waiting for locator action (waiting for element to attach/become visible) or says element(s) not found.
  const hasExpect = errorMsg.includes('expect(');
  const hasElementsNotFound = errorMsg.includes('element(s) not found');
  const hasUnexpectedValue = errorMsg.includes('unexpected value') || errorMsg.includes('Expected string:') || errorMsg.includes('Expected:');
  const isLocatorActionTimeout =
    (errorMsg.includes('Timeout') || errorMsg.includes('timed out')) &&
    !hasUnexpectedValue &&
    (errorMsg.includes('waiting for locator') ||
      errorMsg.includes('waiting for getBy') ||
      errorMsg.includes('locator.click') ||
      errorMsg.includes('locator.fill') ||
      errorMsg.includes('locator.check'));

  const hasLocatorDriftTerms =
    hasElementsNotFound ||
    errorMsg.includes('strict mode violation') ||
    isLocatorActionTimeout;

  if (hasExpect && !hasElementsNotFound && !isLocatorActionTimeout && (hasUnexpectedValue || !hasLocatorDriftTerms)) {
    return {
      verdict: 'ASSERTION_MISMATCH',
      allowHealing: false,
      confidence: 0.9,
      reasons: ['Assertion failed due to value mismatch, not missing locator or timeout'],
    };
  }

  // 4) Locator failure: error mentions Timeout, waiting for locator, waiting for getBy, element(s) not found, or strict mode violation -> verdict: 'LOCATOR_DRIFT', allowHealing: true, confidence: 0.85.
  if (
    hasElementsNotFound ||
    hasLocatorDriftTerms ||
    errorMsg.includes('Timeout') ||
    errorMsg.includes('waiting for locator') ||
    errorMsg.includes('waiting for getBy') ||
    errorMsg.includes('locator(') ||
    errorMsg.includes('getByRole')
  ) {
    return {
      verdict: 'LOCATOR_DRIFT',
      allowHealing: true,
      confidence: 0.85,
      reasons: ['Locator failed to match element, timed out, or encountered DOM mutation'],
    };
  }

  // 5) Fallback -> verdict: 'UNKNOWN', allowHealing: false, confidence: 0.3.
  return {
    verdict: 'UNKNOWN',
    allowHealing: false,
    confidence: 0.3,
    reasons: ['Unrecognized failure pattern, manual review required'],
  };
}
