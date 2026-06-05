/** @type {Record<number, string>} */
const STATUS_MESSAGES = {
  400: 'Bad request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not found',
  405: 'Method not allowed',
  408: 'No answer',
  410: 'Number no longer available',
  413: 'Request too large',
  414: 'URI too long',
  415: 'Unsupported media',
  416: 'Unsupported URI scheme',
  420: 'Bad extension',
  421: 'Extension required',
  423: 'Interval too brief',
  480: 'Temporarily unavailable',
  481: 'Call does not exist',
  482: 'Loop detected',
  483: 'Too many hops',
  484: 'Invalid number',
  485: 'Ambiguous',
  486: 'Busy',
  487: 'Call cancelled',
  488: 'Not acceptable',
  491: 'Request pending',
  493: 'Undecipherable',
  500: 'Server error',
  501: 'Not implemented',
  502: 'Bad gateway',
  503: 'Service unavailable',
  504: 'Server timeout',
  505: 'Version not supported',
  513: 'Message too large',
  580: 'Precondition failure',
  600: 'Busy everywhere',
  603: 'Declined',
  604: 'Does not exist anywhere',
  606: 'Not acceptable',
};

/**
 * @param {string} phrase
 */
function humanizeReasonPhrase(phrase) {
  const trimmed = phrase.trim();
  if (!trimmed) {
    return '';
  }

  const lower = trimmed.toLowerCase();
  if (lower === 'busy here') {
    return 'Busy';
  }
  if (lower === 'decline' || lower === 'declined') {
    return 'Declined';
  }
  if (lower === 'temporarily unavailable') {
    return 'Temporarily unavailable';
  }
  if (lower === 'request terminated') {
    return 'Call cancelled';
  }
  if (lower === 'not found') {
    return 'Not found';
  }

  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/**
 * User-visible text for a failed or ended call.
 * @param {number | undefined} statusCode
 * @param {string | undefined} reasonPhrase
 */
export function formatCallEndStatus(statusCode, reasonPhrase) {
  if (!statusCode && !reasonPhrase?.trim()) {
    return '';
  }

  if (reasonPhrase?.trim()) {
    const fromPhrase = humanizeReasonPhrase(reasonPhrase);
    if (fromPhrase) {
      return fromPhrase;
    }
  }

  if (statusCode && STATUS_MESSAGES[statusCode]) {
    return STATUS_MESSAGES[statusCode];
  }

  if (statusCode && reasonPhrase) {
    return `${statusCode} ${reasonPhrase}`;
  }

  if (statusCode) {
    return `Call failed (${statusCode})`;
  }

  return '';
}
